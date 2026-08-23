import { NextResponse } from 'next/server';
import { getProvider } from '@/lib/market-data';
import { searchCatalog } from '@/lib/market-data/catalog';
import type { SecurityMeta } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Ticker autocomplete. The offline catalogue answers instantly and the provider
 * fills in everything else; results are merged so a known symbol never
 * disappears just because the remote search is slow or throttled.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (query.length < 1) return NextResponse.json({ results: [] });

  const local: SecurityMeta[] = searchCatalog(query).map((e) => ({
    symbol: e.symbol,
    name: e.name,
    assetClass: e.assetClass,
    currency: 'USD',
    exchange: undefined,
  }));

  let remote: SecurityMeta[] = [];
  try {
    remote = await getProvider().search(query);
  } catch {
    // A failed lookup degrades to catalogue-only rather than to an error.
  }

  const seen = new Set<string>();
  const results: SecurityMeta[] = [];
  for (const item of [...local, ...remote]) {
    const key = item.symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
    if (results.length >= 12) break;
  }

  return NextResponse.json({ results });
}
