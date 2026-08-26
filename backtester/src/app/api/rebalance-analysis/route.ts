import { NextResponse } from 'next/server';
import { runRebalanceAnalysis } from '@/lib/backtest';
import { getProvider } from '@/lib/market-data';
import { parseConfig, parsePortfolio } from '@/lib/validate';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const analysis = await runRebalanceAnalysis({
      portfolio: parsePortfolio(body.portfolio),
      config: parseConfig(body.config),
      provider: getProvider(),
    });
    return NextResponse.json(analysis);
  } catch (error) {
    return errorResponse(error);
  }
}
