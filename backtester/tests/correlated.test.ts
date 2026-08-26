import { describe, expect, it } from 'vitest';
import {
  CorrelatedError,
  cholesky,
  estimateMoments,
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
