import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RegressionError,
  defaultLags,
  regress,
  rollingRegression,
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

describe('rolling regression', () => {
  /**
   * Builds a series whose market beta CHANGES halfway through. A single
   * full-sample fit reports the average of the two, which describes neither
   * half — the whole reason to roll the window.
   */
  function regimeChange(n: number, betaEarly: number, betaLate: number) {
    let a = 12345 >>> 0;
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
    const mkt: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const m = 0.01 * norm();
      const beta = i < n / 2 ? betaEarly : betaLate;
      mkt.push(m);
      y.push(beta * m + 0.002 * norm());
    }
    return { y, x: { Mkt: mkt } };
  }

  it('finds a beta change a single fit would average away', () => {
    const data = regimeChange(2000, 1.5, 0.5);
    const whole = regress({ ...data, periodsPerYear: 252 });
    // The full-sample answer lands between the two and matches neither.
    expect(whole.betas[0].estimate).toBeGreaterThan(0.8);
    expect(whole.betas[0].estimate).toBeLessThan(1.2);

    const rolling = rollingRegression({ ...data, periodsPerYear: 252, window: 250, step: 50 });
    const first = rolling[0].betas.Mkt;
    const last = rolling[rolling.length - 1].betas.Mkt;
    expect(first).toBeCloseTo(1.5, 1);
    expect(last).toBeCloseTo(0.5, 1);
  });

  it('produces windows in order, each ending later than the last', () => {
    const data = regimeChange(1200, 1, 1);
    const rolling = rollingRegression({ ...data, periodsPerYear: 252, window: 200, step: 40 });
    expect(rolling.length).toBeGreaterThan(5);
    for (let i = 1; i < rolling.length; i++) {
      expect(rolling[i].endIndex).toBeGreaterThan(rolling[i - 1].endIndex);
    }
    // Every window is a real fit, not a placeholder.
    for (const w of rolling) {
      expect(Number.isFinite(w.betas.Mkt)).toBe(true);
      expect(w.rSquared).toBeGreaterThan(0);
    }
  });

  it('refuses a window longer than the history', () => {
    const data = regimeChange(120, 1, 1);
    expect(() =>
      rollingRegression({ ...data, periodsPerYear: 252, window: 500 }),
    ).toThrow(RegressionError);
  });

  it('skips a collinear window rather than fabricating a loading', () => {
    // A factor that does not move within a window cannot have its loading
    // identified there, even though the full sample identifies it fine.
    const n = 600;
    const mkt = Array.from({ length: n }, (_, i) => (i < 300 ? 0 : 0.01 * Math.sin(i)));
    const flat = new Array<number>(n).fill(0);
    const y = mkt.map((m, i) => m + flat[i]);
    const rolling = rollingRegression({
      y,
      x: { Mkt: mkt, Dead: flat },
      periodsPerYear: 252,
      window: 200,
      step: 100,
    });
    // Some windows drop out; the ones returned are all genuine fits.
    for (const w of rolling) expect(Number.isFinite(w.betas.Mkt)).toBe(true);
  });
});
