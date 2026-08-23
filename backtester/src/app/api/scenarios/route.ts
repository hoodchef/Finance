import { NextResponse } from 'next/server';
import { runScenarioAnalysis } from '@/lib/analysis/scenarios';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, parseSymbol } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const analysis = await runScenarioAnalysis({
      portfolio: parsePortfolio(body.portfolio),
      config: parseConfig(body.config),
      provider: getProvider(body.provider),
      reference: body.reference ? parseSymbol(body.reference, 'reference index') : 'SPY',
      count: Math.min(12, Math.max(1, Number(body.count) || 8)),
    });
    return NextResponse.json(analysis);
  } catch (error) {
    return errorResponse(error);
  }
}
