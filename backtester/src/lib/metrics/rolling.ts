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
 * Largest index whose timestamp is on or before `limit`, searching forward from
 * `from`. Windows advance monotonically, so this is amortised O(1) across the
 * sweep rather than a binary search per start.
 */
function lastIndexOnOrBefore(stamps: Float64Array, from: number, limit: number): number {
  let j = from;
  while (j + 1 < stamps.length && stamps[j + 1] <= limit) j++;
  return j;
}

/**
 * `addYears` in milliseconds, without the string round-trip.
 * =============================================================================
 * `addYears` → `addMonths` → `toIso` costs a `Date` parse, three `Date`
 * allocations and a `toISOString()` on every call, and the sweep below calls it
 * once per window — about 28,000 times across the six window lengths on a
 * 25-year history. `toISOString` in particular is one of the more expensive
 * things in the language, and none of the strings it produced were ever read;
 * they existed only to be compared against other date strings.
 *
 * The month arithmetic is reproduced exactly, clamp included: 31 January plus
 * one month is 28 February, not 3 March. `tests/rolling-equivalence.test.ts`
 * runs this against the original for every date in several calendars, which is
 * what makes replicating it acceptable rather than reckless.
 */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month !== 1) return MONTH_LENGTHS[month];
  // Gregorian leap rule, so 1900 is 28 days and 2000 is 29.
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

function addYearsMs(year: number, month: number, day: number, years: number): number {
  // Whole months, matching `addMonths(s, years * 12)`.
  const months = month + Math.trunc(years * 12);
  const y = year + Math.floor(months / 12);
  const m = ((months % 12) + 12) % 12;
  // Clamped, so 31 January plus one month is 28 February and not 3 March.
  return Date.UTC(y, m, Math.min(day, daysInMonth(y, m)));
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
  //
  // Parsed once here rather than repeatedly inside the sweep. The loop below
  // used to parse `dates[start]` and `dates[end]` on every iteration, so a
  // 6,300-day history paid for ~56,000 date parses to answer questions about
  // 6,300 distinct days.
  const stamps = new Float64Array(index.length);
  // The calendar fields come straight off the ISO string, so the sweep needs no
  // `Date` object at all — it was allocating two per window purely to read back
  // the year and month of a date it had just formatted.
  const years4 = new Int32Array(index.length);
  const months0 = new Int32Array(index.length);
  const daysOfMonth = new Int32Array(index.length);
  for (let i = 0; i < index.length; i++) {
    const d = dates[i];
    const y = +d.slice(0, 4);
    const m = +d.slice(5, 7) - 1;
    const day = +d.slice(8, 10);
    years4[i] = y;
    months0[i] = m;
    daysOfMonth[i] = day;
    stamps[i] = Date.UTC(y, m, day);
  }
  const lastStamp = stamps[index.length - 1];

  // Prefix sums make the rolling standard deviation O(1) per window.
  const n = dailyReturns.length;
  const sum = new Float64Array(n + 1);
  const sumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + dailyReturns[i];
    sumSq[i + 1] = sumSq[i] + dailyReturns[i] * dailyReturns[i];
  }

  /*
   * Window bounds are recorded so the deepest drawdown can be measured AFTER
   * downsampling rather than during the sweep.
   *
   * It used to be measured inside the loop, for every window, and then ~92% of
   * those windows were dropped by the stride filter forty lines below — the
   * chart keeps 500 points and a 25-year history produces about 6,000 windows.
   * Because the rescan is O(window width), that discarded work dominated the
   * whole rolling module: 37.5M inner-loop iterations across the six window
   * lengths, measured at 161ms against 89ms for the entire backtest engine.
   *
   * Measuring only the survivors is the same arithmetic on the points actually
   * returned, so no reported figure changes.
   */
  const all: RollingPoint[] = [];
  /** `[startIndex, endIndex]` per entry of `all`, parallel by construction. */
  const bounds: number[] = [];
  let end = 0;
  for (let start = 0; start < index.length - 1; start++) {
    const limit = addYearsMs(years4[start], months0[start], daysOfMonth[start], years);
    if (limit > lastStamp) break; // No complete window remains.

    if (end < start) end = start;
    end = lastIndexOnOrBefore(stamps, end, limit);
    if (end <= start) continue;

    // `yearsBetween` is days / 365.25; the division by MS_PER_DAY is exact for
    // UTC-midnight stamps, so this is the same number without the two parses.
    const elapsed = (stamps[end] - stamps[start]) / 86_400_000 / 365.25;
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
      // Filled below, for the kept points only.
      maxDrawdown: null,
    });
    bounds.push(start, end);
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
  const keep: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (i % stride === 0 || i === all.length - 1) keep.push(i);
  }

  /*
   * Now the drawdowns, on the kept windows only. The budget is checked against
   * the work actually about to be done rather than against the whole sweep, so
   * in practice it no longer trips — 500 windows of a 25-year history is about
   * 3M iterations — and histories that previously reported `null` because the
   * full sweep was too expensive now carry a real figure.
   */
  let widest = 0;
  for (const i of keep) {
    const w = bounds[i * 2 + 1] - bounds[i * 2];
    if (w > widest) widest = w;
  }
  if (keep.length * widest < 120_000_000) {
    for (const i of keep) {
      all[i].maxDrawdown = drawdownWithin(index, bounds[i * 2], bounds[i * 2 + 1]);
    }
  }

  const points = keep.map((i) => all[i]);

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

