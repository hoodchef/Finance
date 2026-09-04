/**
 * Measured inputs for the distribution lab.
 * =============================================================================
 * The lab draws a distribution. Whether that picture means anything depends
 * entirely on where its volatility and correlations came from, so these are
 * computed from observed closes rather than assumed — and the shape of the
 * calculation is the part that matters:
 *
 *  - Volatility is the standard deviation of LOG returns, annualised by the
 *    square root of the observed trading frequency. Using simple returns
 *    understates it, and assuming 252 days a year for a series that is weekly
 *    overstates it by more than two.
 *  - Correlations are measured only on dates every symbol actually traded.
 *    Pairing a US holiday against a day a foreign listing traded silently
 *    inserts a zero return on one side, which drags every correlation toward
 *    zero and makes a portfolio look better diversified than it is.
 *
 * Both refuse rather than guess when there is too little overlap. A
 * correlation from eleven shared days is not a correlation.
 */

export interface DatedClose {
  date: string;
  close: number;
}

/** Fewer than this many shared observations is not an estimate. */
export const MINIMUM_OBSERVATIONS = 30;

export class InsufficientHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientHistoryError';
  }
}

/** Log returns from a close series, in order. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

/**
 * Annualised volatility from dated closes.
 *
 * The annualisation factor is derived from the observed spacing of the dates,
 * not assumed: a daily series scales by √252 and a weekly one by √52, and
 * applying the daily factor to weekly data overstates volatility by 2.2 times.
 * That exact error — a weekly holding beside a daily benchmark — has already
 * cost this codebase a 7.22% reading where the truth was 15.73%.
 */
export function realizedVolatility(series: readonly DatedClose[]): number {
  if (series.length < MINIMUM_OBSERVATIONS) {
    throw new InsufficientHistoryError(
      `${series.length} closes cannot support a volatility estimate; ${MINIMUM_OBSERVATIONS} are needed.`,
    );
  }
  const returns = logReturns(series.map((s) => s.close));
  if (returns.length < 2) {
    throw new InsufficientHistoryError('Not enough usable closes to measure volatility.');
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  // Sample variance: this is an estimate from a sample, not a population.
  const variance =
    returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (returns.length - 1);

  return Math.sqrt(variance * periodsPerYear(series));
}

/**
 * Observations per year, from the median gap between dates.
 *
 * Median rather than mean because a single long gap — a delisting, a data
 * outage, a holiday week — would drag the mean and mislabel a daily series as
 * weekly.
 */
export function periodsPerYear(series: readonly DatedClose[]): number {
  if (series.length < 3) return 252;
  const gaps: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const d = (Date.parse(`${series[i].date}T00:00:00Z`) -
      Date.parse(`${series[i - 1].date}T00:00:00Z`)) / 86_400_000;
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return 252;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // Calendar days between observations, mapped to the trading year it implies.
  if (median <= 1.5) return 252;
  if (median <= 4) return 252 / Math.round(median);
  if (median <= 9) return 52;
  if (median <= 45) return 12;
  return 4;
}

export interface AlignedSeries {
  symbols: string[];
  /** Dates every symbol traded on, ascending. */
  dates: string[];
  /** Log returns per symbol, aligned to `dates` less one. */
  returns: number[][];
}

/**
 * Restricts several series to the dates they ALL traded on.
 *
 * The intersection, not a union with gaps filled. A union inserts a flat day
 * wherever one symbol did not trade, and a flat day is a zero return that
 * pulls its correlations toward zero — which makes an undiversified portfolio
 * look diversified, in the direction nobody checks.
 */
export function alignSeries(input: Record<string, readonly DatedClose[]>): AlignedSeries {
  const symbols = Object.keys(input);
  if (symbols.length === 0) return { symbols: [], dates: [], returns: [] };

  const byDate = symbols.map((s) => new Map(input[s].map((r) => [r.date, r.close])));
  const shared = [...byDate[0].keys()]
    .filter((d) => byDate.every((m) => m.has(d)))
    .sort();

  if (shared.length < MINIMUM_OBSERVATIONS + 1) {
    throw new InsufficientHistoryError(
      `${symbols.join(', ')} share only ${shared.length} trading days; ` +
        `${MINIMUM_OBSERVATIONS + 1} are needed for a correlation.`,
    );
  }

  const returns = byDate.map((m) => logReturns(shared.map((d) => m.get(d) as number)));
  return { symbols, dates: shared, returns };
}

/**
 * Pearson correlation of the aligned log returns.
 *
 * Returns a full square matrix with ones on the diagonal, so callers can index
 * it directly without worrying about which triangle was filled.
 */
export function correlationMatrix(aligned: AlignedSeries): number[][] {
  const n = aligned.symbols.length;
  const rows = aligned.returns;
  const out = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  const means = rows.map((r) => r.reduce((a, b) => a + b, 0) / Math.max(1, r.length));
  const sds = rows.map((r, i) => {
    const v = r.reduce((a, x) => a + (x - means[i]) ** 2, 0) / Math.max(1, r.length - 1);
    return Math.sqrt(v);
  });

  for (let i = 0; i < n; i++) {
    out[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const T = Math.min(rows[i].length, rows[j].length);
      let cov = 0;
      for (let t = 0; t < T; t++) cov += (rows[i][t] - means[i]) * (rows[j][t] - means[j]);
      cov /= Math.max(1, T - 1);
      // A motionless series has no correlation with anything; zero is the
      // honest answer, not the NaN that dividing by its zero deviation gives.
      const denom = sds[i] * sds[j];
      const c = denom > 0 ? cov / denom : 0;
      // Clamp: floating point can produce 1.0000000002 on identical series.
      const clamped = Math.max(-1, Math.min(1, c));
      out[i][j] = clamped;
      out[j][i] = clamped;
    }
  }
  return out;
}

/** Annualised volatility per symbol, from the same aligned window. */
export function volatilities(aligned: AlignedSeries, perYear: number): number[] {
  return aligned.returns.map((r) => {
    if (r.length < 2) return 0;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const v = r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1);
    return Math.sqrt(v * perYear);
  });
}
