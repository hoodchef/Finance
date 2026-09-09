import { autocorrelation, percentile } from '@/lib/metrics/stats';

/**
 * Volatility persistence: whether quiet days are followed by quiet days.
 * =============================================================================
 * The volatility cone says how volatile this security is right now, at six
 * horizons, against its own history. It says nothing about the DYNAMICS — how
 * long a reading tends to last. Those are different facts and they drive
 * different decisions. Two names at the 90th percentile of their own
 * volatility are the same on the cone; if one reverts to normal within a week
 * and the other stays elevated for two months, they are not remotely the same
 * risk to carry, and no percentile can tell them apart.
 *
 * Volatility clustering — Mandelbrot's observation that "large changes tend to
 * be followed by large changes, of either sign" — is the most robust empirical
 * regularity in the whole of asset pricing, and the entire GARCH literature
 * exists to model it. It is also easy to measure directly, without fitting
 * anything, which is what this does. Two shapes:
 *
 *   THE ACF PAIR. Autocorrelation of |log return| at each lag, drawn beside
 *   the autocorrelation of the SIGNED log return at the same lags. The signed
 *   curve sits near zero — direction is not predictable from its own past —
 *   while the absolute curve is positive and decays slowly. Seeing them
 *   together is the point: the same series is unpredictable in sign and
 *   strongly predictable in magnitude, and one line alone cannot show that.
 *
 *   THE TRANSITION MATRIX. Sort every day into a quartile of its own absolute
 *   move, then count where the next day landed. Under independence every cell
 *   is 0.25 and the matrix is flat. Real securities show a heavy diagonal at
 *   the corners — quiet begets quiet, storm begets storm — and the middle rows
 *   are usually much closer to flat, which the single ACF number hides.
 *
 * CONVENTIONS, and here the choice genuinely changes the answer.
 *
 *  - The volatility proxy is |log return|, NOT the squared return. Both are
 *    standard. Squared returns are the theoretically natural proxy but their
 *    autocorrelation estimator has enormous sampling variance under fat tails
 *    — it depends on the fourth moment, which for daily equity returns is
 *    barely finite — so a single crash day can set the whole ACF. The absolute
 *    return depends on the second moment, is far better behaved, and is what
 *    the empirical literature (Taylor, Ding-Granger-Engle) reports. The two
 *    give visibly different numbers on the same data; this is the absolute one.
 *  - Returns are LOG returns, so a −50% and a +100% move count as the same
 *    magnitude, which for a volatility proxy is the correct symmetry.
 *  - The autocorrelation estimator is `metrics/stats.autocorrelation`, the same
 *    one behind the smart ratios, dividing by the full sum of squares.
 *  - The HALF-LIFE reads the lag-1 autocorrelation as if the decay were
 *    geometric — an AR(1). It is not: absolute returns famously decay far more
 *    slowly than any AR(1), which is why the ACF curve is reported beside it.
 *    Read the half-life as "how fast it decays at the start", never as a law,
 *    and read the curve for the tail.
 *  - Quartile cuts come from the WHOLE sample. That makes the matrix a clean
 *    description of the record and would be look-ahead if traded, because a
 *    reader standing in 2019 did not know 2020's quartile boundaries.
 *
 * WHAT THIS IS NOT. A description of a record. The matrix reads tomorrow to
 * fill today's row; that is what a transition matrix is, and it means the
 * figures are historical frequencies rather than probabilities for tomorrow.
 */

export interface AcfPoint {
  lag: number;
  /** Autocorrelation of |log return| — the persistence curve. */
  absolute: number | null;
  /** Autocorrelation of the signed log return, at the same lag. */
  signed: number | null;
}

export interface PersistenceRow {
  /** Quartile of |log return| the day sat in: 1 quietest, 4 wildest. */
  from: number;
  /** P(next day in quartile 1..4), or nulls when the row is too thin. */
  to: Array<number | null>;
  /** Days in this row that had a next day at all. */
  observations: number;
}

