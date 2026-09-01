import { NextResponse } from 'next/server';
import { polygonConfigured, searchTickers } from '@/lib/market-data/polygon';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ticker autocomplete. Debounced by the client; the results cache upstream. */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = String(body.query ?? '').trim().slice(0, 40);
    if (!query) return NextResponse.json({ results: [] });
    if (!polygonConfigured()) {
      return NextResponse.json({
        results: [],
        note: 'Search needs a Polygon key. Set POLYGON_API_KEY to enable it.',
      });
    }
    return NextResponse.json({ results: await searchTickers(query) });
  } catch (error) {
    return errorResponse(error);
  }
}
