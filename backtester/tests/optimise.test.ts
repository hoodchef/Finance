import { describe, expect, it } from 'vitest';
import {
  efficientFrontier,
  maximumSharpe,
  minimumVariance,
  riskParity,
} from '../src/lib/analysis/optimise';
import { CorrelatedError, type AssetMoments } from '../src/lib/analysis/correlated';

/**
 * The optimiser is checked against portfolios whose answers can be derived by
 * hand, not against its own output. Every case below has a closed form.
 */

/** Builds moments directly, so the estimate is exact rather than sampled. */
function moments(
  symbols: string[],
  annualReturns: number[],
  annualVols: number[],
  corr: number[][],
  periodsPerYear = 252,
): AssetMoments {
  const n = symbols.length;
  const sigma = annualVols.map((v) => v / Math.sqrt(periodsPerYear));
  const cov = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => corr[i][j] * sigma[i] * sigma[j]),
  );
  const mu = annualReturns.map(
    (r, i) => Math.log1p(r) / periodsPerYear - cov[i][i] / 2,
  );
  return { symbols, mu, cov, corr, sigma, observations: 2520, shrinkage: 0, averageCorrelation: 0 };
}

const PPY = 252;

describe('minimum variance', () => {
  it('splits two identical uncorrelated assets evenly', () => {
    const m = moments(['A', 'B'], [0.08, 0.08], [0.2, 0.2], [[1, 0], [0, 1]]);
    const out = minimumVariance({ moments: m, periodsPerYear: PPY });
    expect(out.weights[0]).toBeCloseTo(0.5, 2);
    // Two uncorrelated 20% assets at 50/50 give 20/sqrt(2) = 14.1%.
    expect(out.volatility).toBeCloseTo(0.2 / Math.SQRT2, 2);
  });

  it('matches the closed form for two uncorrelated assets of different risk', () => {
    // w_A = sigma_B^2 / (sigma_A^2 + sigma_B^2) when uncorrelated.
    const m = moments(['A', 'B'], [0.1, 0.05], [0.30, 0.10], [[1, 0], [0, 1]]);
    const expected = 0.10 ** 2 / (0.30 ** 2 + 0.10 ** 2); // = 0.1
    const out = minimumVariance({ moments: m, periodsPerYear: PPY });
    expect(out.weights[0]).toBeCloseTo(expected, 2);
  });

  it('ignores expected returns entirely', () => {
    // Which is the point: it is the estimate you can actually trust.
    const corr = [[1, 0.2], [0.2, 1]];
    const a = minimumVariance({ moments: moments(['A', 'B'], [0.02, 0.20], [0.2, 0.3], corr), periodsPerYear: PPY });
    const b = minimumVariance({ moments: moments(['A', 'B'], [0.20, 0.02], [0.2, 0.3], corr), periodsPerYear: PPY });
    expect(a.weights[0]).toBeCloseTo(b.weights[0], 3);
  });

  it('produces the lowest variance of any method offered', () => {
    const m = moments(['A', 'B', 'C'], [0.09, 0.06, 0.03], [0.20, 0.14, 0.06],
      [[1, 0.5, 0.1], [0.5, 1, 0.2], [0.1, 0.2, 1]]);
    const opts = { moments: m, periodsPerYear: PPY };
    const mv = minimumVariance(opts);
    expect(mv.volatility).toBeLessThanOrEqual(riskParity(opts).volatility + 1e-9);
    expect(mv.volatility).toBeLessThanOrEqual(maximumSharpe(opts).volatility + 1e-9);
  });

  it('never goes short', () => {
    // The unconstrained solution for these inputs wants a short leg.
    const m = moments(['A', 'B'], [0.08, 0.08], [0.10, 0.30], [[1, 0.95], [0.95, 1]]);
    const out = minimumVariance({ moments: m, periodsPerYear: PPY });
    expect(Math.min(...out.weights)).toBeGreaterThanOrEqual(0);
    expect(out.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 9);
  });
});

