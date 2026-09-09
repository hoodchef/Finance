import { autocorrelation, mean, percentile, stdev } from './stats';
import type { DrawdownPoint } from './drawdown';
import type { PeriodReturn } from './periods';
import { normCdf, normInv } from '@/lib/options/pricing';

/**
 * Extended performance statistics.
 * =============================================================================
 * These are the ratios a performance report is expected to carry, and almost
 * every one of them has more than one definition in circulation. Two libraries
 * can both report "Sortino" and disagree by thirty percent, so each function
 * here states the convention it implements and, where a competing one is
 * common, says which it is not.
 *
 * Everything is a pure function of a return series. Nothing annualises without
 * being told the period count, because the single most common error in this
 * family is applying a daily factor to weekly data — an error that has already
 * cost this codebase a 7.22% volatility reading where the truth was 15.73%.
 *
 * A degenerate input returns a defined value rather than Infinity or NaN. A
 * ratio of a positive number to zero is not "infinitely good"; sorted into a
 * table it would rank first forever, which is worse than admitting the figure
 * is unavailable.
 */

/** Returned in place of a ratio whose denominator is zero. */
export const UNDEFINED_RATIO = null;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const wins = (rs: number[]) => rs.filter((r) => r > 0);
const losses = (rs: number[]) => rs.filter((r) => r < 0);

/** Guards a quotient: a zero denominator has no ratio, and says so. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) < 1e-12) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ */
/* Gain and loss ratios                                                */
/* ------------------------------------------------------------------ */

/**
 * Omega: probability-weighted gains above a threshold over losses below it.
 *
 * The integral form of the definition reduces exactly to this sum-of-excesses
 * ratio for a discrete sample, which is why no distribution is fitted here.
 * The threshold is a PER-PERIOD return, not annual — passing an annual
 * risk-free rate directly is the usual way this gets overstated.
 */
export function omega(returns: number[], threshold = 0): number | null {
  const gains = sum(returns.filter((r) => r > threshold).map((r) => r - threshold));
  const pains = sum(returns.filter((r) => r < threshold).map((r) => threshold - r));
  return ratio(gains, pains);
}

/**
 * Gain-to-pain: total gains over the absolute total of losses.
 *
 * Identical arithmetic to the profit factor, and reported separately only
 * because both names appear on performance reports and a reader looking for
 * one should not have to know it is the other.
 */
export function gainToPain(returns: number[]): number | null {
  return ratio(sum(wins(returns)), Math.abs(sum(losses(returns))));
}

/** Profit factor: gross gains over gross losses. See `gainToPain`. */
export function profitFactor(returns: number[]): number | null {
  return gainToPain(returns);
}

/**
 * Payoff ratio: the AVERAGE win over the average loss.
 *
 * Distinct from the profit factor, which compares totals. A strategy winning
 * rarely but hugely has a high payoff ratio and may still have a poor profit
 * factor, and conflating the two hides exactly that shape.
 */
export function payoffRatio(returns: number[]): number | null {
  const w = wins(returns);
  const l = losses(returns);
  if (!w.length || !l.length) return null;
  return ratio(mean(w), Math.abs(mean(l)));
}

/**
 * Tail ratio: the size of the right tail against the left.
 *
 * The 95th percentile of returns over the absolute 5th. Above one, the best
 * days are larger than the worst; below one, the losses have the longer tail
 * whatever the average says.
 */
export function tailRatio(returns: number[], cut = 0.95): number | null {
  if (returns.length < 4) return null;
  // Both magnitudes, not the signed right tail. On a series whose 95th
  // percentile is still negative — a losing period throughout — the signed
  // form returns a NEGATIVE ratio, which is not a ratio of tail sizes and
  // sorts nonsensically beside positive ones.
  const right = Math.abs(percentile(returns, cut));
  const left = Math.abs(percentile(returns, 1 - cut));
  return ratio(right, left);
}

/**
 * Value at risk on a fitted normal, rather than read from the sample.
 *
 * Reported beside the historical figure because the two disagree in a way that
 * is itself information: a normal fit cannot see a fat left tail, so where the
 * parametric number is the milder of the two, the distribution has a tail the
 * model is not pricing. Where the sample is short, the historical figure is the
 * less trustworthy one, for the opposite reason — it can only report losses
 * that already happened.
 */
export function parametricValueAtRisk(returns: number[], confidence = 0.95): number | null {
  if (returns.length < 4) return null;
  const s = stdev(returns);
  if (s === 0) return 0;
  // normInv is the inverse standard normal; at 95% this is −1.645.
  const z = -Math.abs(normInv(confidence));
  return mean(returns) + z * s;
}

