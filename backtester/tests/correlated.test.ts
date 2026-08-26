import { describe, expect, it } from 'vitest';
import {
  CorrelatedError,
  cholesky,
  estimateMoments,
  estimateRegimes,
  linearGlidepath,
  runCorrelated,
} from '../src/lib/analysis/correlated';

/**
 * Correlated simulation.
 * =============================================================================
 * The claim being tested is narrow and checkable: multiplying independent unit
 * normals by the Cholesky factor of Sigma yields vectors whose covariance is
 * Sigma. If that holds, the assets move together the way the estimate says they
 * did; if it silently does not, every diversification and rebalancing
 * conclusion drawn from this is wrong in a way no chart would reveal.
 */

/** Draws `T` correlated series with a known correlation, to fit against. */
function syntheticPair(T: number, rho: number, seed = 1): number[][] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const norm = () => {
    let u = 0;
    while (u <= 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const x: number[] = [];
  const y: number[] = [];
  for (let t = 0; t < T; t++) {
    const z1 = norm();
    const z2 = norm();
    x.push(Math.expm1(0.0003 + 0.01 * z1));
    y.push(Math.expm1(0.0002 + 0.01 * (rho * z1 + Math.sqrt(1 - rho * rho) * z2)));
  }
  return [x, y];
}

describe('Cholesky', () => {
  it('factorises so that L L′ reconstructs the matrix', () => {
    const cov = [
      [4, 2, 0.6],
      [2, 3, 0.4],
      [0.6, 0.4, 1],
    ];
    const { L, ridge } = cholesky(cov);
    expect(ridge).toBe(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let acc = 0;
        for (let k = 0; k < 3; k++) acc += L[i][k] * L[j][k];
        expect(acc).toBeCloseTo(cov[i][j], 10);
      }
    }
  });

  it('is lower triangular', () => {
    const { L } = cholesky([
      [2, 0.5],
      [0.5, 1],
    ]);
    expect(L[0][1]).toBe(0);
  });

  it('regularises a singular matrix rather than returning NaN', () => {
    // Two identical assets: perfectly collinear, so the sample covariance is
    // rank-deficient and the raw factorisation hits a zero pivot.
    const singular = [
      [1, 1],
      [1, 1],
    ];
    const { L, ridge } = cholesky(singular);
    expect(ridge).toBeGreaterThan(0);
    expect(L.every((row) => row.every((v) => Number.isFinite(v)))).toBe(true);
  });

  it('refuses an invalid matrix instead of regularising it into a valid one', () => {
    // A negative variance is not a covariance. An unbounded ridge would add
    // enough to the diagonal to make this factorise, returning a confident
    // answer about a matrix nobody supplied.
    expect(() => cholesky([[-1, 0], [0, -1]])).toThrow(CorrelatedError);
    expect(() => cholesky([[1, 0], [0, -0.5]])).toThrow(CorrelatedError);
    expect(() => cholesky([[0, 0], [0, 0]])).toThrow(CorrelatedError);
  });

  it('keeps the ridge small enough to be a numerical fix, not a rewrite', () => {
    const { ridge } = cholesky([[1, 1], [1, 1]]);
    // A millionth of the mean variance at most: it clears a zero pivot without
    // materially changing the correlations being simulated.
    expect(ridge).toBeGreaterThan(0);
    expect(ridge).toBeLessThan(1e-5);
  });
});

describe('moment estimation', () => {
  it('recovers a known correlation from the sample', () => {
    const [x, y] = syntheticPair(6000, 0.7);
    const m = estimateMoments(['A', 'B'], [x, y]);
    expect(m.corr[0][1]).toBeCloseTo(0.7, 1);
    expect(m.corr[0][0]).toBeCloseTo(1, 10);
    // Daily sigma of 1% was built in.
    expect(m.sigma[0]).toBeGreaterThan(0.008);
    expect(m.sigma[0]).toBeLessThan(0.012);
  });

  it('refuses series that do not share a calendar', () => {
    expect(() => estimateMoments(['A', 'B'], [[0.1, 0.2, 0.3], [0.1, 0.2]])).toThrow(
      CorrelatedError,
    );
  });

  it('refuses too few observations to identify the matrix', () => {
    expect(() => estimateMoments(['A', 'B'], [[0.01, 0.02], [0.01, 0.02]])).toThrow(
      CorrelatedError,
    );
  });
});

