import type { IsoDate } from '@/lib/types';
import type { PerformanceMetrics } from './index';
import { drawdownSeries } from './drawdown';
import { dailyReturns, quarterlyReturns, summarise, type PeriodReturn } from './periods';
import { rollingStats, type RollingStat } from './rolling';
import {
  adjustedSortino,
  smartFactor,
  commonSenseRatio,
  conditionalValueAtRisk,
  expectedReturns,
  extremes,
  gainToPain,
  kellyCriterion,
  omega,
  outlierLossRatio,
  outlierWinRatio,
  parametricValueAtRisk,
  payoffRatio,
  probabilisticSharpe,
  profitFactor,
  recoveryFactor,
  riskAdjustedReturn,
  riskOfRuin,
  serenityIndex,
  smartRatio,
  streaks,
  tailRatio,
  trailingReturns,
  ulcerIndex,
  ulcerPerformanceIndex,
  valueAtRisk,
  winRate,
  type TrailingReturn,
} from './extended';

/**
 * The full performance report.
 * =============================================================================
 * This module assembles rather than computes. Every figure comes from either
 * `computeMetrics` — the engine's own statistics, already used by the backtest
 * page — or from `extended.ts`. Nothing is recalculated here, because two
 * places computing "Sharpe" is how a product ends up quoting two different
 * Sharpes on two pages and having no way to say which is right.
 *
 * What this module DOES own is the labelling: which convention each figure
 * follows, what it needs before it can be computed, and why it is missing when
 * it is. A metrics table without that is a wall of decimals — the reader cannot
 * tell a Sortino computed against the risk-free rate from one computed against
 * zero, and the two differ by more than most people's alpha.
 *
 * Three conversions are handled here deliberately, because each is a mistake
 * that produces a plausible wrong number rather than an obvious one:
 *
 *   - The probabilistic Sharpe takes a PER-OBSERVATION Sharpe, while the rest
 *     of the report is annualised. Feeding it the annual figure returns a
 *     confidence near 1.0 for almost any strategy.
 *   - Omega's threshold is a per-period return, not an annual rate.
 *   - Kurtosis arrives as EXCESS kurtosis; the PSR formula wants the raw form.
 */

export type MetricFormat = 'percent' | 'ratio' | 'number' | 'days' | 'count';

/** Whether a larger number is better, which is what colours the value. */
export type MetricSense = 'higher-better' | 'lower-better' | 'signed' | 'neutral';

export interface MetricRow {
  key: string;
  label: string;
  /** Null when the figure cannot be computed; `unavailable` then says why. */
  value: number | null;
  format: MetricFormat;
  sense: MetricSense;
  /** The convention this figure follows, and what it is not. */
  note: string;
  /** Why the value is null. Present only when it is. */
  unavailable?: string;
  /** Free text shown beside the value, e.g. the date a best month fell in. */
  detail?: string;
}

export interface MetricGroup {
  id: string;
  label: string;
  blurb: string;
  rows: MetricRow[];
}

export interface PeriodBreakdown {
  id: string;
  label: string;
  count: number;
  winRate: number | null;
  best: { key: string; return: number } | null;
  worst: { key: string; return: number } | null;
  average: number;
  median: number;
}

export interface PerformanceReport {
  groups: MetricGroup[];
  trailing: TrailingReturn[];
  periods: PeriodBreakdown[];
  rolling: RollingStat[];
  rollingWindow: number;
  window: {
    from: IsoDate;
    to: IsoDate;
    observations: number;
    periodsPerYear: number;
    /** Annual, averaged across the window. */
    riskFree: number;
    years: number;
  };
  benchmark: { symbol: string; name: string } | null;
  /** Set when a group could not be computed at all, rather than left blank. */
  notes: string[];
}