describe('risk parity', () => {
  it('equalises risk contribution, not weight', () => {
    const m = moments(['Equity', 'Bond'], [0.09, 0.03], [0.18, 0.06], [[1, 0.1], [0.1, 1]]);
    const out = riskParity({ moments: m, periodsPerYear: PPY });

    // Contribution_i = w_i * (Sigma w)_i / portfolio vol.
    const w = out.weights;
    const port = Math.sqrt(
      w.reduce((s, wi, i) => s + wi * w.reduce((t, wj, j) => t + wj * m.cov[i][j], 0), 0),
    );
    const contrib = w.map((wi, i) => (wi * w.reduce((t, wj, j) => t + wj * m.cov[i][j], 0)) / port);
    expect(contrib[0]).toBeCloseTo(contrib[1], 3);

    // And the resulting portfolio is nothing like 50/50: the low-risk leg
    // takes most of the capital. That gap is the whole reason to do this.
    expect(w[1]).toBeGreaterThan(0.65);
  });

  it('reduces to inverse volatility when correlations are equal', () => {
    // Exact in that case, so it is a real check rather than a re-run.
    const m = moments(['A', 'B', 'C'], [0.07, 0.07, 0.07], [0.30, 0.15, 0.10],
      [[1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.3, 1]]);
    const out = riskParity({ moments: m, periodsPerYear: PPY });
    const invVol = [1 / 0.30, 1 / 0.15, 1 / 0.10];
    const total = invVol.reduce((s, v) => s + v, 0);
    out.weights.forEach((w, i) => expect(w).toBeCloseTo(invVol[i] / total, 2));
  });
});

describe('maximum Sharpe', () => {
  it('beats the alternatives on the measure it optimises', () => {
    const m = moments(['A', 'B', 'C'], [0.12, 0.07, 0.03], [0.22, 0.13, 0.05],
      [[1, 0.4, 0.05], [0.4, 1, 0.15], [0.05, 0.15, 1]]);
    const opts = { moments: m, periodsPerYear: PPY, riskFree: 0.02 };
    const best = maximumSharpe(opts);
    expect(best.sharpe).toBeGreaterThanOrEqual(minimumVariance(opts).sharpe - 1e-9);
    expect(best.sharpe).toBeGreaterThanOrEqual(riskParity(opts).sharpe - 1e-9);
  });

  it('does respond to expected returns, unlike the other two', () => {
    const corr = [[1, 0.2], [0.2, 1]];
    const vols = [0.2, 0.2];
    const favourA = maximumSharpe({ moments: moments(['A', 'B'], [0.15, 0.04], vols, corr), periodsPerYear: PPY });
    const favourB = maximumSharpe({ moments: moments(['A', 'B'], [0.04, 0.15], vols, corr), periodsPerYear: PPY });
    expect(favourA.weights[0]).toBeGreaterThan(favourB.weights[0]);
  });

  it('honours a per-holding cap', () => {
    // Left uncapped, this concentrates almost entirely in A.
    const m = moments(['A', 'B', 'C'], [0.25, 0.05, 0.04], [0.20, 0.18, 0.19],
      [[1, 0.1, 0.1], [0.1, 1, 0.1], [0.1, 0.1, 1]]);
    const capped = maximumSharpe({ moments: m, periodsPerYear: PPY, maxWeight: 0.4 });
    expect(Math.max(...capped.weights)).toBeLessThanOrEqual(0.4 + 1e-6);
    expect(capped.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 9);
  });
});