/**
 * Common sense ratio: profit factor times tail ratio.
 *
 * Rewards a strategy only when it both wins more than it loses AND keeps its
 * worst days smaller than its best. One without the other cancels out.
 */
export function commonSenseRatio(returns: number[]): number | null {
  const pf = profitFactor(returns);
  const tr = tailRatio(returns);
  if (pf == null || tr == null) return null;
  return pf * tr;
}

/**
 * Outlier ratio: the extreme win (or loss) against the typical one.
 *
 * A high figure means the average is being carried by a handful of days, which
 * is a different risk from a high volatility and is invisible in it.
 */
export function outlierWinRatio(returns: number[], q = 0.99): number | null {
  const w = wins(returns);
  if (w.length < 4) return null;
  return ratio(percentile(w, q), mean(w));
}

export function outlierLossRatio(returns: number[], q = 0.01): number | null {
  const l = losses(returns);
  if (l.length < 4) return null;
  return ratio(Math.abs(percentile(l, q)), Math.abs(mean(l)));
}

/* ------------------------------------------------------------------ */
/* Drawdown-based                                                      */
/* ------------------------------------------------------------------ */

/**
 * Ulcer index: the root-mean-square depth of drawdown.
 *
 * Unlike maximum drawdown, which is one day's reading, this penalises being
 * under water for a long time as well as deeply. Squaring means a single 40%
 * hole counts for far more than steady 4% chop, which matches how a drawdown
 * is actually experienced.
 */
export function ulcerIndex(drawdowns: DrawdownPoint[]): number {
  if (!drawdowns.length) return 0;
  const squares = drawdowns.map((d) => d.drawdown * d.drawdown);
  return Math.sqrt(mean(squares));
}

/**
 * Ulcer performance index: excess return per unit of ulcer.
 *
 * Also called the Martin ratio. Uses the same numerator as the Sharpe ratio
 * and replaces standard deviation with the ulcer index, so it asks "per unit
 * of time spent under water" rather than "per unit of wobble".
 */
export function ulcerPerformanceIndex(
  annualReturn: number,
  riskFree: number,
  ulcer: number,
): number | null {
  return ratio(annualReturn - riskFree, ulcer);
}

/**
 * Serenity index: return per unit of ulcer, penalised by tail risk.
 *
 * The ulcer index says how it felt to hold; the penalty says how bad the tail
 * was. A strategy can look serene by never drawing down much and still carry a
 * fat left tail, and this is the figure that refuses to let those cancel.
 *
 * Implemented as UPI scaled by the ratio of conditional VaR to standard
 * deviation — the "pitfall". A normal distribution gives a pitfall near one,
 * so a figure well below the UPI is a statement about tails specifically.
 */
export function serenityIndex(
  annualReturn: number,
  riskFree: number,
  ulcer: number,
  returns: number[],
): number | null {
  const upi = ulcerPerformanceIndex(annualReturn, riskFree, ulcer);
  if (upi == null) return null;
  const sd = stdev(returns);
  const tail = Math.abs(conditionalValueAtRisk(returns, 0.95));
  const pitfall = ratio(tail, sd);
  if (pitfall == null || pitfall <= 0) return null;
  return upi / pitfall;
}

/** Recovery factor: total return earned per unit of worst drawdown. */
export function recoveryFactor(totalReturn: number, maxDrawdown: number): number | null {
  return ratio(totalReturn, Math.abs(maxDrawdown));
}

/**
 * Risk-adjusted return: growth divided by the share of time actually invested.
 *
 * A portfolio in cash half the time and returning 8% is doing something
 * different from one fully invested returning 8%, and only this figure
 * separates them.
 */
export function riskAdjustedReturn(cagr: number, exposure: number): number | null {
  return ratio(cagr, exposure);
}

/* ------------------------------------------------------------------ */
/* Value at risk                                                       */
/* ------------------------------------------------------------------ */

/**
 * Historical value at risk: the loss the worst (1−confidence) of periods
 * exceeded. Returned NEGATIVE, as a return.
 *
 * Historical rather than parametric on purpose. The parametric form assumes
 * normality, and the whole reason to look at a tail is that returns are not
 * normal there.
 */
export function valueAtRisk(returns: number[], confidence = 0.95): number {
  if (!returns.length) return 0;
  return percentile(returns, 1 - confidence);
}

/**
 * Conditional VaR, also called expected shortfall: the AVERAGE of the losses
 * beyond the VaR threshold, not the threshold itself.
 *
 * The distinction matters. VaR says how bad a bad day is at the boundary; cVaR
 * says how bad it is once you are past it, which is the question anyone sizing
 * a position is actually asking.
 */
export function conditionalValueAtRisk(returns: number[], confidence = 0.95): number {
  if (!returns.length) return 0;
  const threshold = valueAtRisk(returns, confidence);
  const tail = returns.filter((r) => r <= threshold);
  return tail.length ? mean(tail) : threshold;
}