export interface ReportInput {
  metrics: PerformanceMetrics;
  dates: IsoDate[];
  /** Growth of 1.00, time-weighted. */
  index: number[];
  /** Benchmark growth of 1.00 on the same calendar. */
  benchmarkIndex?: number[];
  benchmark?: { symbol: string; name: string };
  /**
   * Average share of capital actually invested, 0–1. Risk-adjusted return
   * divides by this, so a half-invested strategy is not credited with a
   * fully-invested one's risk.
   */
  exposure?: number;
}

const pct = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : v;

/** Simple period returns from a growth index. */
function returnsFromIndex(index: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < index.length; i++) {
    if (index[i - 1] > 0) out.push(index[i] / index[i - 1] - 1);
  }
  return out;
}

const NEEDS_BENCHMARK = 'Needs a benchmark. Choose one above to compute it.';

export function buildReport(input: ReportInput): PerformanceReport {
  const { metrics, dates, index, benchmarkIndex, exposure } = input;
  const { returns: ret, risk, ratios, periodsPerYear } = metrics;

  const daily = returnsFromIndex(index);
  const notes: string[] = [];

  // The risk-free rate arrives annualised; almost every formula below wants it
  // per period. Compounded, not divided: dividing understates it, and on a
  // 5% rate over daily data the difference reaches the third decimal of Sharpe.
  const rfAnnual = metrics.averageRiskFree;
  const rfPeriod = rfAnnual === 0 ? 0 : Math.pow(1 + rfAnnual, 1 / periodsPerYear) - 1;

  const dd = drawdownSeries(dates, index);
  const ulcer = ulcerIndex(dd);

  // PSR wants the per-observation Sharpe. The report's Sharpe is annualised, so
  // it is un-annualised here rather than passed through.
  const sharpePeriodic = ratios.sharpe / Math.sqrt(periodsPerYear);
  const psr = probabilisticSharpe(sharpePeriodic, daily.length, risk.skewness, risk.kurtosis);

  const run = streaks(daily);
  // Shown on the two Smart rows. When returns are near-independent this is
  // 1.00 and the Smart figures equal their plain counterparts — which is the
  // correct answer for daily equity returns, and looks like a broken duplicate
  // row unless the factor itself is on screen.
  const autocorrelation = smartFactor(daily);
  const penaltyDetail = `${autocorrelation.toFixed(2)}× penalty`;
  const expected = expectedReturns(daily, periodsPerYear);

  // The period builders index returns BY DATE, so they want a series aligned to
  // `dates` including day zero — whose "return" is the entry cost, not a market
  // move, and is zero. Passing the N-element series against N+1 dates reads one
  // past the end, and `undefined` propagates to a NaN average that renders as
  // an em dash in a column of real numbers.
  const alignedToDates = [0, ...daily];
  const dailyPeriods = dailyReturns(dates, alignedToDates);
  const quarterly = metrics.quarterly.length
    ? metrics.quarterly
    : quarterlyReturns(dates, alignedToDates);

  /**
   * A benchmark counts only if it is aligned AND actually moved.
   *
   * A flat series passes every length check and then poisons the whole group:
   * a zero-variance benchmark yields a beta of exactly 0.00, an R² of 0.00%
   * and a correlation of 0.00, none of which are measurements — they are what
   * the formulas return when the denominator is guarded. Rendered in a table
   * beside real figures they assert that the portfolio is uncorrelated with
   * the market, which is a claim, and not one an unmeasured number gets to
   * make. (The capture ratios do come back undefined, so the group would
   * otherwise show four confident zeros beside two honest blanks.)
   */
  const aligned = benchmarkIndex && benchmarkIndex.length === index.length ? benchmarkIndex : null;
  const benchMoved = aligned ? new Set(aligned.map((v) => v.toFixed(10))).size > 1 : false;
  const bench = benchMoved ? aligned : null;

  if (input.benchmark && !aligned) {
    notes.push(
      `The benchmark ${input.benchmark.symbol} could not be aligned to the portfolio's calendar, ` +
        'so the relative statistics are omitted rather than computed on mismatched dates.',
    );
  } else if (input.benchmark && !benchMoved) {
    notes.push(
      `The benchmark ${input.benchmark.symbol} priced flat across the whole window, which means ` +
        'it did not load rather than that it did not move. Alpha, beta, R² and correlation are ' +
        'omitted — against a motionless series they would all read as exactly zero.',
    );
  }

  // Relative statistics, but only when there is a benchmark worth comparing to.
  // Reading them straight off `ratios` would leak the zeros above back in.
  const relative = bench ? ratios : null;
  const rel = (v: number | undefined) => (relative ? pct(v) : null);

  const ratioRows: MetricRow[] = [
    {
      key: 'sharpe',
      label: 'Sharpe',
      value: pct(ratios.sharpe),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'Excess return over the risk-free rate, per unit of total standard deviation, ' +
        'annualised. Penalises upside volatility as heavily as downside.',
    },
    {
      key: 'smartSharpe',
      label: 'Smart Sharpe',
      value: smartRatio(ratios.sharpe, daily),
      format: 'ratio',
      sense: 'higher-better',
      detail: penaltyDetail,
      note:
        'Sharpe with an autocorrelation penalty. Returns that trend period to period are ' +
        'less independent than the formula assumes, which flatters the plain figure. The ' +
        'penalty can only lower a ratio, never raise it.',
    },
    {
      key: 'sortino',
      label: 'Sortino',
      value: pct(ratios.sortino),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'Excess return per unit of DOWNSIDE deviation only. Measured against the risk-free ' +
        'rate here, not against zero — the zero-threshold form gives a systematically higher ' +
        'number and both are called "Sortino" in the wild.',
    },
    {
      key: 'adjustedSortino',
      label: 'Adjusted Sortino',
      value: adjustedSortino(ratios.sortino),
      format: 'ratio',
      sense: 'higher-better',
      note:
        "Sortino divided by √2, which puts it on the Sharpe ratio's scale so the two can be " +
        'read side by side. Schwager’s adjustment.',
    },
    {
      key: 'smartSortino',
      label: 'Smart Sortino',
      value: smartRatio(ratios.sortino, daily),
      format: 'ratio',
      sense: 'higher-better',
      detail: penaltyDetail,
      note:
        'Sortino carrying the same autocorrelation penalty as Smart Sharpe. A penalty of ' +
        '1.00× means none was found — the ordinary result for daily returns, and the reason ' +
        'this row can equal the one above it.',
    },
    {
      key: 'calmar',
      label: 'Calmar',
      value: pct(ratios.calmar),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'Annualised return over the worst drawdown. One bad day sets the denominator, so ' +
        'this figure is far less stable than Sharpe across different windows.',
    },
    {
      key: 'omega',
      label: 'Omega',
      value: omega(daily, rfPeriod),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'Total gains above the threshold over total losses below it, at the per-period ' +
        'risk-free rate. Uses the whole distribution rather than its first two moments.',
    },
    {
      key: 'treynor',
      label: 'Treynor',
      value: rel(ratios.treynor),
      format: 'ratio',
      sense: 'higher-better',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note:
        'Excess return per unit of BETA rather than of total volatility. Answers what the ' +
        'holding added per unit of market risk, ignoring risk that diversifies away.',
    },
    {
      key: 'informationRatio',
      label: 'Information ratio',
      value: rel(ratios.informationRatio),
      format: 'ratio',
      sense: 'higher-better',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note: 'Excess return over the benchmark divided by the tracking error of that excess.',
    },
    {
      key: 'psr',
      label: 'Probabilistic Sharpe',
      value: psr,
      format: 'percent',
      sense: 'higher-better',
      note:
        'The probability the true Sharpe exceeds zero, given the sample length, skew and ' +
        'kurtosis. A high Sharpe from a short, negatively-skewed record scores lower here — ' +
        'which is the honest reading of it. Bailey and López de Prado.',
    },
    {
      key: 'gainToPain',
      label: 'Gain / pain',
      value: gainToPain(daily),
      format: 'ratio',
      sense: 'higher-better',
      note: 'Sum of gains over the absolute sum of losses. Identical to the profit factor.',
    },
    {
      key: 'payoff',
      label: 'Payoff ratio',
      value: payoffRatio(daily),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'AVERAGE win over average loss — totals in the profit factor, averages here. A ' +
        'strategy that wins rarely but hugely scores well on this and poorly on that.',
    },
    {
      key: 'profitFactor',
      label: 'Profit factor',
      value: profitFactor(daily),
      format: 'ratio',
      sense: 'higher-better',
      note: 'Gross gains over gross losses. Below 1.0 the losses outweigh the gains.',
    },
    {
      key: 'commonSense',
      label: 'Common sense ratio',
      value: commonSenseRatio(daily),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'Profit factor multiplied by tail ratio, so a strategy must both win more than it ' +
        'loses and keep its worst days smaller than its best.',
    },
    {
      key: 'tailRatio',
      label: 'Tail ratio',
      value: tailRatio(daily),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'The 95th percentile return against the absolute 5th. Above 1.0 the best days are ' +
        'larger than the worst; below it, the losses have the longer tail.',
    },
    {
      key: 'upi',
      label: 'Ulcer performance index',
      value: ulcerPerformanceIndex(ret.cagr, rfAnnual, ulcer),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'Excess return per unit of ulcer — depth of drawdown and time spent in it, rather ' +
        'than volatility. Also called the Martin ratio.',
    },
    {
      key: 'serenity',
      label: 'Serenity index',
      value: serenityIndex(ret.cagr, rfAnnual, ulcer, daily),
      format: 'ratio',
      sense: 'higher-better',
      note:
        'The ulcer performance index scaled by tail risk, so a record that felt calm but ' +
        'carries a fat left tail cannot score as calm.',
    },
    {
      key: 'rar',
      label: 'Risk-adjusted return',
      value: exposure == null ? null : riskAdjustedReturn(ret.cagr, exposure),
      format: 'percent',
      sense: 'higher-better',
      unavailable:
        exposure == null
          ? 'Needs the share of capital actually invested, which this run did not report.'
          : undefined,
      detail: exposure == null ? undefined : `at ${(exposure * 100).toFixed(0)}% invested`,
      note:
        'Annualised return divided by exposure. Half-invested capital earning the same ' +
        'growth is a materially different result, and the headline CAGR cannot say so.',
    },
  ];

  const returnRows: MetricRow[] = [
    {
      key: 'totalReturn',
      label: 'Total return',
      value: pct(ret.totalReturn),
      format: 'percent',
      sense: 'signed',
      note: 'Time-weighted growth across the whole window, with external flows removed.',
    },
    {
      key: 'cagr',
      label: 'CAGR',
      value: pct(ret.cagr),
      format: 'percent',
      sense: 'signed',
      note:
        'The constant annual rate that reproduces the total return over the elapsed ' +
        'calendar time. Not the average of the annual returns, which is higher.',
    },
    {
      key: 'arithmetic',
      label: 'Arithmetic annual',
      value: pct(ret.arithmeticAnnualReturn),
      format: 'percent',
      sense: 'signed',
      note:
        'The mean period return multiplied by the period count, with NO compounding — so it ' +
        'can sit either side of the CAGR rather than always above it. Read the three ' +
        'together: this to Expected yearly is compounding, Expected yearly to CAGR is drag.',
    },
    {
      key: 'mwr',
      label: 'Money-weighted',
      value: pct(ret.moneyWeightedReturn),
      format: 'percent',
      sense: 'signed',
      unavailable:
        ret.moneyWeightedReturn == null
          ? 'No external cash flows, so this is the same as the time-weighted return.'
          : undefined,
      note:
        'The internal rate of return on the actual cash flows (XIRR). Answers what the ' +
        'investor earned rather than what the strategy returned.',
    },
    {
      key: 'expectedDaily',
      label: 'Expected daily',
      value: expected.perPeriod,
      format: 'percent',
      sense: 'signed',
      note: 'Mean return of one period in the underlying data.',
    },
    {
      key: 'expectedMonthly',
      label: 'Expected monthly',
      value: expected.monthly,
      format: 'percent',
      sense: 'signed',
      note: 'The mean period return compounded over a month, not multiplied by it.',
    },
    {
      key: 'expectedYearly',
      label: 'Expected yearly',
      value: expected.yearly,
      format: 'percent',
      sense: 'signed',
      note:
        'The mean period return compounded over a year — compounded, not scaled: a 0.05% ' +
        'daily mean is 13.4% a year, not 12.6%. The gap down to the CAGR is volatility ' +
        'drag, because a bumpy path compounds to less than its own average suggests.',
    },
    {
      key: 'winStreak',
      label: 'Longest win streak',
      value: run.longestWin,
      format: 'count',
      sense: 'neutral',
      detail: run.currentWin > 0 ? `now ${run.currentWin}` : undefined,
      note: 'Consecutive positive periods. A flat period breaks the run rather than extending it.',
    },
    {
      key: 'lossStreak',
      label: 'Longest loss streak',
      value: run.longestLoss,
      format: 'count',
      sense: 'neutral',
      detail: run.currentLoss > 0 ? `now ${run.currentLoss}` : undefined,
      note: 'Consecutive negative periods, on the same basis.',
    },
  ];

  const riskRows: MetricRow[] = [
    {
      key: 'volatility',
      label: 'Volatility (ann.)',
      value: pct(risk.volatility),
      format: 'percent',
      sense: 'lower-better',
      note:
        'Standard deviation of period returns, annualised by the OBSERVED frequency of the ' +
        'data — weekly data is scaled by √52, not √252.',
    },
    {
      key: 'downside',
      label: 'Downside deviation',
      value: pct(risk.downsideDeviation),
      format: 'percent',
      sense: 'lower-better',
      note: 'The same calculation restricted to returns below the risk-free rate.',
    },
    {
      key: 'maxDrawdown',
      label: 'Max drawdown',
      value: pct(risk.maxDrawdown),
      format: 'percent',
      sense: 'signed',
      note: 'The deepest peak-to-trough fall, measured on the time-weighted index.',
    },
    {
      key: 'avgDrawdown',
      label: 'Average drawdown',
      value: pct(risk.averageDrawdown),
      format: 'percent',
      sense: 'signed',
      note: 'Mean depth across every distinct drawdown episode, not across every day.',
    },
    {
      key: 'longestDrawdown',
      label: 'Longest drawdown',
      value: risk.longestDrawdownDays,
      format: 'days',
      sense: 'lower-better',
      note:
        'Calendar days from a peak to the recovery of that peak. Usually the figure people ' +
        'actually experience, and the one a depth-only headline hides.',
    },
    {
      key: 'timeUnderwater',
      label: 'Time under water',
      value: pct(risk.timeUnderwater),
      format: 'percent',
      sense: 'lower-better',
      note: 'Share of the window spent below a previous high.',
    },
    {
      key: 'ulcer',
      label: 'Ulcer index',
      value: ulcer,
      format: 'percent',
      sense: 'lower-better',
      note:
        'Root-mean-square drawdown depth. Squaring means one 40% hole counts for far more ' +
        'than steady 4% chop, which matches how a drawdown is actually lived through.',
    },
    {
      key: 'skew',
      label: 'Skew',
      value: pct(risk.skewness),
      format: 'number',
      sense: 'signed',
      note:
        'Asymmetry of the return distribution. Negative means the left tail is longer — ' +
        'many small gains against occasional large losses.',
    },
    {
      key: 'kurtosis',
      label: 'Kurtosis (excess)',
      value: pct(risk.kurtosis),
      format: 'number',
      sense: 'neutral',
      note:
        'EXCESS kurtosis: zero is the normal distribution, not three. Positive means fatter ' +
        'tails than normal in both directions.',
    },
    {
      key: 'var95',
      label: 'Daily VaR (95%)',
      value: pct(risk.var95),
      format: 'percent',
      sense: 'signed',
      note:
        'Historical: the 5th percentile of actual daily returns. Twenty days in a hundred ' +
        'in nineteen — this is the level the worst one in twenty fell below.',
    },
    {
      key: 'var95p',
      label: 'Daily VaR (95%, normal)',
      value: parametricValueAtRisk(daily, 0.95),
      format: 'percent',
      sense: 'signed',
      note:
        'The same level from a fitted normal, mean − 1.645σ. Milder than the historical ' +
        'figure means the distribution has a tail the normal model cannot see.',
    },
    {
      key: 'var99',
      label: 'Daily VaR (99%)',
      value: pct(risk.var99),
      format: 'percent',
      sense: 'signed',
      note: 'Historical 1st percentile of daily returns.',
    },
    {
      key: 'cvar95',
      label: 'cVaR (95%)',
      value: pct(risk.cvar95),
      format: 'percent',
      sense: 'signed',
      note:
        'Expected shortfall: the AVERAGE of the returns beyond the VaR level, not the level ' +
        'itself. Always the worse of the two, and the one that says how bad a bad day gets.',
    },
    {
      key: 'riskOfRuin',
      label: 'Risk of ruin',
      value: riskOfRuin(daily),
      format: 'percent',
      sense: 'lower-better',
      note:
        'Probability of losing the stake, from the observed win rate and payoff, on a fixed ' +
        'fractional bet. A model of the record, not a forecast of this portfolio.',
    },
    {
      key: 'recovery',
      label: 'Recovery factor',
      value: recoveryFactor(ret.totalReturn, risk.maxDrawdown),
      format: 'ratio',
      sense: 'higher-better',
      note: 'Total return divided by the worst drawdown — how much was made per unit of pain.',
    },
    {
      key: 'kelly',
      label: 'Kelly criterion',
      value: kellyCriterion(daily),
      format: 'percent',
      sense: 'neutral',
      note:
        'The growth-optimal fraction to stake, from the observed win rate and payoff. It ' +
        'assumes independent repeated bets, which returns are not, and full Kelly is far ' +
        'too aggressive to size a portfolio by.',
    },
    {
      key: 'outlierWin',
      label: 'Outlier win ratio',
      value: outlierWinRatio(daily),
      format: 'ratio',
      sense: 'neutral',
      note:
        'The 99th-percentile win against the average win. A high figure means the record is ' +
        'carried by a handful of days — a risk invisible in the volatility.',
    },
    {
      key: 'outlierLoss',
      label: 'Outlier loss ratio',
      value: outlierLossRatio(daily),
      format: 'ratio',
      sense: 'neutral',
      note: 'The 1st-percentile loss against the average loss, on the same basis.',
    },
  ];

  const benchRows: MetricRow[] = [
    {
      key: 'alpha',
      label: 'Alpha (ann.)',
      value: rel(ratios.alpha),
      format: 'percent',
      sense: 'signed',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note:
        'Jensen’s alpha: the annualised return left over after the benchmark exposure is ' +
        'paid for at beta. One of the two figures a performance report calls "the Greeks".',
    },
    {
      key: 'beta',
      label: 'Beta',
      value: rel(ratios.beta),
      format: 'ratio',
      sense: 'neutral',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note:
        'Slope of the portfolio’s returns regressed on the benchmark’s. 1.0 moves with the ' +
        'market. The other of the two regression "Greeks" — unrelated to the option Greeks ' +
        'on the Options page, which measure a contract’s sensitivities.',
    },
    {
      key: 'rSquared',
      label: 'R²',
      value: rel(ratios.rSquared),
      format: 'percent',
      sense: 'neutral',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note:
        'Share of the portfolio’s variance explained by the benchmark. A low R² makes the ' +
        'beta and alpha above unreliable, because the regression has little to fit.',
    },
    {
      key: 'correlation',
      label: 'Correlation',
      value: rel(ratios.correlation),
      format: 'ratio',
      sense: 'neutral',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note: 'Pearson correlation of the two return series over the same dates.',
    },
    {
      key: 'trackingError',
      label: 'Tracking error',
      value: rel(ratios.trackingError),
      format: 'percent',
      sense: 'lower-better',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note: 'Annualised standard deviation of the return difference against the benchmark.',
    },
    {
      key: 'upCapture',
      label: 'Up capture',
      value: rel(ratios.upCapture),
      format: 'percent',
      sense: 'higher-better',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note: 'Share of the benchmark’s gain captured in the periods the benchmark rose.',
    },
    {
      key: 'downCapture',
      label: 'Down capture',
      value: rel(ratios.downCapture),
      format: 'percent',
      sense: 'lower-better',
      unavailable: relative == null ? NEEDS_BENCHMARK : undefined,
      note:
        'Share of the benchmark’s loss taken in the periods it fell. Below 100% is the half ' +
        'of the pair that most defensive strategies are actually sold on.',
    },
  ];

  const groups: MetricGroup[] = [
    {
      id: 'ratios',
      label: 'Risk-adjusted ratios',
      blurb:
        'Return per unit of something unpleasant. They disagree because they disagree about ' +
        'what "unpleasant" means — total variance, downside only, depth of drawdown, or the ' +
        'shape of the tail.',
      rows: ratioRows,
    },
    {
      id: 'returns',
      label: 'Return',
      blurb: 'What was earned, and how evenly it arrived.',
      rows: returnRows,
    },
    {
      id: 'risk',
      label: 'Risk',
      blurb:
        'What it cost to earn it. Volatility describes the middle of the distribution; the ' +
        'drawdown, tail and ruin figures describe the end that ends a strategy.',
      rows: riskRows,
    },
    {
      id: 'benchmark',
      label: 'Benchmark-relative',
      blurb: bench
        ? `Measured against ${input.benchmark?.symbol ?? 'the benchmark'} on the trading dates both series share.`
        : 'Select a benchmark to compute alpha, beta, R², capture and tracking error.',
      rows: benchRows,
    },
  ];

  const periods: PeriodBreakdown[] = [
    breakdown('daily', 'Daily', dailyPeriods),
    breakdown('weekly', 'Weekly', metrics.weekly),
    breakdown('monthly', 'Monthly', metrics.monthly),
    breakdown('quarterly', 'Quarterly', quarterly),
    breakdown('annual', 'Yearly', metrics.annual),
  ];

  // Half a year of observations. Short enough to show the shape moving, long
  // enough that a single week does not swing the line.
  const rollingWindow = Math.max(20, Math.round(periodsPerYear / 2));
  const benchDaily = bench ? returnsFromIndex(bench) : undefined;

  return {
    groups,
    trailing: trailingReturns(dates, index),
    periods,
    rolling: rollingStats(
      dates.slice(1),
      daily,
      periodsPerYear,
      rollingWindow,
      rfAnnual,
      benchDaily,
    ),
    rollingWindow,
    window: {
      from: dates[0],
      to: dates[dates.length - 1],
      observations: daily.length,
      periodsPerYear,
      riskFree: rfAnnual,
      years: ret.years,
    },
    benchmark: bench ? (input.benchmark ?? null) : null,
    notes,
  };
}

function breakdown(id: string, label: string, periods: PeriodReturn[]): PeriodBreakdown {
  const s = summarise(periods);
  const e = extremes(periods);
  return {
    id,
    label,
    count: s.count,
    winRate: winRate(periods),
    best: e.best ? { key: e.best.key, return: e.best.return } : null,
    worst: e.worst ? { key: e.worst.key, return: e.worst.return } : null,
    average: s.average,
    median: s.median,
  };
}

/** Historical VaR and expected shortfall at an arbitrary confidence, for the UI slider. */
export function varAt(returns: number[], confidence: number) {
  return {
    var: valueAtRisk(returns, confidence),
    cvar: conditionalValueAtRisk(returns, confidence),
  };
}
