import type { IsoDate } from '@/lib/types';
import type { DailyRecord, EngineResult } from '@/lib/engine/types';
import { yearsBetween } from '@/lib/market-data/dates';
import {
  averageDrawdown,
  drawdownEpisodes,
  drawdownSeries,
  longestDrawdownDays,
  maxDrawdown,
  timeUnderwater,
  type DrawdownEpisode,
} from './drawdown';
import {
  annualReturns,
  monthlyReturns,
  quarterlyReturns,
  summarise,
  weeklyReturns,
  type PeriodReturn,
  type PeriodSummary,
} from './periods';
import { correlation, covariance, finite, mean, percentile, stdev } from './stats';

export * from './stats';
export * from './drawdown';
export * from './periods';
export * from './rolling';
export * from './correlation';

/**
 * Metric methodology
 * =============================================================================
 * Every figure below is derived from the engine's daily time-weighted return
 * series `r_t = (V_t − F_t) / V_{t−1} − 1`, where `F_t` is the external cash
 * flow settled on day *t*. External flows are therefore excluded from every
 * performance and risk statistic.
 *
 * `P` is the observed number of trading periods per year, measured from the
 * data itself rather than assumed to be 252 — so a crypto portfolio annualises
 * on ~365 and a US equity portfolio on ~252.
 *
 *   Total return        index_last / index_first − 1
 *   CAGR                (index_last / index_first)^(1 / years) − 1,
 *                       years = calendar days / 365.25
 *   Arithmetic ann.     mean(r) × P
 *   Volatility          sample stdev(r) × √P            (n − 1 denominator)
 *   Downside deviation  √( Σ min(0, r − MAR_daily)² / N ) × √P
 *                       (target semideviation: all N periods in the
 *                        denominator, upside days entering as zero)
 *   Sharpe              mean(r − rf) × P / (stdev(r − rf) × √P)
 *   Sortino             mean(r − MAR) × P / downside deviation
 *   Calmar              CAGR / |max drawdown|
 *   Beta                cov(r − rf, b − rf) / var(b − rf)
 *   Alpha (Jensen)      (mean(r − rf) − β × mean(b − rf)) × P
 *   Treynor             mean(r − rf) × P / β
 *   Tracking error      stdev(r − b) × √P
 *   Information ratio   mean(r − b) × P / tracking error
 *   Historical VaR      the (1 − c) empirical quantile of daily r
 *   CVaR                mean of the daily returns at or below that quantile
 *   Money-weighted      the IRR that discounts every external flow plus the
 *                       terminal value back to zero (XIRR, actual/365)
 *
 * The risk-free series is per-day and may vary through time (13-week T-bill),
 * so `rf` above is `(1 + annual_t)^(1/P) − 1` for each day.
 */

export interface RiskMetrics {
  volatility: number;
  downsideDeviation: number;
  maxDrawdown: number;
  averageDrawdown: number;
  longestDrawdownDays: number;
  timeUnderwater: number;
  var95: number;
  var99: number;
  cvar95: number;
  skewness: number;
  kurtosis: number;
  positiveDayRate: number;
}

export interface RatioMetrics {
  sharpe: number;
  sortino: number;
  calmar: number;
  /** Present only when a benchmark series was supplied. */
  beta?: number;
  alpha?: number;
  treynor?: number;
  trackingError?: number;
  informationRatio?: number;
  rSquared?: number;
  correlation?: number;
  upCapture?: number;
  downCapture?: number;
}

export interface ReturnMetrics {
  totalReturn: number;
  cagr: number;
  arithmeticAnnualReturn: number;
  moneyWeightedReturn: number | null;
  years: number;
  startValue: number;
  finalValue: number;
}

export interface PerformanceMetrics {
  returns: ReturnMetrics;
  risk: RiskMetrics;
  ratios: RatioMetrics;
  annual: PeriodReturn[];
  quarterly: PeriodReturn[];
  monthly: PeriodReturn[];
  weekly: PeriodReturn[];
  annualSummary: PeriodSummary;
  quarterlySummary: PeriodSummary;
  monthlySummary: PeriodSummary;
  weeklySummary: PeriodSummary;
  drawdowns: DrawdownEpisode[];
  periodsPerYear: number;
  averageRiskFree: number;
}

export interface MetricInput {
  daily: DailyRecord[];
  periodsPerYear: number;
  /** Annual risk-free rate per day, as a decimal, aligned to `daily`. */
  riskFree: number[];
  /** Benchmark daily TWR returns, aligned to `daily`, for relative statistics. */
  benchmarkReturns?: number[];
  /** Minimum acceptable annual return for Sortino. Defaults to the risk-free rate. */
  marAnnual?: number;
  /** External flows for the money-weighted return. */
  cashFlows?: Array<{ date: IsoDate; amount: number }>;
}