describe('the simulation reproduces the correlation it was given', () => {
  it.each([-0.4, 0, 0.5, 0.9])('holds at rho = %s', (rho) => {
    const [x, y] = syntheticPair(4000, rho, 7);
    const moments = estimateMoments(['A', 'B'], [x, y]);
    const out = runCorrelated({
      moments,
      weights: [0.5, 0.5],
      periodsPerYear: 252,
      years: 20,
      paths: 40,
      initialInvestment: 10_000,
      seed: 3,
    });
    // The simulation's own realised correlation against the estimate it was
    // handed. A transposed or mis-indexed L shows up here immediately.
    expect(out.realisedCorrelation[0][1]).toBeCloseTo(out.inputCorrelation[0][1], 1);
  });

  it('reports the ridge when one was needed', () => {
    const [x] = syntheticPair(3000, 0, 5);
    const moments = estimateMoments(['A', 'A-copy'], [x, x]);
    const out = runCorrelated({
      moments, weights: [0.5, 0.5], periodsPerYear: 252, years: 5,
      paths: 20, initialInvestment: 1000, seed: 1,
    });
    expect(out.ridge).toBeGreaterThan(0);
  });
});

describe('rebalancing, which the portfolio-level simulator cannot see', () => {
  const [x, y] = syntheticPair(5000, -0.2, 11);
  const moments = estimateMoments(['A', 'B'], [x, y]);
  const common = {
    moments, weights: [0.5, 0.5], periodsPerYear: 252, years: 25,
    paths: 400, initialInvestment: 10_000, seed: 21,
  };

  it('lets weights drift when never rebalancing', () => {
    const drift = runCorrelated({ ...common, rebalanceEvery: 0 });
    // The higher-drift asset ends up dominating; 50/50 does not survive 25y.
    const gap = Math.abs(drift.endingWeights[0] - 0.5);
    expect(gap).toBeGreaterThan(0.02);
    expect(drift.endingWeights[0] + drift.endingWeights[1]).toBeCloseTo(1, 6);
  });

  it('holds weights at target when rebalancing', () => {
    const rebal = runCorrelated({ ...common, rebalanceEvery: 21 });
    expect(rebal.endingWeights[0]).toBeCloseTo(0.5, 1);
  });

  it('reduces dispersion of outcomes versus letting it drift', () => {
    const drift = runCorrelated({ ...common, rebalanceEvery: 0 });
    const rebal = runCorrelated({ ...common, rebalanceEvery: 21 });
    const spread = (r: typeof drift) => Math.log(r.terminal.p95 / r.terminal.p5);
    // Rebalancing a negatively correlated pair trims the tails. This is the
    // conclusion the single-series simulator structurally cannot reach.
    expect(spread(rebal)).toBeLessThan(spread(drift));
  });
});

describe('glidepaths', () => {
  it('interpolates linearly and clamps outside the horizon', () => {
    const g = linearGlidepath([1, 0], [0, 1], 10);
    expect(g(0)).toEqual([1, 0]);
    expect(g(5)[0]).toBeCloseTo(0.5, 10);
    expect(g(10)).toEqual([0, 1]);
    expect(g(99)).toEqual([0, 1]);
  });

  it('ends near the glidepath destination, not the starting mix', () => {
    const [x, y] = syntheticPair(4000, 0.1, 13);
    const moments = estimateMoments(['Equity', 'Bond'], [x, y]);
    const out = runCorrelated({
      moments,
      weights: linearGlidepath([0.9, 0.1], [0.2, 0.8], 20),
      periodsPerYear: 252, years: 20, paths: 200,
      initialInvestment: 10_000, rebalanceEvery: 21, seed: 5,
    });
    expect(out.endingWeights[0]).toBeLessThan(0.35);
    expect(out.endingWeights[1]).toBeGreaterThan(0.65);
  });
});