/**
 * Kelly criterion: the fraction of capital the edge justifies risking.
 *
 * f = W − (1 − W)/R, with W the win rate and R the payoff ratio. Reported
 * because it is asked for, with the caveat that full Kelly is famously too
 * aggressive to trade — it maximises long-run growth while accepting drawdowns
 * most people cannot hold through, and it is exquisitely sensitive to an
 * estimate of the edge that is itself uncertain.
 */
export function kellyCriterion(returns: number[]): number | null {
  const w = wins(returns);
  const l = losses(returns);
  if (!w.length || !l.length) return null;
  const winRate = w.length / returns.length;
  const payoff = ratio(mean(w), Math.abs(mean(l)));
  if (payoff == null || payoff === 0) return null;
  return winRate - (1 - winRate) / payoff;
}

/**
 * Risk of ruin for a fixed-fraction bettor.
 *
 * ((1 − edge) / (1 + edge))^units, where edge is the win rate less the loss
 * rate. This assumes identical, independent bets of equal size — which a
 * portfolio is not — so it is a rule of thumb about the shape of an edge, not
 * a probability anyone should plan around.
 */
export function riskOfRuin(returns: number[], capitalUnits = 10): number | null {
  if (!returns.length) return null;
  const winRate = wins(returns).length / returns.length;
  const edge = winRate - (1 - winRate);
  if (edge <= 0) return 1;
  const base = (1 - edge) / (1 + edge);
  return Math.pow(base, Math.max(1, capitalUnits));
}

/* ------------------------------------------------------------------ */
/* Sharpe family                                                       */
/* ------------------------------------------------------------------ */

/**
 * Probabilistic Sharpe ratio: the probability the true Sharpe exceeds a
 * benchmark, given the sample's length, skew and kurtosis.
 *
 * This is the honest reading of a Sharpe ratio. A 2.0 from forty observations
 * of a skewed series is a far weaker claim than a 1.2 from a thousand
 * well-behaved ones, and the plain figure cannot tell them apart. Bailey and
 * López de Prado's estimator, which is what this implements.
 */
export function probabilisticSharpe(
  sharpe: number,
  observations: number,
  skew: number,
  kurtosis: number,
  benchmarkSharpe = 0,
): number | null {
  if (observations < 2 || !Number.isFinite(sharpe)) return null;
  // Kurtosis here is the RAW fourth moment, not excess: the estimator wants 3
  // for a normal distribution, so an excess figure is converted.
  const k = kurtosis + 3;
  const denominator = Math.sqrt(
    Math.max(1e-12, 1 - skew * sharpe + ((k - 1) / 4) * sharpe * sharpe),
  );
  const z = ((sharpe - benchmarkSharpe) * Math.sqrt(observations - 1)) / denominator;
  return normCdf(z);
}

/**
 * The autocorrelation penalty behind the "smart" ratios.
 *
 * Serially correlated returns understate risk: a series that trends within
 * itself has a lower measured standard deviation than its true dispersion, so
 * every ratio built on it is flattered. The penalty inflates the denominator
 * by the autocorrelation actually present, which is why a smoothed series —
 * illiquid marks, monthly appraisals — scores lower here than its raw Sharpe
 * suggests.
 */
export function smartFactor(returns: number[], lags = 3): number {
  if (returns.length < lags + 2) return 1;

  let penalty = 0;
  for (let k = 1; k <= lags; k++) {
    // One definition of the autocorrelation estimator, and it lives in `stats`.
    // Two copies is how two pages come to disagree about the same number.
    const rho = autocorrelation(returns, k);
    if (rho == null) return 1; // A flat series carries no penalty.
    penalty += (1 - k / (lags + 1)) * rho;
  }
  // Never below one: the penalty may only make a ratio worse, never better.
  return Math.max(1, Math.sqrt(1 + 2 * penalty));
}

/** A ratio divided by the autocorrelation penalty. */
export function smartRatio(value: number, returns: number[], lags = 3): number {
  return value / smartFactor(returns, lags);
}

/**
 * Adjusted Sortino: divided by √2 so it sits on the same scale as Sharpe.
 *
 * Sortino uses only downside deviation, which is smaller than the full
 * standard deviation, so an unadjusted Sortino is systematically larger than
 * the Sharpe of the same series and the two cannot be compared. Jack Schwager's
 * adjustment makes them commensurate.
 */
export function adjustedSortino(sortino: number): number {
  return sortino / Math.SQRT2;
}

/* ------------------------------------------------------------------ */
/* Streaks, win rates and period returns                               */
/* ------------------------------------------------------------------ */

