import { NextResponse } from 'next/server';
import { runBacktest, type BacktestResult } from '@/lib/backtest';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ENTRIES = 6;

/**
 * Replays several backtests for side-by-side comparison.
 *
 * Each entry carries its OWN configuration rather than sharing one, because a
 * comparison is between saved runs — and a saved run is defined by the config
 * it executed under. Forcing them onto a single shared config would silently
 * re-run each one under settings it never used, which is precisely the class of
 * quiet mismatch immutable snapshots exist to prevent.
 *
 * Where that makes the entries non-comparable — different date ranges, different
 * starting capital — the client surfaces it; the server does not silently
 * reconcile them.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const rawEntries = Array.isArray(body.entries)
      ? body.entries
      : // Older shape: one shared config across N portfolios.
        Array.isArray(body.portfolios)
        ? body.portfolios.map((p: unknown) => ({ portfolio: p, config: body.config }))
        : null;

    if (!rawEntries || rawEntries.length === 0) {
      throw new ValidationError('Select at least one run to compare.', 'entries');
    }
    if (rawEntries.length > MAX_ENTRIES) {
      throw new ValidationError(`Compare at most ${MAX_ENTRIES} runs at once.`, 'entries');
    }

    const provider = getProvider();
    const results: BacktestResult[] = [];

    // Sequential on purpose: the price cache is warm for every run after the
    // first, so the whole comparison costs about as much as its slowest single
    // backtest, and the data provider is not hit concurrently.
    for (const entry of rawEntries) {
      results.push(
        await runBacktest({
          portfolio: parsePortfolio(entry.portfolio),
          config: parseConfig(entry.config),
          provider,
          includeAssetAnalysis: false,
        }),
      );
    }

    return NextResponse.json({ results });
  } catch (error) {
    return errorResponse(error);
  }
}
