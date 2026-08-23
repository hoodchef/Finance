import type { IsoDate } from '@/lib/types';
import { addYears, yearsBetween } from '@/lib/market-data/dates';
import { percentile } from './stats';

/**
 * Rolling-period analysis.
 * =============================================================================
 * A single CAGR answers "what would one specific entry date have produced?".
 * It says nothing about how much that answer depended on the entry date, which
 * is usually the more useful question — a strategy whose ten-year outcomes span
 * 2% to 14% is a different proposition from one that spans 6% to 8%, even when
 * both average the same.
 *
 * Every overlapping window is evaluated, so the sample is the full set of start
 * dates the data supports rather than a handful of calendar anniversaries.
 *
 * Windows overlap heavily, so the observations are not independent. That makes
 * the spread a fair description of history and a poor basis for a confidence
 * interval, which is why none is reported.
 */

export interface RollingPoint {
  startDate: IsoDate;
  endDate: IsoDate;
  /** Annualised return across the window. */
  annualised: number;
  /** Annualised standard deviation of daily returns inside the window. */
  volatility: number;
  /**
   * Deepest drawdown inside the window, as a negative fraction. Null when the
   * sweep was skipped because the sample was too large — reporting 0 there
   * would read as "no drawdown" rather than "not measured".
   */
  maxDrawdown: number | null;
}

export interface RollingSummary {
  years: number;
  count: number;
  min: number;
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
  mean: number;
  /** Share of windows that ended below where they started. */
  negativeRate: number;
  worstWindow: { startDate: IsoDate; endDate: IsoDate; annualised: number } | null;
  bestWindow: { startDate: IsoDate; endDate: IsoDate; annualised: number } | null;
}

export interface RollingSeries {
  years: number;
  summary: RollingSummary;
  /** Downsampled for charting; the summary always uses every window. */
  points: RollingPoint[];
}

/** Standard window lengths, filtered to those the data can actually support. */
export const ROLLING_WINDOWS = [1, 3, 5, 10, 15, 20];

/** Deepest drawdown of `index` between two indices, inclusive. */
function drawdownWithin(index: number[], from: number, to: number): number {
  let peak = index[from];
  let worst = 0;
  for (let i = from; i <= to; i++) {
    if (index[i] > peak) peak = index[i];
    else {
      const dd = index[i] / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Largest index whose date is on or before `limit`, searching forward from
 * `from`. Windows advance monotonically, so this is amortised O(1) across the
 * sweep rather than a binary search per start.
 */
function lastIndexOnOrBefore(dates: IsoDate[], from: number, limit: IsoDate): number {
  let j = from;
  while (j + 1 < dates.length && dates[j + 1] <= limit) j++;
  return j;
}

export function computeRolling(
  dates: IsoDate[],
  index: number[],
  dailyReturns: number[],
  years: number,
  periodsPerYear: number,
  maxPoints = 500,
): RollingSeries | null {
  if (index.length < 3 || years <= 0) return null;

  // Windows are measured in *calendar* time, not in a fixed number of trading
  // days. 252 trading days is only about 0.96 of a calendar year, so a fixed
  // width would annualise a "1-year" window over the wrong denominator and
  // overstate it by roughly 0.8 percentage points.
  const lastDate = dates[dates.length - 1];

  // Prefix sums make the rolling standard deviation O(1) per window.
  const n = dailyReturns.length;
  const sum = new Float64Array(n + 1);
  const sumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + dailyReturns[i];
    sumSq[i + 1] = sumSq[i] + dailyReturns[i] * dailyReturns[i];
  }

  // Rolling drawdown rescans each window, so skip it when the sweep would be
  // large enough to stall the request. Skipped windows report null.
  const approxWidth = Math.round(years * periodsPerYear);
  const wantDrawdowns = index.length * approxWidth < 120_000_000;

  const all: RollingPoint[] = [];
  let end = 0;
  for (let start = 0; start < index.length - 1; start++) {
    const limit = addYears(dates[start], years);
    if (limit > lastDate) break; // No complete window remains.

    if (end < start) end = start;
    end = lastIndexOnOrBefore(dates, end, limit);
    if (end <= start) continue;

    const elapsed = yearsBetween(dates[start], dates[end]);
    if (elapsed <= 0) continue;

    const growth = index[end] / index[start];
    if (!Number.isFinite(growth) || growth <= 0) continue;

    const count = end - start;
    const s = sum[end] - sum[start];
    const sq = sumSq[end] - sumSq[start];
    const variance = count > 1 ? Math.max(0, (sq - (s * s) / count) / (count - 1)) : 0;

    all.push({
      startDate: dates[start],
      endDate: dates[end],
      annualised: Math.pow(growth, 1 / elapsed) - 1,
      volatility: Math.sqrt(variance) * Math.sqrt(periodsPerYear),
      maxDrawdown: wantDrawdowns ? drawdownWithin(index, start, end) : null,
    });
  }

  if (!all.length) return null;

  const values = all.map((p) => p.annualised);
  const worst = all.reduce((a, b) => (b.annualised < a.annualised ? b : a));
  const best = all.reduce((a, b) => (b.annualised > a.annualised ? b : a));

  const summary: RollingSummary = {
    years,
    count: all.length,
    min: Math.min(...values),
    p5: percentile(values, 0.05),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    negativeRate: values.filter((v) => v < 0).length / values.length,
    worstWindow: { startDate: worst.startDate, endDate: worst.endDate, annualised: worst.annualised },
    bestWindow: { startDate: best.startDate, endDate: best.endDate, annualised: best.annualised },
  };

  // Even stride for the chart; the summary above already used every window.
  const stride = Math.max(1, Math.ceil(all.length / maxPoints));
  const points = all.filter((_, i) => i % stride === 0 || i === all.length - 1);

  return { years, summary, points };
}

export function computeAllRolling(
  dates: IsoDate[],
  index: number[],
  dailyReturns: number[],
  periodsPerYear: number,
): RollingSeries[] {
  const out: RollingSeries[] = [];
  for (const years of ROLLING_WINDOWS) {
    const series = computeRolling(dates, index, dailyReturns, years, periodsPerYear);
    if (series) out.push(series);
  }
  return out;
}
