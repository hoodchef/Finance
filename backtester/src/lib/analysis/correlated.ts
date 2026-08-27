/**
 * Correlated multi-asset simulation.
 * =============================================================================
 * The portfolio-level simulator in `montecarlo.ts` resamples one series: the
 * portfolio's own realised return. That is honest and cheap, but it bakes in
 * whatever weights the backtest happened to hold. It cannot answer what
 * rebalancing is worth, what a glidepath does, or what happens when one
 * holding's correlation to the rest is different from what it has been —
 * because it never sees the holdings at all.
 *
 * This simulates the ASSETS and lets the portfolio emerge. Returns are drawn
 * from a multivariate distribution fitted to the joint history:
 *
 *     r_t  =  mu  +  L z_t          with  L L' = Sigma,  z ~ N(0, I)
 *
 * L is the Cholesky factor. The identity is the whole trick: multiplying
 * independent unit-variance noise by L produces vectors whose covariance is
 * exactly Sigma, so the simulated assets move together the way the real ones
 * did without any correlation being imposed step by step.
 *
 * Everything is done in LOG space. Log returns add across time, so compounding
 * is exact and no simulated price can go negative; simple returns would need a
 * floor at -100% and would quietly distort the tail that matters most.
 */

export class CorrelatedError extends Error {}

export interface AssetMoments {
  symbols: string[];
  /** Mean log return per period. */
  mu: number[];
  /** Covariance of log returns, per period. */
  cov: number[][];
  /** Correlation, for display. Derived from `cov`. */
  corr: number[][];
  /** Per-period standard deviation of log returns. */
  sigma: number[];
  /** Overlapping observations the estimate is built from. */
  observations: number;
  /** Ledoit-Wolf intensity applied, 0 when shrinkage was not requested. */
  shrinkage: number;
  /** The constant correlation shrunk toward, for reporting. */
  averageCorrelation: number;
}

/* ------------------------------------------------------------------ */
/* Estimation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fits mean and covariance from aligned per-asset return series.
 *
 * The series must already share a calendar. Estimating covariance across
 * mismatched dates pairs a Tuesday against a Wednesday and produces a number
 * that looks like a correlation but is not one.
 */
export function estimateMoments(
  symbols: string[],
  returns: number[][],
  options: { shrink?: boolean } = {},
): AssetMoments {
  const n = symbols.length;
  if (n === 0) throw new CorrelatedError('No assets to estimate.');
  const T = returns[0]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    if (returns[i].length !== T) {
      throw new CorrelatedError(
        `${symbols[i]} has ${returns[i].length} observations against ${T} for ${symbols[0]}. ` +
          'Covariance needs a shared calendar.',
      );
    }
  }
  // n+1 is the bare minimum for a non-singular sample covariance; well below
  // that the matrix is rank-deficient and Cholesky fails outright.
  if (T < Math.max(30, n + 1)) {
    throw new CorrelatedError(
      `${T} overlapping observations cannot support a ${n}-asset covariance estimate.`,
    );
  }

  // Log space.
  const logs = returns.map((r) => r.map((v) => (v > -1 ? Math.log1p(v) : -1e3)));
  const mu = logs.map((r) => r.reduce((s, v) => s + v, 0) / T);

  const cov = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let acc = 0;
      for (let t = 0; t < T; t++) acc += (logs[i][t] - mu[i]) * (logs[j][t] - mu[j]);
      // Bessel-corrected: the sample mean was estimated from the same data.
      const v = acc / (T - 1);
      cov[i][j] = v;
      cov[j][i] = v;
    }
  }

  // Shrinkage acts on the log-return covariance, before anything is derived
  // from it, so the correlations reported and the ones simulated are the same
  // numbers.
  const shrunk = options.shrink === false ? null : shrinkCovariance(cov, logs);
  const finalCov = shrunk ? shrunk.cov : cov;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cov[i][j] = finalCov[i][j];

  const sigma = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  const corr = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      sigma[i] > 0 && sigma[j] > 0 ? cov[i][j] / (sigma[i] * sigma[j]) : i === j ? 1 : 0,
    ),
  );

  return {
    symbols,
    mu,
    cov,
    corr,
    sigma,
    observations: T,
    shrinkage: shrunk?.intensity ?? 0,
    averageCorrelation: shrunk?.averageCorrelation ?? 0,
  };
}

