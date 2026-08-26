import { NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtest';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio } from '@/lib/validate';

export const runtime = 'nodejs';
/** Backtests are computed per request; nothing here is safe to cache at the edge. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);
    const provider = getProvider();

    const result = await runBacktest({
      portfolio,
      config,
      provider,
      includeAssetAnalysis: body.includeAssetAnalysis !== false,
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