/* ------------------------------------------------------------------ */
/* Rolling statistics over a fixed observation window                  */
/* ------------------------------------------------------------------ */

/**
 * One window's worth of risk statistics, dated at the window's LAST day.
 *
 * Dated at the end rather than the middle or the start: a reader tracing a line
 * to a date is asking "what did the trailing six months look like as of then",
 * and centring the window would answer using returns that had not happened yet.
 */
export interface RollingStat {
  date: IsoDate;
  sharpe: number;
  sortino: number;
  /** Annualised standard deviation inside the window. */
  volatility: number;
  /** Null when no benchmark was supplied, or the window's benchmark is flat. */
  beta: number | null;
}

/**
 * Rolling Sharpe, Sortino, volatility and beta on a fixed-width window.
 *
 * Deliberately separate from `computeRolling`, which measures CALENDAR windows
 * of whole years to answer "what would a ten-year holder have got". This one
 * answers a different question — how the risk profile moved over time — and so
 * counts observations rather than years, because a window that changes width
 * with the calendar would put a kink in every line at a market holiday.
 *
 * A flat window is reported as a Sharpe of zero, not Infinity. `riskFree` is an
 * ANNUAL rate; it is converted here, because subtracting an annual rate from a
 * daily return is the standard way this figure comes out roughly 250x wrong.
 */
export function rollingStats(
  dates: IsoDate[],
  returns: number[],
  periodsPerYear: number,
  window: number,
  riskFree = 0,
  benchmarkReturns?: number[],
): RollingStat[] {
  const n = Math.min(dates.length, returns.length);
  if (n < window || window < 3) return [];

  const rfPeriod = riskFree === 0 ? 0 : Math.pow(1 + riskFree, 1 / periodsPerYear) - 1;
  const root = Math.sqrt(periodsPerYear);
  const out: RollingStat[] = [];

  for (let end = window; end <= n; end++) {
    const start = end - window;
    const slice = returns.slice(start, end);

    const m = slice.reduce((a, b) => a + b, 0) / window;
    const variance = slice.reduce((a, r) => a + (r - m) ** 2, 0) / (window - 1);
    const sd = Math.sqrt(variance);
    const excess = m - rfPeriod;

    // Downside deviation uses the full window in the denominator, not just the
    // losing days. Dividing by the count of losses instead inflates Sortino on
    // a strategy that rarely loses, which is exactly when it is read.
    const below = slice.reduce((a, r) => a + (r < rfPeriod ? (r - rfPeriod) ** 2 : 0), 0);
    const downside = Math.sqrt(below / window);

    let beta: number | null = null;
    if (benchmarkReturns && benchmarkReturns.length >= end) {
      const b = benchmarkReturns.slice(start, end);
      const bm = b.reduce((a, x) => a + x, 0) / window;
      let cov = 0;
      let bvar = 0;
      for (let i = 0; i < window; i++) {
        cov += (slice[i] - m) * (b[i] - bm);
        bvar += (b[i] - bm) ** 2;
      }
      beta = bvar > 1e-18 ? cov / bvar : null;
    }

    out.push({
      date: dates[end - 1],
      sharpe: sd > 1e-12 ? (excess / sd) * root : 0,
      sortino: downside > 1e-12 ? (excess / downside) * root : 0,
      volatility: sd * root,
      beta,
    });
  }
  return out;
}
