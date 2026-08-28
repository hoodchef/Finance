import { describe, expect, it } from 'vitest';
import {
  capOverlay,
  compose,
  equalWeight,
  fixedWeights,
  makeContext,
  minimumVarianceStrategy,
  momentum,
  riskParityStrategy,
  trendOverlay,
  volatilityTargetOverlay,
} from '../src/lib/engine/strategy';
import { buildStrategy, describeStrategy, normaliseStrategy } from '../src/lib/engine/build-strategy';
import { buildPrepared, flat, makeCalendar, ramp } from './helpers';
import type { StrategySpec } from '../src/lib/types';

/**
 * A strategy as a base plus overlays.
 *
 * The combination that motivated all of this — hold the strongest, but step
 * out of anything that has rolled over — was inexpressible while every rule
 * read the declared weights and answered the whole question at once.
 */

const cal = makeCalendar('2020-01-01', 400);

/** A series alternating up and down by `pct` a day, around a flat level. */
const choppy = (start: number, n: number, pct: number) => {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    out.push(v);
    v = i % 2 === 0 ? v * (1 + pct) : v / (1 + pct);
  }
  return out;
};


/**
 * A seeded random walk. Distinct seeds give near-uncorrelated series, which
 * the optimiser needs: two perfectly correlated series make a singular
 * covariance, and `minimumVariance` refuses it rather than inverting garbage.
 */
const walk = (seed: number, n: number, vol: number, start = 100) => {
  let x = seed >>> 0;
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    out.push(v);
    // Lehmer generator: deterministic across runs, no dependency.
    x = (x * 48271) % 2147483647;
    v *= 1 + ((x / 2147483647) * 2 - 1) * vol;
  }
  return out;
};

describe('overlays compose onto any base', () => {
  it('filters a momentum selection by trend, which no single rule could', () => {
    // UP and MID both rise over the ranking window; MID has since rolled over.
    const assets = buildPrepared(cal, [
      { symbol: 'UP', prices: ramp(100, 400, 400), weight: 34 },
      { symbol: 'MID', prices: [...ramp(100, 300, 200), ...ramp(300, 120, 200)], weight: 33 },
      { symbol: 'DOWN', prices: ramp(400, 100, 400), weight: 33 },
    ]).assets;
    const declared = new Map([['UP', 0.34], ['MID', 0.33], ['DOWN', 0.33]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);

    const base = momentum({ lookbackDays: 300, holdCount: 2, minimumReturn: -1 });
    const picked = base.targetWeights(ctx);
    expect(picked.get('MID')).toBeGreaterThan(0);

    const filtered = compose(base, [trendOverlay({ windowDays: 100 })]).targetWeights(ctx);
    // MID survives the ranking and fails the trend, so it goes to cash.
    expect(filtered.get('MID')).toBe(0);
    expect(filtered.get('UP')).toBe(picked.get('UP'));
  });

  it('leaves anything an overlay removes in cash rather than reallocating it', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'UP', prices: ramp(100, 400, 400), weight: 50 },
      { symbol: 'DOWN', prices: ramp(400, 100, 400), weight: 50 },
    ]).assets;
    const declared = new Map([['UP', 0.5], ['DOWN', 0.5]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);
    const w = compose(fixedWeights, [trendOverlay({ windowDays: 50 })]).targetWeights(ctx);
    expect(w.get('UP')).toBe(0.5);
    expect(w.get('DOWN')).toBe(0);
    // Not renormalised to 1: the missing half is cash, which is the point.
    expect([...w.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 9);
  });

  it('applies overlays in order', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 400, 400), weight: 90 },
      { symbol: 'B', prices: ramp(100, 400, 400), weight: 10 },
    ]).assets;
    const declared = new Map([['A', 0.9], ['B', 0.1]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);
    const w = compose(fixedWeights, [capOverlay(0.5)]).targetWeights(ctx);
    expect(w.get('A')).toBeCloseTo(0.5, 9);
    expect(w.get('B')).toBeCloseTo(0.5, 9);
  });

  it('names the whole stack', () => {
    const s = compose(equalWeight, [trendOverlay({ windowDays: 200 }), capOverlay(0.25)]);
    expect(s.id).toBe('equal+trend200+cap25');
    expect(s.label).toContain('Equal weight');
    expect(s.label).toContain('200d average');
  });
});

