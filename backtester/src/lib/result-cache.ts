import type { BacktestResult, RunBacktestOptions } from '@/lib/backtest';

/**
 * Memoises a computed backtest across surfaces.
 * =============================================================================
 * The Backtest page, Studies, the Simulator and the Lab all need the same
 * thing: this portfolio, over this window, run through the engine. Each was
 * computing it independently, so moving between them cost twenty seconds a
 * time and the product felt like four tools rather than one.
 *
 * The key is the whole question — every holding, every setting, and the
 * provider that answered — so a cached result can only be returned to a
 * request that would have produced it. Change a weight, a date, a fee or the
 * provider and it is a different key.
 *
 * WHAT THIS DOES NOT CACHE: market data. That has its own layer with its own
 * expiry, deliberately, because a warm price cache is a performance detail and
 * a stale one is a wrong answer. This sits above that and holds only the
 * arithmetic.
 */

interface Entry {
  result: BacktestResult;
  expiresAt: number;
}

/**
 * Short by design. Long enough that clicking through four surfaces is
 * instant, short enough that a result never outlives the session it belongs
 * to or the market data underneath it.
 */
const TTL_MS = 5 * 60 * 1000;
/** Results are large; a handful is all that is ever wanted at once. */
const MAX_ENTRIES = 12;

const cache = new Map<string, Entry>();

/** Stable JSON: key order must not change the key. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

export function resultKey(options: {
  portfolio: RunBacktestOptions['portfolio'];
  config: RunBacktestOptions['config'];
  providerId: string;
  includeAssetAnalysis: boolean;
}): string {
  return stable({
    // Only the fields that change the answer. A rename does not.
    positions: options.portfolio.positions.map((p) => ({
      symbol: p.symbol.trim().toUpperCase(),
      weight: Number(p.weight) || 0,
      expenseRatio: p.expenseRatio ?? null,
    })),
    config: options.config,
    provider: options.providerId,
    assets: options.includeAssetAnalysis,
  });
}

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  // Map preserves insertion order, so the oldest keys are first.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Returns the cached result for this exact question, or computes and stores it.
 *
 * Concurrent callers share one computation rather than starting several: the
 * Studies page fires four analyses at once, and without this they would each
 * run the engine on the same inputs.
 */
const inFlight = new Map<string, Promise<BacktestResult>>();

export async function cachedResult(
  key: string,
  compute: () => Promise<BacktestResult>,
): Promise<{ result: BacktestResult; cached: boolean }> {
  sweep();
  const hit = cache.get(key);
  if (hit) return { result: hit.result, cached: true };

  const existing = inFlight.get(key);
  if (existing) return { result: await existing, cached: true };

  const promise = compute();
  inFlight.set(key, promise);
  try {
    const result = await promise;
    cache.set(key, { result, expiresAt: Date.now() + TTL_MS });
    sweep();
    return { result, cached: false };
  } finally {
    inFlight.delete(key);
  }
}

export function resultCacheStats(): { entries: number; inFlight: number } {
  sweep();
  return { entries: cache.size, inFlight: inFlight.size };
}

/** Test seam. */
export function __resetResultCache(): void {
  cache.clear();
  inFlight.clear();
}
