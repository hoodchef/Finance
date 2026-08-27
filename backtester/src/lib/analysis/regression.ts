/**
 * Ordinary least squares with Newey–West standard errors.
 * =============================================================================
 * Small, dense, and self-contained: factor models here have at most seven
 * regressors, so a direct solve is both simpler and more predictable than
 * pulling in a linear-algebra dependency.
 *
 * The standard errors matter more than the coefficients. Daily return
 * residuals are heteroskedastic and autocorrelated, and plain OLS standard
 * errors assume neither. They come out too small, which makes alpha look
 * significant when it is not — the single most consequential error a factor
 * panel can make. Both are computed and both are reported, so the gap between
 * them is visible rather than hidden behind a choice made here.
 */

export interface RegressionInput {
  /** Dependent variable, already in excess-of-risk-free terms. */
  y: number[];
  /** Regressors, each the same length as `y`. An intercept is added here. */
  x: Record<string, number[]>;
  /**
   * Newey–West lag truncation. Defaults to Newey and West's own rule,
   * floor(4·(n/100)^(2/9)), which is what most published tables use.
   */
  lags?: number;
  /** Periods per year, used only to annualise the intercept. */
  periodsPerYear?: number;
}

export interface Coefficient {
  name: string;
  estimate: number;
  /** Classical OLS standard error, assuming iid homoskedastic residuals. */
  stdError: number;
  /** Heteroskedasticity- and autocorrelation-consistent standard error. */
  stdErrorNW: number;
  /** t-statistic on the Newey–West standard error. */
  tStat: number;
  /** Two-sided p-value for the Newey–West t-statistic. */
  pValue: number;
}

export interface RegressionResult {
  observations: number;
  /** Number of estimated parameters, including the intercept. */
  parameters: number;
  neweyWestLags: number;
  /** The intercept, i.e. alpha. Reported separately because it is the answer. */
  alpha: Coefficient;
  /** Annualised intercept, linear convention: alpha × periodsPerYear. */
  alphaAnnualised: number;
  betas: Coefficient[];
  rSquared: number;
  adjRSquared: number;
  /** Residual standard deviation, per period. */
  residualStdDev: number;
}

export class RegressionError extends Error {}

/* ------------------------------------------------------------------ */
/* Linear algebra                                                      */
/* ------------------------------------------------------------------ */

/**
 * Inverts a small symmetric positive-definite matrix by Gauss–Jordan.
 *
 * Exported because the optimiser needs the same inverse of the same kind of
 * matrix; a second implementation would be a second thing to get wrong.
 */
export function invert(a: number[][]): number[][] {
  const n = a.length;
  // Work on a copy augmented with the identity.
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting. Without it, a factor that happens to be near-zero in
    // the sample produces a silently wrong inverse rather than a failure.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      throw new RegressionError(
        'The factors supplied are collinear over this window, so their separate ' +
          'contributions cannot be identified. Shorten the factor set or widen the window.',
      );
    }
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];

    const d = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/* ------------------------------------------------------------------ */
/* Distributions                                                       */
/* ------------------------------------------------------------------ */

/** Continued-fraction expansion for the incomplete beta function. */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

function lnGamma(z: number): number {
  // Lanczos approximation, g = 7, n = 9.
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = g[0];
  for (let i = 1; i < 9; i++) x += g[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularised incomplete beta I_x(a, b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value for a t-statistic on `df` degrees of freedom.
 *
 * The normal approximation is close enough at the thousands of observations a
 * decade of daily data provides, but a one-year window has 250 and the tails
 * are where the answer is read, so the exact distribution is used.
 */
export function tDistTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return Number.NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/* ------------------------------------------------------------------ */
/* Regression                                                          */
/* ------------------------------------------------------------------ */

/** Newey and West's own lag rule, floor(4·(n/100)^(2/9)). */
export function defaultLags(n: number): number {
  return Math.max(1, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
}

export function regress(input: RegressionInput): RegressionResult {
  const names = Object.keys(input.x);
  const n = input.y.length;
  const k = names.length + 1; // +1 for the intercept

  if (n === 0) throw new RegressionError('No overlapping observations to regress.');
  for (const name of names) {
    if (input.x[name].length !== n) {
      throw new RegressionError(`Factor "${name}" has ${input.x[name].length} points, not ${n}.`);
    }
  }
  if (n <= k) {
    throw new RegressionError(
      `${n} observations cannot identify ${k} parameters. Widen the window or drop factors.`,
    );
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(input.y[i])) throw new RegressionError(`Observation ${i} is not finite.`);
  }

  // Design matrix, intercept first.
  const X: number[][] = Array.from({ length: n }, (_, i) => [1, ...names.map((f) => input.x[f][i])]);
  const y = input.y;

  // X'X and X'y
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += X[i][a] * y[i];
      for (let b = a; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];

  const xtxInv = invert(xtx);
  const beta = xtxInv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));

  // Residuals and fit
  const resid = new Array<number>(n);
  let rss = 0;
  let ySum = 0;
  for (let i = 0; i < n; i++) ySum += y[i];
  const yBar = ySum / n;
  let tss = 0;
  for (let i = 0; i < n; i++) {
    let fitted = 0;
    for (let a = 0; a < k; a++) fitted += X[i][a] * beta[a];
    resid[i] = y[i] - fitted;
    rss += resid[i] * resid[i];
    tss += (y[i] - yBar) * (y[i] - yBar);
  }

  const df = n - k;
  const sigma2 = rss / df;

  // Classical standard errors: sigma^2 (X'X)^-1
  const seOls = Array.from({ length: k }, (_, a) => Math.sqrt(Math.max(0, sigma2 * xtxInv[a][a])));

  // Newey–West: (X'X)^-1 S (X'X)^-1, with S the Bartlett-weighted sum of
  // autocovariances of the score x_t·e_t.
  const L = input.lags ?? defaultLags(n);
  const S = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < n; i++) {
    const e = resid[i];
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) S[a][b] += e * e * X[i][a] * X[i][b];
    }
  }
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1); // Bartlett kernel: guarantees S stays PSD
    for (let i = l; i < n; i++) {
      const ee = resid[i] * resid[i - l];
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          S[a][b] += w * ee * (X[i][a] * X[i - l][b] + X[i - l][a] * X[i][b]);
        }
      }
    }
  }
  // sandwich = (X'X)^-1 S (X'X)^-1
  const tmp = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => xtxInv[a].reduce((s, v, j) => s + v * S[j][b], 0)),
  );
  const seNw = Array.from({ length: k }, (_, a) =>
    Math.sqrt(Math.max(0, tmp[a].reduce((s, v, j) => s + v * xtxInv[j][a], 0))),
  );

  const coef = (i: number, name: string): Coefficient => {
    const t = seNw[i] > 0 ? beta[i] / seNw[i] : Number.NaN;
    return {
      name,
      estimate: beta[i],
      stdError: seOls[i],
      stdErrorNW: seNw[i],
      tStat: t,
      pValue: tDistTwoSided(t, df),
    };
  };

  const rSquared = tss > 0 ? 1 - rss / tss : Number.NaN;

  return {
    observations: n,
    parameters: k,
    neweyWestLags: L,
    alpha: coef(0, 'Alpha'),
    alphaAnnualised: beta[0] * (input.periodsPerYear ?? 252),
    betas: names.map((name, j) => coef(j + 1, name)),
    rSquared,
    adjRSquared: tss > 0 ? 1 - ((1 - rSquared) * (n - 1)) / df : Number.NaN,
    residualStdDev: Math.sqrt(sigma2),
  };
}