describe('return overrides', () => {
  it('changes drift without disturbing the correlation', () => {
    const [x, y] = syntheticPair(4000, 0.6, 17);
    const moments = estimateMoments(['A', 'B'], [x, y]);
    const common = {
      moments, weights: [0.5, 0.5], periodsPerYear: 252, years: 15,
      paths: 60, initialInvestment: 10_000, seed: 9,
    };
    const base = runCorrelated(common);
    // The fitted history already implies ~15% a year here, so 15% would be no
    // override at all. Picking a number without checking what it replaces is
    // how an "override" test passes while proving nothing.
    const bullish = runCorrelated({ ...common, expectedReturns: [0.40, null] });
    const bearish = runCorrelated({ ...common, expectedReturns: [0.0, null] });
    expect(bullish.terminal.median).toBeGreaterThan(base.terminal.median);
    expect(bearish.terminal.median).toBeLessThan(base.terminal.median);
    // A view on returns is not a view on co-movement.
    expect(bullish.realisedCorrelation[0][1]).toBeCloseTo(base.realisedCorrelation[0][1], 1);
  });
});

describe('covariance shrinkage', () => {
  /** n assets, all pairwise correlation `rho`, drawn from a known truth. */
  function drawUniverse(n: number, T: number, rho: number, seed: number): number[][] {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const norm = () => {
      let u = 0;
      while (u <= 0) u = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const b = Math.sqrt(rho);
    const idio = Math.sqrt(1 - rho);
    const out: number[][] = Array.from({ length: n }, () => []);
    for (let t = 0; t < T; t++) {
      const common = norm();
      for (let i = 0; i < n; i++) out[i].push(Math.expm1(0.01 * (b * common + idio * norm())));
    }
    return out;
  }

  /** Mean squared error of the off-diagonal correlations against the truth. */
  function corrError(corr: number[][], rho: number): number {
    const n = corr.length;
    let acc = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        acc += (corr[i][j] - rho) * (corr[i][j] - rho);
        k++;
      }
    }
    return acc / k;
  }

  it('reduces correlation error when assets are many and history is short', () => {
    // 15 assets is 105 correlations from 120 observations. This is exactly the
    // regime where a raw sample matrix is confidently wrong.
    const TRUTH = 0.35;
    const data = drawUniverse(15, 120, TRUTH, 99);
    const raw = estimateMoments(
      data.map((_, i) => `A${i}`), data, { shrink: false },
    );
    const shrunk = estimateMoments(data.map((_, i) => `A${i}`), data);

    expect(shrunk.shrinkage).toBeGreaterThan(0);
    expect(corrError(shrunk.corr, TRUTH)).toBeLessThan(corrError(raw.corr, TRUTH));
  });

  /**
   * A universe whose correlations DIFFER from one another, via per-asset
   * loadings on a common factor: corr(i,j) = b_i·b_j.
   *
   * This matters. A constant-correlation universe IS the shrinkage target, so
   * the distance to it is ~0, the intensity saturates at 1, and full shrinkage
   * is both correct and harmless — which makes it useless for testing whether
   * intensity responds to sample size.
   */
  function drawHeterogeneous(loadings: number[], T: number, seed: number): number[][] {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const norm = () => {
      let u = 0;
      while (u <= 0) u = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const out: number[][] = loadings.map(() => []);
    for (let t = 0; t < T; t++) {
      const common = norm();
      loadings.forEach((b, i) => {
        out[i].push(Math.expm1(0.01 * (b * common + Math.sqrt(1 - b * b) * norm())));
      });
    }
    return out;
  }

  it('intervenes less as history grows', () => {
    // Loadings spread wide, so pairwise correlations range from ~0.09 to ~0.72
    // and the constant-correlation target is genuinely wrong for most pairs.
    const loadings = [0.95, 0.85, 0.6, 0.4, 0.25, 0.1];
    const names = loadings.map((_, i) => `A${i}`);
    const short = estimateMoments(names, drawHeterogeneous(loadings, 90, 7));
    const long = estimateMoments(names, drawHeterogeneous(loadings, 8000, 7));

    // The estimator's whole job: lean on the target when the sample is thin,
    // step back when it is not.
    expect(long.shrinkage).toBeLessThan(short.shrinkage);
    expect(long.shrinkage).toBeLessThan(0.2);
  });

  it('recovers distinct correlations when history is plentiful', () => {
    const loadings = [0.9, 0.8, 0.2];
    const m = estimateMoments(['A', 'B', 'C'], drawHeterogeneous(loadings, 8000, 11));
    // corr(i,j) = b_i * b_j
    expect(m.corr[0][1]).toBeCloseTo(0.72, 1);
    expect(m.corr[0][2]).toBeCloseTo(0.18, 1);
  });

  it('leaves variances untouched', () => {
    const data = drawUniverse(8, 200, 0.3, 3);
    const names = data.map((_, i) => `A${i}`);
    const raw = estimateMoments(names, data, { shrink: false });
    const shrunk = estimateMoments(names, data);
    // Each asset's own risk is estimated far more reliably than co-movement;
    // shrinking it to fix a joint problem would distort the wrong thing.
    for (let i = 0; i < 8; i++) {
      expect(shrunk.cov[i][i]).toBeCloseTo(raw.cov[i][i], 12);
      expect(shrunk.sigma[i]).toBeCloseTo(raw.sigma[i], 12);
    }
  });

  it('pulls correlations toward their average, not toward zero', () => {
    const data = drawUniverse(12, 150, 0.5, 21);
    const names = data.map((_, i) => `A${i}`);
    const raw = estimateMoments(names, data, { shrink: false });
    const shrunk = estimateMoments(names, data);
    const spread = (m: typeof raw) => {
      const off: number[] = [];
      for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) off.push(m.corr[i][j]);
      const mean = off.reduce((a, b) => a + b, 0) / off.length;
      return Math.sqrt(off.reduce((s, v) => s + (v - mean) ** 2, 0) / off.length);
    };
    // Dispersion falls; the average is preserved.
    expect(spread(shrunk)).toBeLessThan(spread(raw));
    expect(shrunk.averageCorrelation).toBeCloseTo(0.5, 1);
  });

  it('keeps the shrunk matrix factorisable', () => {
    const data = drawUniverse(10, 60, 0.6, 5);
    const m = estimateMoments(data.map((_, i) => `A${i}`), data);
    // Shrinkage toward a well-conditioned target should IMPROVE conditioning,
    // never break it — that is half the reason to do it.
    expect(() => cholesky(m.cov)).not.toThrow();
  });
});

