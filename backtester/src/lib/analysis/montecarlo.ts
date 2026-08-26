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

/**
 * How a path is generated.
 *
 *   block      resample contiguous stretches of real history (default)
 *   iid        resample individual real days, independently
 *   normal     draw from a fitted lognormal
 *   student-t  draw from a fitted Student-t, standardised to the target vol
 *
 * The two bootstraps make no distributional assumption and cannot produce a
 * day the history does not contain. The two parametric methods can — which is
 * their point and their danger: a normal fit understates tails badly, and
 * Student-t exists here so that can be seen rather than argued about.
 */
export type SimMethod = ResampleMethod | 'normal' | 'student-t';

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
  method?: SimMethod;
  /** Block length in trading days. Ignored for `iid`. */
  blockDays?: number;
  /** Seed, so a given set of inputs always produces the same answer. */
  seed?: number;

  /* ---- decumulation ---------------------------------------------------- */
  /**
   * Amount withdrawn every `withdrawalEvery` periods, in TODAY's dollars. It
   * is inflated forward, because a retiree's spending is a real quantity and
   * holding it nominal quietly makes every plan look safer than it is.
   */
  withdrawalAmount?: number;
  withdrawalEvery?: number;

  /* ---- assumptions ----------------------------------------------------- */
  /**
   * Annual arithmetic return. Null estimates it from the supplied history.
   * Only used by the parametric methods; a bootstrap takes its mean from the
   * sample by construction.
   */
  expectedReturn?: number | null;
  /** Annual volatility. Null estimates it from the supplied history. */
  volatility?: number | null;
  /** Degrees of freedom for `student-t`. Lower means fatter tails. */
  degreesOfFreedom?: number;
  /** Annual inflation, used to report outcomes in today's dollars. */
  inflation?: number;
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
  method: SimMethod;
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

  /**
   * Every number the simulation ran on, and whether it was measured or
   * asserted. A fan chart drawn from assumed parameters is indistinguishable
   * from one drawn from measured ones, so the distinction has to travel with
   * the result rather than living in whoever set it up.
   */
  parameters: {
    expectedReturn: number;
    volatility: number;
    expectedReturnSource: 'history' | 'assumed';
    volatilitySource: 'history' | 'assumed';
    degreesOfFreedom: number | null;
    inflation: number;
  };

  /** Terminal values deflated to today's dollars. */
  terminalReal: { p5: number; median: number; p95: number };
  /**
   * Fraction of paths that never hit zero. Meaningful only when withdrawing;
   * 1 when there is nothing to run out of.
   */
  successRate: number;
  /** Median year of depletion among the paths that failed, else null. */
  medianRuinYear: number | null;
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

/* ------------------------------------------------------------------ */
/* Parametric draws                                                    */
/* ------------------------------------------------------------------ */

/** Standard normal, Box–Muller. Rejects u=0 so the log is finite. */
function makeNormal(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u <= 0) u = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * rng();
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };
}

/**
 * Gamma(shape, 1) by Marsaglia–Tsang, for shape >= 1.
 *
 * Needed for Student-t: a chi-square with v degrees of freedom is
 * 2·Gamma(v/2, 1). Building it from a sum of v squared normals instead would
 * be exact but costs v draws per step — tens of millions across a long
 * simulation — where this accepts on the first try almost every time.
 */
