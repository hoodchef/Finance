import { NextResponse } from 'next/server';
import { computeDailyReturns, runBacktest } from '@/lib/backtest';
import { runMonteCarlo, type SimMethod } from '@/lib/analysis/montecarlo';
import { getProvider } from '@/lib/market-data';
import { sharedBacktest } from '@/lib/backtest-shared';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const METHODS: SimMethod[] = ['block', 'iid', 'normal', 'student-t'];

/** Clamps a client number into a range, falling back when absent or unusable. */
function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** An override is only an override when the client actually sent one. */
function optional(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Runs a simulation grounded in a real backtest of the same portfolio.
 *
 * The historical run happens first and unconditionally, even when every
 * parameter is overridden: its realised return and volatility are what the
 * assumptions get compared against on screen. A simulator that cannot show you
 * how far your assumption sits from the record invites you to forget there is
 * one.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);
    const provider = getProvider();

    const method: SimMethod = METHODS.includes(body.method) ? body.method : 'block';

    const [{ result: historical, cached }, daily] = await Promise.all([
      sharedBacktest({ portfolio, config, includeAssetAnalysis: false }),
      computeDailyReturns({ portfolio, config, provider }),
    ]);

    if (daily.returns.length < 60) {
      throw new ValidationError(
        `This window has ${daily.returns.length} observations. A simulation drawn from that ` +
          'describes those days, not the strategy. Widen the date range.',
        'start',
      );
    }

    const periodsPerYear = daily.periodsPerYear;
    const years = num(body.years, 1, 60, 30);

    const everyFor = (freq: unknown): number =>
      freq === 'monthly'
        ? Math.max(1, Math.round(periodsPerYear / 12))
        : freq === 'quarterly'
          ? Math.max(1, Math.round(periodsPerYear / 4))
          : freq === 'annual'
            ? Math.max(1, Math.round(periodsPerYear))
            : 0;

    const simulation = runMonteCarlo({
      returns: daily.returns,
      periodsPerYear,
      initialInvestment: num(body.initialInvestment, 0, 1e9, config.initialInvestment),
      contributionAmount: num(body.contributionAmount, 0, 1e8, 0),
      contributionEvery: everyFor(body.contributionFrequency),
      withdrawalAmount: num(body.withdrawalAmount, 0, 1e8, 0),
      withdrawalEvery: everyFor(body.withdrawalFrequency),
      years,
      paths: num(body.paths, 200, 20_000, 2000),
      method,
      blockDays: optional(body.blockDays, 2, 252) ?? undefined,
      seed: num(body.seed, 1, 2 ** 31, 12345),
      expectedReturn: optional(body.expectedReturn, -0.5, 0.5),
      volatility: optional(body.volatility, 0.001, 2),
      degreesOfFreedom: num(body.degreesOfFreedom, 3, 100, 5),
      inflation: num(body.inflation, 0, 0.25, 0),
    });

    return NextResponse.json({
      simulation,
      historical: {
        start: historical.effectiveStart,
        end: historical.effectiveEnd,
        cagr: historical.metrics.returns.cagr,
        volatility: historical.metrics.risk.volatility,
        maxDrawdown: historical.metrics.risk.maxDrawdown,
        observations: daily.returns.length,
      },
      dataSource: historical.dataSource,
      warnings: historical.warnings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
