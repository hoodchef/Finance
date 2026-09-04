import { describe, expect, it } from 'vitest';
import {
  binPrice,
  binomialCoefficient,
  binomialPmf,
  buildRidge,
  latticeOutcomes,
  layoutRelationshipGraph,
  percentile,
  riskNeutralUpProbability,
  runLattice,
} from '../src/lib/lattice/distribution';
import { blackScholes } from '../src/lib/options/pricing';

/**
 * The distribution lab, against arithmetic that exists outside this code.
 * =============================================================================
 * The claim the page makes is that its three pictures are one piece of
 * mathematics seen three ways. These check that claim rather than checking
 * that the drawing code ran: the lattice must reproduce the binomial the
 * option model prices against, and the ridge must reproduce the probability
 * Black-Scholes uses.
 */

describe('the binomial underneath the board', () => {
  it('computes coefficients that match Pascal', () => {
    expect(binomialCoefficient(5, 0)).toBe(1);
    expect(binomialCoefficient(5, 2)).toBe(10);
    expect(binomialCoefficient(5, 5)).toBe(1);
    expect(binomialCoefficient(10, 5)).toBe(252);
    // Out of range is zero, not a NaN that poisons a chart.
    expect(binomialCoefficient(5, 6)).toBe(0);
    expect(binomialCoefficient(5, -1)).toBe(0);
  });

  it('gives a pmf that sums to one', () => {
    for (const p of [0.2, 0.5, 0.73]) {
      let total = 0;
      for (let k = 0; k <= 16; k++) total += binomialPmf(16, k, p);
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('matches hand-worked values', () => {
    // Ten fair flips: P(exactly 5) = 252/1024.
    expect(binomialPmf(10, 5, 0.5)).toBeCloseTo(252 / 1024, 12);
    expect(binomialPmf(3, 0, 0.5)).toBeCloseTo(0.125, 12);
  });
});

describe('the lattice', () => {
  const inputs = { levels: 16, trials: 4000, pUp: 0.5, seed: 42 };

  it('replays exactly for a seed', () => {
    // A picture nobody can reproduce is one nobody can check.
    expect(runLattice(inputs).bins).toEqual(runLattice(inputs).bins);
  });

  it('drops every ball into exactly one bin', () => {
    const r = runLattice(inputs);
    expect(r.bins).toHaveLength(inputs.levels + 1);
    expect(r.bins.reduce((a, b) => a + b, 0)).toBe(inputs.trials);
  });

  it('converges on the binomial it is meant to be', () => {
    // The whole point of the picture: independent coin flips reproduce a
    // curve nobody drew. Checked as total variation across all bins.
    const r = runLattice({ ...inputs, trials: 40_000 });
    const total = r.bins.reduce((a, b) => a + b, 0);
    let deviation = 0;
    for (let k = 0; k < r.bins.length; k++) {
      deviation += Math.abs(r.bins[k] / total - r.expected[k] / total);
    }
    expect(deviation).toBeLessThan(0.05);
  });

  it('leans when the probability leans', () => {
    const fair = runLattice({ ...inputs, pUp: 0.5 });
    const up = runLattice({ ...inputs, pUp: 0.75 });
    const mean = (bins: number[]) =>
      bins.reduce((a, c, k) => a + c * k, 0) / bins.reduce((a, c) => a + c, 0);
    expect(mean(up.bins)).toBeGreaterThan(mean(fair.bins) + 2);
  });

  it('records sample paths of the right length', () => {
    const r = runLattice({ ...inputs, trials: 5 });
    expect(r.samplePaths).toHaveLength(5);
    for (const path of r.samplePaths) expect(path).toHaveLength(inputs.levels);
  });
});

describe('the board is the option model', () => {
  it('uses the risk-neutral probability a CRR tree uses', () => {
    // p = (e^((r-q)dt) - d) / (u - d), which is what makes the pile lean by
    // exactly the drift the model charges for.
    const args = {
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
      years: 1,
      steps: 50,
    };
    const p = riskNeutralUpProbability(args);
    const dt = 1 / 50;
    const u = Math.exp(0.2 * Math.sqrt(dt));
    const d = 1 / u;
    expect(p).toBeCloseTo((Math.exp(0.05 * dt) - d) / (u - d), 12);
    // With a positive drift the up-step is favoured, but only slightly.
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(0.55);
  });

  it('prices a bin the way the tree prices a node', () => {
    const args = { spot: 100, volatility: 0.2, years: 1, steps: 4 };
    // All up-moves: S * u^4.
    const u = Math.exp(0.2 * Math.sqrt(1 / 4));
    expect(binPrice({ ...args, upMoves: 4 })).toBeCloseTo(100 * u ** 4, 9);
    expect(binPrice({ ...args, upMoves: 0 })).toBeCloseTo(100 / u ** 4, 9);
    // A balanced path returns to the spot, which is what makes the tree recombine.
    expect(binPrice({ ...args, upMoves: 2 })).toBeCloseTo(100, 9);
  });

  it('produces a terminal distribution centred near the forward', () => {
    const steps = 60;
    const p = riskNeutralUpProbability({
      riskFreeRate: 0.05, dividendYield: 0, volatility: 0.2, years: 1, steps,
    });
    const result = runLattice({ levels: steps, trials: 20_000, pUp: p, seed: 3 });
    const prices = latticeOutcomes(result, { spot: 100, volatility: 0.2, years: 1 });
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    // The risk-neutral expectation is the forward, 100e^0.05 = 105.13.
    expect(mean).toBeGreaterThan(101);
    expect(mean).toBeLessThan(109);
  });
});

describe('the ridge', () => {
  const ridge = buildRidge({
    spot: 100,
    volatility: 0.25,
    riskFreeRate: 0.04,
    dividendYield: 0,
    horizons: [
      { years: 0.25, label: '3M' },
      { years: 1, label: '1Y' },
      { years: 3, label: '3Y' },
    ],
  });

  it('samples every band on one shared grid', () => {
    // Each on its own axis, the far horizons would look no wider than the near
    // ones — the opposite of what the picture is for.
    for (const band of ridge.bands) expect(band.density).toHaveLength(ridge.grid.length);
  });

  it('widens with the square root of time', () => {
    const [q, y, three] = ridge.bands;
    expect(y.oneSigma / q.oneSigma).toBeCloseTo(Math.sqrt(1 / 0.25), 6);
    expect(three.oneSigma / y.oneSigma).toBeCloseTo(Math.sqrt(3), 6);
  });

  it('flattens as the horizon lengthens', () => {
    // Same area under each curve, so a wider one must be lower.
    const peak = (d: number[]) => Math.max(...d);
    expect(peak(ridge.bands[0].density)).toBeGreaterThan(peak(ridge.bands[1].density));
    expect(peak(ridge.bands[1].density)).toBeGreaterThan(peak(ridge.bands[2].density));
  });

  it('integrates to one over the grid', () => {
    const step = ridge.grid[1] - ridge.grid[0];
    for (const band of ridge.bands) {
      const area = band.density.reduce((a, d) => a + d * step, 0);
      // The grid is truncated at four sigma of the longest horizon, so the
      // near bands are complete and the far one loses a sliver of tail.
      expect(area).toBeGreaterThan(0.93);
      expect(area).toBeLessThan(1.01);
    }
  });

  it('agrees with the probability Black-Scholes uses', () => {
    // P(S_T > K) is N(d2), the same quantity that prices the option.
    const r = buildRidge({
      spot: 100, volatility: 0.25, riskFreeRate: 0.04, dividendYield: 0,
      horizons: [{ years: 1, label: '1Y' }], reference: 110,
    });
    const d2 =
      (Math.log(100 / 110) + (0.04 - 0.5 * 0.0625) * 1) / (0.25 * 1);
    const expected = 1 - (1 - normApprox(d2));
    expect(r.bands[0].probabilityAbove).toBeCloseTo(expected, 6);
    // And it must be consistent with a real option price being non-zero.
    expect(blackScholes({
      spot: 100, strike: 110, timeToExpiry: 1, riskFreeRate: 0.04,
      volatility: 0.25, type: 'call',
    }).price).toBeGreaterThan(0);
  });
});

function normApprox(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

describe('the relationship graph', () => {
  const symbols = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD'];
  // Equities correlate tightly; bonds and gold sit apart.
  const correlation = [
    [1.0, 0.95, 0.88, -0.35, 0.05],
    [0.95, 1.0, 0.82, -0.38, 0.02],
    [0.88, 0.82, 1.0, -0.30, 0.08],
    [-0.35, -0.38, -0.30, 1.0, 0.25],
    [0.05, 0.02, 0.08, 0.25, 1.0],
  ];

  it('lays out deterministically', () => {
    const a = layoutRelationshipGraph({ symbols, correlation, seed: 5 });
    const b = layoutRelationshipGraph({ symbols, correlation, seed: 5 });
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });

  it('keeps every node inside the unit disc', () => {
    const g = layoutRelationshipGraph({ symbols, correlation });
    for (const n of g.nodes) expect(Math.hypot(n.x, n.y)).toBeLessThanOrEqual(1.0001);
  });

  it('draws only edges above the threshold', () => {
    const g = layoutRelationshipGraph({ symbols, correlation, threshold: 0.5 });
    for (const e of g.edges) expect(Math.abs(e.correlation)).toBeGreaterThanOrEqual(0.5);
    // GLD correlates with nothing that strongly, so it has no edges at 0.5.
    expect(g.edges.some((e) => e.a === 'GLD' || e.b === 'GLD')).toBe(false);
  });

  it('pulls the correlated cluster closer than the diversifier', () => {
    // The point of the picture: things that move together sit together, so a
    // portfolio of "different" holdings that clusters is not diversified.
    const g = layoutRelationshipGraph({ symbols, correlation, seed: 11 });
    const at = (id: string) => g.nodes.find((n) => n.id === id)!;
    const dist = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    expect(dist('SPY', 'QQQ')).toBeLessThan(dist('SPY', 'TLT'));
  });

  it('scores centrality by average absolute correlation', () => {
    const g = layoutRelationshipGraph({ symbols, correlation });
    const at = (id: string) => g.nodes.find((n) => n.id === id)!;
    // SPY moves with almost everything; GLD with almost nothing.
    expect(at('SPY').centrality).toBeGreaterThan(at('GLD').centrality);
    expect(at('SPY').centrality).toBeCloseTo((0.95 + 0.88 + 0.35 + 0.05) / 4, 9);
  });

  it('survives a single holding and an empty portfolio', () => {
    expect(layoutRelationshipGraph({ symbols: [], correlation: [] }).nodes).toEqual([]);
    const one = layoutRelationshipGraph({ symbols: ['SPY'], correlation: [[1]] });
    expect(one.nodes).toHaveLength(1);
    expect(one.edges).toEqual([]);
    expect(one.nodes[0].centrality).toBe(0);
  });
});

describe('percentiles', () => {
  it('reads the sample in order', () => {
    const v = [5, 1, 4, 2, 3];
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 0.5)).toBe(3);
    expect(percentile(v, 0.99)).toBe(5);
  });

  it('returns zero for an empty sample rather than NaN', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});
