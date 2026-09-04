import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  PolygonNotEntitledError,
  PolygonRateLimitError,
  __testing,
  clearPolygonCache,
  fetchAggregates,
  fetchDividends,
  fetchSplits,
  normalisePolygonTicker,
  polygonConfigured,
  searchTickers,
} from '../src/lib/market-data/polygon';
import { UnknownSymbolError } from '../src/lib/market-data/provider';
import { clearMemoryCache } from '../src/lib/market-data/cache';
import { PROVIDER_LICENCES } from '../src/lib/market-data/licence';
import { reconcileDividends } from '../src/lib/market-data/integrity';
import type { PriceSeries } from '../src/lib/types';

/**
 * The Polygon provider, exercised against a mocked transport.
 *
 * The live key is on the free Stocks Basic plan — about five requests a
 * minute — so a test suite that called the real API would spend the user's
 * whole quota and then fail on its own rate limit. Every behaviour that
 * matters is reachable through the transport, and the recorded payload shapes
 * below are copied verbatim from live responses captured on 2026-08-31.
 *
 * The one live check is at the bottom, behind VERIFY_POLYGON=1.
 */

const KEY = 'test-key-not-a-real-one';

interface Recorded {
  url: string;
  authorization: string | null;
}

let calls: Recorded[] = [];
let routes: Array<[RegExp, () => Response]> = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function route(pattern: RegExp, respond: () => Response): void {
  routes.push([pattern, respond]);
}

/** A daily aggregate row, stamped at midnight New York as Polygon does. */
function agg(date: string, close: number, volume = 1_000_000) {
  return {
    t: Date.parse(`${date}T04:00:00Z`),
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: volume,
    vw: close,
    n: 1000,
  };
}

