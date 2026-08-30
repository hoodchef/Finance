import { describe, expect, it } from 'vitest';
import { candidateStrikes, optimise, type OptimiseRequest } from '../src/lib/options/optimise';

/**
 * The optimiser, and the one thing it must not pretend.
 * =============================================================================
 * Scoring candidates on expected value under the same model that priced them
 * gives every candidate zero — that is what risk-neutral pricing means. An
 * optimiser that ranked those numbers would be ranking floating-point noise
 * and presenting it as a recommendation. These check that the degenerate case
 * is detected and said out loud, and that objectives which do not depend on
 * drift still work either way.
 */

const BASE: OptimiseRequest = {
  underlying: 'TEST',
  spot: 100,
  asOf: '2026-01-15',
  riskFreeRate: 0.04,
  dividendYield: 0,
  pricingVolatility: 0.25,
  evaluation: { drift: 0.04, volatility: 0.25 },
  expiries: ['2026-07-17'],
  shapes: ['bull-call-spread', 'bull-put-spread', 'iron-condor'],
  objective: 'max-probability-of-profit',
  constraints: {},
  contracts: 1,
  multiplier: 100,
  maxCandidates: 1500,
};

describe('the strike grid', () => {
  it('centres on spot at a listed-looking increment', () => {
    const k = candidateStrikes(100);
    expect(k).toContain(100);
    expect(k.every((s) => s > 0)).toBe(true);
    // $5 increments in the $100 range.
    expect(k[1] - k[0]).toBe(5);
  });

  it('scales the increment with the price', () => {
    expect(candidateStrikes(600)[1] - candidateStrikes(600)[0]).toBe(10);
    expect(candidateStrikes(12)[1] - candidateStrikes(12)[0]).toBe(0.5);
  });
});

describe('risk-neutral degeneracy', () => {
  it('says so when evaluation matches pricing', () => {
    // The most important behaviour here. Under matching assumptions nothing
    // has an edge, and the ranking is noise — the optimiser has to admit it
    // rather than present a winner.
    const r = optimise({ ...BASE, objective: 'max-expected-value' });
    expect(r.notes.some((n) => /approximately zero/i.test(n))).toBe(true);
  });

  it('really does produce near-zero expected values there', () => {
    const r = optimise({ ...BASE, objective: 'max-expected-value' });
    for (const c of r.candidates.slice(0, 10)) {
      /*
       * Relative to the capital at risk, not an absolute dollar figure. What
       * remains is integration error over 800 slices of a kinked payoff, so it
       * scales with the size of the structure — an absolute threshold passes
       * on small spreads and fails on large ones for no reason. Under a real
       * view this ratio reaches 20-40%, so 1% is comfortably "no edge".
       */
      const relative = Math.abs(c.expectedValue) / Math.max(1, c.capital);
      expect(relative, c.label).toBeLessThan(0.01);
    }
  });

  it('stops saying so once the user expresses a view', () => {
    const bullish = optimise({
      ...BASE,
      objective: 'max-expected-value',
      evaluation: { drift: 0.25, volatility: 0.25 },
    });
    expect(bullish.notes.some((n) => /approximately zero/i.test(n))).toBe(false);
  });

  it('prefers upside structures under a bullish drift', () => {
    const bullish = optimise({
      ...BASE,
      shapes: ['bull-call-spread', 'bear-call-spread'],
      objective: 'max-expected-value',
      evaluation: { drift: 0.4, volatility: 0.25 },
    });
    // Believing the underlying will rise should favour the debit call spread
    // over selling one. If the drift did not reach the score, it would not.
    expect(bullish.candidates[0].shape).toBe('bull-call-spread');
  });

  it('flips to credit spreads under a bearish drift', () => {
    const bearish = optimise({
      ...BASE,
      shapes: ['bull-call-spread', 'bear-call-spread'],
      objective: 'max-expected-value',
      evaluation: { drift: -0.3, volatility: 0.25 },
    });
    expect(bearish.candidates[0].shape).toBe('bear-call-spread');
  });
});