export interface VolatilityPersistence {
  acf: AcfPoint[];
  /** Lag-1 autocorrelation of |log return|. The headline persistence figure. */
  rho1: number | null;
  /** Trading days for the lag-1 decay to halve, under an AR(1) reading. */
  halfLife: number | null;
  matrix: PersistenceRow[];
  /** The three quartile cuts of |log return| the matrix was built on. */
  cuts: number[];
  /** P(quietest | quietest). 0.25 under independence. */
  quietAfterQuiet: number | null;
  /** P(wildest | wildest). 0.25 under independence. */
  stormAfterStorm: number | null;
  /** Mean of the four diagonal cells, minus the 0.25 independence would give. */
  excessPersistence: number | null;
  /** Quartile the most recent day's absolute move sits in. */
  currentQuartile: number | null;
  /** Log returns the whole thing was measured over. */
  observations: number;
}

export interface PersistenceOptions {
  /** Lags the ACF is drawn out to. */
  lags?: number;
  /** Below this many transitions a matrix row reports counts but no shares. */
  minRowObservations?: number;
  /** Below this many returns the model reports nothing at all. */
  minObservations?: number;
}

/**
 * Measures persistence from a close series.
 *
 * Non-positive closes break the logarithm, so a pair containing one is skipped
 * rather than being silently treated as flat — a zero return where the data was
 * actually missing would read as the quietest possible day and drag the whole
 * first quartile toward it.
 */
export function volatilityPersistence(
  closes: readonly number[],
  options: PersistenceOptions = {},
): VolatilityPersistence | null {
  const { lags = 10, minRowObservations = 10, minObservations = 60 } = options;

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (returns.length < minObservations) return null;

  const magnitude = returns.map(Math.abs);

  const acf: AcfPoint[] = Array.from({ length: lags }, (_, i) => {
    const lag = i + 1;
    return {
      lag,
      absolute: autocorrelation(magnitude, lag),
      signed: autocorrelation(returns, lag),
    };
  });

  const rho1 = acf[0]?.absolute ?? null;
  // ln(0.5)/ln(ρ) is the AR(1) half-life. Defined only for a decaying positive
  // ρ: a negative or ≥1 lag-1 correlation is not a decay and has no half-life.
  const halfLife =
    rho1 != null && rho1 > 0 && rho1 < 1 ? Math.log(0.5) / Math.log(rho1) : null;

  const cuts = [0.25, 0.5, 0.75].map((p) => percentile(magnitude, p));
  const quartile = (v: number): number => {
    let q = 1;
    while (q < 4 && v > cuts[q - 1]) q++;
    return q;
  };

  // Counts first, shares after, so a row that is too thin can report its
  // observation count without publishing four percentages built on three days.
  const counts = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
  for (let i = 0; i + 1 < magnitude.length; i++) {
    counts[quartile(magnitude[i]) - 1][quartile(magnitude[i + 1]) - 1]++;
  }

  const matrix: PersistenceRow[] = counts.map((row, i) => {
    const observations = row.reduce((a, b) => a + b, 0);
    const enough = observations >= minRowObservations;
    return {
      from: i + 1,
      to: row.map((c) => (enough ? c / observations : null)),
      observations,
    };
  });

  const diagonal = matrix.map((r, i) => r.to[i]);
  const measured = diagonal.filter((d): d is number => d != null);

  return {
    acf,
    rho1,
    halfLife,
    matrix,
    cuts,
    quietAfterQuiet: matrix[0].to[0],
    stormAfterStorm: matrix[3].to[3],
    // Only reported when all four rows carried enough observations to be
    // averaged; a mean over two of them is not a statement about the matrix.
    excessPersistence: measured.length === 4 ? measured.reduce((a, b) => a + b, 0) / 4 - 0.25 : null,
    currentQuartile: magnitude.length ? quartile(magnitude[magnitude.length - 1]) : null,
    observations: returns.length,
  };
}
