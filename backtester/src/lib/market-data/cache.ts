import fs from 'node:fs/promises';
import path from 'node:path';
import type { PriceSeries } from '@/lib/types';

/**
 * Two-tier cache for downloaded price history.
 *
 * Tier 1 is a process-local map, so a single backtest that touches SPY five
 * times issues one network request. Tier 2 is a JSON file per symbol, so a dev
 * server restart or a second backtest minutes later costs nothing.
 *
 * Cached series are stored as full history (`FULL_START` → today) and sliced to
 * the requested range on read, so widening a date range is also a cache hit.
 */

const memory = new Map<string, { series: PriceSeries; expiresAt: number }>();

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h — daily bars settle overnight.

function cacheDir(): string {
  const configured = process.env.MARKET_DATA_CACHE_DIR ?? '.cache/market-data';
  return path.isAbsolute(configured)
    ? configured
    : path.join(process.cwd(), configured);
}

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function memoryGet(key: string): PriceSeries | undefined {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return hit.series;
}

export function memorySet(key: string, series: PriceSeries, ttlMs = DEFAULT_TTL_MS): void {
  memory.set(key, { series, expiresAt: Date.now() + ttlMs });
}

export async function diskGet(key: string): Promise<PriceSeries | undefined> {
  const hit = await diskGetEntry(key);
  return hit && !hit.expired ? hit.series : undefined;
}

/**
 * Reads the cache including EXPIRED entries, reporting which it found.
 *
 * Expired data is not useless data. When the upstream provider is unreachable,
 * yesterday's real prices are far more useful than an error — and infinitely
 * more useful than generated ones. The caller decides whether to accept it, and
 * the staleness is surfaced to the user rather than hidden.
 */
export async function diskGetEntry(
  key: string,
): Promise<{ series: PriceSeries; expired: boolean; cachedAt: number } | undefined> {
  try {
    const file = path.join(cacheDir(), `${safeName(key)}.json`);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { expiresAt: number; series: PriceSeries };
    if (!parsed?.series?.bars?.length) return undefined;
    return {
      series: parsed.series,
      expired: parsed.expiresAt < Date.now(),
      cachedAt: parsed.expiresAt,
    };
  } catch {
    return undefined;
  }
}

export async function diskSet(
  key: string,
  series: PriceSeries,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    const dir = cacheDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeName(key)}.json`);
    const body = JSON.stringify({ expiresAt: Date.now() + ttlMs, series });
    await fs.writeFile(file, body, 'utf8');
  } catch {
    // A cache write failure must never fail a backtest.
  }
}

export function clearMemoryCache(): void {
  memory.clear();
}
