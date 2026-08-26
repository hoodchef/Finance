import { NextResponse } from 'next/server';
import { computeAssetReturns } from '@/lib/backtest';
import {
  estimateMoments,
  linearGlidepath,
  runCorrelated,
  type WeightSchedule,
} from '@/lib/analysis/correlated';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { QueueFullError, enqueue } from '@/lib/jobs/queue';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalises a weight vector, refusing one that cannot be normalised. */
function normalise(weights: number[]): number[] {
  const total = weights.reduce((s, v) => s + v, 0);
  if (!(total > 0)) {
    throw new ValidationError('Target weights must sum to something positive.', 'positions');
  }
  return weights.map((w) => w / total);
}

/**
 * Correlated multi-asset simulation, queued.
 *
 * Fits a covariance to the holdings' joint history and simulates them together,
 * so rebalancing and glidepaths do something rather than being assumed away.
 * Returns 202 with a job id; the work outlives the request.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);
    const provider = getProvider();

    const years = num(body.years, 1, 60, 30);
    const paths = num(body.paths, 100, 10_000, 1000);
    const rebalanceMode = String(body.rebalance ?? 'annual');

    const job = enqueue('correlated', async () => {
      const { symbols, returns, periodsPerYear, dates } = await computeAssetReturns({
        portfolio,
        config,
        provider,
      });

      if (symbols.length < 2) {
        throw Object.assign(new Error('too few assets'), {
          userMessage:
            'A correlated simulation needs at least two priced holdings. With one, use the ' +
            'portfolio simulator instead — there is nothing to correlate.',
        });
      }

      const moments = estimateMoments(symbols, returns);

      const declared = portfolio.positions
        .filter((p) => symbols.includes(p.symbol.toUpperCase()) || symbols.includes(p.symbol))
        .map((p) => Number(p.weight) || 0);
      const target = normalise(
        declared.length === symbols.length ? declared : symbols.map(() => 1),
      );

      const glide = Array.isArray(body.glidepathTo) && body.glidepathTo.length === symbols.length;
      const weights: number[] | WeightSchedule = glide
        ? linearGlidepath(target, normalise(body.glidepathTo.map(Number)), years)
        : target;

      const rebalanceEvery =
        rebalanceMode === 'never'
          ? 0
          : rebalanceMode === 'monthly'
            ? Math.max(1, Math.round(periodsPerYear / 12))
            : rebalanceMode === 'quarterly'
              ? Math.max(1, Math.round(periodsPerYear / 4))
              : Math.max(1, Math.round(periodsPerYear));

      const simulation = runCorrelated({
        moments,
        weights,
        periodsPerYear,
        years,
        paths,
        initialInvestment: num(body.initialInvestment, 0, 1e9, config.initialInvestment),
        rebalanceEvery,
        contributionAmount: num(body.contributionAmount, 0, 1e8, 0),
        contributionEvery:
          body.contributionFrequency === 'monthly'
            ? Math.max(1, Math.round(periodsPerYear / 12))
            : body.contributionFrequency === 'annual'
              ? Math.max(1, Math.round(periodsPerYear))
              : 0,
        seed: num(body.seed, 1, 2 ** 31, 12345),
        expectedReturns: Array.isArray(body.expectedReturns)
          ? body.expectedReturns.map((v: unknown) =>
              v == null || v === '' ? null : Number(v),
            )
          : undefined,
      });

      return {
        simulation,
        estimate: {
          symbols,
          correlation: moments.corr,
          annualVolatility: moments.sigma.map((s) => s * Math.sqrt(periodsPerYear)),
          observations: moments.observations,
          from: dates[0],
          to: dates[dates.length - 1],
        },
        targetWeights: target,
      };
    });

    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    if (error instanceof QueueFullError) {
      return NextResponse.json({ error: error.message, kind: 'busy' }, { status: 503 });
    }
    return errorResponse(error);
  }
}