beforeEach(() => {
  calls = [];
  routes = [];
  clearPolygonCache();
  clearMemoryCache();
  process.env.POLYGON_API_KEY = KEY;
  // An empty cache directory, so the disk tier cannot answer for the network
  // and a passing test cannot be a leftover from a previous run.
  process.env.MARKET_DATA_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-test-'));

  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, authorization: headers.get('authorization') });
    for (const [pattern, respond] of routes) {
      if (pattern.test(url)) return respond();
    }
    throw new Error(`No mock route for ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the key', () => {
  it('is read from the environment and sent as a bearer header', async () => {
    route(/\/v2\/aggs\//, () => json({ status: 'OK', results: [agg('2026-08-10', 100)] }));
    await fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31');

    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe(`Bearer ${KEY}`);
  });

  it('never appears in a URL', async () => {
    // A key in a query string leaks through logs, error messages and any
    // cached cursor. Header-only is the whole reason this is asserted.
    route(/\/v2\/aggs\//, () => json({ status: 'OK', results: [agg('2026-08-10', 100)] }));
    route(/\/reference\/tickers\?/, () => json({ status: 'OK', results: [] }));
    await fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31');
    await searchTickers('app');

    for (const call of calls) {
      expect(call.url).not.toContain(KEY);
      expect(call.url.toLowerCase()).not.toContain('apikey');
    }
  });

  it('reports itself unconfigured when the variable is empty', () => {
    process.env.POLYGON_API_KEY = '';
    expect(polygonConfigured()).toBe(false);
    process.env.POLYGON_API_KEY = KEY;
    expect(polygonConfigured()).toBe(true);
  });
});

describe('ticker handling', () => {
  it('accepts equities, crypto and option contracts', () => {
    expect(normalisePolygonTicker('aapl')).toBe('AAPL');
    expect(normalisePolygonTicker(' brk.b ')).toBe('BRK.B');
    expect(normalisePolygonTicker('X:BTCUSD')).toBe('X:BTCUSD');
    // 21 characters — longer than the 20 the equity validator allows, which is
    // why this module has its own.
    expect(normalisePolygonTicker('O:AAPL271217C00300000')).toBe('O:AAPL271217C00300000');
  });

  it('refuses an index before spending a request on the 403', () => {
    // Verified live: I:SPX returns 403 NOT_AUTHORIZED on this plan. Spending a
    // request to rediscover that costs a fifth of the minute's budget.
    try {
      normalisePolygonTicker('I:SPX');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PolygonNotEntitledError);
      expect((error as Error).message).toMatch(/not included on this plan/);
      expect((error as Error).message).toMatch(/SPY|VOO/);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed ticker', () => {
    expect(() => normalisePolygonTicker('')).toThrow();
    expect(() => normalisePolygonTicker('a b')).toThrow();
    expect(() => normalisePolygonTicker('A'.repeat(40))).toThrow();
  });
});

describe('silent window truncation', () => {
  it('reports when Polygon returns less history than was asked for', async () => {
    // The live behaviour this guards, captured on 2026-08-31: a request for
    // 2016-01-01 to 2026-08-28 returned HTTP 200, status "OK", and 499 bars
    // beginning 2024-09-03. No error, no warning field, and queryCount equal
    // to resultsCount as though it had been served in full.
    route(/\/v2\/aggs\//, () =>
      json({
        ticker: 'AAPL',
        queryCount: 2,
        resultsCount: 2,
        adjusted: true,
        status: 'OK',
        results: [agg('2024-09-03', 220), agg('2024-09-04', 221)],
      }),
    );

    const result = await fetchAggregates('AAPL', 'day', '2016-01-01', '2026-08-28');
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.requestedFrom).toBe('2016-01-01');
    expect(result.coverage.coveredFrom).toBe('2024-09-03');
    expect(result.coverage.note).toContain('2024-09-03');
    expect(result.coverage.note).toContain('2016-01-01');
  });

  it('does not cry truncation over a holiday or a weekend at the start', async () => {
    route(/\/v2\/aggs\//, () =>
      json({ status: 'OK', results: [agg('2026-08-03', 100), agg('2026-08-04', 101)] }),
    );
    // Asked from Saturday the first; the first session is Monday the third.
    const result = await fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31');
    expect(result.coverage.truncated).toBe(false);
    expect(result.coverage.note).toBeNull();
  });

  it('measures the shortfall in whole days', () => {
    expect(__testing.daysApart('2016-01-01', '2024-09-03')).toBe(3168);
    expect(__testing.daysApart('2026-08-01', '2026-08-03')).toBe(2);
    expect(__testing.TRUNCATION_TOLERANCE_DAYS).toBe(5);
  });
});

describe('rate limiting', () => {
  it('turns a 429 into a typed error naming the plan and the wait', async () => {
    route(/\/v2\/aggs\//, () => json({ error: 'too many' }, 429, { 'Retry-After': '30' }));

    await expect(fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31')).rejects.toThrow(
      PolygonRateLimitError,
    );
  });

  it('does not retry into the limit, and fails fast while it is cooling down', async () => {
    // Retrying a 429 is how a quota that would have recovered in seconds stays
    // exhausted. The second call must cost no request at all.
    route(/\/v2\/aggs\//, () => json({ error: 'too many' }, 429, { 'Retry-After': '30' }));

    await expect(fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31')).rejects.toThrow(
      PolygonRateLimitError,
    );
    const afterFirst = calls.length;
    expect(afterFirst).toBe(1);

    await expect(fetchAggregates('MSFT', 'day', '2026-08-01', '2026-08-31')).rejects.toThrow(
      PolygonRateLimitError,
    );
    expect(calls).toHaveLength(afterFirst);
  });

  it('says how many requests were spent in the last minute', async () => {
    route(/\/v2\/aggs\//, () => json({ error: 'too many' }, 429));
    try {
      await fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/five requests a minute/);
      expect((error as Error).message).toMatch(/none has been guessed at/);
    }
  });

  it('surfaces a 403 as a plan entitlement problem, not a failure', async () => {
    route(/\/v2\/aggs\//, () =>
      json({ status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data.' }, 403),
    );
    await expect(fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31')).rejects.toThrow(
      PolygonNotEntitledError,
    );
  });
});

describe('request coalescing', () => {
  it('collapses concurrent identical fetches into one request', async () => {
    // Four views of the same symbol on a five-a-minute budget is the
    // difference between a page that loads and one that rate-limits.
    route(/\/v2\/aggs\//, () => json({ status: 'OK', results: [agg('2026-08-10', 100)] }));

    const results = await Promise.all([
      fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31'),
      fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31'),
      fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31'),
    ]);
    expect(calls).toHaveLength(1);
    expect(results.map((r) => r.bars.length)).toEqual([1, 1, 1]);
  });

  it('serves a repeat from cache without a second request', async () => {
    route(/\/v2\/aggs\//, () => json({ status: 'OK', results: [agg('2026-08-10', 100)] }));
    await fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31');
    await fetchAggregates('AAPL', 'day', '2026-08-01', '2026-08-31');
    expect(calls).toHaveLength(1);
  });
});

describe('the licence registry', () => {
  it('records Polygon with its real commercial status', () => {
    // tests/routes.test.ts fails if a vendor hostname appears in the code
    // without an entry here, and the entry is what makes the constraint
    // visible in the application rather than only in someone's memory.
    const licence = PROVIDER_LICENCES.polygon;
    expect(licence).toBeDefined();
    expect(licence.commercial).toBe('personal-only');
    expect(licence.label).toBe('Polygon.io');
    expect(licence.freeTier).toMatch(/5 requests\/minute/);
    // The silent truncation is the fact most likely to be forgotten.
    expect(licence.freeTier).toMatch(/SILENTLY/);
  });

  it('leaves every other registry entry untouched', () => {
    for (const id of ['yahoo', 'tiingo', 'alphavantage', 'alpaca', 'demo']) {
      expect(PROVIDER_LICENCES[id]).toBeDefined();
    }
  });
});

/**
 * One live call, off by default.
 *
 * The plan allows about five requests a minute, so running this as part of the
 * ordinary suite would exhaust the quota and then fail on its own rate limit.
 *
 *   VERIFY_POLYGON=1 npx vitest run tests/polygon.test.ts
 */
const live = process.env.VERIFY_POLYGON === '1' && Boolean(process.env.POLYGON_API_KEY);

describe.runIf(live)('live API', () => {
  it('returns real daily bars for AAPL', async () => {
    vi.unstubAllGlobals();
    clearPolygonCache();
    const result = await fetchAggregates('AAPL', 'day', '2026-08-10', '2026-08-20');
    expect(result.bars.length).toBeGreaterThan(5);
    // Raw vendor aggregates: c/h/l/t, normalised later by `charting/bars`.
    for (const bar of result.bars) {
      expect(bar.c).toBeGreaterThan(0);
      expect(bar.h).toBeGreaterThanOrEqual(bar.l as number);
      expect(typeof bar.t).toBe('number');
    }
    expect(result.coverage.truncated).toBe(false);
  }, 30_000);
});