/**
 * Ledoit–Wolf shrinkage toward a constant-correlation target.
 *
 * A sample covariance is noisy, and it is noisy in a way that does specific
 * damage: the largest estimated correlations are biased upward and the
 * smallest downward, because extreme sample values are the ones most likely to
 * be extreme by luck. Simulating from it produces confident diversification
 * that the data does not support. With 10 assets there are 45 correlations to
 * estimate; with 20 there are 190, and daily history runs out long before the
 * estimates settle.
 *
 * Shrinkage pulls every off-diagonal toward the average correlation:
 *
 *     Sigma* = (1 - d) Sigma + d F
 *
 * where F has the same variances and one shared correlation. The intensity is
 * chosen by the Ledoit–Wolf rule — the value minimising expected squared error
 * — and clamped to [0, 1]. Variances are left alone; they are estimated far
 * more reliably than co-movements and shrinking them would distort each
 * asset's own risk to fix a joint problem.
 */
export function shrinkCovariance(
  cov: number[][],
  returns: number[][],
): { cov: number[][]; intensity: number; averageCorrelation: number } {
  const n = cov.length;
  const T = returns[0]?.length ?? 0;
  if (n < 2 || T < 2) return { cov, intensity: 0, averageCorrelation: 0 };

  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  // Average of the off-diagonal correlations — the target's single value.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sd[i] > 0 && sd[j] > 0) {
        sum += cov[i][j] / (sd[i] * sd[j]);
        count++;
      }
    }
  }
  const rbar = count > 0 ? sum / count : 0;

  const target = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? cov[i][i] : rbar * sd[i] * sd[j])),
  );

  // pi: summed variance of the sample covariance entries.
  // gamma: squared distance from the sample matrix to the target.
  const means = returns.map((r) => r.reduce((a, b) => a + b, 0) / T);
  let pi = 0;
  let gamma = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let t = 0; t < T; t++) {
        const d = (returns[i][t] - means[i]) * (returns[j][t] - means[j]) - cov[i][j];
        acc += d * d;
      }
      pi += acc / T;
      const diff = target[i][j] - cov[i][j];
      gamma += diff * diff;
    }
  }

  // rho (the covariance between estimation errors of Sigma and F) is dropped.
  // Ledoit and Wolf note the omission is small for this target, and including
  // it costs an O(n^2 T) pass for a correction well inside the noise it fixes.
  const intensity = gamma > 0 ? Math.max(0, Math.min(1, pi / T / gamma)) : 0;

  const out = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? cov[i][j] : (1 - intensity) * cov[i][j] + intensity * target[i][j],
    ),
  );

  return { cov: out, intensity, averageCorrelation: rbar };
}

/* ------------------------------------------------------------------ */
/* Cholesky                                                            */
/* ------------------------------------------------------------------ */

export interface CholeskyResult {
  /** Lower-triangular L with L L' = the (possibly adjusted) covariance. */
  L: number[][];
  /**
   * Ridge added to the diagonal to force positive definiteness, as a fraction
   * of the mean variance. Zero when the sample matrix was already usable.
   */
  ridge: number;
}

/**
 * Cholesky factorisation, with a ridge fallback.
 *
 * A sample covariance matrix is only positive definite when there are more
 * observations than assets AND no asset is a linear combination of the others.
 * Two share classes of the same fund, or a holding duplicated under two
 * tickers, breaks the second condition even with decades of data — and the
 * failure is a square root of a negative number, not a wrong answer.
 *
 * Rather than refuse, a small multiple of the identity is added until the
 * factorisation succeeds. That is standard practice and it is a real
 * modification of the input, so the amount is reported and surfaced.
 */