describe('the position cap', () => {
  it('redistributes the excess to holdings with room', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, 400), weight: 80 },
      { symbol: 'B', prices: flat(100, 400), weight: 10 },
      { symbol: 'C', prices: flat(100, 400), weight: 10 },
    ]).assets;
    const ctx = makeContext(10, cal, assets, new Map([['A', 0.8], ['B', 0.1], ['C', 0.1]]), 1000);
    const w = capOverlay(0.4).apply(new Map([['A', 0.8], ['B', 0.1], ['C', 0.1]]), ctx);
    expect(w.get('A')).toBeCloseTo(0.4, 9);
    expect(w.get('B')! + w.get('C')!).toBeCloseTo(0.6, 6);
  });

  it('stops rather than looping when nothing has room', () => {
    // A 20% cap over three holdings cannot invest more than 60%; the rest is
    // cash, not an infinite redistribution.
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, 400), weight: 34 },
      { symbol: 'B', prices: flat(100, 400), weight: 33 },
      { symbol: 'C', prices: flat(100, 400), weight: 33 },
    ]).assets;
    const ctx = makeContext(10, cal, assets, new Map(), 1000);
    const w = capOverlay(0.2).apply(
      new Map([['A', 0.34], ['B', 0.33], ['C', 0.33]]),
      ctx,
    );
    expect([...w.values()].every((v) => v <= 0.2 + 1e-9)).toBe(true);
    expect([...w.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(0.6, 6);
  });
});

describe('volatility targeting', () => {
  const target = (pct: number) =>
    volatilityTargetOverlay({ targetVol: pct, lookbackDays: 120, periodsPerYear: 252 });

  it('cuts exposure when realised volatility exceeds the target', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'WILD', prices: choppy(100, 400, 0.03), weight: 100 },
    ]).assets;
    const ctx = makeContext(399, cal, assets, new Map([['WILD', 1]]), 1000);
    const w = target(0.1).apply(new Map([['WILD', 1]]), ctx);
    expect(w.get('WILD')!).toBeLessThan(1);
    expect(w.get('WILD')!).toBeGreaterThan(0);
  });

  it('never levers above what the base asked for', () => {
    // A calm portfolio under a high target must stay at its weights: scaling
    // up in quiet years is leverage a backtest can claim and nobody traded.
    const assets = buildPrepared(cal, [
      { symbol: 'CALM', prices: choppy(100, 400, 0.0005), weight: 100 },
    ]).assets;
    const ctx = makeContext(399, cal, assets, new Map([['CALM', 1]]), 1000);
    const w = target(0.5).apply(new Map([['CALM', 0.6]]), ctx);
    expect(w.get('CALM')).toBeCloseTo(0.6, 9);
  });

  it('leaves the weights alone when there is too little history to measure', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: choppy(100, 400, 0.02), weight: 100 },
    ]).assets;
    const ctx = makeContext(5, cal, assets, new Map([['A', 1]]), 1000);
    // No measurement is not the same as no risk.
    expect(target(0.1).apply(new Map([['A', 1]]), ctx).get('A')).toBe(1);
  });

  it('sees correlated holdings as riskier than uncorrelated ones', () => {
    // Same per-asset volatility; one pair moves together, the other opposes.
    const together = buildPrepared(cal, [
      { symbol: 'A', prices: choppy(100, 400, 0.02), weight: 50 },
      { symbol: 'B', prices: choppy(100, 400, 0.02), weight: 50 },
    ]).assets;
    const opposed = buildPrepared(cal, [
      { symbol: 'A', prices: choppy(100, 400, 0.02), weight: 50 },
      { symbol: 'B', prices: choppy(100, 400, 0.02).map((_, i, arr) => arr[arr.length - 1 - i]), weight: 50 },
    ]).assets;
    const w = new Map([['A', 0.5], ['B', 0.5]]);
    const scaled = (assets: typeof together) =>
      target(0.1).apply(w, makeContext(399, cal, assets, w, 1000)).get('A')!;
    // Perfectly correlated holdings do not diversify, so exposure is cut more.
    expect(scaled(together)).toBeLessThanOrEqual(scaled(opposed) + 1e-9);
  });
});

