import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/lib/engine/engine';
import {
  fixedWeights,
  glidepath,
  makeContext,
  momentum,
} from '../src/lib/engine/strategy';
import { buildPrepared, flat, makeCalendar, ramp, testConfig } from './helpers';

const portfolio = (symbols: Array<[string, number]>) => ({
  id: 'p',
  name: 'P',
  positions: symbols.map(([symbol, weight]) => ({ id: symbol, symbol, weight })),
});

describe('the default strategy changes nothing', () => {
  it('reproduces the declared weights exactly', () => {
    const cal = makeCalendar('2020-01-01', 300);
    const spec = [
      { symbol: 'A', prices: ramp(100, 200, 300), weight: 60 },
      { symbol: 'B', prices: flat(100, 300), weight: 40 },
    ];
    const run = (strategy?: Parameters<typeof runEngine>[0]['strategy']) =>
      runEngine({
        portfolio: portfolio([['A', 60], ['B', 40]]),
        config: testConfig({ rebalance: 'monthly' }),
        data: buildPrepared(cal, spec),
        strategy,
      });

    // Passing the default explicitly must be indistinguishable from omitting it.
    expect(JSON.stringify(run(fixedWeights).daily)).toBe(JSON.stringify(run().daily));
  });
});

describe('look-ahead is structurally impossible', () => {
  it('clamps a request for a future price to today', () => {
    const cal = makeCalendar('2020-01-02', 10);
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], weight: 100 },
    ]).assets;

    const ctx = makeContext(3, cal, assets, new Map([['A', 1]]), 1000);
    expect(ctx.priceAt('A', 0)).toBe(40); // today
    expect(ctx.priceAt('A', 2)).toBe(20); // two sessions back
    // A negative lookback is a request for tomorrow; it returns today instead.
    expect(ctx.priceAt('A', -5)).toBe(40);
  });

  it('refuses a trailing return the window cannot support', () => {
    const cal = makeCalendar('2020-01-02', 10);
    const assets = buildPrepared(cal, [{ symbol: 'A', prices: ramp(10, 100, 10), weight: 100 }]).assets;
    // Only three days of history exist, so a ten-day window is not available.
    // Reporting a shorter one would rank holdings over unequal periods.
    expect(makeContext(3, cal, assets, new Map([['A', 1]]), 1000).trailingReturn('A', 10)).toBeNull();
    expect(makeContext(5, cal, assets, new Map([['A', 1]]), 1000).trailingReturn('A', 3)).not.toBeNull();
  });

  it('makes identical decisions when only the future differs', () => {
    // The definitive test: two datasets agreeing up to day 60 and diverging
    // wildly afterwards must produce identical records through day 60.
    const cal = makeCalendar('2020-01-01', 200);
    const shared = ramp(100, 140, 61);
    const strat = momentum({ lookbackDays: 20, holdCount: 1 });

    const build = (tail: number[]) =>
      buildPrepared(cal, [
        { symbol: 'A', prices: [...shared, ...tail], weight: 50 },
        { symbol: 'B', prices: flat(100, 200), weight: 50 },
      ]);

    const up = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data: build(ramp(140, 400, 139)),
      strategy: strat,
    });
    const down = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data: build(ramp(140, 20, 139)),
      strategy: strat,
    });

    for (let i = 0; i <= 60; i++) {
      expect(down.daily[i].totalValue).toBe(up.daily[i].totalValue);
      expect(down.daily[i].positionShares.A).toBe(up.daily[i].positionShares.A);
    }
    // And they must genuinely diverge afterwards, or the test proves nothing.
    expect(down.totals.finalValue).not.toBeCloseTo(up.totals.finalValue, 2);
  });
});