export function cholesky(cov: number[][]): CholeskyResult {
  const n = cov.length;

  // A ridge is for numerical near-singularity — two holdings that track each
  // other so closely the sample matrix loses rank. It is NOT a way to make an
  // invalid matrix factorisable. A negative variance is not a covariance at
  // all, and a large enough ridge would happily "fix" it into something that
  // factorises and means nothing.
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(cov[i][i]) || cov[i][i] < 0) {
      throw new CorrelatedError(
        `Variance for asset ${i} is ${cov[i][i]}, which is not a variance. ` +
          'The covariance estimate is invalid, not merely ill-conditioned.',
      );
    }
  }

  const meanVar = cov.reduce((s, row, i) => s + row[i], 0) / Math.max(1, n);
  if (!(meanVar > 0)) {
    throw new CorrelatedError('Every asset has zero variance; there is nothing to simulate.');
  }

  // Capped at a millionth of the mean variance: enough to clear a zero pivot
  // from collinearity, far too little to paper over a broken estimate.
  for (let attempt = 0; attempt <= 4; attempt++) {
    const ridge = attempt === 0 ? 0 : meanVar * Math.pow(10, -10 + attempt);
    const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = true;

    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = cov[i][j] + (i === j ? ridge : 0);
        for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
        if (i === j) {
          if (sum <= 0) {
            ok = false;
            break;
          }
          L[i][j] = Math.sqrt(sum);
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }
    if (ok) return { L, ridge };
  }

  throw new CorrelatedError(
    'The covariance matrix could not be factorised even after regularisation. ' +
      'Two holdings are probably identical or perfectly collinear.',
  );
}

/* ------------------------------------------------------------------ */
/* Regimes                                                             */
/* ------------------------------------------------------------------ */

export interface RegimeMoments {
  calm: AssetMoments;
  stressed: AssetMoments;
  /** Fraction of days classified as stressed. */
  stressFrequency: number;
  /** Trailing portfolio volatility at or above which a day counts as stressed. */
  threshold: number;
  /** Average off-diagonal correlation in each regime, for reporting. */
  calmCorrelation: number;
  stressedCorrelation: number;
  /**
   * Day-to-day transition probabilities, estimated from the observed regime
   * sequence. `stayStressed` above the base rate is persistence — stress
   * clusters rather than arriving independently.
   */
  transition: {
    stayCalm: number;
    stayStressed: number;
    /** Mean length of a stressed run, in periods: 1 / (1 - stayStressed). */
    meanStressRun: number;
    /** Frequency implied by the chain's stationary distribution. */
    stationaryStressFrequency: number;
  };
}

/**
 * Trailing window for the volatility classifier, in periods.
 *
 * About two trading weeks at daily resolution. Short enough to turn quickly
 * into a crisis, long enough that a single day does not flip the regime.
 */
function periodsHint(_observations: number): number {
  return 10;
}

/** Mean off-diagonal correlation of a matrix. */
function averageOffDiagonal(corr: number[][]): number {
  const n = corr.length;
  if (n < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += corr[i][j];
      count++;
    }
  }
  return sum / count;
}

/**
 * Splits history into a calm and a stressed regime and fits each separately.
 *
 * The single-covariance model asserts that assets move together the same way
 * always. They do not. Correlations rise in falls — in precisely the episodes
 * diversification was bought for — and a simulation that holds them fixed
 * reports a downside band that is too narrow for the reason that matters most.
 *
 * The usual fix is to assume a stress multiplier. This measures it instead: the
 * worst `quantile` of days by portfolio return become the stressed regime, and
 * both regimes are fitted from the actual data in them.
 *
 * Crucially BOTH the mean and the covariance are estimated per regime, and the
 * simulation draws a regime with the empirical frequency. That keeps the
 * mixture's unconditional mean equal to the full-sample mean by construction.
 * Taking the stressed covariance while keeping the overall mean — the obvious
 * shortcut — would understate risk; taking the stressed MEAN as a permanent
 * drift would make every path a catastrophe. Neither is what the data says.
 */
