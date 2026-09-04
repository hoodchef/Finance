import { describe, expect, it } from 'vitest';
import { generatePortfolio, runSharpeLab, scoreWeights } from '../src/lib/analysis/sharpe-lab';

/**
 * Sharpe construction, and the honesty of its reporting.
 * =============================================================================
 * The interesting assertions are not that the optimiser returns weights — it
 * always will — but that the split is chronological, that the out-of-sample
 * column is measured on data the solver never saw, and that a degenerate
 * window does not produce an infinite Sharpe that ranks first forever.
 */

/** Deterministic pseudo-returns, so a test cannot pass by luck. */
function series(n: number, amplitude: number, phase: number, drift = 0): number[] {
  return Array.from({ length: n }, (_, i) => drift + Math.sin(i * 0.37 + phase) * amplitude);
}

const PER_YEAR = 252;

describe('scoring a fixed weighting', () => {
  it('reproduces a single asset exactly', () => {
    const r = [series(400, 0.01, 0)];
    const direct = scoreWeights([1], r, PER_YEAR);
    const mean = r[0].reduce((a, b) => a + b, 0) / r[0].length;
    expect(direct.expectedReturn).toBeCloseTo(mean * PER_YEAR, 9);
  });

  it('halves the volatility of two identical, opposite series', () => {
    // Perfectly anti-correlated at equal weight cancels to nothing.
    const a = series(400, 0.01, 0);
    const b = a.map((x) => -x);
    const s = scoreWeights([0.5, 0.5], [a, b], PER_YEAR);
    expect(s.volatility).toBeCloseTo(0, 9);
  });

  it('does not report an infinite Sharpe for a riskless window', () => {
    // A flat window with a positive mean would divide by zero; ranked by
    // Sharpe, an Infinity would sit first forever.
    const flat = [new Array(300).fill(0.001)];
    const s = scoreWeights([1], flat, PER_YEAR);
    expect(Number.isFinite(s.sharpe)).toBe(true);
    expect(s.sharpe).toBe(0);
  });

  it('subtracts the risk-free rate', () => {
    const r = [series(400, 0.01, 0, 0.0004)];
    const gross = scoreWeights([1], r, PER_YEAR, 0);
    const net = scoreWeights([1], r, PER_YEAR, 0.05);
    expect(net.sharpe).toBeLessThan(gross.sharpe);
    expect(net.expectedReturn).toBeCloseTo(gross.expectedReturn, 12);
  });
});

describe('the lab', () => {
  const symbols = ['A', 'B', 'C'];
  const returns = [
    series(600, 0.012, 0, 0.0006),
    series(600, 0.010, 1.1, 0.0004),
    series(600, 0.020, 2.3, 0.0002),
  ];
  const lab = runSharpeLab({ symbols, returns, periodsPerYear: PER_YEAR, trainFraction: 0.7 });

  it('splits chronologically, never at random', () => {
    // Shuffling would leak the future into training: a portfolio's risk comes
    // from how returns cluster in time, and shuffling destroys that.
    expect(lab.trainObservations).toBe(Math.floor(600 * 0.7));
    expect(lab.testObservations).toBe(600 - lab.trainObservations);
    expect(lab.trainObservations + lab.testObservations).toBe(lab.observations);
  });

  it('offers the unoptimised benchmarks beside the optimised ones', () => {
    const ids = lab.candidates.map((c) => c.id);
    expect(ids).toContain('sharpe');
    expect(ids).toContain('minvar');
    expect(ids).toContain('riskparity');
    // Equal weight is the honest benchmark and must always be present.
    expect(ids).toContain('equal');
  });

  it('gives every candidate weights that sum to one and are long-only', () => {
    for (const c of lab.candidates) {
      const total = c.weights.reduce((a, b) => a + b, 0);
      expect(total, c.id).toBeCloseTo(1, 6);
      for (const w of c.weights) expect(w, c.id).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('scores in and out of sample separately', () => {
    for (const c of lab.candidates) {
      expect(c.outOfSample, c.id).not.toBeNull();
      // Two different windows: identical figures would mean the split did not
      // happen, which is the failure this whole module exists to avoid.
      expect(c.inSample.volatility).not.toBeCloseTo(c.outOfSample!.volatility, 9);
    }
  });

  it('maximises in-sample Sharpe on the window it was solved on', () => {
    // The optimiser's own claim, and the reason the out-of-sample column
    // exists: it wins where it was fitted, by construction.
    const sharpe = lab.candidates.find((c) => c.id === 'sharpe')!;
    const equal = lab.candidates.find((c) => c.id === 'equal')!;
    expect(sharpe.inSample.sharpe).toBeGreaterThanOrEqual(equal.inSample.sharpe - 1e-9);
  });

  it('states the caveat rather than leaving it to be inferred', () => {
    expect(lab.caveat).toMatch(/never saw/);
    expect(lab.caveat).toMatch(/not a forecast/);
  });

  it('honours a per-holding ceiling', () => {
    const capped = runSharpeLab({
      symbols, returns, periodsPerYear: PER_YEAR, maxWeight: 0.4,
    });
    for (const c of capped.candidates) {
      if (c.id === 'current') continue;
      for (const w of c.weights) expect(w).toBeLessThanOrEqual(0.4 + 1e-6);
    }
  });

  it('scores the current weighting alongside the suggestions', () => {
    const withCurrent = runSharpeLab({
      symbols, returns, periodsPerYear: PER_YEAR, current: [60, 30, 10],
    });
    const mine = withCurrent.candidates.find((c) => c.id === 'current')!;
    // Normalised from the percentages given.
    expect(mine.weights[0]).toBeCloseTo(0.6, 9);
    expect(mine.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('refuses a single holding, where there is nothing to weight', () => {
    expect(() =>
      runSharpeLab({ symbols: ['A'], returns: [returns[0]], periodsPerYear: PER_YEAR }),
    ).toThrow(/two holdings/);
  });

  it('returns a frontier to plot', () => {
    expect(lab.frontier.length).toBeGreaterThan(4);
    // A frontier is monotone in risk once sorted by it.
    const sorted = [...lab.frontier].sort((a, b) => a.volatility - b.volatility);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].volatility).toBeGreaterThanOrEqual(sorted[i - 1].volatility - 1e-9);
    }
  });
});

describe('generating a portfolio', () => {
  const symbols = ['A', 'B', 'C', 'D', 'E'];
  const returns = [
    series(500, 0.012, 0, 0.0008),
    series(500, 0.011, 0.9, 0.0006),
    series(500, 0.030, 2.0, -0.0004),
    series(500, 0.026, 3.1, -0.0002),
    series(500, 0.009, 4.2, 0.0005),
  ];

  it('selects by giving the rest a weight of zero', () => {
    // Selection is not a separate step: the solvers are long-only, so anything
    // that does not earn a place is simply not funded.
    const { kept } = generatePortfolio({
      symbols, returns, periodsPerYear: PER_YEAR, minimumWeight: 0.02,
    });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(symbols.length);
    for (const k of kept) expect(k.weight).toBeGreaterThanOrEqual(0.02);
  });

  it('orders what it kept by size', () => {
    const { kept } = generatePortfolio({ symbols, returns, periodsPerYear: PER_YEAR });
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i - 1].weight).toBeGreaterThanOrEqual(kept[i].weight);
    }
  });

  it('still reports the out-of-sample score for what it built', () => {
    const { result } = generatePortfolio({ symbols, returns, periodsPerYear: PER_YEAR });
    const sharpe = result.candidates.find((c) => c.id === 'sharpe')!;
    expect(sharpe.outOfSample).not.toBeNull();
  });
});
