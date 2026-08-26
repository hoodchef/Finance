import type {
  CorporateActions,
  DateRange,
  DividendEvent,
  IsoDate,
  PriceBar,
  PriceSeries,
  SecurityMeta,
  SplitEvent,
} from '@/lib/types';
import { MarketDataError, UnknownSymbolError, type MarketDataProvider } from './provider';
import { diskGetEntry, diskSet, memoryGet, memorySet } from './cache';
import { todayIso } from './dates';

/**
 * Tiingo end-of-day provider.
 *
 * WHY THIS EXISTS ALONGSIDE YAHOO
 *
 * Yahoo is reached through an undocumented endpoint, is rate-limited without
 * warning, and its terms permit personal use only. Tiingo is a documented,
 * key-authenticated API with an explicit corporate-actions model and a far more
 * generous published quota (1,000 requests/day against Yahoo's unstated and
 * aggressive throttle).
 *
 * LICENSING — READ BEFORE COMMERCIALISING
 *
 * Tiingo's free AND $30/month tiers are both restricted to internal use: "you
 * may only use the data for your own personal use and you may not display or
 * share the data with another person or organization." That is fine for
 * personal research and wrong for a product with users. Redistribution needs a
 * commercial agreement, from Tiingo or from a provider licensed for it.
 * `PROVIDER_LICENCES` in `licence.ts` states this in the application itself.
 *
 * ADJUSTMENT MODEL — DIFFERENT FROM YAHOO
 *
 * Tiingo returns RAW prices plus per-bar `divCash` and `splitFactor`, where
 * Yahoo returns retroactively split-adjusted prices with separate event lists.
 * This series is therefore declared `adjustment: 'raw'`, and the engine applies
 * splits to share counts itself — a path it already supports and tests. The
 * difference is exactly what the provider abstraction exists to absorb.
 */

const BASE = 'https://api.tiingo.com/tiingo/daily';
const FULL_HISTORY_START: IsoDate = '1970-01-02';

interface TiingoBar {
  date: string; // ISO 8601 timestamp
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  adjClose: number;
  adjHigh: number;
  adjLow: number;
  adjOpen: number;
  adjVolume: number;
  divCash: number;
  splitFactor: number;
}

interface TiingoMeta {
  ticker: string;
  name: string;
  exchangeCode?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

function apiKey(): string {
  const key = process.env.TIINGO_API_KEY?.trim();
  if (!key) {
    throw new MarketDataError(
      'TIINGO_API_KEY is not set. Add it to .env.local, or leave MARKET_DATA_PROVIDER unset to use Yahoo Finance.',
    );
  }
  return key;
}

async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (res.status === 404) throw new MarketDataError('HTTP 404');
    if (res.status === 401 || res.status === 403) {
      throw new MarketDataError(
        'Tiingo rejected the API key. Check TIINGO_API_KEY in .env.local.',
      );
    }
    if (!res.ok) throw new MarketDataError(`Market data request failed with HTTP ${res.status}.`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parse(symbol: string, meta: TiingoMeta, raw: TiingoBar[]): PriceSeries {
  const bars: PriceBar[] = [];
  const dividends: DividendEvent[] = [];
  const splits: SplitEvent[] = [];

  for (const b of raw) {
    // Tiingo timestamps bars at midnight UTC of the trading day.
    const date = b.date.slice(0, 10);
    if (!Number.isFinite(b.close) || b.close <= 0) continue;

    bars.push({
      date,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
      adjClose: Number.isFinite(b.adjClose) ? b.adjClose : b.close,
      volume: b.volume ?? 0,
    });

    if (Number.isFinite(b.divCash) && b.divCash > 0) {
      dividends.push({ date, amount: b.divCash });
    }
    // A split factor of 1 is the no-split case, present on every other bar.
    if (Number.isFinite(b.splitFactor) && b.splitFactor !== 1 && b.splitFactor > 0) {
      splits.push({ date, numerator: b.splitFactor, denominator: 1 });
    }
  }

  if (!bars.length) throw new UnknownSymbolError(symbol);
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    meta: {
      symbol: meta.ticker?.toUpperCase() ?? symbol.toUpperCase(),
      name: meta.name ?? symbol.toUpperCase(),
      // Tiingo does not classify instrument type on this endpoint; leaving it
      // 'other' is honest, and nothing in the engine branches on it.
      assetClass: 'other',
      // Tiingo's daily metadata carries no currency field, so this stays
      // undefined rather than asserting USD for a listing it never described.
      currency: undefined,
      exchange: meta.exchangeCode,
      firstTradeDate: meta.startDate?.slice(0, 10) ?? bars[0].date,
      lastTradeDate: meta.endDate?.slice(0, 10) ?? bars[bars.length - 1].date,
    },
    bars,
    dividends,
    splits,
    // Raw prices with explicit corporate actions — the engine applies splits.
    adjustment: 'raw',
    source: 'tiingo',
    synthetic: false,
    fetchedAt: new Date().toISOString(),
  };
}

const inFlight = new Map<string, Promise<PriceSeries>>();

export class TiingoProvider implements MarketDataProvider {
  readonly id = 'tiingo';
  readonly label = 'Tiingo';
  readonly synthetic = false;
  readonly description =
    'Documented end-of-day API with explicit per-bar dividends and split factors. Requires an API key. Free and standard tiers are licensed for personal use only.';

