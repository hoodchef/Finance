import { buildRidge, type Ridge } from '@/lib/lattice/distribution';
// The options pricer's Hart implementation, not a second copy. The quantity
// reported here IS the small number in the corner of the distribution, which
// is exactly where a cheaper approximation is worst — and two normal CDFs in
// one codebase is how two pages come to disagree about the same probability.
import { normCdf } from '@/lib/options/pricing';

/**
 * The tail ridge: what the model says, against what actually happened.
 * =============================================================================
 * A ridge of terminal distributions is a familiar picture and, on its own, a
 * slightly dishonest one. It is drawn from a lognormal — constant volatility,
 * independent increments — and real securities have neither. The lognormal
 * puts a 5σ day at roughly one in three million; equities deliver them every
 * few years. Drawn alone, the ridge quietly asserts a tail thinner than the
 * one the reader is exposed to.
 *
 * So this module draws the ridge AND measures the same threshold against the
 * security's own history, and reports both. Where the observed frequency
 * exceeds the modelled probability — which is the usual direction — the gap is
 * the fat tail the lognormal is missing, expressed as a multiple.
 *
 * The density arithmetic is `buildRidge`, reused rather than rewritten: two
 * implementations of a lognormal in one codebase is how two pages come to
 * disagree about the same probability.
 */

export interface TailComparison {
  label: string;
  /** Trading days in the horizon. */
  days: number;
  /**
   * Move size the tail is measured beyond, as a fraction.
   *
   * Scaled to THIS horizon's own standard deviation rather than fixed. A flat
   * ±10% is about seven sigma for an index over a week and about one sigma for
   * a biotech over six months, so a fixed threshold asks an impossible
   * question at one end and a trivial one at the other, and the comparison is
   * uninformative at both.
   */
  threshold: number;
  /** Sigmas the threshold represents. The same at every horizon. */
  sigmas: number;
  /** P(return beyond +threshold) under the lognormal. */
  modelUp: number;
  /** P(return beyond −threshold) under the lognormal. */
  modelDown: number;
  /**
   * Share of the security's own overlapping windows that finished beyond the
   * threshold. Null when the history is too short to contain one.
   */
  observedUp: number | null;
  observedDown: number | null;
  /** Windows the observed figures were measured over. */
  samples: number;
  /**
   * Observed over modelled, both tails combined.
   *
   * Above one means the security's history is fatter-tailed than the model
   * drawing the ridge. Null when either side is zero, because a ratio to zero
   * is not "infinitely fat" — it is unmeasured.
   */
  fatTailMultiple: number | null;
}

export interface TailRidge {
  ridge: Ridge;
  comparisons: TailComparison[];
  /** Annualised volatility the ridge was drawn from. */
  volatility: number;
  spot: number;
  /** Trading days per year the horizons were converted with. */
  periodsPerYear: number;
}

export const TAIL_HORIZONS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '1W', days: 5 },
  { label: '2W', days: 10 },
  { label: '1M', days: 21 },
  { label: '3M', days: 63 },
  { label: '6M', days: 126 },
];

/**
 * Observed frequency of a move beyond `threshold` over `days`, from real closes.
 *
 * Overlapping windows, so the sample uses the whole record rather than a
 * handful of non-overlapping anniversaries. They are not independent, which
 * makes this a description of what this security has done and not a
 * significance test — and a description is what the comparison needs.
 */
export function observedTailFrequency(
  closes: readonly number[],
  days: number,
  threshold: number,
): { up: number | null; down: number | null; samples: number } {
  if (closes.length <= days) return { up: null, down: null, samples: 0 };
  let up = 0;
  let down = 0;
  let samples = 0;
  for (let i = days; i < closes.length; i++) {
    const from = closes[i - days];
    if (!(from > 0)) continue;
    const ret = closes[i] / from - 1;
    samples++;
    if (ret >= threshold) up++;
    else if (ret <= -threshold) down++;
  }
  if (!samples) return { up: null, down: null, samples: 0 };
  return { up: up / samples, down: down / samples, samples };
}

/**
 * The ridge, plus the model-versus-history comparison at each horizon.
 *
 * `volatility` is the security's own realised figure rather than an assumption
 * — the desk already measures it across six windows — so the picture is at
 * least anchored to how this name has actually moved, even though the SHAPE it
 * is drawn in remains an assumption.
 */
export function buildTailRidge(options: {
  closes: readonly number[];
  volatility: number;
  periodsPerYear?: number;
  /**
   * How many standard deviations out the tail begins. Two by default, which
   * a normal puts at about 4.6% two-tailed — a number big enough to observe
   * and small enough to be a tail.
   */
  sigmas?: number;
  riskFreeRate?: number;
  dividendYield?: number;
  horizons?: ReadonlyArray<{ label: string; days: number }>;
}): TailRidge | null {
  const {
    closes,
    volatility,
    periodsPerYear = 252,
    sigmas = 2,
    riskFreeRate = 0,
    dividendYield = 0,
    horizons = TAIL_HORIZONS,
  } = options;

  const spot = closes[closes.length - 1];
  if (!(spot > 0) || !(volatility > 0) || closes.length < 30) return null;

  const ridge = buildRidge({
    spot,
    volatility,
    riskFreeRate,
    dividendYield,
    horizons: horizons.map((h) => ({ years: h.days / periodsPerYear, label: h.label })),
  });

  const comparisons: TailComparison[] = horizons.map(({ label, days }) => {
    const t = days / periodsPerYear;
    const sd = volatility * Math.sqrt(t);
    const drift = (riskFreeRate - dividendYield - 0.5 * volatility * volatility) * t;

    /*
     * The threshold grows with the horizon, at `sigmas` of that horizon's own
     * deviation. That keeps the MODEL probability roughly constant across the
     * table — near 4.6% at two sigma — so the observed column, and only the
     * observed column, is what moves. The ratio between them is then a clean
     * read on how much fatter this security's tail is than the model's, and it
     * is comparable across horizons and across securities.
     */
    const threshold = Math.expm1(sigmas * sd);

    // P(S_T > spot·(1+k)) under the lognormal, and the mirror below.
    const zUp = (Math.log(1 + threshold) - drift) / sd;
    const zDown = (Math.log(1 - threshold) - drift) / sd;
    const modelUp = 1 - normCdf(zUp);
    const modelDown = normCdf(zDown);

    const observed = observedTailFrequency(closes, days, threshold);
    const modelled = modelUp + modelDown;
    const seen = (observed.up ?? 0) + (observed.down ?? 0);

    return {
      label,
      days,
      threshold,
      sigmas,
      modelUp,
      modelDown,
      observedUp: observed.up,
      observedDown: observed.down,
      samples: observed.samples,
      fatTailMultiple: modelled > 1e-9 && observed.samples > 0 ? seen / modelled : null,
    };
  });

  return { ridge, comparisons, volatility, spot, periodsPerYear };
}