describe('concentration is always reported', () => {
  it('distinguishes a diversified solution from a single bet', () => {
    const spread = moments(['A', 'B', 'C', 'D'], [0.07, 0.07, 0.07, 0.07],
      [0.15, 0.15, 0.15, 0.15],
      [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
    const out = minimumVariance({ moments: spread, periodsPerYear: PPY });
    // Herfindahl is 1/n at equal weights.
    expect(out.concentration).toBeCloseTo(0.25, 2);
    expect(out.effectiveHoldings).toBe(4);
  });
});

describe('the efficient frontier', () => {
  const m = moments(['A', 'B', 'C'], [0.12, 0.07, 0.03], [0.22, 0.13, 0.05],
    [[1, 0.4, 0.05], [0.4, 1, 0.15], [0.05, 0.15, 1]]);

  it('rises: more risk buys more return', () => {
    const curve = efficientFrontier({ moments: m, periodsPerYear: PPY, points: 12 });
    expect(curve.length).toBe(12);
    // Sorted by risk, and return should not fall as risk rises. Allow a small
    // tolerance: these are numerical solutions, not closed forms.
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].volatility).toBeGreaterThanOrEqual(curve[i - 1].volatility - 1e-9);
      expect(curve[i].expectedReturn).toBeGreaterThan(curve[i - 1].expectedReturn - 0.01);
    }
  });

  it('starts no lower-risk than the minimum-variance portfolio', () => {
    const curve = efficientFrontier({ moments: m, periodsPerYear: PPY, points: 10 });
    const mv = minimumVariance({ moments: m, periodsPerYear: PPY });
    expect(curve[0].volatility).toBeGreaterThan(mv.volatility - 0.005);
  });

  it('keeps every point long-only and fully invested', () => {
    for (const p of efficientFrontier({ moments: m, periodsPerYear: PPY, points: 8 })) {
      expect(Math.min(...p.weights)).toBeGreaterThanOrEqual(0);
      expect(p.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
    }
  });
});

describe('refusals', () => {
  it('explains collinear holdings in portfolio terms', () => {
    const m = moments(['A', 'A-clone'], [0.08, 0.08], [0.2, 0.2], [[1, 1], [1, 1]]);
    // Not a linear-algebra error from a module the user never called.
    expect(() => minimumVariance({ moments: m, periodsPerYear: PPY })).toThrow(CorrelatedError);
    expect(() => minimumVariance({ moments: m, periodsPerYear: PPY })).toThrow(/too alike/i);
  });

  it('handles a single holding without optimising anything', () => {
    const m = moments(['A'], [0.08], [0.2], [[1]]);
    expect(minimumVariance({ moments: m, periodsPerYear: PPY }).weights).toEqual([1]);
  });
});

describe('a per-holding cap binds every method equally', () => {
  const m = moments(['A', 'B', 'C'], [0.10, 0.05, 0.04], [0.20, 0.06, 0.08],
    [[1, 0.1, 0.2], [0.1, 1, 0.3], [0.2, 0.3, 1]]);
  const CAP = 0.5;
  const opts = { moments: m, periodsPerYear: PPY, maxWeight: CAP };

  it.each(['minimumVariance', 'riskParity', 'maximumSharpe'] as const)(
    '%s respects it',
    (method) => {
      const fn = { minimumVariance, riskParity, maximumSharpe }[method];
      const out = fn(opts);
      expect(Math.max(...out.weights)).toBeLessThanOrEqual(CAP + 1e-6);
      expect(out.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
    },
  );

  it('still leaves minimum variance the lowest-risk of the three', () => {
    // The bug this exists for: risk parity ignored the cap while the others
    // honoured it, so it could return a lower-risk portfolio than the
    // minimum-variance solution — impossible by definition, and visible in the
    // UI as minimum variance showing MORE risk than another row.
    const mv = minimumVariance(opts);
    expect(mv.volatility).toBeLessThanOrEqual(riskParity(opts).volatility + 1e-9);
    expect(mv.volatility).toBeLessThanOrEqual(maximumSharpe(opts).volatility + 1e-9);
  });

  it('falls back to equal weight when the cap cannot be satisfied', () => {
    // A cap below 1/n has no feasible solution; equal weight is the closest
    // thing to what was asked for.
    const out = minimumVariance({ moments: m, periodsPerYear: PPY, maxWeight: 0.2 });
    out.weights.forEach((w) => expect(w).toBeCloseTo(1 / 3, 6));
  });
});