describe('glidepath', () => {
  const cal = makeCalendar('2020-01-01', 500);
  const data = () =>
    buildPrepared(cal, [
      { symbol: 'STOCK', prices: flat(100, 500), weight: 50 },
      { symbol: 'BOND', prices: flat(100, 500), weight: 50 },
    ]);

  it('shifts from growth to defensive over the horizon', () => {
    const r = runEngine({
      portfolio: portfolio([['STOCK', 50], ['BOND', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data: data(),
      strategy: glidepath({ growthSymbols: ['STOCK'], startGrowth: 0.9, endGrowth: 0.3 }),
    });

    const weightOf = (i: number, sym: string) =>
      r.daily[i].positionValues[sym] / r.daily[i].totalValue;

    // Prices are flat, so any change in weight is the strategy, not the market.
    expect(weightOf(0, 'STOCK')).toBeCloseTo(0.9, 2);
    expect(weightOf(r.daily.length - 1, 'STOCK')).toBeLessThan(0.4);
    expect(weightOf(r.daily.length - 1, 'STOCK')).toBeGreaterThan(0.25);
  });

  it('moves monotonically towards the destination', () => {
    const r = runEngine({
      portfolio: portfolio([['STOCK', 50], ['BOND', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data: data(),
      strategy: glidepath({ growthSymbols: ['STOCK'], startGrowth: 0.9, endGrowth: 0.3 }),
    });
    const rebalances = r.daily.filter((d) => d.rebalanced);
    const weights = rebalances.map((d) => d.positionValues.STOCK / d.totalValue);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1] + 1e-9);
    }
  });

  it('preserves the split within each sleeve', () => {
    const two = buildPrepared(cal, [
      { symbol: 'US', prices: flat(100, 500), weight: 42 },
      { symbol: 'INTL', prices: flat(100, 500), weight: 18 },
      { symbol: 'BOND', prices: flat(100, 500), weight: 40 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['US', 42], ['INTL', 18], ['BOND', 40]]),
      config: testConfig({ rebalance: 'monthly' }),
      data: two,
      strategy: glidepath({ growthSymbols: ['US', 'INTL'], startGrowth: 0.6, endGrowth: 0.6 }),
    });
    const d = r.daily[0];
    // The equity sleeve was declared 42/18, i.e. 70/30 internally. Holding it
    // at 60% of the portfolio should keep that ratio.
    expect(d.positionValues.US / (d.positionValues.US + d.positionValues.INTL)).toBeCloseTo(0.7, 3);
  });
});

describe('momentum', () => {
  const cal = makeCalendar('2020-01-01', 400);

  it('holds the stronger asset and sells the weaker', () => {
    const data = buildPrepared(cal, [
      { symbol: 'WINNER', prices: ramp(100, 400, 400), weight: 50 },
      { symbol: 'LOSER', prices: ramp(100, 60, 400), weight: 50 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['WINNER', 50], ['LOSER', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data,
      strategy: momentum({ lookbackDays: 60, holdCount: 1 }),
    });

    const last = r.daily[r.daily.length - 1];
    expect(last.positionValues.WINNER).toBeGreaterThan(0);
    expect(last.positionValues.LOSER).toBeCloseTo(0, 4);
  });

  it('goes to cash when nothing clears the threshold', () => {
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 50, 400), weight: 50 },
      { symbol: 'B', prices: ramp(100, 60, 400), weight: 50 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data,
      strategy: momentum({ lookbackDays: 60, holdCount: 1, minimumReturn: 0 }),
    });

    const last = r.daily[r.daily.length - 1];
    // Everything is falling, so the rule holds cash rather than the least bad.
    expect(last.cash / last.totalValue).toBeGreaterThan(0.9);
  });

  it('never levers the account above fully invested', () => {
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 300, 400), weight: 50 },
      { symbol: 'B', prices: ramp(100, 250, 400), weight: 50 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data,
      strategy: momentum({ lookbackDays: 60, holdCount: 2 }),
    });
    for (const d of r.daily) {
      expect(d.cash).toBeGreaterThanOrEqual(-0.01);
      const invested = Object.values(d.positionValues).reduce((s, v) => s + v, 0);
      expect(invested).toBeLessThanOrEqual(d.totalValue + 0.01);
    }
  });
});
