import { NextResponse } from 'next/server';
import { getProvider } from '@/lib/market-data';
import { searchCatalog } from '@/lib/market-data/catalog';
import { searchUniverse, toSecurityMeta, universeInfo } from '@/lib/market-data/universe';
import type { SecurityMeta } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Ticker search.
 *
 * Three tiers, in order of both speed and trustworthiness:
 *
 *  1. The curated catalogue — a few dozen widely-used funds, so the common case
 *     lands first rather than behind an alphabetical accident.
 *  2. The local universe — 13,000+ US listings from the exchanges' own
 *     directory. In memory, so it answers instantly and, crucially, keeps
 *     working while the price provider is rate-limited.
 *  3. The provider's own search — reaches listings outside the US directory,
 *     such as Toronto tickers, and is allowed to fail without breaking search.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Bounded before it reaches a provider: an unbounded query becomes an
  // unbounded outbound URL, and nothing useful is longer than this.
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 64);

  // `?info=1` reports the universe's provenance and size for the UI.
  if (url.searchParams.get('info')) {
    return NextResponse.json({ universe: universeInfo() });
  }

  if (query.length < 1) return NextResponse.json({ results: [] });

  const curated: SecurityMeta[] = searchCatalog(query).map((e) => ({
    symbol: e.symbol,
    name: e.name,
    assetClass: e.assetClass,
    currency: 'USD',
  }));

  const local = searchUniverse(query, 24).map(toSecurityMeta);

  let remote: SecurityMeta[] = [];
  // Only reach out when the local index is thin — this is the common path for
  // non-US tickers, and skipping it otherwise avoids burning provider quota on
  // queries already answered locally.
  if (local.length < 8) {
    try {
      remote = await getProvider().search(query);
    } catch {
      // Search degrades to local results rather than failing.
    }
  }

  const seen = new Set<string>();
  const results: SecurityMeta[] = [];
  for (const item of [...curated, ...local, ...remote]) {
    const key = item.symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
    if (results.length >= 20) break;
  }

  return NextResponse.json({ results });
}
