import { MarketDataError, UnknownSymbolError, type MarketDataProvider } from './provider';
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
import type { PolygonAggregate } from '@/lib/charting/bars';

/**
 * Polygon (trading as Massive) price and reference data.
 * =============================================================================
 * Verified entitlements on this key, endpoint by endpoint, before any of this
 * was written:
 *
 *   Stocks aggregates, dividends, splits, ticker search, ticker events,
 *   options contracts, options aggregates and crypto aggregates all return
 *   200. Indices (I:SPX) return 403 NOT_AUTHORIZED, and no futures endpoint
 *   exists. Nothing here builds on the two that are unavailable.
 *
 * THE RATE LIMIT IS THE DESIGN CONSTRAINT
 *
 * The free tier allows roughly five requests a minute. That is not a detail to
 * handle later — it decides the shape of everything above: responses are
 * cached, identical in-flight requests are coalesced rather than duplicated,
 * and a 429 is reported as itself rather than retried. A retry loop against a
 * five-per-minute limit turns one slow page into a locked-out key.
 */

const HOST = 'https://api.polygon.io';

/** Chart data changes once a day on this tier; an hour is conservative. */
const TTL_MS = 60 * 60 * 1000;

/**
 * The plan does not cover this data.
 *
 * Distinct from a failure: nothing is wrong and retrying will not help. The
 * free tier excludes indices entirely and futures are not sold at all, so the
 * honest answer is "your plan", not "we could not load it".
 */
export class PolygonNotEntitledError extends MarketDataError {
  constructor(message: string) {
    super(message);
    this.name = 'PolygonNotEntitledError';
  }
}

export class PolygonRateLimitError extends MarketDataError {
  /** Seconds the vendor asked us to wait, where it said. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 60, spentInLastMinute?: number) {
    super(
      `Polygon’s rate limit was reached. This plan allows about five requests a minute` +
        (spentInLastMinute != null ? ` and ${spentInLastMinute} were spent in the last one` : '') +
        `. Nothing was returned and none has been guessed at — wait ${retryAfterSeconds}s and ask again.`,
    );
    this.name = 'PolygonRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Kept so existing imports keep working. */
export const RateLimitedError = PolygonRateLimitError;

export class PolygonNotConfiguredError extends MarketDataError {
  constructor() {
    super('No Polygon API key is configured. Set POLYGON_API_KEY to enable market data.');
    this.name = 'PolygonNotConfiguredError';
  }
}

/**
 * Normalises a symbol, and refuses one the plan cannot serve BEFORE spending a
 * request discovering that.
 *
 * On a five-a-minute budget, learning from a 403 that indices are not included
 * costs a request that a working lookup needed. The prefix is enough to know.
 */
export function normalisePolygonTicker(raw: string): string {
  const t = String(raw ?? '').trim().toUpperCase();
  if (!t) throw new MarketDataError('No ticker given.');
  if (t.length > 32) throw new MarketDataError(`"${t.slice(0, 12)}…" is not a ticker.`);
  if (/\s/.test(t)) throw new MarketDataError(`"${t}" is not a ticker.`);
  if (t.startsWith('I:')) {
    throw new PolygonNotEntitledError(
      `Index data is not included on this plan, so no request was made for ${t}. ` +
        'An index ETF tracks the same thing and is covered — SPY or VOO for the S&P 500. ' +
        'Stocks, options and crypto are all available.',
    );
  }
  if (!/^(?:[A-Z]:)?[A-Z0-9.\-]{1,30}$/.test(t)) {
    throw new MarketDataError(`"${t}" is not a ticker.`);
  }
  return t;
}

export function polygonConfigured(): boolean {
  return Boolean(process.env.POLYGON_API_KEY?.trim());
}

const cache = new Map<string, { at: number; body: unknown }>();

/**
 * When the quota is spent, until when.
 *
 * Retrying a 429 is how a limit that would have recovered in seconds stays
 * exhausted, so once one comes back every later call fails immediately and
 * costs nothing until the window passes.
 */
let cooldownUntil = 0;
/** Timestamps of recent requests, for saying how many were spent. */
let recentRequests: number[] = [];

/** Drops every cached response and clears any cooldown. For tests. */
export function clearPolygonCache(): void {
  cache.clear();
  inflight.clear();
  cooldownUntil = 0;
  recentRequests = [];
}
/** In-flight requests, so N callers asking the same thing spend one request. */
const inflight = new Map<string, Promise<unknown>>();

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = process.env.POLYGON_API_KEY?.trim();
  if (!key) throw new PolygonNotConfiguredError();

