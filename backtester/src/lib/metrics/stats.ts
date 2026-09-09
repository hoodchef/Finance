/** Small numeric helpers. Kept separate so every formula has one definition. */

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n − 1). */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated percentile, `p` in [0, 1]. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function covariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (xs[i] - mx) * (ys[i] - my);
  return acc / (n - 1);
}

export function correlation(xs: number[], ys: number[]): number {
  const sx = stdev(xs);
  const sy = stdev(ys);
  if (sx === 0 || sy === 0) return 0;
  return covariance(xs, ys) / (sx * sy);
}

/**
 * Sample autocorrelation of a series at one lag.
 *
 * CONVENTION. The estimator divides by the FULL sum of squared deviations
 * (n terms) rather than by the n − k terms that actually enter the numerator.
 * That is the standard "biased" definition used by every ACF plot and by
 * Newey-West-style corrections; it shrinks toward zero at long lags, which is
 * the behaviour that keeps a sample ACF positive-semidefinite. The alternative
 * — dividing by n − k — is unbiased per lag and can produce |ρ| > 1, and the
 * two disagree materially once the lag is a noticeable fraction of the sample.
 *
 * The mean is estimated over the whole series, once, for both legs. Returns
 * null when the lag cannot be measured (too few points) and when the series is
 * flat, because a constant series has no correlation to report and zero would
 * read as "no persistence" rather than "no variance".
 */
export function autocorrelation(xs: readonly number[], lag: number): number | null {
  const n = xs.length;
  if (!Number.isInteger(lag) || lag < 1 || n <= lag) return null;

  const m = mean([...xs]);
  let denom = 0;
  for (const x of xs) denom += (x - m) ** 2;
  if (!(denom > 1e-12)) return null;

  let cov = 0;
  for (let i = lag; i < n; i++) cov += (xs[i] - m) * (xs[i - lag] - m);

  const rho = cov / denom;
  return Number.isFinite(rho) ? rho : null;
}

/** Compounds a list of period returns into one cumulative return. */
export function chain(returns: number[]): number {
  let acc = 1;
  for (const r of returns) acc *= 1 + r;
  return acc - 1;
}

export function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
