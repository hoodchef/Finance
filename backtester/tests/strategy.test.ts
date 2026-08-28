import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/lib/engine/engine';
import {
  equalWeight,
  fixedWeights,
  glidepath,
  inverseVolatility,
  makeContext,
  momentum,
  trendFilter,
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

describe('equal weight', () => {
  it('splits evenly regardless of what was declared', () => {
    const cal = makeCalendar('2020-01-01', 30);
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, 30), weight: 90 },
      { symbol: 'B', prices: flat(100, 30), weight: 10 },
    ]).assets;
    const ctx = makeContext(10, cal, assets, new Map([['A', 0.9], ['B', 0.1]]), 1000);
    expect(equalWeight.targetWeights(ctx)).toEqual(new Map([['A', 0.5], ['B', 0.5]]));
  });

  it('is a rule, not a one-off normalisation', () => {
    // The point of it over retyping the weights: a portfolio typed as equal
    // stops being equal as prices diverge, and this holds it there.
    const cal = makeCalendar('2020-01-01', 400);
    const run = (strategy?: Parameters<typeof runEngine>[0]['strategy']) =>
      runEngine({
        portfolio: portfolio([['A', 50], ['B', 50]]),
        config: testConfig({ rebalance: 'monthly' }),
        data: buildPrepared(cal, [
          { symbol: 'A', prices: ramp(100, 400, 400), weight: 50 },
          { symbol: 'B', prices: flat(100, 400), weight: 50 },
        ]),
        strategy,
      });
    // Same start, same rebalancing: equal weight tracks the declared 50/50.
    const withRule = run(equalWeight).daily.at(-1)!.totalValue;
    const declared = run().daily.at(-1)!.totalValue;
    expect(withRule).toBeCloseTo(declared, 6);
  });
});

describe('trend filter', () => {
  const cal = makeCalendar('2020-01-01', 60);

  it('holds while price is above its moving average', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 200, 60), weight: 100 },
    ]).assets;
    const ctx = makeContext(59, cal, assets, new Map([['A', 1]]), 1000);
    // A rising series is above its own trailing average.
    expect(trendFilter({ windowDays: 20 }).targetWeights(ctx).get('A')).toBe(1);
  });

  it('goes to cash while price is below it', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(200, 100, 60), weight: 100 },
    ]).assets;
    const ctx = makeContext(59, cal, assets, new Map([['A', 1]]), 1000);
    expect(trendFilter({ windowDays: 20 }).targetWeights(ctx).get('A')).toBe(0);
  });

  it('keeps each holding at its declared weight rather than concentrating', () => {
    // A filtered-out holding must go to cash, not hand its weight to whatever
    // is still rising — that would turn a defensive rule into a momentum bet.
    const assets = buildPrepared(cal, [
      { symbol: 'UP', prices: ramp(100, 200, 60), weight: 60 },
      { symbol: 'DOWN', prices: ramp(200, 100, 60), weight: 40 },
    ]).assets;
    const ctx = makeContext(59, cal, assets, new Map([['UP', 0.6], ['DOWN', 0.4]]), 1000);
    const w = trendFilter({ windowDays: 20 }).targetWeights(ctx);
    expect(w.get('UP')).toBe(0.6);
    expect(w.get('DOWN')).toBe(0);
  });

  it('holds the declared weight until the window is full', () => {
    // Comparing against an average of three days is not a trend.
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(200, 100, 60), weight: 100 },
    ]).assets;
    const ctx = makeContext(3, cal, assets, new Map([['A', 1]]), 1000);
    expect(trendFilter({ windowDays: 20 }).targetWeights(ctx).get('A')).toBe(1);
  });

  it('cannot see past the decision day', () => {
    // Same history, different futures: the decision must be identical.
    const rising = buildPrepared(cal, [
      { symbol: 'A', prices: [...ramp(100, 150, 30), ...ramp(150, 400, 30)], weight: 100 },
    ]).assets;
    const falling = buildPrepared(cal, [
      { symbol: 'A', prices: [...ramp(100, 150, 30), ...ramp(150, 10, 30)], weight: 100 },
    ]).assets;
    const at = (assets: typeof rising) =>
      trendFilter({ windowDays: 20 })
        .targetWeights(makeContext(29, cal, assets, new Map([['A', 1]]), 1000))
        .get('A');
    expect(at(rising)).toBe(at(falling));
  });
});

describe('inverse volatility', () => {
  const cal = makeCalendar('2020-01-01', 200);

  /** A series alternating up and down by `pct` each day. */
  const choppy = (start: number, n: number, pct: number) => {
    const out: number[] = [];
    let v = start;
    for (let i = 0; i < n; i++) {
      out.push(v);
      v = i % 2 === 0 ? v * (1 + pct) : v / (1 + pct);
    }
    return out;
  };

  it('gives the calmer holding the larger weight', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'CALM', prices: choppy(100, 200, 0.002), weight: 50 },
      { symbol: 'WILD', prices: choppy(100, 200, 0.02), weight: 50 },
    ]).assets;
    const ctx = makeContext(150, cal, assets, new Map([['CALM', 0.5], ['WILD', 0.5]]), 1000);
    const w = inverseVolatility({ lookbackDays: 60 }).targetWeights(ctx);
    expect(w.get('CALM')!).toBeGreaterThan(w.get('WILD')!);
    expect(w.get('CALM')! + w.get('WILD')!).toBeCloseTo(1, 9);
  });

  it('weights in inverse proportion to volatility', () => {
    // Ten times the volatility should earn about a tenth of the weight.
    const assets = buildPrepared(cal, [
      { symbol: 'CALM', prices: choppy(100, 200, 0.002), weight: 50 },
      { symbol: 'WILD', prices: choppy(100, 200, 0.02), weight: 50 },
    ]).assets;
    const ctx = makeContext(150, cal, assets, new Map([['CALM', 0.5], ['WILD', 0.5]]), 1000);
    const w = inverseVolatility({ lookbackDays: 60 }).targetWeights(ctx);
    expect(w.get('CALM')! / w.get('WILD')!).toBeGreaterThan(5);
  });

  it('falls back to the declared weights before the window is full', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'A', prices: choppy(100, 200, 0.01), weight: 70 },
      { symbol: 'B', prices: choppy(100, 200, 0.01), weight: 30 },
    ]).assets;
    const declared = new Map([['A', 0.7], ['B', 0.3]]);
    const ctx = makeContext(5, cal, assets, declared, 1000);
    expect(inverseVolatility({ lookbackDays: 60 }).targetWeights(ctx)).toEqual(declared);
  });

  it('gives a motionless holding nothing rather than infinite weight', () => {
    const assets = buildPrepared(cal, [
      { symbol: 'FLAT', prices: flat(100, 200), weight: 50 },
      { symbol: 'MOVES', prices: choppy(100, 200, 0.01), weight: 50 },
    ]).assets;
    const ctx = makeContext(150, cal, assets, new Map([['FLAT', 0.5], ['MOVES', 0.5]]), 1000);
    const w = inverseVolatility({ lookbackDays: 60 }).targetWeights(ctx);
    expect(Number.isFinite(w.get('FLAT')!)).toBe(true);
    expect(w.get('FLAT')).toBe(0);
    expect(w.get('MOVES')).toBeCloseTo(1, 9);
  });
});
