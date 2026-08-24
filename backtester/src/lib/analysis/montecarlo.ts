import type { IsoDate } from '@/lib/types';
import { percentile } from '@/lib/metrics/stats';

/**
 * Monte Carlo by bootstrap resampling.
 * =============================================================================
 * WHAT THIS DOES, PRECISELY
 *
 * It resamples the portfolio's OWN realised daily returns and replays them in
 * different orders. It does not invent returns from an assumed distribution,
 * and it does not forecast. The question it answers is narrow and honest:
 *
 *   "Given the days this strategy actually lived through, how much did the
 *    ORDER of those days matter?"
 *
 * That is worth knowing. A portfolio whose ten-year outcomes span 2% to 14%
 * depending only on sequencing is a different proposition from one that spans
 * 6% to 8%, even where both averaged the same.
 *
 * WHAT IT IS NOT
 *
 * It is not a probability distribution over the future. Every sampled day comes
 * from one historical period, so the simulation inherits that period's regime
 * entirely: its inflation, its rate environment, its valuations. A bootstrap of
 * 2010-2021 cannot produce 1970s stagflation because no such day is in the hat.
 * The UI says this beside the result rather than leaving it implied.
 *
 * WHY BLOCK RESAMPLING IS THE DEFAULT
 *
 * Sampling individual days independently destroys volatility clustering — the
 * tendency of turbulent days to arrive together — and that clustering is most
 * of what makes a drawdown deep. IID resampling therefore understates tail risk
 * in a way that looks reassuring and is not. Sampling contiguous BLOCKS keeps
 * the short-run structure intact.
 */

export type ResampleMethod = 'block' | 'iid';

export interface MonteCarloOptions {
  /** The portfolio's realised daily time-weighted returns. */
  returns: number[];
  /** Trading periods per year, used to annualise. */
  periodsPerYear: number;
  /** Starting capital. */
  initialInvestment: number;
  /**
   * Contribution added every `contributionEvery` periods. Applied to the
   * simulated path so terminal values reflect the real funding pattern.
   */
  contributionAmount?: number;
  contributionEvery?: number;
  /** How many years forward to simulate. */
  years: number;
  /** Number of paths. */
  paths?: number;
  method?: ResampleMethod;
  /** Block length in trading days. Ignored for `iid`. */
  blockDays?: number;
  /** Seed, so a given set of inputs always produces the same answer. */
  seed?: number;
}

export interface MonteCarloBand {
  /** Years from the start. */
  year: number;
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  /** Capital contributed by this point, for comparison against the bands. */
  contributed: number;
}

export interface MonteCarloResult {
  method: ResampleMethod;
  paths: number;
  years: number;
  blockDays: number | null;
  /** Days available to resample from — the size of the hat. */
  sampleDays: number;
  /** Distinct calendar years the sample spans, for the regime caveat. */
  sampleYears: number;

  terminal: {
    min: number;
    p5: number;
    p25: number;
    median: number;
    p75: number;
    p95: number;
    max: number;
    mean: number;
  };
  annualised: { p5: number; median: number; p95: number };
  /** Fraction of paths ending below total capital contributed. */
  probabilityOfLoss: number;
  /** Fraction ending below a target, when one is given. */
  probabilityBelowTarget: number | null;
  worstDrawdown: { median: number; p95: number };
  totalContributed: number;
  bands: MonteCarloBand[];
}

/** mulberry32 — small and fully deterministic from a 32-bit seed. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds one resampled return path.
 *
 * Blocks wrap around the end of the sample rather than being rejected, so every
 * day has an equal chance of appearing — truncating instead would quietly
 * under-sample the final weeks of the series.
 */
function samplePath(
  source: number[],
  length: number,
  method: ResampleMethod,
  blockDays: number,
  rng: () => number,
): number[] {
  const out = new Array<number>(length);
  if (method === 'iid') {
    for (let i = 0; i < length; i++) out[i] = source[Math.floor(rng() * source.length)];
    return out;
  }

  let i = 0;
  while (i < length) {
    const start = Math.floor(rng() * source.length);
    const take = Math.min(blockDays, length - i);
    for (let j = 0; j < take; j++) out[i + j] = source[(start + j) % source.length];
    i += take;
  }
  return out;
}