describe('two-regime simulation', () => {
  /**
   * A universe where correlation genuinely differs by regime: on stressed days
   * everything moves with the common factor, on calm days much less. This is
   * the pattern the single-covariance model averages away.
   */
  function drawRegimeSwitching(n: number, T: number, seed: number): number[][] {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const norm = () => {
      let u = 0;
      while (u <= 0) u = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const out: number[][] = Array.from({ length: n }, () => []);
    for (let t = 0; t < T; t++) {
      const stressed = rand() < 0.12;
      const b = stressed ? 0.95 : 0.25;
      const vol = stressed ? 0.03 : 0.008;
      const drift = stressed ? -0.01 : 0.0012;
      const common = norm();
      for (let i = 0; i < n; i++) {
        out[i].push(Math.expm1(drift + vol * (b * common + Math.sqrt(1 - b * b) * norm())));
      }
    }
    return out;
  }

  const SYMS = ['A', 'B', 'C', 'D'];
  const data = drawRegimeSwitching(4, 3000, 42);

  it('finds a higher correlation in the stressed regime', () => {
    const r = estimateRegimes(SYMS, data, { quantile: 0.12 });
    // The whole premise: diversification is weakest exactly when it is needed.
    expect(r.stressedCorrelation).toBeGreaterThan(r.calmCorrelation);
    expect(r.stressFrequency).toBeCloseTo(0.12, 1);
  });

  it('refuses to split a window too short to fit both regimes', () => {
    const short = drawRegimeSwitching(4, 60, 1);
    expect(() => estimateRegimes(SYMS, short, { quantile: 0.1 })).toThrow(CorrelatedError);
  });

  it('draws stressed steps at the frequency it measured', () => {
    const regimes = estimateRegimes(SYMS, data, { quantile: 0.12 });
    const moments = estimateMoments(SYMS, data);
    const out = runCorrelated({
      moments, regimes, weights: [0.25, 0.25, 0.25, 0.25],
      periodsPerYear: 252, years: 20, paths: 30, initialInvestment: 10_000, seed: 4,
    });
    expect(out.regimeUsed).not.toBeNull();
    expect(out.regimeUsed!.realisedStressShare).toBeCloseTo(regimes.stressFrequency, 1);
  });

  it('separates the two regimes by volatility as well as correlation', () => {
    const r = estimateRegimes(SYMS, data, { quantile: 0.12 });
    const avgVol = (m: typeof r.calm) =>
      m.sigma.reduce((a, b) => a + b, 0) / m.sigma.length;
    // The classifier is a volatility classifier, so this is close to circular
    // — which is the point of asserting it. If the stressed regime were NOT
    // more volatile, the split has found nothing and every downstream claim
    // about it is empty.
    expect(avgVol(r.stressed)).toBeGreaterThan(avgVol(r.calm) * 1.5);
  });

  it('does not narrow the downside relative to a blended covariance', () => {
    // This series has INDEPENDENT regimes, so a chain fitted to it correctly
    // finds little persistence and the two models nearly agree. The claim that
    // regimes deepen a drawdown belongs with clustered data, and is tested
    // there. What must hold here is that modelling them never flatters the
    // tail.
    const moments = estimateMoments(SYMS, data);
    const regimes = estimateRegimes(SYMS, data, { quantile: 0.12 });
    const common = {
      moments, weights: [0.25, 0.25, 0.25, 0.25], periodsPerYear: 252,
      years: 25, paths: 800, initialInvestment: 10_000, rebalanceEvery: 21, seed: 8,
    };
    const blended = runCorrelated(common);
    const regimeAware = runCorrelated({ ...common, regimes });
    expect(regimeAware.worstDrawdown.p95).toBeLessThan(blended.worstDrawdown.p95 * 0.97);
  });

  it('keeps the mixture centred on the same long-run outcome', () => {
    // The mixture's unconditional mean equals the sample mean by construction,
    // because both regimes are fitted from a partition of one sample and drawn
    // at the observed frequency. Taking the stressed MEAN as a permanent drift
    // — the tempting shortcut — would make every path a catastrophe instead.
    const moments = estimateMoments(SYMS, data);
    const regimes = estimateRegimes(SYMS, data, { quantile: 0.12 });
    const common = {
      moments, weights: [0.25, 0.25, 0.25, 0.25], periodsPerYear: 252,
      years: 25, paths: 800, initialInvestment: 10_000, rebalanceEvery: 21, seed: 12,
    };
    const blended = runCorrelated(common);
    const regimeAware = runCorrelated({ ...common, regimes });

    const ratio = regimeAware.terminal.median / blended.terminal.median;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.25);
  });

  it('reports no regime detail when none was supplied', () => {
    const moments = estimateMoments(SYMS, data);
    const out = runCorrelated({
      moments, weights: [0.25, 0.25, 0.25, 0.25], periodsPerYear: 252,
      years: 5, paths: 40, initialInvestment: 1000, seed: 2,
    });
    expect(out.regimeUsed).toBeNull();
  });
});

