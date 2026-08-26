import { NextResponse } from 'next/server';
import { computeDailyReturns, runBacktest } from '@/lib/backtest';
import { runMonteCarlo, type ResampleMethod } from '@/lib/analysis/montecarlo';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Simulation is grounded in the portfolio's OWN realised returns, so the
 * historical backtest runs first and its daily series becomes the sample.
 * There is no separate model to fit and no assumed distribution to argue with.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);
    const provider = getProvider();

    const historical = await runBacktest({
      portfolio,
      config,
      provider,
      includeAssetAnalysis: false,
    });

    const method: ResampleMethod = body.method === 'iid' ? 'iid' : 'block';
    const years = Math.min(50, Math.max(1, Number(body.years) || 20));
    const paths = Math.min(5000, Math.max(200, Number(body.paths) || 1000));

    // The FULL daily series, not `historical.series`, which is thinned for
    // charting — treating those points as daily observations overstates the
    // compounding per step severalfold.
    const { returns, periodsPerYear } = await computeDailyReturns({
      portfolio,
      config,
      provider,
    });

    if (returns.length < 30) {
      throw new ValidationError(
        'This backtest is too short to resample. Widen the date range.',
        'start',
      );
    }

    const contributionEvery =
      config.contributionFrequency === 'monthly'
        ? Math.round(periodsPerYear / 12)
        : config.contributionFrequency === 'quarterly'
          ? Math.round(periodsPerYear / 4)
          : config.contributionFrequency === 'annual'
            ? Math.round(periodsPerYear)
            : 0;

    const simulation = runMonteCarlo({
      returns,
      periodsPerYear,
      initialInvestment: config.initialInvestment,
      contributionAmount: config.contributionIsWithdrawal ? 0 : config.contributionAmount,
      contributionEvery,
      years,
      paths,
      method,
      seed: Number(body.seed) || 12345,
    });

    return NextResponse.json({
      simulation,
      historical: {
        start: historical.effectiveStart,
        end: historical.effectiveEnd,
        cagr: historical.metrics.returns.cagr,
        volatility: historical.metrics.risk.volatility,
        maxDrawdown: historical.metrics.risk.maxDrawdown,
      },
      dataSource: historical.dataSource,
      warnings: historical.warnings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