export interface Streaks {
  longestWin: number;
  longestLoss: number;
  currentWin: number;
  currentLoss: number;
}

/** Longest and current runs of positive and negative periods. */
export function streaks(returns: number[]): Streaks {
  let longestWin = 0;
  let longestLoss = 0;
  let win = 0;
  let loss = 0;
  for (const r of returns) {
    // Exactly zero breaks both runs: a flat period is neither a win nor a
    // loss, and counting it as either would inflate whichever it joined.
    if (r > 0) {
      win += 1;
      loss = 0;
    } else if (r < 0) {
      loss += 1;
      win = 0;
    } else {
      win = 0;
      loss = 0;
    }
    longestWin = Math.max(longestWin, win);
    longestLoss = Math.max(longestLoss, loss);
  }
  return { longestWin, longestLoss, currentWin: win, currentLoss: loss };
}

/** Share of periods that finished positive. */
export function winRate(periods: PeriodReturn[]): number | null {
  if (!periods.length) return null;
  return periods.filter((p) => p.return > 0).length / periods.length;
}

export interface Extremes {
  best: PeriodReturn | null;
  worst: PeriodReturn | null;
}

export function extremes(periods: PeriodReturn[]): Extremes {
  if (!periods.length) return { best: null, worst: null };
  let best = periods[0];
  let worst = periods[0];
  for (const p of periods) {
    if (p.return > best.return) best = p;
    if (p.return < worst.return) worst = p;
  }
  return { best, worst };
}

export interface TrailingReturn {
  label: string;
  /** Null when the series is shorter than the window. */
  value: number | null;
  /** True when the whole window is covered by the data. */
  complete: boolean;
}

/**
 * Trailing returns over standard windows, measured back from the last date.
 *
 * A window the history cannot cover returns null rather than whatever the
 * series happens to hold. Reporting eighteen months of data as a "3Y" return
 * is the kind of quiet overstatement that makes a track record look longer
 * than it is.
 */
/**
 * Calendar days a window's first observation may fall after its nominal start
 * and still count as covering it. Four days spans a Friday-to-Tuesday holiday
 * weekend, which is the longest ordinary gap in a trading calendar.
 */
const WINDOW_GRACE_DAYS = 4;

const daysBetween = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

export function trailingReturns(
  dates: string[],
  index: number[],
  today = dates[dates.length - 1],
): TrailingReturn[] {
  if (!dates.length || dates.length !== index.length) return [];
  const end = index[index.length - 1];
  const endDate = today;

  const windows: Array<{ label: string; start: () => string }> = [
    { label: 'MTD', start: () => `${endDate.slice(0, 7)}-01` },
    { label: '3M', start: () => shift(endDate, -3) },
    { label: '6M', start: () => shift(endDate, -6) },
    { label: 'YTD', start: () => `${endDate.slice(0, 4)}-01-01` },
    { label: '1Y', start: () => shift(endDate, -12) },
    { label: '3Y', start: () => shift(endDate, -36) },
    { label: '5Y', start: () => shift(endDate, -60) },
    { label: '10Y', start: () => shift(endDate, -120) },
  ];

  const out: TrailingReturn[] = windows.map(({ label, start }) => {
    const from = start();
    // The first observation on or after the window opens.
    const i = dates.findIndex((d) => d >= from);
    // A window opening on a weekend or a holiday has no observation on its own
    // start date, so requiring one exactly on or before it would report a
    // ten-year record as "not covered" because the tenth anniversary fell on a
    // Saturday. The grace absorbs a long weekend and no more — a genuinely
    // short record still has its first observation years past the start.
    const complete = i > 0 || (i === 0 && daysBetween(from, dates[0]) <= WINDOW_GRACE_DAYS);
    if (i < 0 || index[i] <= 0) return { label, value: null, complete: false };
    return { label, value: end / index[i] - 1, complete };
  });

  out.push({
    label: 'All',
    value: index[0] > 0 ? end / index[0] - 1 : null,
    complete: true,
  });
  return out;
}

/** Shifts an ISO date by whole months, clamping the day. */
function shift(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1;
  const d = Number(iso.slice(8, 10));
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Expected return per period, and the same figure annualised. */
export function expectedReturns(
  returns: number[],
  periodsPerYear: number,
): { perPeriod: number; monthly: number; yearly: number } {
  const m = returns.length ? mean(returns) : 0;
  // Compounded, not multiplied: a 0.05% daily mean is not 12.6% a year.
  const monthsPerYear = 12;
  const perMonth = Math.pow(1 + m, periodsPerYear / monthsPerYear) - 1;
  const perYear = Math.pow(1 + m, periodsPerYear) - 1;
  return { perPeriod: m, monthly: perMonth, yearly: perYear };
}
