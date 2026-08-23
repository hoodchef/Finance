import type {
  AssetClass,
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
import { diskGet, diskSet, memoryGet, memorySet } from './cache';
import { toIso, todayIso, toUnixSeconds, unixToIso } from './dates';

/**
 * Yahoo Finance daily-bar provider.
 *
 * Verified data contract (see `tests/market-data.test.ts`, which re-checks this
 * against recorded fixtures):
 *
 *  1. `indicators.quote[0].close` is retroactively **split-adjusted** and not
 *     dividend-adjusted. AAPL's 2020-08-28 close is reported as 124.81, i.e.
 *     the as-traded 499.23 divided by the later 4:1 split.
 *  2. `events.dividends[].amount` is expressed in the *same* split-adjusted
 *     units. AAPL's August 2020 dividend is reported as 0.205, i.e. the
 *     as-paid 0.82 divided by 4.
 *  3. `adjclose / close` is piecewise-constant and steps only on ex-dividend
 *     dates, by exactly `1 - dividend / prior close`.
 *
 * (1) and (2) together mean share counts never need split handling: a split is
 * value-neutral across the whole series. (3) gives us a free integrity check —
 * we can rederive every dividend from the adjusted close and compare.
 */

const CHART_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

/**
 * Floor for the history request. Kept at a positive unix timestamp — a negative
 * `period1` is not documented as supported — and comfortably earlier than
 * `MAX_HISTORY_START`, the earliest date the app will accept.
 */
const FULL_HISTORY_START: IsoDate = '1970-01-02';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface YahooChartResponse {
  chart: {
    result?: Array<{
      meta: {
        symbol: string;
        currency?: string;
        instrumentType?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        longName?: string;
        shortName?: string;
        firstTradeDate?: number;
      };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
      events?: {
        dividends?: Record<string, { amount: number; date: number }>;
        splits?: Record<
          string,
          { date: number; numerator: number; denominator: number; splitRatio?: string }
        >;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

function classify(instrumentType?: string): AssetClass {
  switch ((instrumentType ?? '').toUpperCase()) {
    case 'ETF':
      return 'etf';
    case 'EQUITY':
      return 'equity';
    case 'INDEX':
      return 'index';
    case 'MUTUALFUND':
      return 'mutualfund';
    case 'CRYPTOCURRENCY':
      return 'crypto';
    default:
      return 'other';
  }
}

async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new MarketDataError(
        `Market data request failed with HTTP ${res.status}.`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Alternates hosts and backs off on 429/503. Yahoo throttles aggressively when
 * several symbols are requested at once, and a throttled request that is not
 * retried shows up to the user as "this ticker does not exist", which is both
 * wrong and impossible to debug.
 */
async function fetchChart(symbol: string): Promise<YahooChartResponse> {
  const qs = new URLSearchParams({
    period1: String(toUnixSeconds(FULL_HISTORY_START)),
    period2: String(toUnixSeconds(todayIso()) + 86_400),
    interval: '1d',
    events: 'div,split',
    includeAdjustedClose: 'true',
  });

  let lastError: unknown;
  let wait = 700;
  for (let attempt = 0; attempt < 6; attempt++) {
    const host = CHART_HOSTS[attempt % CHART_HOSTS.length];
    try {
      return await fetchJson<YahooChartResponse>(
        `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`,
      );
    } catch (err) {
      lastError = err;
      const status =
        err instanceof MarketDataError ? /HTTP (\d+)/.exec(err.message)?.[1] : undefined;
      // 404 means the ticker really does not exist; retrying cannot help.
      if (status === '404') throw new UnknownSymbolError(symbol);
      if (attempt < 5) {
        await sleep(wait);
        wait = Math.min(wait * 2, 8_000);
      }
    }
  }

  throw new MarketDataError(
    `Could not load market data for "${symbol}" — the data service refused repeated requests. Wait a minute and try again, or switch to the demo data provider in Settings.`,
    symbol,
    lastError,
  );
}

function parseChart(symbol: string, json: YahooChartResponse): PriceSeries {
  const result = json.chart.result?.[0];
  if (!result || !result.timestamp?.length) {
    throw new UnknownSymbolError(symbol);
  }

  const q = result.indicators.quote[0] ?? {};
  const adj = result.indicators.adjclose?.[0]?.adjclose ?? [];
  const bars: PriceBar[] = [];

  for (let i = 0; i < result.timestamp.length; i++) {
    const close = q.close?.[i];
    // Yahoo emits null rows for days an exchange reported no trade. A day with
    // no close is not a trading day for this security, so we drop it rather
    // than inventing a price.
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    const date = unixToIso(result.timestamp[i]);
    const adjClose = adj[i];
    bars.push({
      date,
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      adjClose: adjClose != null && Number.isFinite(adjClose) ? adjClose : close,
      volume: q.volume?.[i] ?? 0,
    });
  }

  if (!bars.length) throw new UnknownSymbolError(symbol);
  // Yahoo returns ascending order, but never rely on a provider for ordering.
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const dividends: DividendEvent[] = Object.values(result.events?.dividends ?? {})
    .map((d) => ({ date: unixToIso(d.date), amount: d.amount }))
    .filter((d) => Number.isFinite(d.amount) && d.amount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const splits: SplitEvent[] = Object.values(result.events?.splits ?? {})
    .map((s) => ({
      date: unixToIso(s.date),
      numerator: s.numerator,
      denominator: s.denominator,
    }))
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const meta: SecurityMeta = {
    symbol: result.meta.symbol ?? symbol.toUpperCase(),
    name: result.meta.longName ?? result.meta.shortName ?? symbol.toUpperCase(),
    assetClass: classify(result.meta.instrumentType),
    currency: result.meta.currency ?? 'USD',
    exchange: result.meta.fullExchangeName ?? result.meta.exchangeName,
    firstTradeDate: result.meta.firstTradeDate
      ? toIso(new Date(result.meta.firstTradeDate * 1000))
      : bars[0].date,
    lastTradeDate: bars[bars.length - 1].date,
  };

  return {
    meta,
    bars,
    dividends,
    splits,
    adjustment: 'split-adjusted',
    source: 'yahoo',
    synthetic: false,
    fetchedAt: new Date().toISOString(),
  };
}

function slice(series: PriceSeries, range: DateRange): PriceSeries {
  const bars = series.bars.filter((b) => b.date >= range.start && b.date <= range.end);
  return {
    ...series,
    bars,
    dividends: series.dividends.filter(
      (d) => d.date >= range.start && d.date <= range.end,
    ),
    splits: series.splits.filter((s) => s.date >= range.start && s.date <= range.end),
  };
}

/** De-duplicates concurrent requests for the same symbol into one fetch. */
const inFlight = new Map<string, Promise<PriceSeries>>();

export class YahooFinanceProvider implements MarketDataProvider {
  readonly id = 'yahoo';
  readonly label = 'Yahoo Finance';
  readonly synthetic = false;
  readonly description =
    'Daily split-adjusted OHLC, cash dividends and split events from Yahoo Finance. Unofficial endpoint, delayed, and not warranted for accuracy.';

  private async loadFull(symbol: string): Promise<PriceSeries> {
    const key = `yahoo:${symbol.toUpperCase()}`;

    const hot = memoryGet(key);
    if (hot) return hot;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const task = (async () => {
      const cold = await diskGet(key);
      if (cold) {
        memorySet(key, cold);
        return cold;
      }
      const series = parseChart(symbol, await fetchChart(symbol));
      memorySet(key, series);
      void diskSet(key, series);
      return series;
    })();

    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    return slice(await this.loadFull(symbol), range);
  }

  /** Full, unsliced history. Used when the engine needs pre-window context. */
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
    const qs = new URLSearchParams({
      q,
      quotesCount: '10',
      newsCount: '0',
      listsCount: '0',
    });
    try {
      const json = await fetchJson<{
        quotes?: Array<{
          symbol?: string;
          shortname?: string;
          longname?: string;
          quoteType?: string;
          exchDisp?: string;
        }>;
      }>(`${CHART_HOSTS[0]}/v1/finance/search?${qs}`, 8_000);
      return (json.quotes ?? [])
        .filter((r) => r.symbol)
        .map((r) => ({
          symbol: r.symbol as string,
          name: r.longname ?? r.shortname ?? (r.symbol as string),
          assetClass: classify(r.quoteType),
          currency: 'USD',
          exchange: r.exchDisp,
        }));
    } catch {
      return [];
    }
  }
}

/** Exposed for `tests/market-data.test.ts`, which checks the parsing contract. */
export const __testing = { parseChart };
