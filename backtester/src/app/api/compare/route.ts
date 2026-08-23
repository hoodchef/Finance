import { NextResponse } from 'next/server';
import { runBacktest, type BacktestResult } from '@/lib/backtest';
import { getProvider } from '@/lib/market-data';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PORTFOLIOS = 6;

/**
 * Runs several portfolios over one shared configuration. They run sequentially
 * so the price cache is warm for every run after the first, which makes the
 * whole comparison roughly as expensive as its slowest single backtest.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!Array.isArray(body.portfolios) || body.portfolios.length === 0) {
      throw new ValidationError('Select at least one portfolio to compare.', 'portfolios');
    }
    if (body.portfolios.length > MAX_PORTFOLIOS) {
      throw new ValidationError(
        `Compare at most ${MAX_PORTFOLIOS} portfolios at once.`,
        'portfolios',
      );
    }

    const config = parseConfig(body.config);
    const provider = getProvider(body.provider);
    const results: BacktestResult[] = [];

    for (const raw of body.portfolios) {
      results.push(
        await runBacktest({
          portfolio: parsePortfolio(raw),
          config,
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
