import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/lib/backtest';
import { getDemoProvider } from '../src/lib/market-data';
import { testConfig } from './helpers';
import type { StrategySpec } from '../src/lib/types';

/**
 * That a configured strategy actually runs.
 * =============================================================================
 * This is the test the change most needed, and the one whose absence caused
 * the problem it fixes. The engine has been able to express a glidepath and a
 * momentum rotation since the day loop was written, and both were tested — but
 * nothing between the config and `runEngine` ever passed one, so every backtest
 * in the product ran the declared weights regardless of what was asked for.
 *
 * Unit tests on the rules could not catch that, because they call the engine
 * directly and supply the strategy themselves. Only a test that goes in
 * through `runBacktest`, the way the API does, exercises the wiring.
 */

const portfolio = {
  id: 'p',
  name: 'Wiring',
  positions: [
    { id: '1', symbol: 'SPY', weight: 50 },
    { id: '2', symbol: 'BND', weight: 50 },
  ],
};

const run = (strategy?: StrategySpec) =>
  runBacktest({
    portfolio,
    config: testConfig({
      start: '2010-01-04',
      end: '2020-12-31',
      rebalance: 'monthly',
      benchmarks: ['SPY'],
      strategy,
    }),
    provider: getDemoProvider(),
    includeAssetAnalysis: false,
  });

describe('a configured strategy changes the run', () => {
  it('produces a different portfolio from the declared weights', async () => {
    const [fixed, trend] = await Promise.all([
      run(),
      run({ kind: 'trend', windowDays: 100 }),
    ]);
    // If the wiring is missing these are identical to the last decimal, which
    // is precisely how the feature stayed dead while its tests passed.
    expect(trend.totals.finalValue).not.toBeCloseTo(fixed.totals.finalValue, 2);
  });

  it('leaves an explicit fixed strategy identical to none', async () => {
    const [none, fixed] = await Promise.all([run(), run({ kind: 'fixed' })]);
    expect(fixed.totals.finalValue).toBeCloseTo(none.totals.finalValue, 6);
  });

  it('equal weight differs from a lopsided declaration', async () => {
    const lopsided = {
      ...portfolio,
      positions: [
        { id: '1', symbol: 'SPY', weight: 90 },
        { id: '2', symbol: 'BND', weight: 10 },
      ],
    };
    const base = { provider: getDemoProvider(), includeAssetAnalysis: false } as const;
    const cfg = (strategy?: StrategySpec) =>
      testConfig({ start: '2010-01-04', end: '2020-12-31', rebalance: 'monthly', strategy });
    const [declared, equal] = await Promise.all([
      runBacktest({ ...base, portfolio: lopsided, config: cfg() }),
      runBacktest({ ...base, portfolio: lopsided, config: cfg({ kind: 'equal' }) }),
    ]);
    expect(equal.totals.finalValue).not.toBeCloseTo(declared.totals.finalValue, 2);
  });

  it('leaves the benchmark buy-and-hold', async () => {
    // A benchmark that ran the strategy would compare it against itself.
    const [fixed, trend] = await Promise.all([
      run(),
      run({ kind: 'trend', windowDays: 100 }),
    ]);
    const b = (r: Awaited<ReturnType<typeof run>>) => r.benchmarks[0]?.finalValue;
    expect(b(fixed)).toBeDefined();
    expect(b(trend)).toBeCloseTo(b(fixed)!, 6);
  });
});
