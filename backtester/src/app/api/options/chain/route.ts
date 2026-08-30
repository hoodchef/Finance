import { NextResponse } from 'next/server';
import {
  chainConfigured,
  ChainUnavailableError,
  fetchOptionChain,
} from '@/lib/options/chain';
import { getProvider } from '@/lib/market-data';
import { MarketDataError } from '@/lib/market-data/provider';
import { errorResponse } from '@/lib/api-errors';
import { todayIso } from '@/lib/market-data/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The option chain and the underlying price for one ticker.
 *
 * Two sources with different provenance, kept apart in the response: the spot
 * comes from the existing market-data chain that the rest of the application
 * already uses, and the chain comes from Alpaca. Neither is ever invented — a
 * failure on either side is reported as one, with the reason, rather than
 * filled in. A fabricated chain would make every downstream number precise,
 * confident and meaningless.
 */

/**
 * Chains are large and change slowly relative to a builder session. Two
 * minutes keeps the strikes and volatilities current for anyone working
 * through a structure without re-fetching a megabyte on every keystroke.
 */
const TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; payload: unknown }>();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const ticker = String(body.ticker ?? '').trim().toUpperCase().slice(0, 12);
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
      return NextResponse.json({ error: 'Enter a ticker.', kind: 'request' }, { status: 400 });
    }
    const expiry = typeof body.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expiry)
      ? body.expiry
      : undefined;

    const key = `${ticker}|${expiry ?? 'all'}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return NextResponse.json(hit.payload);
    }

    // The spot is the one figure the whole builder rests on, so it comes from
    // the provider chain the rest of the app is already verified against.
    let spot: number | null = null;
    let spotAsOf: string | null = null;
    let spotSource: string | null = null;
    let spotNote: string | null = null;
    try {
      const end = todayIso();
      const start = new Date(Date.parse(end) - 30 * 86_400_000).toISOString().slice(0, 10);
      const series = await getProvider().getHistoricalPrices(ticker, { start, end });
      const bar = series.bars.at(-1);
      if (bar) {
        spot = bar.close;
        spotAsOf = bar.date;
        spotSource = getProvider().label;
      }
    } catch (e) {
      spotNote =
        e instanceof MarketDataError
          ? `The underlying price could not be fetched: ${e.message}`
          : 'The underlying price could not be fetched.';
    }

    let chain = null;
    let chainNote: string | null = null;
    let needsConfiguration = false;
    try {
      chain = await fetchOptionChain(ticker, { expiry });
    } catch (e) {
      if (e instanceof ChainUnavailableError) {
        chainNote = e.message;
        needsConfiguration = e.needsConfiguration;
      } else if (e instanceof MarketDataError) {
        chainNote = e.message;
      } else {
        chainNote = 'The option chain could not be loaded.';
      }
    }

    const payload = {
      ticker,
      spot,
      spotAsOf,
      spotSource,
      spotNote,
      chain,
      chainNote,
      chainConfigured: chainConfigured(),
      needsConfiguration,
      provenance: {
        // Stated explicitly so nothing on the page is mistaken for live data.
        underlying: spotSource
          ? `${spotSource}, close of ${spotAsOf}`
          : 'Underlying price unavailable',
        chain: chain ? `${chain.source}, ${chain.latency}, fetched ${chain.fetchedAt}` : null,
        pricing:
          'Theoretical values are computed from Black–Scholes (European) or a Cox–Ross–Rubinstein ' +
          'binomial tree (American). They are model output, not quotes.',
      },
    };

    // Only a successful chain is worth caching; a failure should be retried.
    if (chain) cache.set(key, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