describe('optimiser-backed bases', () => {
  const opts = { lookbackDays: 120, periodsPerYear: 252, shrink: true, maxWeight: 1 };

  it('gives the calmer holding more weight under minimum variance', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'CALM', prices: walk(1, 400, 0.002), weight: 50 },
      { symbol: 'WILD', prices: walk(7, 400, 0.02), weight: 50 },
    ]).assets;
    const declared = new Map([['CALM', 0.5], ['WILD', 0.5]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);
    const w = minimumVarianceStrategy(opts).targetWeights(ctx);
    expect(w.get('CALM')!).toBeGreaterThan(w.get('WILD')!);
    expect(w.get('CALM')! + w.get('WILD')!).toBeCloseTo(1, 6);
  });

  it('falls back to the declared weights before the window is full', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: walk(1, 400, 0.01), weight: 70 },
      { symbol: 'B', prices: walk(7, 400, 0.02), weight: 30 },
    ]).assets;
    const declared = new Map([['A', 0.7], ['B', 0.3]]);
    const ctx = makeContext(10, cal, assets, declared, 1000);
    // Too little history is ordinary early in a run, not a reason to abort it.
    expect(minimumVarianceStrategy(opts).targetWeights(ctx)).toEqual(declared);
  });

  it('honours the per-holding cap', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'CALM', prices: walk(1, 400, 0.001), weight: 50 },
      { symbol: 'WILD', prices: walk(7, 400, 0.05), weight: 50 },
    ]).assets;
    const declared = new Map([['CALM', 0.5], ['WILD', 0.5]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);
    const w = minimumVarianceStrategy({ ...opts, maxWeight: 0.6 }).targetWeights(ctx);
    expect(w.get('CALM')!).toBeLessThanOrEqual(0.6 + 1e-6);
  });

  it('spreads risk more evenly than minimum variance under risk parity', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'CALM', prices: walk(1, 400, 0.002), weight: 50 },
      { symbol: 'WILD', prices: walk(7, 400, 0.02), weight: 50 },
    ]).assets;
    const declared = new Map([['CALM', 0.5], ['WILD', 0.5]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);
    const mv = minimumVarianceStrategy(opts).targetWeights(ctx).get('WILD')!;
    const rp = riskParityStrategy(opts).targetWeights(ctx).get('WILD')!;
    // Risk parity keeps a real allocation to the riskier asset; minimum
    // variance is free to push it to almost nothing.
    expect(rp).toBeGreaterThan(mv);
  });

  it('refuses a singular covariance instead of inverting nonsense', () => {
    // Two perfectly correlated holdings make a rank-deficient matrix. Found by
    // writing this suite with a deterministic alternating fixture, where both
    // series moved in lockstep: minimum variance needs the inverse and cannot
    // have one, so it falls back rather than returning an arbitrary solution.
    // Risk parity, which needs only the volatilities, solves it fine.
    const lockstep = choppy(100, 400, 0.01);
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: lockstep, weight: 50 },
      { symbol: 'B', prices: lockstep.map((v) => v * 2), weight: 50 },
    ]).assets;
    const declared = new Map([['A', 0.5], ['B', 0.5]]);
    const ctx = makeContext(399, cal, assets, declared, 1000);
    expect(minimumVarianceStrategy(opts).targetWeights(ctx)).toEqual(declared);
  });

  it('cannot see past the decision day', () => {
    const same = walk(1, 400, 0.01);
    const rising = buildPrepared(cal, [
      { symbol: 'A', prices: same.map((v, i) => (i < 300 ? v : v * 3)), weight: 50 },
      { symbol: 'B', prices: walk(7, 400, 0.005), weight: 50 },
    ]).assets;
    const falling = buildPrepared(cal, [
      { symbol: 'A', prices: same.map((v, i) => (i < 300 ? v : v / 3)), weight: 50 },
      { symbol: 'B', prices: walk(7, 400, 0.005), weight: 50 },
    ]).assets;
    const declared = new Map([['A', 0.5], ['B', 0.5]]);
    const at = (assets: typeof rising) =>
      minimumVarianceStrategy(opts).targetWeights(makeContext(299, cal, assets, declared, 1000)).get('A');
    expect(at(rising)).toBe(at(falling));
  });
});

describe('normalising stored specs', () => {
  it('reads a bare trend spec as a fixed base under a trend overlay', () => {
    // The pre-composition shape. It read the declared weights and zeroed what
    // was below its average, which is exactly this.
    expect(normaliseStrategy({ kind: 'trend', windowDays: 200 })).toEqual({
      base: { kind: 'fixed' },
      overlays: [{ kind: 'trend', windowDays: 200 }],
    });
  });

  it('keeps a flat base with no overlays', () => {
    expect(normaliseStrategy({ kind: 'equal' })).toEqual({
      base: { kind: 'equal' },
      overlays: [],
    });
  });

  it('drops an overlay kind it does not know rather than failing to open', () => {
    const spec = {
      kind: 'composed',
      base: { kind: 'equal' },
      overlays: [{ kind: 'sentiment' }, { kind: 'cap', maxWeightPct: 25 }],
    } as unknown as StrategySpec;
    expect(normaliseStrategy(spec).overlays).toEqual([{ kind: 'cap', maxWeightPct: 25 }]);
  });

  it('describes a stack in reading order', () => {
    const d = describeStrategy({
      kind: 'composed',
      base: { kind: 'momentum', lookbackDays: 126, holdCount: 2, minimumReturnPct: 0 },
      overlays: [
        { kind: 'trend', windowDays: 200 },
        { kind: 'volatilityTarget', targetVolPct: 10, lookbackDays: 63 },
      ],
    });
    expect(d).toBe(
      'hold the strongest 2 over 126 days, then hold only what is above its 200-day average, ' +
        'then scale exposure toward 10% volatility',
    );
  });

  it('builds a composed spec into a stacked strategy', () => {
    const s = buildStrategy({
      kind: 'composed',
      base: { kind: 'equal' },
      overlays: [{ kind: 'cap', maxWeightPct: 25 }],
    });
    expect(s.id).toBe('equal+cap25');
  });
});
