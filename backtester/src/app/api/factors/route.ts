import { NextResponse } from 'next/server';
import { computeDailyReturns, runBacktest } from '@/lib/backtest';
import { regress, rollingRegression } from '@/lib/analysis/regression';
import {
  FACTOR_SETS,
  alignToFactors,
  getFactorSeries,
  type FactorSetId,
} from '@/lib/market-data/factors';
import { getProvider } from '@/lib/market-data';
import { sharedBacktest } from '@/lib/backtest-shared';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Regresses the portfolio's excess return on the Fama–French factors.
 *
 * The portfolio side uses the FULL daily series rather than the thinned chart
 * series: a regression on downsampled points would estimate betas against days
 * that were chosen for being extremes, which is a selected sample.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const config = parseConfig(body.config);
    const provider = getProvider();

    const model: FactorSetId = body.model === 'ff5' ? 'ff5' : 'ff3';
    const withMomentum = body.momentum === true;

    const [{ result: historical, cached }, { returns, dates, periodsPerYear }] = await Promise.all([
      sharedBacktest({ portfolio, config, includeAssetAnalysis: false }),
      computeDailyReturns({ portfolio, config, provider }),
    ]);

    const setIds: FactorSetId[] = withMomentum ? [model, 'mom'] : [model];
    const sets = await Promise.all(setIds.map((id) => getFactorSeries(id)));

    const aligned = alignToFactors(dates, returns, sets);

    // A year of daily data is the least that gives a factor loading any
    // meaning; below that the standard errors swamp the estimates.
    if (aligned.dates.length < 250) {
      throw new ValidationError(
        `Only ${aligned.dates.length} trading days overlap the factor data — at least 250 are ` +
          'needed for the loadings to mean anything. Widen the date range.',
        'start',
      );
    }

    const fit = regress({
      y: aligned.excess,
      x: aligned.factors,
      periodsPerYear,
    });

    // A single fit reports one loading for the whole history. Rolling shows
    // whether that number described the period or averaged two different ones.
    let rolling: Array<{ date: string; betas: Record<string, number>; alpha: number }> = [];
    try {
      const windowLength = Math.max(126, Math.round(periodsPerYear));
      rolling = rollingRegression({
        y: aligned.excess,
        x: aligned.factors,
        periodsPerYear,
        window: windowLength,
        step: Math.max(5, Math.round(windowLength / 24)),
      }).map((w) => ({
        date: aligned.dates[w.endIndex],
        betas: w.betas,
        alpha: w.alphaAnnualised,
      }));
    } catch {
      // Too short to roll. The single fit above still stands.
    }

    return NextResponse.json({
      rolling,
      model: {
        id: model,
        label: FACTOR_SETS[model].label,
        description: FACTOR_SETS[model].description,
        withMomentum,
      },
      regression: fit,
      window: {
        start: aligned.dates[0],
        end: aligned.covered,
        // What the backtest itself covered, so the gap is visible.
        portfolioStart: historical.effectiveStart,
        portfolioEnd: aligned.portfolioEnd,
        truncated: aligned.truncated,
        observations: aligned.dates.length,
      },
      factorData: {
        // Every set's own last published day, since they can differ.
        lastAvailable: sets.map((s, i) => ({ id: setIds[i], date: s.lastAvailable })),
        fetchedAt: sets[0].fetchedAt,
        attribution:
          'Fama–French factors from the Kenneth R. French Data Library, Tuck School of ' +
          'Business at Dartmouth College.',
      },
      dataSource: historical.dataSource,
      warnings: historical.warnings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
