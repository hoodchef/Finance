import type {
  BarInterval,
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

/**
 * Alpha Vantage — used for Canadian listings, at WEEKLY resolution.
 * =============================================================================
 * This provider exists for one reason: Tiingo does not carry TSX listings and
 * Yahoo is unreliable, which left Canadian portfolios unbacktestable.
 *
 * **Why weekly and not daily.** On the free tier, `TIME_SERIES_DAILY_ADJUSTED`
 * is premium, and plain `TIME_SERIES_DAILY` is capped at 100 bars with
 * `outputsize=full` also premium — roughly five months of raw OHLCV with no
 * dividends and no splits. Neither can produce a correct total return.
 * `TIME_SERIES_WEEKLY_ADJUSTED` is free, returns full history, and carries both
 * an adjusted close and per-bar dividends. It is the only free shape here that
 * is actually correct.
 *
 * **Verified, not assumed.** Alpha Vantage's weekly adjusted close was checked
 * against Tiingo's daily adjusted close on AAPL over 2019-2021, a window
 * containing the 4:1 split: total return 393.5267% against 393.5270%, agreeing
 * to 6.9e-7, with adjusted closes identical on shared dates. Splits are handled
 * and the convention matches the exact total-return one the engine uses.
 *
 * **What weekly costs.** A drawdown that opens and closes inside one week is
 * invisible, so maximum drawdown from this data is a floor rather than the
 * figure. Volatility is measured on ~52 observations a year. The series is
 * tagged `interval: 'weekly'` so the engine annualises correctly and the UI can
 * say so; nothing here pretends to be daily.
 *
 * **Rate limits are severe.** 25 requests/day, and the throttle bites well
 * before that on bursts. Everything is cached hard and fetched one symbol at a
 * time; this is a fallback for symbols other providers cannot serve, never a
 * primary.
 */

const BASE = 'https://www.alphavantage.co/query';

/** Alpha Vantage's exchange suffixes for the Canadian venues. */
const CANADIAN_SUFFIX: Record<string, string> = {
  // Yahoo/common form -> Alpha Vantage form
  '.TO': '.TRT', // Toronto Stock Exchange
  '.V': '.TRV', // TSX Venture
  '.NE': '.NEO', // NEO Exchange
  '.CN': '.CNQ', // Canadian Securities Exchange
};

/** Suffixes Alpha Vantage itself uses, so an already-mapped symbol passes through. */
const NATIVE_SUFFIXES = new Set(['.TRT', '.TRV', '.NEO', '.CNQ']);

/**
 * True when a symbol names a Canadian listing.
 *
 * Bare tickers are NOT treated as Canadian: `SHOP` is the US listing and
 * `SHOP.TO` is the Toronto one, and quietly resolving the first as the second
 * would return a different security in a different currency.
 */
export function isCanadianSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  const dot = s.lastIndexOf('.');
  if (dot < 0) return false;
  const suffix = s.slice(dot);
  return suffix in CANADIAN_SUFFIX || NATIVE_SUFFIXES.has(suffix);
}

/** Maps a common Canadian ticker form onto Alpha Vantage's. */
export function toAlphaVantageSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const dot = s.lastIndexOf('.');
  if (dot < 0) return s;
  const suffix = s.slice(dot);
  const mapped = CANADIAN_SUFFIX[suffix];
  return mapped ? s.slice(0, dot) + mapped : s;
}