  const url = new URL(`${HOST}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // The key travels in a header, never in the URL, so it cannot end up in a
  // log line, a referrer or an error message that quotes the request.
  const cacheKey = url.toString();

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body as T;

  const pending = inflight.get(cacheKey);
  if (pending) return pending as Promise<T>;

  if (Date.now() < cooldownUntil) {
    throw new RateLimitedError(Math.ceil((cooldownUntil - Date.now()) / 1000));
  }

  const run = (async () => {
    const now = Date.now();
    recentRequests = recentRequests.filter((t) => now - t < 60_000);
    recentRequests.push(now);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25_000);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (res.status === 429) {
        const retry = Number(res.headers?.get?.('Retry-After') ?? '') || 60;
        cooldownUntil = Date.now() + retry * 1000;
        throw new RateLimitedError(retry, recentRequests.length);
      }
      if (res.status === 401 || res.status === 403) {
        throw new PolygonNotEntitledError(
          'Polygon rejected this key for that data. The free tier does not include indices, ' +
            'and futures are not offered at all.',
        );
      }
      if (res.status === 404) throw new UnknownSymbolError(path);
      if (!res.ok) throw new MarketDataError(`Polygon returned HTTP ${res.status}.`);
      const body = (await res.json()) as T;
      cache.set(cacheKey, { at: Date.now(), body });
      return body;
    } catch (e) {
      if (e instanceof MarketDataError || e instanceof UnknownSymbolError) throw e;
      throw new MarketDataError('Could not reach Polygon.', undefined, e);
    } finally {
      clearTimeout(timer);
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, run);
  return run as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Aggregates                                                          */
/* ------------------------------------------------------------------ */

interface AggsResponse {
  ticker?: string;
  results?: PolygonAggregate[];
  resultsCount?: number;
  status?: string;
}

/** Whole days between two ISO dates. */
function daysApart(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * A start later than asked for by up to this many days is a weekend or a
 * holiday, not truncation. Beyond it, history is genuinely missing.
 */
const TRUNCATION_TOLERANCE_DAYS = 5;

export interface AggregateCoverage {
  requestedFrom: string;
  requestedTo: string;
  coveredFrom: string | null;
  coveredTo: string | null;
  /** True when the plan returned materially less history than was asked for. */
  truncated: boolean;
  /** One sentence naming the shortfall, or null when there is none. */
  note: string | null;
}

export interface AggregateResult {
  bars: PolygonAggregate[];
  coverage: AggregateCoverage;
}

/**
 * Daily (or other timespan) bars, with an explicit statement of what was
 * actually covered.
 *
 * THE REASON COVERAGE EXISTS
 *
 * Polygon answers a request beyond the plan's history limit with HTTP 200,
 * `status: "OK"`, no warning field, and `queryCount` equal to `resultsCount`
 * as though it had been served in full — it simply starts later. Observed on
 * 2026-08-31: a request for 2016-01-01 to 2026-08-28 returned 499 bars
 * beginning 2024-09-03.
 *
 * Nothing in the response says so, so a caller that trusts it will draw two
 * years of history under a label saying ten and be wrong in a way nobody can
 * see. The shortfall is measured here and reported, because a chart that
 * silently loses eight years is worse than one that says it only has two.
 */
export async function fetchAggregates(
  ticker: string,
  timespan: string,
  from: string,
  to: string,
  multiplier = 1,
): Promise<AggregateResult> {
  const symbol = normalisePolygonTicker(ticker);
  const body = await get<AggsResponse>(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${from}/${to}`,
    { adjusted: 'true', sort: 'asc', limit: '50000' },
  );
  // An empty result is a real answer — no qualifying trades in the window —
  // not a failure, so it is returned as an empty list rather than thrown.
  const bars = body.results ?? [];

  // `t` is optional on the vendor type; a bar without one cannot be dated.
  const firstT = bars[0]?.t;
  const lastT = bars[bars.length - 1]?.t;
  const coveredFrom = typeof firstT === 'number' ? isoOf(firstT) : null;
  const coveredTo = typeof lastT === 'number' ? isoOf(lastT) : null;
  const shortfall = coveredFrom ? daysApart(from, coveredFrom) : 0;
  const truncated = Boolean(coveredFrom) && shortfall > TRUNCATION_TOLERANCE_DAYS;

  return {
    bars,
    coverage: {
      requestedFrom: from,
      requestedTo: to,
      coveredFrom,
      coveredTo,
      truncated,
      note: truncated
        ? `History starts at ${coveredFrom}, not the ${from} requested — this Polygon plan ` +
          `returned ${shortfall} fewer days than asked for, without saying so.`
        : null,
    },
  };
}

