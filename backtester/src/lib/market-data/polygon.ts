import { MarketDataError, UnknownSymbolError } from './provider';
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

export class RateLimitedError extends MarketDataError {
  constructor(symbol?: string) {
    super(
      'Polygon’s rate limit was reached — the free tier allows about five requests a minute. ' +
        'Wait a moment and try again.',
      symbol,
    );
    this.name = 'RateLimitedError';
  }
}

export class PolygonNotConfiguredError extends MarketDataError {
  constructor() {
    super('No Polygon API key is configured. Set POLYGON_API_KEY to enable market data.');
    this.name = 'PolygonNotConfiguredError';
  }
}

export function polygonConfigured(): boolean {
  return Boolean(process.env.POLYGON_API_KEY?.trim());
}

const cache = new Map<string, { at: number; body: unknown }>();
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

  const run = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25_000);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (res.status === 429) throw new RateLimitedError();
      if (res.status === 401 || res.status === 403) {
        throw new MarketDataError(
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

export async function fetchAggregates(
  ticker: string,
  multiplier: number,
  timespan: string,
  from: string,
  to: string,
): Promise<PolygonAggregate[]> {
  const body = await get<AggsResponse>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${from}/${to}`,
    { adjusted: 'true', sort: 'asc', limit: '50000' },
  );
  // An empty result is a real answer — no qualifying trades in the window —
  // not a failure, so it is returned as an empty list rather than thrown.
  return body.results ?? [];
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
