import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/lib/backtest';
import { getDemoProvider } from '../src/lib/market-data';
import { testConfig } from './helpers';
import { describeStrategy } from '../src/lib/engine/build-strategy';
import type { StrategySpec } from '../src/lib/types';

/**
 * Comparing strategies on one portfolio.
 *
 * The property that makes the comparison worth anything is that every variant
 * differs in the rule and in nothing else — same portfolio, same period, same
 * costs. A sweep that varied two things at once would rank rules on a
 * difference that was never about the rules.
 */

const portfolio = {
  id: 'p',
  name: 'Sweep',
  positions: [
    { id: '1', symbol: 'SPY', weight: 40 },
    { id: '2', symbol: 'QQQ', weight: 30 },
    { id: '3', symbol: 'BND', weight: 30 },
  ],
};

const base = {
  provider: getDemoProvider(),
  includeAssetAnalysis: false,
} as const;

const cfg = (strategy?: StrategySpec) =>
  testConfig({
    start: '2010-01-04',
    end: '2020-12-31',
    rebalance: 'monthly',
    strategy,
  });

const VARIANTS: Array<{ label: string; spec: StrategySpec | undefined }> = [
  { label: 'Declared weights', spec: undefined },
  { label: 'Equal weight', spec: { kind: 'equal' } },
  {
    label: 'Trend filter',
    spec: { kind: 'composed', base: { kind: 'fixed' }, overlays: [{ kind: 'trend', windowDays: 200 }] },
  },
  {
    label: 'Volatility target',
    spec: {
      kind: 'composed',
      base: { kind: 'fixed' },
      overlays: [{ kind: 'volatilityTarget', targetVolPct: 8, lookbackDays: 63 }],
    },
  },
];

describe('a strategy sweep is a controlled comparison', () => {
  it('runs every variant over the identical period and capital', async () => {
    const results = [];
    for (const v of VARIANTS) {
      results.push(await runBacktest({ ...base, portfolio, config: cfg(v.spec) }));
    }
    const starts = new Set(results.map((r) => r.effectiveStart));
    const ends = new Set(results.map((r) => r.effectiveEnd));
    const invested = new Set(results.map((r) => r.totals.netInvested.toFixed(2)));
    // One period and one amount across all of them, or the ranking is not
    // about the rules.
    expect(starts.size).toBe(1);
    expect(ends.size).toBe(1);
    expect(invested.size).toBe(1);
  });

  it('separates the rules rather than reporting the same run four times', async () => {
    const finals: number[] = [];
    for (const v of VARIANTS) {
      const r = await runBacktest({ ...base, portfolio, config: cfg(v.spec) });
      finals.push(Number(r.totals.finalValue.toFixed(2)));
    }
    // Equal weight can legitimately coincide with declared weights; a trend
    // filter and a volatility target on this portfolio cannot both equal it.
    expect(new Set(finals).size).toBeGreaterThan(2);
  });

  it('cuts volatility with a volatility target, which is the point of one', async () => {
    const plain = await runBacktest({ ...base, portfolio, config: cfg() });
    const targeted = await runBacktest({
      ...base,
      portfolio,
      config: cfg({
        kind: 'composed',
        base: { kind: 'fixed' },
        overlays: [{ kind: 'volatilityTarget', targetVolPct: 6, lookbackDays: 63 }],
      }),
    });
    expect(targeted.metrics.risk.volatility).toBeLessThan(plain.metrics.risk.volatility);
    // And it should land near the target rather than merely below it.
    expect(targeted.metrics.risk.volatility).toBeLessThan(0.1);
  });

  it('labels every variant distinctly, so two rows cannot read the same', async () => {
    const labels = VARIANTS.map((v) => describeStrategy(v.spec));
    expect(new Set(labels).size).toBe(VARIANTS.length);
  });

  it('leaves the benchmark identical across variants', async () => {
    const a = await runBacktest({
      ...base,
      portfolio,
      config: { ...cfg(), benchmarks: ['SPY'] },
    });
    const b = await runBacktest({
      ...base,
      portfolio,
      config: { ...cfg({ kind: 'equal' }), benchmarks: ['SPY'] },
    });
    expect(b.benchmarks[0].finalValue).toBeCloseTo(a.benchmarks[0].finalValue, 6);
  });
});
