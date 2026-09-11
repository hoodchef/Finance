/**
 * Numerics for the valuation layer.
 *
 * Each routine here matches the library the reference model was built on
 * (numpy / scipy), because the port is held to that model to 1e-9 and a solver
 * or quantile that agrees "to plotting accuracy" would fail the fixture for
 * reasons unrelated to the model. Where this file departs from the library the
 * departure is stated.
 */
import { normCdf, normInv } from '@/lib/options/pricing';

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Inverse standard normal CDF to near machine precision.
 *
 * `normInv` (Acklam) is good to ~1.15e-9 relative, which is fine for drawing
 * samples but not for pinning a tornado's P10 input to scipy's `norm.ppf`. One
 * Halley step against `normCdf` — accurate to ~1e-15 — closes the gap. This is
 * the refinement Acklam's own note recommends; the shared function is left as
 * it is because the options pricer's fixtures were built on it.
 */
export function probit(p: number): number {
  const x = normInv(p);
  if (!Number.isFinite(x)) return x;
  const e = normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export class BracketError extends Error {}

/**
 * Brent's method, ported line for line from scipy's `brentq.c` with scipy's
 * defaults (xtol 2e-12, rtol 4·eps, 100 iterations), so a root found here and a
 * root found by the reference differ only by the arithmetic of `f` itself.
 *
 * Throws `BracketError` when f(a) and f(b) share a sign — the reverse DCF uses
 * that to say "no value of this lever reaches the price", which is an answer,
 * not a failure.
 */
export function brentq(
  f: (x: number) => number,
  xa: number,
  xb: number,
  { xtol = 2e-12, rtol = 4 * Number.EPSILON, maxiter = 100 } = {},
): number {
  let xpre = xa;
  let xcur = xb;
  let xblk = 0;
  let fblk = 0;
  let spre = 0;
  let scur = 0;
  let fpre = f(xpre);
  let fcur = f(xcur);
  if (fpre === 0) return xpre;
  if (fcur === 0) return xcur;
  if (Math.sign(fpre) === Math.sign(fcur)) {
    throw new BracketError('f(a) and f(b) must have different signs');
  }
  for (let i = 0; i < maxiter; i++) {
    if (fpre !== 0 && fcur !== 0 && Math.sign(fpre) !== Math.sign(fcur)) {
      xblk = xpre;
      fblk = fpre;
      spre = scur = xcur - xpre;
    }
    if (Math.abs(fblk) < Math.abs(fcur)) {
      xpre = xcur;
      xcur = xblk;
      xblk = xpre;
      fpre = fcur;
      fcur = fblk;
      fblk = fpre;
    }
    const delta = (xtol + rtol * Math.abs(xcur)) / 2;
    const sbis = (xblk - xcur) / 2;
    if (fcur === 0 || Math.abs(sbis) < delta) return xcur;

    if (Math.abs(spre) > delta && Math.abs(fcur) < Math.abs(fpre)) {
      let stry: number;
      if (xpre === xblk) {
        stry = (-fcur * (xcur - xpre)) / (fcur - fpre); // interpolate
      } else {
        const dpre = (fpre - fcur) / (xpre - xcur); // extrapolate
        const dblk = (fblk - fcur) / (xblk - xcur);
        stry = (-fcur * (fblk * dblk - fpre * dpre)) / (dblk * dpre * (fblk - fpre));
      }
      if (2 * Math.abs(stry) < Math.min(Math.abs(spre), 3 * Math.abs(sbis) - delta)) {
        spre = scur;
        scur = stry;
      } else {
        spre = sbis;
        scur = sbis;
      }
    } else {
      spre = sbis;
      scur = sbis;
    }
    xpre = xcur;
    fpre = fcur;
    xcur += Math.abs(scur) > delta ? scur : sbis > 0 ? delta : -delta;
    fcur = f(xcur);
  }
  return xcur;
}

/**
 * xoshiro128** seeded through splitmix32, returning 53-bit uniforms on the
 * OPEN interval (0, 1) — open because the draws go straight into an inverse
 * CDF, where 0 is −∞.
 *
 * The reference simulation used numpy's PCG64 + ziggurat. That stream cannot
 * be reproduced here and is not attempted: everything downstream of the
 * uniforms (copula, marginals, the engine) is pinned exactly by fixture, and
 * the simulation as a whole is checked statistically against the analyst's
 * 20,000-path result.
 */
export function makeUniform(seed: number): () => number {
  let a = seed | 0;
  const split = () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
  let s0 = split();
  let s1 = split();
  let s2 = split();
  let s3 = split();
  const next = () => {
    const r = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return r;
  };
  return () => {
    const hi = next() >>> 5; // 27 bits
    const lo = next() >>> 6; // 26 bits
    return (hi * 67108864 + lo + 0.5) / 9007199254740992;
  };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Lower-triangular Cholesky factor. Throws if the matrix is not positive definite. */
export function cholesky(C: readonly (readonly number[])[]): number[][] {
  const n = C.length;
  const L = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = C[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) throw new Error('matrix is not positive definite');
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/** Eigenvalues of a small symmetric matrix (cyclic Jacobi). Used to report the copula's PSD margin. */
export function symmetricEigenvalues(A: readonly (readonly number[])[]): number[] {
  const n = A.length;
  const a = A.map((r) => [...r]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
      }
    }
  }
  return a.map((r, i) => r[i]).sort((x, y) => x - y);
}

export function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (ddof = 1), as numpy's `std(ddof=1)` and Excel's STDEV. */
export function sampleStd(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Percentile with linear interpolation between order statistics — numpy's
 * default and Excel's PERCENTILE (= PERCENTILE.INC). numpy's lerp takes the
 * upper anchor when t ≥ 0.5; reproduced so the last bit agrees too.
 */
export function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (!n) return Number.NaN;
  const idx = (q / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n - 1);
  const t = idx - lo;
  const a = sorted[lo];
  const b = sorted[hi];
  const d = b - a;
  return t >= 0.5 ? b - d * (1 - t) : a + d * t;
}
