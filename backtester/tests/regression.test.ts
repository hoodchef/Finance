import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RegressionError,
  defaultLags,
  regress,
  tDistTwoSided,
} from '../src/lib/analysis/regression';

/**
 * The estimator is checked against statsmodels, not against arithmetic written
 * here. `tests/fixtures/regression-reference.json` carries a 900-observation
 * design with AR(1), heteroskedastic residuals — chosen so the Newey–West and
 * classical standard errors genuinely disagree (~1.7x on alpha). With iid
 * residuals they coincide, and a fixture built that way would pass even if the
 * HAC sandwich were never implemented.
 */
const reference = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'regression-reference.json'), 'utf8'),
) as {
  lags: number;
  n: number;
  y: number[];
  x: Record<string, number[]>;
  expected: {
    params: Record<string, number>;
    seOls: Record<string, number>;
    seNW: Record<string, number>;
    tNW: Record<string, number>;
    pNW: Record<string, number>;
    rSquared: number;
    adjRSquared: number;
    residStd: number;
  };
};

/** Relative agreement, which is the meaningful test on numbers this small. */
function rel(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
}

describe('OLS against an independent implementation', () => {
  const fit = regress({ y: reference.y, x: reference.x, periodsPerYear: 252 });
  const all = [fit.alpha, ...fit.betas];

  it('uses Newey and West’s own lag rule', () => {
    expect(fit.neweyWestLags).toBe(reference.lags);
    expect(defaultLags(900)).toBe(6);
  });

  it('recovers the coefficients statsmodels reports', () => {
    for (const c of all) {
      expect(rel(c.estimate, reference.expected.params[c.name])).toBeLessThan(1e-10);
    }
  });

  it('recovers the classical standard errors', () => {
    for (const c of all) {
      expect(rel(c.stdError, reference.expected.seOls[c.name])).toBeLessThan(1e-10);
    }
  });

  it('recovers the Newey–West standard errors', () => {
    for (const c of all) {
      expect(rel(c.stdErrorNW, reference.expected.seNW[c.name])).toBeLessThan(1e-9);
    }
  });

  it('recovers the Newey–West t-statistics and p-values', () => {
    for (const c of all) {
      expect(rel(c.tStat, reference.expected.tNW[c.name])).toBeLessThan(1e-9);
      // statsmodels reports HAC p-values off the normal; this uses the exact t
      // on n-k degrees of freedom, which at n=900 differ only in the far tail.
      expect(Math.abs(c.pValue - reference.expected.pNW[c.name])).toBeLessThan(2e-3);
    }
  });

  it('recovers R², adjusted R², and residual dispersion', () => {
    expect(rel(fit.rSquared, reference.expected.rSquared)).toBeLessThan(1e-12);
    expect(rel(fit.adjRSquared, reference.expected.adjRSquared)).toBeLessThan(1e-12);
    expect(rel(fit.residualStdDev, reference.expected.residStd)).toBeLessThan(1e-12);
  });

  it('reports HAC errors that differ from the classical ones', () => {
    // Guards the fixture, not the code: if the design ever stops being
    // autocorrelated, every Newey–West assertion above becomes vacuous.
    expect(fit.alpha.stdErrorNW / fit.alpha.stdError).toBeGreaterThan(1.3);
  });

  it('annualises alpha by the linear convention', () => {
    expect(fit.alphaAnnualised).toBeCloseTo(fit.alpha.estimate * 252, 12);
  });
});

describe('exact and degenerate cases', () => {
  it('fits a noiseless line exactly', () => {
    const x = Array.from({ length: 50 }, (_, i) => i / 10);
    const fit = regress({ y: x.map((v) => 2 + 3 * v), x: { f: x } });
    expect(fit.alpha.estimate).toBeCloseTo(2, 10);
    expect(fit.betas[0].estimate).toBeCloseTo(3, 10);
    expect(fit.rSquared).toBeCloseTo(1, 12);
    expect(fit.residualStdDev).toBeCloseTo(0, 12);
  });

  it('refuses collinear regressors rather than returning a wrong answer', () => {
    const a = Array.from({ length: 60 }, (_, i) => Math.sin(i));
    // `b` is an exact multiple of `a`, so their separate betas are unidentified.
    expect(() => regress({ y: a.map((v) => v + 1), x: { a, b: a.map((v) => 2 * v) } })).toThrow(
      RegressionError,
    );
  });

  it('refuses a window too short to identify the parameters', () => {
    expect(() => regress({ y: [1, 2, 3], x: { a: [1, 2, 3], b: [1, 4, 9] } })).toThrow(
      RegressionError,
    );
  });

  it('refuses mismatched factor lengths', () => {
    expect(() => regress({ y: [1, 2, 3, 4], x: { a: [1, 2, 3] } })).toThrow(RegressionError);
  });

  it('refuses non-finite observations instead of propagating NaN', () => {
    expect(() => regress({ y: [1, 2, Number.NaN, 4, 5], x: { a: [1, 2, 3, 4, 5] } })).toThrow(
      RegressionError,
    );
  });
});

describe('the t distribution', () => {
  it('matches known two-sided critical values', () => {
    // t(0.025, 10) = 2.228; t(0.025, 30) = 2.042; t(0.025, inf) -> 1.960
    expect(tDistTwoSided(2.228, 10)).toBeCloseTo(0.05, 4);
    expect(tDistTwoSided(2.042, 30)).toBeCloseTo(0.05, 4);
    expect(tDistTwoSided(1.96, 100000)).toBeCloseTo(0.05, 4);
  });

  it('is symmetric and monotone', () => {
    expect(tDistTwoSided(1.5, 40)).toBeCloseTo(tDistTwoSided(-1.5, 40), 15);
    expect(tDistTwoSided(0, 40)).toBeCloseTo(1, 12);
    expect(tDistTwoSided(3, 40)).toBeLessThan(tDistTwoSided(2, 40));
  });
});