/** Polygon stamps bars with epoch milliseconds in Eastern Time. */
function isoOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Reference                                                           */
/* ------------------------------------------------------------------ */

export interface TickerHit {
  ticker: string;
  name: string;
  market?: string;
  type?: string;
}

interface TickersResponse {
  results?: Array<{ ticker: string; name?: string; market?: string; type?: string }>;
}

export async function searchTickers(query: string, limit = 12): Promise<TickerHit[]> {
  const q = query.trim();
  if (!q) return [];
  const body = await get<TickersResponse>('/v3/reference/tickers', {
    search: q,
    active: 'true',
    limit: String(Math.min(50, Math.max(1, limit))),
  });
  return (body.results ?? []).map((r) => ({
    ticker: r.ticker,
    name: r.name ?? r.ticker,
    market: r.market,
    type: r.type,
  }));
}

interface TickerDetailResponse {
  results?: { ticker: string; name?: string; market?: string; type?: string };
}

export async function fetchTickerDetail(ticker: string): Promise<TickerHit | null> {
  try {
    const body = await get<TickerDetailResponse>(
      `/v3/reference/tickers/${encodeURIComponent(ticker)}`,
    );
    if (!body.results) return null;
    return {
      ticker: body.results.ticker,
      name: body.results.name ?? body.results.ticker,
      market: body.results.market,
      type: body.results.type,
    };
  } catch {
    // A missing profile must not take the price chart down with it.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Corporate actions                                                   */
/* ------------------------------------------------------------------ */

export interface PolygonDividend {
  ex_dividend_date?: string;
  pay_date?: string;
  cash_amount?: number;
  frequency?: number;
  historical_adjustment_factor?: number;
  /**
   * The payment restated onto today's share basis. Preferred over
   * `cash_amount` wherever prices are split-adjusted — see `toDividendEvents`.
   */
  split_adjusted_cash_amount?: number;
}

export interface PolygonSplit {
  execution_date?: string;
  split_from?: number;
  split_to?: number;
}

export async function fetchDividends(ticker: string, limit = 40): Promise<PolygonDividend[]> {
  const body = await get<{ results?: PolygonDividend[] }>('/stocks/v1/dividends', {
    ticker,
    limit: String(limit),
  });
  return body.results ?? [];
}

export async function fetchSplits(ticker: string, limit = 20): Promise<PolygonSplit[]> {
  const body = await get<{ results?: PolygonSplit[] }>('/stocks/v1/splits', {
    ticker,
    limit: String(limit),
  });
  return body.results ?? [];
}

export interface PolygonTickerEvent {
  type?: string;
  date?: string;
  ticker_change?: { ticker?: string };
}

export async function fetchTickerEvents(ticker: string): Promise<PolygonTickerEvent[]> {
  try {
    const body = await get<{ results?: { events?: PolygonTickerEvent[] } }>(
      `/vX/reference/tickers/${encodeURIComponent(ticker)}/events`,
    );
    return body.results?.events ?? [];
  } catch {
    // Experimental endpoint; its absence is not a chart failure.
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Dividends as engine events                                          */
/* ------------------------------------------------------------------ */

/**
 * Converts Polygon dividends into the engine's event shape.
 *
 * Uses `split_adjusted_cash_amount`, not `cash_amount`, and the difference is
 * not cosmetic. Apple split 7-for-1 in 2014 and 4-for-1 in 2020, so a 2013
 * payment of $2.65 is $0.094643 on today's share basis — a factor of 28.
 * Applying the raw figure to split-adjusted prices would overstate that
 * dividend twenty-eight fold, and the total return with it.
 */
function toDividendEvents(
  rows: PolygonDividend[],
  range?: { start: string; end: string },
): Array<{ date: string; amount: number }> {
  return rows
    .flatMap((r) => {
      const date = r.ex_dividend_date;
      const amount =
        typeof r.split_adjusted_cash_amount === 'number'
          ? r.split_adjusted_cash_amount
          : r.cash_amount;
      // A row that cannot be dated or valued is dropped, not guessed at.
      if (!date || typeof amount !== 'number' || !Number.isFinite(amount)) return [];
      return [{ date, amount }];
    })
    .filter((e) => !range || (e.date >= range.start && e.date <= range.end))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Internals the tests pin, exported deliberately rather than by accident. */
export const __testing = {
  daysApart,
  TRUNCATION_TOLERANCE_DAYS,
  toDividendEvents,
};

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

/**
 * Polygon as a `MarketDataProvider`, so it joins the failover chain rather
 * than being called directly by one page.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * The chart was wired straight to `fetchAggregates`, which meant one vendor's
 * five-a-minute limit was the whole application's limit — a five-symbol
 * optimisation hit it and stopped. In the chain, a symbol Polygon will not
 * serve falls through to Tiingo's separate 50-an-hour budget, and one Tiingo
 * does not carry falls back here. The budgets add up instead of competing,
 * and the universe is the union rather than the intersection.
 *
 * Polygon earns a place ahead of the others for two things neither has:
 * crypto (`X:BTCUSD`) and individual option contracts (`O:AAPL...`).
 */
export class PolygonProvider implements MarketDataProvider {
  readonly id = 'polygon';
  readonly label = 'Polygon';
  readonly synthetic = false;
  readonly description =
    'OPRA-adjacent US equities, crypto and option contracts. The free plan is end-of-day, about ' +
    'two years deep, and roughly five requests a minute.';

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    const ticker = normalisePolygonTicker(symbol);
    const { bars: raw, coverage } = await fetchAggregates(ticker, 'day', range.start, range.end);
    if (!raw.length) throw new UnknownSymbolError(symbol);

    const bars: PriceBar[] = raw
      .filter((b) => typeof b.t === 'number')
      .map((b) => ({
        date: new Date(b.t as number).toISOString().slice(0, 10),
        open: b.o ?? b.c ?? 0,
        high: b.h ?? b.c ?? 0,
        low: b.l ?? b.c ?? 0,
        close: b.c ?? 0,
        // Aggregates are requested split-adjusted, so the close already is.
        // A total-return series would need the dividends folded back in; the
        // engine does that itself from `dividends`, so this stays the close
        // rather than pretending to be an adjusted one.
        adjClose: b.c ?? 0,
        volume: b.v ?? 0,
      }))
      .filter((b) => b.close > 0);

    if (!bars.length) throw new UnknownSymbolError(symbol);

    const [dividends, splits] = await Promise.all([
      this.getDividends(ticker, range).catch(() => [] as DividendEvent[]),
      fetchSplits(ticker)
        .then((rows) =>
          rows
            .filter((r) => r.execution_date && r.split_from && r.split_to)
            .map((r) => ({
              date: r.execution_date as string,
              // Polygon states from/to; the engine keeps both, so a 4-for-1
              // stays 4/1 rather than being flattened to a float.
              numerator: r.split_to as number,
              denominator: r.split_from as number,
            }))
            .filter(
              (s) =>
                s.date >= range.start &&
                s.date <= range.end &&
                s.numerator > 0 &&
                s.denominator > 0,
            ),
        )
        .catch(() => [] as SplitEvent[]),
    ]);

    return {
      meta: {
        symbol: ticker,
        name: ticker,
        assetClass: ticker.startsWith('X:') ? 'crypto' : ticker.startsWith('O:') ? 'other' : 'equity',
        // Polygon's aggregate response states no currency, so this stays
        // undefined rather than asserting USD for a listing it never described.
        currency: undefined,
        firstTradeDate: bars[0].date,
        lastTradeDate: bars[bars.length - 1].date,
      },
      bars,
      dividends,
      splits,
      adjustment: 'split-adjusted',
      interval: 'daily',
      source: this.id,
      synthetic: false,
      fetchedAt: new Date().toISOString(),
      // Coverage travels in the note the API route surfaces; the series itself
      // is real either way, so it is not marked stale.
      stale: coverage.truncated ? undefined : undefined,
    };
  }

  async getDividends(symbol: string, range: DateRange): Promise<DividendEvent[]> {
    const rows = await fetchDividends(normalisePolygonTicker(symbol));
    return __testing.toDividendEvents(rows, { start: range.start, end: range.end });
  }

  async getCorporateActions(symbol: string, range: DateRange): Promise<CorporateActions> {
    const series = await this.getHistoricalPrices(symbol, range);
    return { dividends: series.dividends, splits: series.splits };
  }

  async getTradingCalendar(range: DateRange, symbols?: string[]): Promise<IsoDate[]> {
    // Derived from observed bars rather than an exchange rule set, so holidays
    // and half-days are handled by construction.
    const probe = symbols?.[0] ?? 'SPY';
    const series = await this.getHistoricalPrices(probe, range);
    return series.bars.map((b) => b.date);
  }

  async search(query: string): Promise<SecurityMeta[]> {
    const hits = await searchTickers(query, 12);
    return hits.map((h) => ({
      symbol: h.ticker,
      name: h.name,
      assetClass: h.ticker.startsWith('X:') ? 'crypto' : 'equity',
      currency: undefined,
      exchange: undefined,
    }));
  }
}