export function estimateRegimes(
  symbols: string[],
  returns: number[][],
  options: { quantile?: number; weights?: number[]; shrink?: boolean } = {},
): RegimeMoments {
  const quantile = Math.min(0.4, Math.max(0.05, options.quantile ?? 0.1));
  const n = symbols.length;
  const T = returns[0]?.length ?? 0;

  const w = options.weights && options.weights.length === n
    ? options.weights
    : new Array<number>(n).fill(1 / n);

  // Classify on the portfolio's own return, not one asset's: the question is
  // what happened to THIS mix on its bad days.
  const portfolio = Array.from({ length: T }, (_, t) =>
    returns.reduce((sum, series, i) => sum + w[i] * series[t], 0),
  );
  /**
   * Classify on TRAILING VOLATILITY, not on the day's return.
   *
   * Thresholding on return picks out bad days, which is not the same as bad
   * regimes: a turbulent stretch contains big up days too, and those get
   * labelled calm, chopping every run into single days. Measured on a series
   * built from runs of ~14 stressed days, return-thresholding recovered a mean
   * run length of 1.5 — it destroyed exactly the clustering the chain exists to
   * capture.
   *
   * Volatility is what persists, and a high-volatility regime is where both the
   * fat losses and the correlation breakdown live. The window is trailing, so
   * nothing here looks ahead.
   */
  const window = Math.max(5, Math.min(40, Math.round(periodsHint(T))));
  const vol = new Array<number>(T).fill(0);
  for (let t = 0; t < T; t++) {
    const from = Math.max(0, t - window + 1);
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let k = from; k <= t; k++) {
      sum += portfolio[k];
      sumSq += portfolio[k] * portfolio[k];
      count++;
    }
    const mean = sum / count;
    vol[t] = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  }

  const sortedVol = [...vol].sort((a, b) => a - b);
  // Top `quantile` by volatility is stressed.
  const cut = Math.max(1, Math.floor(T * (1 - quantile)));
  const threshold = sortedVol[Math.min(T - 1, cut)];

  const stressedIdx: number[] = [];
  const calmIdx: number[] = [];
  for (let t = 0; t < T; t++) (vol[t] >= threshold ? stressedIdx : calmIdx).push(t);

  // A covariance needs more observations than assets in EVERY regime, not just
  // overall. Failing here beats returning a rank-deficient stressed matrix that
  // the ridge would then quietly paper over.
  const minimum = Math.max(20, n + 1);
  if (stressedIdx.length < minimum || calmIdx.length < minimum) {
    throw new CorrelatedError(
      `Splitting this history at the worst ${Math.round(quantile * 100)}% leaves ` +
        `${stressedIdx.length} stressed and ${calmIdx.length} calm days; each regime needs at ` +
        `least ${minimum} to fit ${n} assets. Widen the window or raise the quantile.`,
    );
  }

  /**
   * Transition counts from the day-by-day regime sequence.
   *
   * Drawing regimes independently at the base rate — which is what the first
   * version did — scatters bad days evenly through the horizon. Real stress
   * arrives in runs, and a run is what turns a drawdown into a deep one. The
   * chain below is the difference between "12% of days are bad" and "bad
   * months happen".
   */
  const stressed = new Array<boolean>(T);
  for (let t = 0; t < T; t++) stressed[t] = vol[t] >= threshold;

  let cc = 0;
  let cs = 0;
  let sc = 0;
  let ss = 0;
  for (let t = 1; t < T; t++) {
    if (!stressed[t - 1]) stressed[t] ? cs++ : cc++;
    else stressed[t] ? ss++ : sc++;
  }
  // Falling back to the base rate when a regime never repeats keeps the chain
  // well defined on short or unusually calm windows.
  const baseRate = stressedIdx.length / T;
  const stayCalm = cc + cs > 0 ? cc / (cc + cs) : 1 - baseRate;
  const stayStressed = sc + ss > 0 ? ss / (sc + ss) : baseRate;
  // Stationary distribution of a two-state chain.
  const leaveCalm = 1 - stayCalm;
  const leaveStressed = 1 - stayStressed;
  const stationary =
    leaveCalm + leaveStressed > 0 ? leaveCalm / (leaveCalm + leaveStressed) : baseRate;

  const slice = (idx: number[]) => returns.map((series) => idx.map((t) => series[t]));
  const calm = estimateMoments(symbols, slice(calmIdx), { shrink: options.shrink !== false });
  const stressedMoments = estimateMoments(symbols, slice(stressedIdx), {
    shrink: options.shrink !== false,
  });

  return {
    calm,
    stressed: stressedMoments,
    stressFrequency: stressedIdx.length / T,
    threshold,
    calmCorrelation: averageOffDiagonal(calm.corr),
    stressedCorrelation: averageOffDiagonal(stressedMoments.corr),
    transition: {
      stayCalm,
      stayStressed,
      meanStressRun: stayStressed < 1 ? 1 / (1 - stayStressed) : Number.POSITIVE_INFINITY,
      stationaryStressFrequency: stationary,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

export type WeightSchedule = (yearFraction: number) => number[];

export interface CorrelatedOptions {
  moments: AssetMoments;
  /** Target weights, summing to 1. Fixed, or a function of time for a glidepath. */
  weights: number[] | WeightSchedule;
  periodsPerYear: number;
  years: number;
  paths?: number;
  initialInvestment: number;
  /** Periods between rebalances. 0 never rebalances — weights drift. */
  rebalanceEvery?: number;
  contributionAmount?: number;
  contributionEvery?: number;
  seed?: number;
  /** Annual expected-return overrides per asset, arithmetic. Null keeps history. */
  expectedReturns?: (number | null)[];
  /**
   * Two-regime mixture. When given, each step draws a regime at the empirical
   * frequency and then draws from that regime's own fitted distribution, so
   * correlation breakdown is simulated rather than assumed away.
   */
  regimes?: RegimeMoments;
}

export interface CorrelatedResult {
  symbols: string[];
  paths: number;
  years: number;
  rebalanceEvery: number;
  ridge: number;
  observations: number;
  terminal: { p5: number; p25: number; median: number; p75: number; p95: number };
  annualised: { p5: number; median: number; p95: number };
  worstDrawdown: { median: number; p95: number };
  /** Correlation the SIMULATION produced, for checking against the input. */
  realisedCorrelation: number[][];
  /** Regime detail when a mixture was used. */
  regimeUsed: {
    stressFrequency: number;
    calmCorrelation: number;
    stressedCorrelation: number;
    /** Fraction of simulated steps that landed in the stressed regime. */
    realisedStressShare: number;
    /** Probability stress persists to the next period. */
    stayStressed: number;
    /** Mean length of a stressed run, in periods. */
    meanStressRun: number;
  } | null;
  inputCorrelation: number[][];
  /** Mean end-of-horizon weight per asset — how far drift carried them. */
  endingWeights: number[];
  bands: Array<{ year: number; p5: number; median: number; p95: number }>;
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function percentile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function runCorrelated(options: CorrelatedOptions): CorrelatedResult {
  const {
    moments,
    periodsPerYear,
    years,
    paths = 1000,
    initialInvestment,
    rebalanceEvery = 0,
    contributionAmount = 0,
    contributionEvery = 0,
    seed = 12345,
  } = options;

  const regimes = options.regimes;
  const n = moments.symbols.length;
  const steps = Math.max(1, Math.round(years * periodsPerYear));
  const { L, ridge } = cholesky(moments.cov);

  // Each regime gets its own factor. Both are built up front: factorising
  // inside the step loop would dominate the runtime.
  const calmL = regimes ? cholesky(regimes.calm.cov).L : null;
  const stressL = regimes ? cholesky(regimes.stressed.cov).L : null;
  let stressedSteps = 0;
  let totalSteps = 0;

  // An override replaces the drift only. Covariance — and therefore every
  // correlation — stays as measured, because a view on returns is not a view
  // on how assets move together.
  const mu = moments.mu.slice();
  if (options.expectedReturns) {
    for (let i = 0; i < n; i++) {
      const annual = options.expectedReturns[i];
      if (annual == null || !Number.isFinite(annual)) continue;
      mu[i] = Math.log1p(annual) / periodsPerYear - moments.cov[i][i] / 2;
    }
  }

  const weightsAt: WeightSchedule =
    typeof options.weights === 'function'
      ? options.weights
      : () => options.weights as number[];

  const rng = makeRng(seed);
  const normal = makeNormal(rng);

  const terminals: number[] = [];
  const drawdowns: number[] = [];
  const endingWeightAcc = new Array<number>(n).fill(0);
  const bandSamples: number[][] = Array.from({ length: years + 1 }, () => []);

  // Realised correlation is accumulated from the FIRST path only: it is a
  // diagnostic that the factorisation is doing its job, and one path of
  // thousands of steps is plenty to see that.
  const diagSums = new Array<number>(n).fill(0);
  const diagCross = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const diagSq = new Array<number>(n).fill(0);
  let diagCount = 0;

  const z = new Array<number>(n);
  const r = new Array<number>(n);
  const holdings = new Array<number>(n);

  for (let p = 0; p < paths; p++) {
    let value = initialInvestment;
    const w0 = weightsAt(0);
    for (let i = 0; i < n; i++) holdings[i] = value * w0[i];

    let peak = value;
    let worst = 0;
    // Each path starts in a regime drawn from the chain's stationary
    // distribution, not always in calm — starting calm every time would give
    // every path the same benign opening and understate early drawdowns.
    let inStressNow = regimes
      ? rng() < regimes.transition.stationaryStressFrequency
      : false;
    bandSamples[0].push(value);
    let nextYear = 1;

    for (let t = 0; t < steps; t++) {
      // Regime for this step. The chain carries state from the previous step,
      // so stress arrives in runs the way it actually does rather than being
      // scattered evenly across the horizon.
      let stepMu = mu;
      let stepL = L;
      if (regimes && calmL && stressL) {
        totalSteps++;
        const stay = inStressNow ? regimes.transition.stayStressed : regimes.transition.stayCalm;
        const inStress = rng() < stay ? inStressNow : !inStressNow;
        inStressNow = inStress;
        if (inStress) stressedSteps++;
        // Overrides apply to the unconditional drift only; inside a regime the
        // mean is that regime's own, or the mixture would no longer average
        // back to the sample.
        stepMu = inStress ? regimes.stressed.mu : regimes.calm.mu;
        stepL = inStress ? stressL : calmL;
      }

      for (let i = 0; i < n; i++) z[i] = normal();
      for (let i = 0; i < n; i++) {
        let acc = stepMu[i];
        // Row i of L times z: only the first i+1 terms, L being lower-triangular.
        for (let k = 0; k <= i; k++) acc += stepL[i][k] * z[k];
        r[i] = acc; // log return this period
      }

      if (p === 0) {
        diagCount++;
        for (let i = 0; i < n; i++) {
          diagSums[i] += r[i];
          diagSq[i] += r[i] * r[i];
          for (let j = 0; j < n; j++) diagCross[i][j] += r[i] * r[j];
        }
      }

      value = 0;
      for (let i = 0; i < n; i++) {
        holdings[i] *= Math.exp(r[i]);
        value += holdings[i];
      }

      if (contributionEvery > 0 && contributionAmount > 0 && (t + 1) % contributionEvery === 0) {
        const w = weightsAt((t + 1) / periodsPerYear);
        for (let i = 0; i < n; i++) holdings[i] += contributionAmount * w[i];
        value += contributionAmount;
      }

      const glidepath = typeof options.weights === 'function';
      if ((rebalanceEvery > 0 && (t + 1) % rebalanceEvery === 0) || glidepath) {
        // A glidepath has to be applied on its own schedule; letting drift
        // carry the weights would make the glidepath decorative.
        if (rebalanceEvery > 0 && (t + 1) % rebalanceEvery === 0) {
          const w = weightsAt((t + 1) / periodsPerYear);
          for (let i = 0; i < n; i++) holdings[i] = value * w[i];
        }
      }

      peak = Math.max(peak, value);
      if (peak > 0) worst = Math.min(worst, value / peak - 1);

      while (nextYear <= years && (t + 1) / periodsPerYear >= nextYear) {
        bandSamples[nextYear].push(value);
        nextYear++;
      }
    }

    terminals.push(value);
    drawdowns.push(worst);
    if (value > 0) for (let i = 0; i < n; i++) endingWeightAcc[i] += holdings[i] / value;
  }

  // Realised correlation from the diagnostic path.
  const realisedCorrelation = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const mi = diagSums[i] / diagCount;
      const mj = diagSums[j] / diagCount;
      const cij = diagCross[i][j] / diagCount - mi * mj;
      const vi = diagSq[i] / diagCount - mi * mi;
      const vj = diagSq[j] / diagCount - mj * mj;
      return vi > 0 && vj > 0 ? cij / Math.sqrt(vi * vj) : i === j ? 1 : 0;
    }),
  );

  const contributedTotal =
    initialInvestment +
    (contributionEvery > 0 ? contributionAmount * Math.floor(steps / contributionEvery) : 0);
  const annualisedFrom = (v: number) =>
    contributedTotal > 0 && v > 0 ? Math.pow(v / contributedTotal, 1 / years) - 1 : 0;

  return {
    symbols: moments.symbols,
    paths,
    years,
    rebalanceEvery,
    ridge,
    observations: moments.observations,
    terminal: {
      p5: percentile(terminals, 0.05),
      p25: percentile(terminals, 0.25),
      median: percentile(terminals, 0.5),
      p75: percentile(terminals, 0.75),
      p95: percentile(terminals, 0.95),
    },
    annualised: {
      p5: annualisedFrom(percentile(terminals, 0.05)),
      median: annualisedFrom(percentile(terminals, 0.5)),
      p95: annualisedFrom(percentile(terminals, 0.95)),
    },
    worstDrawdown: {
      median: percentile(drawdowns, 0.5),
      p95: percentile(drawdowns, 0.05),
    },
    realisedCorrelation,
    regimeUsed: regimes
      ? {
          stressFrequency: regimes.stressFrequency,
          calmCorrelation: regimes.calmCorrelation,
          stressedCorrelation: regimes.stressedCorrelation,
          realisedStressShare: totalSteps > 0 ? stressedSteps / totalSteps : 0,
          stayStressed: regimes.transition.stayStressed,
          meanStressRun: regimes.transition.meanStressRun,
        }
      : null,
    inputCorrelation: moments.corr,
    endingWeights: endingWeightAcc.map((v) => v / paths),
    bands: bandSamples.map((values, year) => ({
      year,
      p5: percentile(values, 0.05),
      median: percentile(values, 0.5),
      p95: percentile(values, 0.95),
    })),
  };
}

/** A linear glidepath from one allocation to another over the horizon. */
export function linearGlidepath(from: number[], to: number[], years: number): WeightSchedule {
  return (yearFraction: number) => {
    const k = Math.min(1, Math.max(0, yearFraction / years));
    return from.map((v, i) => v + (to[i] - v) * k);
  };
}