export function runMonteCarlo(options: MonteCarloOptions): MonteCarloResult {
  const {
    returns,
    periodsPerYear,
    initialInvestment,
    contributionAmount = 0,
    contributionEvery = 0,
    years,
    paths = 1000,
    method = 'block',
    seed = 12345,
  } = options;

  const clean = returns.filter((r) => Number.isFinite(r));
  if (clean.length < 30) {
    throw new Error(
      'Not enough history to resample. A simulation drawn from a handful of days describes those days, not the strategy.',
    );
  }

  // Roughly one month, which is long enough to retain volatility clustering
  // without so long that the paths are near-copies of the original ordering.
  const blockDays =
    method === 'block' ? Math.max(2, options.blockDays ?? Math.round(periodsPerYear / 12)) : 0;

  const steps = Math.max(1, Math.round(years * periodsPerYear));
  const rng = makeRng(seed);

  const terminals: number[] = [];
  const drawdowns: number[] = [];
  // Sampled yearly for the fan chart; every step would be far more data than a
  // chart can show.
  const bandSamples: number[][] = Array.from({ length: years + 1 }, () => []);
  let totalContributed = initialInvestment;

  for (let p = 0; p < paths; p++) {
    const path = samplePath(clean, steps, method, blockDays, rng);
    let value = initialInvestment;
    let contributed = initialInvestment;
    let peak = value;
    let worst = 0;

    bandSamples[0].push(value);
    let nextYear = 1;

    for (let i = 0; i < steps; i++) {
      value *= 1 + path[i];
      if (contributionEvery > 0 && contributionAmount > 0 && (i + 1) % contributionEvery === 0) {
        value += contributionAmount;
        contributed += contributionAmount;
      }
      peak = Math.max(peak, value);
      if (peak > 0) worst = Math.min(worst, value / peak - 1);

      const yearMark = Math.round(((i + 1) / periodsPerYear) * 1000) / 1000;
      while (nextYear <= years && yearMark >= nextYear) {
        bandSamples[nextYear].push(value);
        nextYear++;
      }
    }

    terminals.push(value);
    drawdowns.push(worst);
    if (p === 0) totalContributed = contributed;
  }

  const bands: MonteCarloBand[] = bandSamples.map((values, year) => {
    const contributedBy =
      initialInvestment +
      (contributionEvery > 0
        ? contributionAmount * Math.floor((year * periodsPerYear) / contributionEvery)
        : 0);
    return {
      year,
      p5: percentile(values, 0.05),
      p25: percentile(values, 0.25),
      median: percentile(values, 0.5),
      p75: percentile(values, 0.75),
      p95: percentile(values, 0.95),
      contributed: contributedBy,
    };
  });

  const annualisedFrom = (terminal: number): number =>
    totalContributed > 0 && terminal > 0 ? Math.pow(terminal / totalContributed, 1 / years) - 1 : 0;

  const sorted = [...terminals].sort((a, b) => a - b);
  const sampleYears = clean.length / periodsPerYear;

  return {
    method,
    paths,
    years,
    blockDays: method === 'block' ? blockDays : null,
    sampleDays: clean.length,
    sampleYears: Math.round(sampleYears * 10) / 10,
    terminal: {
      min: sorted[0],
      p5: percentile(terminals, 0.05),
      p25: percentile(terminals, 0.25),
      median: percentile(terminals, 0.5),
      p75: percentile(terminals, 0.75),
      p95: percentile(terminals, 0.95),
      max: sorted[sorted.length - 1],
      mean: terminals.reduce((s, v) => s + v, 0) / terminals.length,
    },
    annualised: {
      p5: annualisedFrom(percentile(terminals, 0.05)),
      median: annualisedFrom(percentile(terminals, 0.5)),
      p95: annualisedFrom(percentile(terminals, 0.95)),
    },
    probabilityOfLoss: terminals.filter((v) => v < totalContributed).length / terminals.length,
    probabilityBelowTarget: null,
    worstDrawdown: {
      median: percentile(drawdowns, 0.5),
      p95: percentile(drawdowns, 0.05), // 5th percentile is the deepest tail
    },
    totalContributed,
    bands,
  };
}