describe('objectives', () => {
  it('ranks by probability of profit when asked to', () => {
    const r = optimise({ ...BASE, objective: 'max-probability-of-profit' });
    expect(r.candidates.length).toBeGreaterThan(0);
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1].probabilityOfProfit).toBeGreaterThanOrEqual(
        r.candidates[i].probabilityOfProfit,
      );
    }
  });

  it('treats an unlimited loss as the worst outcome, not the best', () => {
    // A naked short has maxLoss null. Ranking null as "no loss" would put the
    // riskiest structure at the top of a minimise-loss search.
    const r = optimise({
      ...BASE,
      shapes: ['short-put', 'bull-put-spread'],
      objective: 'min-max-loss',
    });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0].maxLoss).not.toBeNull();
  });

  it('gets as close to a target delta as the grid allows', () => {
    const r = optimise({
      ...BASE,
      shapes: ['long-call', 'long-put'],
      objective: 'target-delta',
      constraints: { targetDelta: 0 },
    });
    // Nearest to delta-neutral wins, whichever side it comes from.
    expect(Math.abs(r.candidates[0].delta)).toBeLessThan(Math.abs(r.candidates[5].delta));
  });

  it('minimises capital when asked', () => {
    const r = optimise({ ...BASE, objective: 'min-capital' });
    for (let i = 1; i < Math.min(6, r.candidates.length); i++) {
      expect(r.candidates[i - 1].capital).toBeLessThanOrEqual(r.candidates[i].capital);
    }
  });
});

describe('constraints', () => {
  it('rejects anything that can lose more than the cap', () => {
    const r = optimise({ ...BASE, constraints: { maxLoss: 300 } });
    for (const c of r.candidates) {
      expect(c.maxLoss).not.toBeNull();
      expect(Math.abs(c.maxLoss!)).toBeLessThanOrEqual(300);
    }
  });

  it('excludes unlimited-loss structures from a maximum-loss constraint', () => {
    const r = optimise({
      ...BASE,
      shapes: ['short-put'],
      constraints: { maxLoss: 1000 },
    });
    // Every short put here loses more than 1000 at zero, so none survive.
    expect(r.candidates.every((c) => c.maxLoss != null && Math.abs(c.maxLoss) <= 1000)).toBe(true);
  });

  it('honours a minimum probability of profit', () => {
    const r = optimise({ ...BASE, constraints: { minProbabilityOfProfit: 0.6 } });
    for (const c of r.candidates) expect(c.probabilityOfProfit).toBeGreaterThanOrEqual(0.6);
  });

  it('honours a credit requirement', () => {
    const r = optimise({ ...BASE, constraints: { minCredit: 50 } });
    for (const c of r.candidates) expect(-c.netDebit).toBeGreaterThanOrEqual(50);
  });

  it('keeps strikes inside the requested range', () => {
    const r = optimise({ ...BASE, constraints: { minStrike: 95, maxStrike: 110 } });
    for (const c of r.candidates) {
      for (const l of c.legs) {
        expect(l.strike).toBeGreaterThanOrEqual(95);
        expect(l.strike).toBeLessThanOrEqual(110);
      }
    }
  });

  it('reports when nothing survives rather than returning the least-bad', () => {
    const r = optimise({ ...BASE, constraints: { maxLoss: 0.01, minCredit: 1e9 } });
    expect(r.candidates).toHaveLength(0);
    expect(r.notes.some((n) => /No structure met every constraint/i.test(n))).toBe(true);
  });
});

describe('the search itself', () => {
  it('stays bounded', () => {
    const r = optimise({ ...BASE, maxCandidates: 200 });
    expect(r.evaluated).toBeLessThanOrEqual(200);
  });

  it('returns a shortlist rather than everything', () => {
    const r = optimise(BASE);
    expect(r.candidates.length).toBeLessThanOrEqual(25);
    expect(r.feasible).toBeGreaterThanOrEqual(r.candidates.length);
  });

  it('warns that a ranking is a selection problem', () => {
    expect(optimise(BASE).notes.some((n) => /selection problem/i.test(n))).toBe(true);
  });

  it('says the prices are theoretical', () => {
    expect(optimise(BASE).notes.some((n) => /not from live quotes/i.test(n))).toBe(true);
  });

  it('produces internally consistent candidates', () => {
    for (const c of optimise(BASE).candidates.slice(0, 8)) {
      expect(c.legs.length).toBeGreaterThan(0);
      expect(Number.isFinite(c.netDebit)).toBe(true);
      expect(Number.isFinite(c.capital)).toBe(true);
      expect(c.probabilityOfProfit).toBeGreaterThanOrEqual(0);
      expect(c.probabilityOfProfit).toBeLessThanOrEqual(1);
      // Every leg priced from the model carries a real premium.
      expect(c.legs.every((l) => l.entryPremium > 0)).toBe(true);
    }
  });
});