describe('shrinkage and regime reporting do not interfere', () => {
  function drawPair(T: number, rho: number, seed: number): number[][] {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const norm = () => {
      let u = 0;
      while (u <= 0) u = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const out: number[][] = [[], [], []];
    for (let t = 0; t < T; t++) {
      const c = norm();
      for (let i = 0; i < 3; i++) {
        out[i].push(Math.expm1(0.0004 + 0.01 * (Math.sqrt(rho) * c + Math.sqrt(1 - rho) * norm())));
      }
    }
    return out;
  }

  it('reports the same regime correlations with shrinkage on or off', () => {
    // Shrinkage pulls correlations TOWARD their average, so it leaves that
    // average unchanged. The calm/stressed comparison the panel shows is
    // therefore a property of the data, not of the estimator — worth pinning,
    // because a shrinkage target that moved the mean would silently flatten
    // exactly the difference the feature exists to surface.
    const data = drawPair(3000, 0.3, 77);
    const syms = ['A', 'B', 'C'];
    const on = estimateRegimes(syms, data, { quantile: 0.1, shrink: true });
    const off = estimateRegimes(syms, data, { quantile: 0.1, shrink: false });

    expect(on.calmCorrelation).toBeCloseTo(off.calmCorrelation, 9);
    expect(on.stressedCorrelation).toBeCloseTo(off.stressedCorrelation, 9);
  });

  it('still shrinks the matrix it simulates from', () => {
    const data = drawPair(400, 0.3, 5);
    const syms = ['A', 'B', 'C'];
    const on = estimateRegimes(syms, data, { quantile: 0.15, shrink: true });
    const off = estimateRegimes(syms, data, { quantile: 0.15, shrink: false });
    // The average is preserved, but dispersion around it is not — that is the
    // shrinkage doing its job on the matrix actually fed to Cholesky.
    expect(on.stressed.shrinkage).toBeGreaterThan(0);
    expect(off.stressed.shrinkage).toBe(0);
  });
});

describe('regime persistence', () => {
  /** Stress arrives in runs of ~15 days, the way it actually does. */
  function drawClustered(n: number, T: number, seed: number): number[][] {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const norm = () => {
      let u = 0;
      while (u <= 0) u = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const out: number[][] = Array.from({ length: n }, () => []);
    let stressed = false;
    for (let t = 0; t < T; t++) {
      // stay-stressed 0.93 -> runs of ~14; stay-calm 0.99 -> ~12% of days.
      stressed = stressed ? rand() < 0.93 : rand() < 0.01;
      const b = stressed ? 0.95 : 0.25;
      const vol = stressed ? 0.03 : 0.008;
      const drift = stressed ? -0.012 : 0.0013;
      const common = norm();
      for (let i = 0; i < n; i++) {
        out[i].push(Math.expm1(drift + vol * (b * common + Math.sqrt(1 - b * b) * norm())));
      }
    }
    return out;
  }

  const SYMS = ['A', 'B', 'C', 'D'];
  const clustered = drawClustered(4, 4000, 31);

  it('detects that stress persists rather than arriving independently', () => {
    const r = estimateRegimes(SYMS, clustered, { quantile: 0.12 });
    // The point of the chain: yesterday being bad makes today more likely to
    // be bad than the base rate does.
    expect(r.transition.stayStressed).toBeGreaterThan(r.stressFrequency * 2);
    expect(r.transition.meanStressRun).toBeGreaterThan(3);
  });

  it('has a stationary frequency close to the observed one', () => {
    const r = estimateRegimes(SYMS, clustered, { quantile: 0.12 });
    // A chain whose stationary distribution drifted from the sample would
    // simulate a different world from the one that was measured.
    expect(r.transition.stationaryStressFrequency).toBeCloseTo(r.stressFrequency, 1);
  });

  it('reproduces the run length when simulating', () => {
    const r = estimateRegimes(SYMS, clustered, { quantile: 0.12 });
    const moments = estimateMoments(SYMS, clustered);
    const out = runCorrelated({
      moments, regimes: r, weights: [0.25, 0.25, 0.25, 0.25],
      periodsPerYear: 252, years: 20, paths: 40, initialInvestment: 10_000, seed: 6,
    });
    expect(out.regimeUsed!.realisedStressShare).toBeCloseTo(r.stressFrequency, 1);
    expect(out.regimeUsed!.meanStressRun).toBeGreaterThan(3);
  });

  it('deepens drawdowns relative to scattering the same bad days', () => {
    // Same proportion of stressed days either way. Clustering them is what
    // turns a drawdown into a deep one, and it is the whole reason the chain
    // exists rather than an independent draw at the base rate.
    const r = estimateRegimes(SYMS, clustered, { quantile: 0.12 });
    const scattered = {
      ...r,
      transition: {
        // A chain with no memory: P(stress | anything) = base rate.
        stayCalm: 1 - r.stressFrequency,
        stayStressed: r.stressFrequency,
        meanStressRun: 1 / (1 - r.stressFrequency),
        stationaryStressFrequency: r.stressFrequency,
      },
    };
    const moments = estimateMoments(SYMS, clustered);
    const common = {
      moments, weights: [0.25, 0.25, 0.25, 0.25], periodsPerYear: 252,
      years: 25, paths: 500, initialInvestment: 10_000, rebalanceEvery: 21, seed: 14,
    };
    const persistent = runCorrelated({ ...common, regimes: r });
    const independent = runCorrelated({ ...common, regimes: scattered });

    expect(persistent.worstDrawdown.median).toBeLessThan(independent.worstDrawdown.median);
  });
});
