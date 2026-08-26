import { describe, expect, it } from 'vitest';
import { runMonteCarlo } from '../src/lib/analysis/montecarlo';

/**
 * The parametric side of the simulator.
 *
 * `montecarlo.test.ts` covers the bootstraps. These cover what can go wrong
 * when a distribution is asserted rather than resampled: a mis-parameterised
 * lognormal, an unstandardised Student-t, a withdrawal that is nominal when it
 * should be real, and a deflator applied in the wrong direction.
 */

/** Deterministic pseudo-history with roughly 16% annual volatility. */
const history = Array.from({ length: 2520 }, (_, i) => 0.0003 + 0.01 * Math.sin(i * 0.7));

const base = {
  returns: history,
  periodsPerYear: 252,
  initialInvestment: 10_000,
  seed: 7,
} as const;

describe('parametric paths land on the parameters they were given', () => {
  it('reproduces the analytic lognormal median', () => {
    const r = runMonteCarlo({
      ...base, years: 30, paths: 4000, method: 'normal',
      expectedReturn: 0.07, volatility: 0.15,
    });
    // For a lognormal, the median is exp(mu*T) with mu the LOG drift. Getting
    // the -sigma^2/2 correction wrong lands the median on the MEAN instead,
    // which at these parameters is 45% too high.
    const sigma = 0.15;
    const mu = Math.log(1.07) - (sigma * sigma) / 2;
    expect(r.terminal.median / (10_000 * Math.exp(mu * 30))).toBeCloseTo(1, 1);
  });

  it('standardises Student-t so it does not overshoot the target volatility', () => {
    // A raw t(4) has variance 2, so an unstandardised draw would inflate
    // realised volatility by ~41% over the number asked for.
    const t = runMonteCarlo({
      ...base, years: 10, paths: 4000, method: 'student-t', degreesOfFreedom: 4,
      expectedReturn: 0.07, volatility: 0.15,
    });
    const n = runMonteCarlo({
      ...base, years: 10, paths: 4000, method: 'normal',
      expectedReturn: 0.07, volatility: 0.15,
    });
    // Same variance means a similar spread of outcomes, within sampling noise.
    const spread = (r: typeof n) => Math.log(r.terminal.p95 / r.terminal.p5);
    expect(spread(t) / spread(n)).toBeGreaterThan(0.85);
    expect(spread(t) / spread(n)).toBeLessThan(1.15);
  });

  it('records whether each parameter was measured or asserted', () => {
    const assumed = runMonteCarlo({
      ...base, years: 10, paths: 200, method: 'normal',
      expectedReturn: 0.07, volatility: 0.15,
    });
    expect(assumed.parameters.expectedReturnSource).toBe('assumed');
    expect(assumed.parameters.volatilitySource).toBe('assumed');

    const measured = runMonteCarlo({ ...base, years: 10, paths: 200, method: 'normal' });
    expect(measured.parameters.expectedReturnSource).toBe('history');
    expect(measured.parameters.volatilitySource).toBe('history');
    // Estimated from the same series the bootstraps would resample.
    expect(measured.parameters.volatility).toBeGreaterThan(0.05);
    expect(measured.parameters.volatility).toBeLessThan(0.5);
  });

  it('fat tails wash out at long horizons, and the test says so', () => {
    // Not a defect. Summing thousands of iid draws is the central limit
    // theorem at work, and it is the reason volatility CLUSTERING — which the
    // block bootstrap keeps and an iid parametric draw cannot — is what
    // actually drives long-horizon risk. Pinned so nobody "fixes" it.
    const common = { ...base, years: 20, paths: 3000, expectedReturn: 0.07, volatility: 0.15 } as const;
    const n = runMonteCarlo({ ...common, method: 'normal' });
    const t = runMonteCarlo({ ...common, method: 'student-t', degreesOfFreedom: 4 });
    const ratio = Math.log(t.terminal.p95 / t.terminal.p5) / Math.log(n.terminal.p95 / n.terminal.p5);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

describe('decumulation', () => {
  const retiree = {
    ...base, initialInvestment: 100_000, years: 30, paths: 1500,
    method: 'normal' as const, withdrawalEvery: 21, inflation: 0.025,
  };

  it('depletes a portfolio drawn down faster than it grows', () => {
    const r = runMonteCarlo({
      ...retiree, expectedReturn: 0.05, volatility: 0.15, withdrawalAmount: 1500,
    });
    // ~18% of the starting balance a year: it cannot survive.
    expect(r.successRate).toBeLessThan(0.15);
    expect(r.medianRuinYear).not.toBeNull();
    expect(r.medianRuinYear!).toBeGreaterThan(1);
    expect(r.medianRuinYear!).toBeLessThan(30);
  });

  it('sustains a modest withdrawal', () => {
    const r = runMonteCarlo({
      ...retiree, expectedReturn: 0.07, volatility: 0.12, withdrawalAmount: 300,
    });
    expect(r.successRate).toBeGreaterThan(0.8);
  });

  it('grows the withdrawal with inflation rather than holding it nominal', () => {
    // A nominal withdrawal shrinks in real terms every year, which makes any
    // plan look safer than it is. Same dollar amount, more inflation, must
    // survive less often.
    const low = runMonteCarlo({
      ...retiree, inflation: 0.0, expectedReturn: 0.06, volatility: 0.12, withdrawalAmount: 500,
    });
    const high = runMonteCarlo({
      ...retiree, inflation: 0.05, expectedReturn: 0.06, volatility: 0.12, withdrawalAmount: 500,
    });
    expect(high.successRate).toBeLessThan(low.successRate);
  });

  it('reports success as 1 when there is nothing to withdraw', () => {
    const r = runMonteCarlo({ ...base, years: 10, paths: 200, method: 'normal' });
    expect(r.successRate).toBe(1);
    expect(r.medianRuinYear).toBeNull();
  });
});

describe('real terms', () => {
  it('deflates terminal values by exactly the compounded price level', () => {
    const r = runMonteCarlo({
      ...base, years: 20, paths: 800, method: 'normal',
      expectedReturn: 0.07, volatility: 0.15, inflation: 0.03,
    });
    expect(r.terminalReal.median / r.terminal.median).toBeCloseTo(1 / Math.pow(1.03, 20), 9);
    // Direction check: inflation makes you poorer, not richer.
    expect(r.terminalReal.median).toBeLessThan(r.terminal.median);
  });

  it('leaves real equal to nominal when inflation is zero', () => {
    const r = runMonteCarlo({ ...base, years: 10, paths: 400, method: 'normal' });
    expect(r.terminalReal.median).toBeCloseTo(r.terminal.median, 6);
  });
});

describe('the arithmetic/geometric distinction the panel reports', () => {
  it('estimates an arithmetic mean above the sample CAGR by about half the variance', () => {
    // The simulator is parameterised by the ARITHMETIC mean, because it
    // compounds period by period. A reader comparing it against a CAGR sees a
    // higher number and reasonably suspects a thumb on the scale, so the panel
    // states the relationship. This pins the claim.
    const r = runMonteCarlo({ ...base, years: 10, paths: 300, method: 'normal' });
    const { expectedReturn, volatility } = r.parameters;

    // Reconstruct the sample CAGR from the same history.
    const logSum = history.reduce((s, v) => s + Math.log1p(v), 0);
    const cagr = Math.exp((logSum / history.length) * 252) - 1;

    const gap = expectedReturn - cagr;
    const drag = (volatility * volatility) / 2;
    expect(gap).toBeGreaterThan(0);
    // Agreement to within a fifth of the drag itself; the identity is exact
    // only in the continuous limit.
    expect(Math.abs(gap - drag)).toBeLessThan(drag * 0.2 + 0.002);
  });
});
