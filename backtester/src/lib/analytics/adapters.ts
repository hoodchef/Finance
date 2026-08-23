import type { BacktestResult } from '@/lib/backtest';
import type { AnalyticsSubject, SubjectSet } from './subject';

/**
 * Adapters from each producer of analytics to the shared view-model.
 *
 * Everything that can be charted converts here and nowhere else. A new
 * producer — a live brokerage position, a Monte Carlo percentile band, a
 * factor-model residual — becomes chartable by adding one function to this
 * file, with no change to any chart.
 */

/** A completed backtest and the benchmarks it was run against. */
export function fromBacktest(result: BacktestResult): SubjectSet {
  const shared = {
    dataSource: result.dataSource.providerLabel,
    synthetic: result.dataSource.synthetic,
    start: result.effectiveStart,
    end: result.effectiveEnd,
  };

  const primary: AnalyticsSubject = {
    id: result.portfolio.id || 'portfolio',
    label: result.portfolio.name || 'Portfolio',
    origin: 'backtest',
    series: result.series,
    metrics: result.metrics,
    meta: { ...shared },
    finalValue: result.totals.finalValue,
    isPrimary: true,
  };

  const comparisons: AnalyticsSubject[] = result.benchmarks.map((b) => ({
    id: b.symbol,
    label: b.symbol,
    origin: 'benchmark',
    series: b.series,
    metrics: b.metrics,
    meta: { ...shared },
    finalValue: b.finalValue,
  }));

  return { primary, comparisons };
}

/**
 * One holding examined on its own, as a standalone buy-and-hold, with the
 * portfolio it sits inside as the comparison.
 */
export function fromAssetAnalysis(
  result: BacktestResult,
  symbol: string,
): SubjectSet | null {
  const asset = result.assets.find((a) => a.symbol === symbol);
  if (!asset) return null;

  const shared = {
    dataSource: result.dataSource.providerLabel,
    synthetic: result.dataSource.synthetic,
  };

  return {
    primary: {
      id: asset.symbol,
      label: asset.symbol,
      origin: 'asset',
      series: asset.series,
      metrics: asset.metrics,
      meta: { ...shared, start: asset.firstDate, end: asset.lastDate },
      isPrimary: true,
    },
    comparisons: [
      {
        id: result.portfolio.id || 'portfolio',
        label: result.portfolio.name || 'Portfolio',
        origin: 'backtest',
        series: result.series,
        metrics: result.metrics,
        meta: { ...shared, start: result.effectiveStart, end: result.effectiveEnd },
        finalValue: result.totals.finalValue,
      },
    ],
  };
}

/**
 * Several completed backtests rendered against each other.
 *
 * The first is treated as primary purely for ordering and colour; no
 * comparison statistic is computed against it here.
 */
export function fromComparison(results: BacktestResult[]): SubjectSet | null {
  if (!results.length) return null;
  const subjects = results.map((r, i) => {
    const s = fromBacktest(r).primary;
    return { ...s, isPrimary: i === 0 };
  });
  return { primary: subjects[0], comparisons: subjects.slice(1) };
}
