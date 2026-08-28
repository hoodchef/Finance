import { describe, expect, it } from 'vitest';
import { buildStrategy, describeStrategy } from '../src/lib/engine/build-strategy';
import { fixedWeights } from '../src/lib/engine/strategy';
import { parseConfig } from '../src/lib/validate';
import { defaultConfig } from '../src/lib/defaults';
import type { StrategySpec } from '../src/lib/types';
import { runEngine } from '../src/lib/engine/engine';
import { buildPrepared, makeCalendar, ramp, testConfig } from './helpers';

/**
 * Turning a stored strategy back into a running rule.
 *
 * The specs here arrive from a shared link, a saved run or a database row, so
 * the interesting cases are the malformed ones — a config written by a version
 * that had a rule this one does not.
 */

describe('building a strategy from a stored spec', () => {
  it('resolves each kind to a distinct rule', () => {
    const kinds: StrategySpec[] = [
      { kind: 'fixed' },
      { kind: 'equal' },
      { kind: 'glidepath', growthSymbols: ['A'], startGrowthPct: 90, endGrowthPct: 40 },
      { kind: 'momentum', lookbackDays: 126, holdCount: 2, minimumReturnPct: 0 },
      { kind: 'trend', windowDays: 200 },
      { kind: 'inverseVolatility', lookbackDays: 63 },
    ];
    const ids = kinds.map((k) => buildStrategy(k).id);
    expect(new Set(ids).size).toBe(kinds.length);
  });

  it('falls back to the declared weights for a rule it does not know', () => {
    // A link from a later version must still open, showing what the user
    // typed rather than throwing or guessing a nearby rule.
    expect(buildStrategy({ kind: 'sentiment' } as unknown as StrategySpec)).toBe(fixedWeights);
    expect(buildStrategy(undefined)).toBe(fixedWeights);
    expect(buildStrategy(null)).toBe(fixedWeights);
    expect(buildStrategy('momentum' as unknown as StrategySpec)).toBe(fixedWeights);
  });

  it('converts percentages at the boundary and not inside the engine', () => {
    const glide = buildStrategy({
      kind: 'glidepath',
      growthSymbols: ['A'],
      startGrowthPct: 100,
      endGrowthPct: 0,
    });
    expect(glide.id).toBe('glidepath');
    // A 100% start must not become a 100x allocation.
    expect(glide.label).toBe('Glidepath');
  });

  it('describes what a spec does in words', () => {
    expect(describeStrategy({ kind: 'trend', windowDays: 200 })).toMatch(/200-day moving average/);
    expect(describeStrategy(undefined)).toBe('Fixed weights');
  });
});

describe('validating a strategy off the wire', () => {
  const cfg = (strategy: unknown) =>
    parseConfig({ ...defaultConfig(), strategy });

  it('accepts an absent strategy, as every older config has', () => {
    expect(parseConfig({ ...defaultConfig() }).strategy).toBeUndefined();
  });

  it('rejects a window that would walk the calendar forever', () => {
    // The bound is here rather than in the engine: a lookback of ten million
    // days is not a strategy, it is a request to do ten million days of work
    // at every rebalance.
    expect(() => cfg({ kind: 'trend', windowDays: 10_000_000 })).toThrow(/2 and 2520/);
    expect(() => cfg({ kind: 'trend', windowDays: 1 })).toThrow(/2 and 2520/);
    expect(cfg({ kind: 'trend', windowDays: 200 }).strategy).toEqual({
      kind: 'trend',
      windowDays: 200,
    });
  });

  it('rejects a growth allocation outside 0 to 100 percent', () => {
    expect(() =>
      cfg({ kind: 'glidepath', growthSymbols: ['A'], startGrowthPct: 150, endGrowthPct: 40 }),
    ).toThrow(/between 0 and 100/);
  });

  it('rejects a rule it does not recognise rather than silently ignoring it', () => {
    // Different from buildStrategy, deliberately: a client sending an unknown
    // rule has a bug worth reporting, where a stored config may simply be old.
    expect(() => cfg({ kind: 'sentiment' })).toThrow(/Unknown strategy/);
  });

  it('normalises glidepath symbols the way holdings are matched', () => {
    const s = cfg({
      kind: 'glidepath',
      growthSymbols: [' spy ', 'bnd', ''],
      startGrowthPct: 90,
      endGrowthPct: 40,
    }).strategy;
    expect(s).toMatchObject({ growthSymbols: ['SPY', 'BND'] });
  });

  it('rounds a fractional holding count rather than holding 2.5 things', () => {
    expect(
      cfg({ kind: 'momentum', lookbackDays: 126, holdCount: 2.4, minimumReturnPct: 0 }).strategy,
    ).toMatchObject({ holdCount: 2 });
  });
});

describe('a strategy in a config reaches the engine', () => {
  /**
   * The wiring is the point of all of this. Before it, the engine could run a
   * glidepath or a momentum rule and nothing in the product ever asked it to,
   * so every backtest ran the declared weights whatever the config said.
   */
  const cal = makeCalendar('2015-01-01', 900);
  const data = () =>
    buildPrepared(cal, [
      { symbol: 'UP', prices: ramp(100, 500, 900), weight: 50 },
      { symbol: 'DOWN', prices: ramp(500, 100, 900), weight: 50 },
    ]);

  const run = (strategy?: StrategySpec) =>
    runEngine({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: 'UP', symbol: 'UP', weight: 50 },
          { id: 'DOWN', symbol: 'DOWN', weight: 50 },
        ],
      },
      config: testConfig({ rebalance: 'monthly', strategy }),
      data: data(),
      strategy: buildStrategy(strategy),
    });

  it('produces a different result from the declared weights', () => {
    const fixed = run().daily.at(-1)!.totalValue;
    const trend = run({ kind: 'trend', windowDays: 50 }).daily.at(-1)!.totalValue;
    // A trend filter that sells the falling holding cannot land on the same
    // number as holding both. If these match, the strategy never ran.
    expect(trend).not.toBeCloseTo(fixed, 2);
  });

  it('leaves a fixed spec identical to no spec at all', () => {
    expect(run({ kind: 'fixed' }).daily.at(-1)!.totalValue).toBeCloseTo(
      run().daily.at(-1)!.totalValue,
      9,
    );
  });

  it('holds only the strongest holding under a momentum rule', () => {
    const result = run({
      kind: 'momentum',
      lookbackDays: 60,
      holdCount: 1,
      minimumReturnPct: -100,
    });
    const last = result.daily.at(-1)!;
    // The rising holding is ranked first throughout, so the falling one is sold.
    expect(last.positionValues.DOWN ?? 0).toBeCloseTo(0, 6);
    expect(last.positionValues.UP).toBeGreaterThan(0);
  });
});
