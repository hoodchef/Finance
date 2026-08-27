import { NextResponse } from 'next/server';
import { computeAssetReturns } from '@/lib/backtest';
import { estimateMoments } from '@/lib/analysis/correlated';
import {
  efficientFrontier,
  maximumSharpe,
  minimumVariance,
  riskParity,
} from '@/lib/analysis/optimise';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Suggests allocations from the holdings' joint history.
 *
 * Returns four, not one. A single "optimal" portfolio invites more confidence
 * than the estimate behind it can carry, and the three that ignore expected
 * returns are usually the more trustworthy answers — so they are shown beside
 * the one that does not.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);

    const { symbols, returns, periodsPerYear, dates } = await computeAssetReturns({
      portfolio,
      config,
      provider: getProvider(),
    });

    if (symbols.length < 2) {
      throw new ValidationError(
        'Optimising needs at least two priced holdings — with one there is nothing to weigh ' +
          'against anything.',
        'positions',
      );
    }

    const moments = estimateMoments(symbols, returns, { shrink: body.shrink !== false });
    const maxWeight = Math.min(1, Math.max(1 / symbols.length, Number(body.maxWeight) || 1));
    const riskFree = Math.min(0.2, Math.max(0, Number(body.riskFree) || 0));
    const opts = { moments, periodsPerYear, riskFree, maxWeight };

    const current = symbols.map((sym) => {
      const p = portfolio.positions.find(
        (x) => x.symbol.trim().toUpperCase() === sym.toUpperCase(),
      );
      return Number(p?.weight) || 0;
    });
    const currentTotal = current.reduce((s, v) => s + v, 0);

    return NextResponse.json({
      symbols,
      // The allocation the user already holds, scored the same way, so every
      // suggestion is read against it rather than in the abstract.
      current: currentTotal > 0 ? current.map((w) => w / currentTotal) : null,
      portfolios: {
        minimumVariance: minimumVariance(opts),
        riskParity: riskParity(opts),
        maximumSharpe: maximumSharpe(opts),
      },
      frontier: efficientFrontier({ ...opts, points: 24 }),
      estimate: {
        observations: moments.observations,
        shrinkage: moments.shrinkage,
        from: dates[0],
        to: dates[dates.length - 1],
        annualVolatility: moments.sigma.map((s) => s * Math.sqrt(periodsPerYear)),
        correlation: moments.corr,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