function gamma1(shape: number, normal: () => number, rng: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal();
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Student-t with `df` degrees of freedom, standardised to unit variance.
 *
 * A raw t has variance df/(df−2), so feeding it straight into a vol parameter
 * would overshoot the target — at df=4 by 41%. Scaling by sqrt((df−2)/df)
 * makes the fat tails a redistribution of the same variance rather than extra
 * variance, which is the honest comparison against the normal.
 */
function makeStudentT(df: number, normal: () => number, rng: () => number): () => number {
  const scale = Math.sqrt((df - 2) / df);
  return () => {
    const chi2 = 2 * gamma1(df / 2, normal, rng);
    return (normal() / Math.sqrt(chi2 / df)) * scale;
  };
}

/** Sample mean and standard deviation of log(1+r), the compounding space. */
function fitLogMoments(returns: number[]): { mu: number; sigma: number } {
  const logs = returns.filter((r) => r > -1).map((r) => Math.log1p(r));
  const n = logs.length;
  const mu = logs.reduce((s, v) => s + v, 0) / n;
  const varce = logs.reduce((s, v) => s + (v - mu) * (v - mu), 0) / Math.max(1, n - 1);
  return { mu, sigma: Math.sqrt(varce) };
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
    withdrawalAmount = 0,
    withdrawalEvery = 0,
    inflation = 0,
    degreesOfFreedom = 5,
  } = options;
  const parametric = method === 'normal' || method === 'student-t';

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
  const normal = makeNormal(rng);

  // Historical moments, in log space, are the fallback for both parameters and
  // the baseline the overrides are measured against.
  const fitted = fitLogMoments(clean);
  const histVolAnnual = fitted.sigma * Math.sqrt(periodsPerYear);
  // Arithmetic annual mean implied by the fitted lognormal.
  const histReturnAnnual =
    Math.exp(periodsPerYear * (fitted.mu + (fitted.sigma * fitted.sigma) / 2)) - 1;

  const usingReturnOverride = options.expectedReturn != null && Number.isFinite(options.expectedReturn);
  const usingVolOverride = options.volatility != null && Number.isFinite(options.volatility);
  const targetReturn = usingReturnOverride ? (options.expectedReturn as number) : histReturnAnnual;
  const targetVol = usingVolOverride ? (options.volatility as number) : histVolAnnual;

  // Per-period log parameters. sigma scales with the square root of time; mu
  // carries the -sigma^2/2 correction so the ARITHMETIC annual mean lands on
  // the target rather than the median doing so.
  const sigmaStep = targetVol / Math.sqrt(periodsPerYear);
  const muStep = Math.log1p(targetReturn) / periodsPerYear - (sigmaStep * sigmaStep) / 2;
  const draw =
    method === 'student-t' ? makeStudentT(Math.max(3, degreesOfFreedom), normal, rng) : normal;

  const inflationStep = Math.pow(1 + inflation, 1 / periodsPerYear);
  const ruinYears: number[] = [];
  let survived = 0;

  const terminals: number[] = [];
  const drawdowns: number[] = [];
  // Sampled yearly for the fan chart; every step would be far more data than a
  // chart can show.
  const bandSamples: number[][] = Array.from({ length: years + 1 }, () => []);
  let totalContributed = initialInvestment;

  for (let p = 0; p < paths; p++) {
    const path = parametric
      ? Array.from({ length: steps }, () => Math.expm1(muStep + sigmaStep * draw()))
      : samplePath(clean, steps, method as ResampleMethod, blockDays, rng);
    let value = initialInvestment;
    let contributed = initialInvestment;
    let peak = value;
    let worst = 0;

    bandSamples[0].push(value);
    let nextYear = 1;

    let ruinedAt = -1;
    let priceLevel = 1;

    for (let i = 0; i < steps; i++) {
      value *= 1 + path[i];
      if (contributionEvery > 0 && contributionAmount > 0 && (i + 1) % contributionEvery === 0) {
        value += contributionAmount;
        contributed += contributionAmount;
      }
      priceLevel *= inflationStep;
      if (withdrawalEvery > 0 && withdrawalAmount > 0 && (i + 1) % withdrawalEvery === 0) {
        // Stated in today's dollars, so it grows with the price level. A
        // nominal withdrawal shrinks in real terms every year and makes any
        // retirement plan look safer than it is.
        value -= withdrawalAmount * priceLevel;
        if (value <= 0 && ruinedAt < 0) {
          ruinedAt = i;
          value = 0;
        }
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
    if (ruinedAt >= 0) ruinYears.push(ruinedAt / periodsPerYear);
    else survived++;
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

  // Everything nominal is divided by this to reach today's dollars.
  const realDeflator = Math.pow(1 + inflation, years);
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
    parameters: {
      expectedReturn: targetReturn,
      volatility: targetVol,
      expectedReturnSource: usingReturnOverride ? 'assumed' : 'history',
      volatilitySource: usingVolOverride ? 'assumed' : 'history',
      degreesOfFreedom: method === 'student-t' ? Math.max(3, degreesOfFreedom) : null,
      inflation,
    },
    terminalReal: {
      p5: percentile(terminals, 0.05) / realDeflator,
      median: percentile(terminals, 0.5) / realDeflator,
      p95: percentile(terminals, 0.95) / realDeflator,
    },
    successRate: survived / paths,
    medianRuinYear: ruinYears.length ? percentile(ruinYears, 0.5) : null,
  };
}