function apiKey(): string {
  const key = process.env.ALPHA_VANTAGE_API_KEY?.trim();
  if (!key) {
    throw new MarketDataError(
      'ALPHA_VANTAGE_API_KEY is not set. Canadian listings need it; get a free key at ' +
        'https://www.alphavantage.co/support/#api-key and put it in .env.local.',
    );
  }
  return key;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface WeeklyBar {
  '1. open': string;
  '2. high': string;
  '3. low': string;
  '4. close': string;
  '5. adjusted close': string;
  '6. volume': string;
  '7. dividend amount': string;
}

/**
 * Alpha Vantage answers 200 OK for everything, including refusals.
 *
 * A premium-gated endpoint, an exhausted quota and a bad key all come back as a
 * JSON body with an `Information`, `Note` or `Error Message` key and no data.
 * Treating those as success is how a caller ends up with an empty series it
 * believes is real, so they are turned into errors here.
 */
function assertPayload(body: Record<string, unknown>, symbol: string): void {
  const refusal =
    (body['Error Message'] as string | undefined) ??
    (body.Information as string | undefined) ??
    (body.Note as string | undefined);
  if (!refusal) return;

  if (/invalid api call|does not exist/i.test(refusal)) throw new UnknownSymbolError(symbol);
  if (/premium/i.test(refusal)) {
    throw new MarketDataError(
      `Alpha Vantage requires a premium plan for this request: ${refusal}`,
      symbol,
    );
  }
  // Quota and throttle share this shape.
  throw new MarketDataError(
    `Alpha Vantage declined the request for ${symbol}. Its free tier allows 25 requests a day ` +
      `and throttles bursts well before that. Original message: ${refusal}`,
    symbol,
  );
}

function parseWeekly(
  symbol: string,
  requested: string,
  body: Record<string, unknown>,
): PriceSeries {
  const table = body['Weekly Adjusted Time Series'] as Record<string, WeeklyBar> | undefined;
  if (!table || Object.keys(table).length === 0) throw new UnknownSymbolError(requested);

  const bars: PriceBar[] = [];
  const dividends: DividendEvent[] = [];
  // The weekly adjusted feed carries no split factor. Splits are already folded
  // into both close and adjusted close (verified against Tiingo across AAPL's
  // 4:1), so the engine must NOT also apply one — hence 'split-adjusted' below
  // and an empty split list, which is a statement of fact rather than a gap.
  const splits: SplitEvent[] = [];

  for (const [date, row] of Object.entries(table)) {
    const close = Number(row['4. close']);
    const adjClose = Number(row['5. adjusted close']);
    if (!Number.isFinite(close) || close <= 0) continue;

    bars.push({
      date: date as IsoDate,
      open: Number(row['1. open']) || close,
      high: Number(row['2. high']) || close,
      low: Number(row['3. low']) || close,
      close,
      adjClose: Number.isFinite(adjClose) ? adjClose : close,
      volume: Number(row['6. volume']) || 0,
    });

    const div = Number(row['7. dividend amount']);
    if (Number.isFinite(div) && div > 0) dividends.push({ date: date as IsoDate, amount: div });
  }

  if (!bars.length) throw new UnknownSymbolError(requested);
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  dividends.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const meta: SecurityMeta = {
    symbol: requested.toUpperCase(),
    name: requested.toUpperCase(),
    assetClass: 'other',
    // The venue is knowable from the suffix, and for Canadian listings the
    // currency follows from it. Asserting USD for a TSX line would be wrong.
    currency: isCanadianSymbol(requested) ? 'CAD' : undefined,
    exchange: symbol.slice(symbol.lastIndexOf('.') + 1) || undefined,
    firstTradeDate: bars[0].date,
    lastTradeDate: bars[bars.length - 1].date,
  };

  return {
    meta,
    bars,
    dividends,
    splits,
    adjustment: 'split-adjusted',
    interval: 'weekly' satisfies BarInterval,
    source: 'alphavantage',
    synthetic: false,
    fetchedAt: new Date().toISOString(),
  };
}

const inFlight = new Map<string, Promise<PriceSeries>>();

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = 'alphavantage';
  readonly label = 'Alpha Vantage';
  readonly synthetic = false;
  readonly description =
    'Weekly adjusted history with dividends, used for Canadian listings that other providers do not carry. Weekly bars, so intra-week drawdowns are not visible. Free tier is 25 requests a day.';

  private async loadFull(requested: string): Promise<PriceSeries> {
    // Scoped to Canadian listings on purpose. Alpha Vantage does serve US
    // tickers, but only weekly here — and letting it answer for them would mean
    // a transient Tiingo outage quietly turning a daily backtest into a weekly
    // one, changing its drawdown and volatility. This is a MarketDataError
    // rather than UnknownSymbolError because it says nothing about whether the
    // ticker exists, only that this provider is not the one to ask.
    if (!isCanadianSymbol(requested)) {
      throw new MarketDataError(
        `Alpha Vantage is configured here only for Canadian listings, and ${requested} is not one. ` +
          'Use a suffixed symbol such as XEQT.TO for the Toronto listing.',
        requested,
      );
    }

    const avSymbol = toAlphaVantageSymbol(requested);
    const key = `alphavantage:${avSymbol}`;

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
        const qs = new URLSearchParams({
          function: 'TIME_SERIES_WEEKLY_ADJUSTED',
          symbol: avSymbol,
          apikey: apiKey(),
        });

        // Backoff is long on purpose: the free throttle is measured in tens of
        // seconds, and hammering it only extends the block.
        let body: Record<string, unknown> | null = null;
        let wait = 20_000;
        for (let attempt = 0; attempt < 3; attempt++) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          try {
            const res = await fetch(`${BASE}?${qs}`, { signal: controller.signal });
            if (!res.ok) throw new MarketDataError(`Alpha Vantage returned HTTP ${res.status}`);
            const parsed = (await res.json()) as Record<string, unknown>;
            try {
              assertPayload(parsed, requested);
            } catch (e) {
              // A throttle is worth retrying; a missing symbol or a premium
              // gate never resolves itself.
              const retryable =
                e instanceof MarketDataError &&
                !(e instanceof UnknownSymbolError) &&
                /25 requests/.test(e.message);
              if (!retryable || attempt === 2) throw e;
              await sleep(wait);
              wait = Math.min(wait * 2, 90_000);
              continue;
            }
            body = parsed;
            break;
          } finally {
            clearTimeout(timer);
          }
        }
        if (!body) throw new MarketDataError(`Alpha Vantage did not return data for ${requested}`);

        const series = parseWeekly(avSymbol, requested, body);
        memorySet(key, series);
        void diskSet(key, series);
        return series;
      } catch (error) {
        // Real prices from an expired cache beat failing, and beat anything
        // invented. The staleness is flagged all the way to the UI.
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

  private slice(series: PriceSeries, range: DateRange): PriceSeries {
    return {
      ...series,
      bars: series.bars.filter((b) => b.date >= range.start && b.date <= range.end),
      dividends: series.dividends.filter((d) => d.date >= range.start && d.date <= range.end),
      splits: [],
    };
  }

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    return this.slice(await this.loadFull(symbol), range);
  }

  async getCorporateActions(symbol: string, range: DateRange) {
    const x = this.slice(await this.loadFull(symbol), range);
    return { dividends: x.dividends, splits: x.splits };
  }

  async getDividends(symbol: string, range: DateRange): Promise<DividendEvent[]> {
    return this.slice(await this.loadFull(symbol), range).dividends;
  }

  /**
   * Weekly bars are the wrong shape for a market calendar, and offering them as
   * one would make every other holding look stale four days in five. Another
   * provider supplies the calendar.
   */
  async getTradingCalendar(_range: DateRange): Promise<IsoDate[]> {
    return [];
  }

  async search(query: string): Promise<SecurityMeta[]> {
    try {
      const qs = new URLSearchParams({
        function: 'SYMBOL_SEARCH',
        keywords: query,
        apikey: apiKey(),
      });
      const res = await fetch(`${BASE}?${qs}`);
      if (!res.ok) return [];
      const body = (await res.json()) as Record<string, unknown>;
      const matches = body.bestMatches as Array<Record<string, string>> | undefined;
      if (!Array.isArray(matches)) return [];

      return matches
        // Only the Canadian venues; this provider is not a general search.
        .filter((m) => NATIVE_SUFFIXES.has(m['1. symbol'].slice(m['1. symbol'].lastIndexOf('.'))))
        .slice(0, 10)
        .map((m) => ({
          symbol: m['1. symbol'].toUpperCase(),
          name: m['2. name'],
          assetClass: m['3. type']?.toLowerCase() === 'etf' ? 'etf' : 'equity',
          currency: m['8. currency'] || undefined,
        })) as SecurityMeta[];
    } catch {
      return [];
    }
  }
}

/** Exposed for `tests/alphavantage.test.ts`. */
export const __testing = { parseWeekly, assertPayload };