function toDailyRate(annual: number, periodsPerYear: number): number {
  if (annual === 0) return 0;
  return Math.pow(1 + annual, 1 / periodsPerYear) - 1;
}

function moment(xs: number[], k: number): number {
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0 || xs.length < 3) return 0;
  const acc = xs.reduce((sum, x) => sum + ((x - m) / s) ** k, 0);
  return acc / xs.length;
}

/**
 * XIRR by bisection. Bisection rather than Newton because a portfolio with
 * large late withdrawals can produce a derivative that sends Newton off to
 * nonsense; bisection on a bracketed sign change always converges or reports
 * that it could not.
 */
export function xirr(
  flows: Array<{ date: IsoDate; amount: number }>,
  guessRange: [number, number] = [-0.9999, 10],
): number | null {
  if (flows.length < 2) return null;
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const t0 = Date.parse(`${sorted[0].date}T00:00:00Z`);
  const hasPositive = sorted.some((f) => f.amount > 0);
  const hasNegative = sorted.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  const npv = (rate: number): number =>
    sorted.reduce((acc, f) => {
      const years = (Date.parse(`${f.date}T00:00:00Z`) - t0) / (365 * 86_400_000);
      return acc + f.amount / Math.pow(1 + rate, years);
    }, 0);

  let [lo, hi] = guessRange;
  let flo = npv(lo);
  let fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-10) return mid;
    if (flo * fm <= 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

export function computeMetrics(input: MetricInput): PerformanceMetrics {
  const { daily, periodsPerYear } = input;
  const empty = emptyMetrics(periodsPerYear);
  if (daily.length < 2) return empty;

  const dates = daily.map((d) => d.date);
  const index = daily.map((d) => d.index);
  // Day 0's "return" is the entry cost, not a market move — excluded from all
  // distribution statistics, but retained in the index so it still shows up in
  // total return.
  const r = daily.slice(1).map((d) => d.twrReturn);
  const rf = (input.riskFree.length === daily.length ? input.riskFree : new Array(daily.length).fill(0)).slice(1);

  const years = Math.max(1 / 365.25, yearsBetween(dates[0], dates[dates.length - 1]));
  const startIndex = index[0] || 1;
  const endIndex = index[index.length - 1];
  const totalReturn = endIndex / startIndex - 1;
  const cagr = Math.pow(endIndex / startIndex, 1 / years) - 1;

  const rfDaily = rf.map((a) => toDailyRate(a, periodsPerYear));
  const excess = r.map((x, i) => x - (rfDaily[i] ?? 0));
  const averageRiskFree = mean(rf);

  const volatility = stdev(r) * Math.sqrt(periodsPerYear);

  const marAnnual = input.marAnnual ?? averageRiskFree;
  const marDaily = toDailyRate(marAnnual, periodsPerYear);
  const downsideSq = r.reduce((s, x) => s + Math.min(0, x - marDaily) ** 2, 0);
  const downsideDeviation =
    Math.sqrt(downsideSq / Math.max(1, r.length)) * Math.sqrt(periodsPerYear);

  const ddSeries = drawdownSeries(dates, index);
  const episodes = drawdownEpisodes(dates, index);
  const mdd = maxDrawdown(index);

  const q95 = percentile(r, 0.05);
  const tail = r.filter((x) => x <= q95);

  const risk: RiskMetrics = {
    volatility: finite(volatility),
    downsideDeviation: finite(downsideDeviation),
    maxDrawdown: finite(mdd),
    averageDrawdown: finite(averageDrawdown(episodes)),
    longestDrawdownDays: longestDrawdownDays(episodes),
    timeUnderwater: timeUnderwater(ddSeries),
    var95: finite(q95),
    var99: finite(percentile(r, 0.01)),
    cvar95: finite(tail.length ? mean(tail) : q95),
    skewness: finite(moment(r, 3)),
    kurtosis: finite(moment(r, 4) - 3),
    positiveDayRate: r.length ? r.filter((x) => x > 0).length / r.length : 0,
  };

  const annualisedExcess = mean(excess) * periodsPerYear;
  const excessVol = stdev(excess) * Math.sqrt(periodsPerYear);
  const marExcess = r.map((x) => x - marDaily);

  const ratios: RatioMetrics = {
    sharpe: excessVol > 0 ? finite(annualisedExcess / excessVol) : 0,
    sortino:
      downsideDeviation > 0
        ? finite((mean(marExcess) * periodsPerYear) / downsideDeviation)
        : 0,
    calmar: mdd < 0 ? finite(cagr / Math.abs(mdd)) : 0,
  };

  const b = input.benchmarkReturns;
  if (b && b.length === r.length + 1) {
    const br = b.slice(1);
    const bExcess = br.map((x, i) => x - (rfDaily[i] ?? 0));
    const varB = stdev(bExcess) ** 2;
    const beta = varB > 0 ? covariance(excess, bExcess) / varB : 0;
    const active = r.map((x, i) => x - br[i]);
    const te = stdev(active) * Math.sqrt(periodsPerYear);
    const corr = correlation(r, br);

    const up = br.map((x, i) => ({ b: x, p: r[i] })).filter((x) => x.b > 0);
    const down = br.map((x, i) => ({ b: x, p: r[i] })).filter((x) => x.b < 0);

    ratios.beta = finite(beta);
    ratios.alpha = finite((mean(excess) - beta * mean(bExcess)) * periodsPerYear);
    ratios.treynor = beta !== 0 ? finite(annualisedExcess / beta) : undefined;
    ratios.trackingError = finite(te);
    ratios.informationRatio = te > 0 ? finite((mean(active) * periodsPerYear) / te) : 0;
    ratios.correlation = finite(corr);
    ratios.rSquared = finite(corr * corr);
    ratios.upCapture =
      up.length && mean(up.map((x) => x.b)) !== 0
        ? finite(mean(up.map((x) => x.p)) / mean(up.map((x) => x.b)))
        : undefined;
    ratios.downCapture =
      down.length && mean(down.map((x) => x.b)) !== 0
        ? finite(mean(down.map((x) => x.p)) / mean(down.map((x) => x.b)))
        : undefined;
  }

  const allReturns = daily.map((d) => d.twrReturn);
  const annual = annualReturns(dates, allReturns);
  const quarterly = quarterlyReturns(dates, allReturns);
  const monthly = monthlyReturns(dates, allReturns);
  const weekly = weeklyReturns(dates, allReturns);

  return {
    returns: {
      totalReturn: finite(totalReturn),
      cagr: finite(cagr),
      arithmeticAnnualReturn: finite(mean(r) * periodsPerYear),
      moneyWeightedReturn: input.cashFlows ? xirr(input.cashFlows) : null,
      years,
      startValue: daily[0].totalValue,
      finalValue: daily[daily.length - 1].totalValue,
    },
    risk,
    ratios,
    annual,
    quarterly,
    monthly,
    weekly,
    annualSummary: summarise(annual),
    quarterlySummary: summarise(quarterly),
    monthlySummary: summarise(monthly),
    weeklySummary: summarise(weekly),
    drawdowns: episodes,
    periodsPerYear,
    averageRiskFree,
  };
}

/** Builds the external-flow list an XIRR needs from an engine run. */
export function cashFlowsFromResult(
  result: EngineResult,
): Array<{ date: IsoDate; amount: number }> {
  const flows: Array<{ date: IsoDate; amount: number }> = [];
  for (const d of result.daily) {
    if (Math.abs(d.netFlow) > 1e-9) flows.push({ date: d.date, amount: -d.netFlow });
  }
  const last = result.daily[result.daily.length - 1];
  if (last) flows.push({ date: last.date, amount: last.totalValue });
  return flows;
}

function emptyMetrics(periodsPerYear: number): PerformanceMetrics {
  return {
    returns: {
      totalReturn: 0,
      cagr: 0,
      arithmeticAnnualReturn: 0,
      moneyWeightedReturn: null,
      years: 0,
      startValue: 0,
      finalValue: 0,
    },
    risk: {
      volatility: 0,
      downsideDeviation: 0,
      maxDrawdown: 0,
      averageDrawdown: 0,
      longestDrawdownDays: 0,
      timeUnderwater: 0,
      var95: 0,
      var99: 0,
      cvar95: 0,
      skewness: 0,
      kurtosis: 0,
      positiveDayRate: 0,
    },
    ratios: { sharpe: 0, sortino: 0, calmar: 0 },
    annual: [],
    quarterly: [],
    monthly: [],
    weekly: [],
    annualSummary: { best: null, worst: null, average: 0, median: 0, positiveRate: 0, count: 0 },
    quarterlySummary: { best: null, worst: null, average: 0, median: 0, positiveRate: 0, count: 0 },
    monthlySummary: { best: null, worst: null, average: 0, median: 0, positiveRate: 0, count: 0 },
    weeklySummary: { best: null, worst: null, average: 0, median: 0, positiveRate: 0, count: 0 },
    drawdowns: [],
    periodsPerYear,
    averageRiskFree: 0,
  };
}