  private async loadFull(symbol: string): Promise<PriceSeries> {
    const key = `tiingo:${symbol.toUpperCase()}`;

    const hot = memoryGet(key);
    if (hot) return hot;
    const pending = inFlight.get(key);
    if (pending) return pending;

    const task = (async () => {
      const cached = await diskGetEntry(key);
      if (cached && !cached.expired) {
        memorySet(key, cached.series);
        return cached.series;
      }

      try {
        const token = apiKey();
        const ticker = encodeURIComponent(symbol.toLowerCase());
        const qs = new URLSearchParams({
          startDate: FULL_HISTORY_START,
          endDate: todayIso(),
          format: 'json',
          token,
        });

        let bars: TiingoBar[] | null = null;
        let meta: TiingoMeta | null = null;
        let wait = 700;

        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            [meta, bars] = await Promise.all([
              fetchJson<TiingoMeta>(`${BASE}/${ticker}?token=${encodeURIComponent(token)}`),
              fetchJson<TiingoBar[]>(`${BASE}/${ticker}/prices?${qs}`),
            ]);
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : '';
            // A missing ticker or a bad key will not fix itself on retry.
            if (message.includes('404')) throw new UnknownSymbolError(symbol);
            if (message.includes('API key')) throw err;
            if (attempt === 3) throw err;
            await sleep(wait);
            wait = Math.min(wait * 2, 6_000);
          }
        }

        if (!bars?.length) throw new UnknownSymbolError(symbol);
        const series = parse(symbol, meta ?? ({ ticker: symbol, name: symbol } as TiingoMeta), bars);
        memorySet(key, series);
        void diskSet(key, series);
        return series;
      } catch (error) {
        // Real prices from an expired cache beat failing outright, and beat
        // anything invented. The staleness is flagged all the way to the UI.
        if (cached) {
          const stale: PriceSeries = { ...cached.series, stale: true };
          memorySet(key, stale, 5 * 60 * 1000);
          return stale;
        }
        throw error;
      }
    })();

    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    const full = await this.loadFull(symbol);
    return {
      ...full,
      bars: full.bars.filter((b) => b.date >= range.start && b.date <= range.end),
      dividends: full.dividends.filter((d) => d.date >= range.start && d.date <= range.end),
      splits: full.splits.filter((s) => s.date >= range.start && s.date <= range.end),
    };
  }

  async getFullHistory(symbol: string): Promise<PriceSeries> {
    return this.loadFull(symbol);
  }

  async getCorporateActions(symbol: string, range: DateRange): Promise<CorporateActions> {
    const s = await this.getHistoricalPrices(symbol, range);
    return { dividends: s.dividends, splits: s.splits };
  }

  async getDividends(symbol: string, range: DateRange): Promise<DividendEvent[]> {
    return (await this.getHistoricalPrices(symbol, range)).dividends;
  }

  async getTradingCalendar(range: DateRange, symbols: string[] = ['SPY']): Promise<IsoDate[]> {
    const all = await Promise.all(
      symbols.map((s) => this.getHistoricalPrices(s, range).catch(() => null)),
    );
    const days = new Set<IsoDate>();
    for (const series of all) {
      if (!series) continue;
      for (const bar of series.bars) days.add(bar.date);
    }
    return [...days].sort();
  }

  async search(query: string): Promise<SecurityMeta[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const results = await fetchJson<
        Array<{ ticker: string; name: string; assetType?: string; countryCode?: string }>
      >(
        `https://api.tiingo.com/tiingo/utilities/search?query=${encodeURIComponent(q)}&token=${encodeURIComponent(apiKey())}`,
        8_000,
      );
      return results.slice(0, 10).map((r) => ({
        symbol: r.ticker.toUpperCase(),
        name: r.name,
        assetClass: r.assetType?.toLowerCase() === 'etf' ? 'etf' : 'equity',
        currency: undefined,
      }));
    } catch {
      return [];
    }
  }
}

/** Exposed for `tests/parity-tiingo.test.ts`, which replays recorded bars. */
export const __testing = { parse };
