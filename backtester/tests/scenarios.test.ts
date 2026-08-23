import { describe, expect, it } from 'vitest';
import { runScenarioAnalysis } from '../src/lib/analysis/scenarios';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import { testConfig } from './helpers';

/**
 * The value of this feature rests entirely on the episodes being real. These
 * tests check that they come out of the price data — ordered by depth, with
 * dates that are consistent with each other — rather than from a table.
 */

const provider = new DemoDataProvider();

const portfolio = {
  id: 'p',
  name: 'P',
  positions: [
    { id: '1', symbol: 'SPY', weight: 60 },
    { id: '2', symbol: 'BND', weight: 40 },
  ],
};

describe('scenario analysis', () => {
  it('derives episodes from the reference index, deepest first', async () => {
    const a = await runScenarioAnalysis({
      portfolio,
      config: testConfig({ end: '2024-12-31' }),
      provider,
      reference: 'SPY',
      count: 6,
    });

    expect(a.reference.symbol).toBe('SPY');
    expect(a.outcomes.length).toBeGreaterThan(0);

    for (let i = 1; i < a.outcomes.length; i++) {
      const prev = a.outcomes[i - 1].episode.referenceDepth;
      const curr = a.outcomes[i].episode.referenceDepth;
      expect(curr).toBeGreaterThanOrEqual(prev); // depths are negative
    }
  });

  it('produces internally consistent episode dates', async () => {
    const a = await runScenarioAnalysis({
      portfolio,
      config: testConfig({ end: '2024-12-31' }),
      provider,
      reference: 'SPY',
    });

    for (const { episode } of a.outcomes) {
      expect(episode.peakDate < episode.troughDate).toBe(true);
      expect(episode.referenceDepth).toBeLessThan(0);
      expect(episode.declineDays).toBeGreaterThan(0);
      if (episode.recovered) {
        expect(episode.recoveryDate).not.toBeNull();
        expect(episode.recoveryDate! > episode.troughDate).toBe(true);
      } else {
        expect(episode.recoveryDate).toBeNull();
      }
    }
  });

  it('respects the minimum depth filter', async () => {
    const deep = await runScenarioAnalysis({
      portfolio,
      config: testConfig({ end: '2024-12-31' }),
      provider,
      reference: 'SPY',
      minDepth: 0.25,
    });
    for (const o of deep.outcomes) {
      expect(o.episode.referenceDepth).toBeLessThanOrEqual(-0.25);
    }
  });

  it('measures the portfolio only where it has history, and says which', async () => {
    const a = await runScenarioAnalysis({
      portfolio,
      config: testConfig({ end: '2024-12-31' }),
      provider,
      reference: 'SPY',
    });

    for (const o of a.outcomes) {
      if (o.coverage === 'none') {
        // Nothing is reported for a period the portfolio did not exist for.
        expect(o.portfolioDecline).toBeNull();
        expect(o.downsideCapture).toBeNull();
      } else {
        expect(o.measuredFrom).not.toBeNull();
        expect(o.portfolioDecline).not.toBeNull();
        expect(o.measuredFrom! >= o.episode.peakDate).toBe(true);
        expect(o.measuredTo! <= o.episode.troughDate).toBe(true);
      }
    }
  });

  it('changes the episode set when the reference changes', async () => {
    const equity = await runScenarioAnalysis({
      portfolio, config: testConfig({ end: '2024-12-31' }), provider, reference: 'SPY',
    });
    const bonds = await runScenarioAnalysis({
      portfolio, config: testConfig({ end: '2024-12-31' }), provider, reference: 'BND', minDepth: 0.02,
    });
    // A bond index's bad periods are not an equity index's bad periods.
    expect(bonds.outcomes[0]?.episode.id).not.toBe(equity.outcomes[0]?.episode.id);
  });

  it('reports a bond-heavy sleeve as lower downside capture than a pure equity one', async () => {
    const config = testConfig({ end: '2024-12-31' });
    const defensive = await runScenarioAnalysis({
      portfolio: { id: 'd', name: 'D', positions: [
        { id: '1', symbol: 'SPY', weight: 20 }, { id: '2', symbol: 'BND', weight: 80 }] },
      config, provider, reference: 'SPY', count: 3,
    });
    const aggressive = await runScenarioAnalysis({
      portfolio: { id: 'a', name: 'A', positions: [{ id: '1', symbol: 'SPY', weight: 100 }] },
      config, provider, reference: 'SPY', count: 3,
    });

    const capture = (a: typeof defensive) =>
      a.outcomes.filter((o) => o.downsideCapture != null).map((o) => o.downsideCapture!);

    const d = capture(defensive);
    const g = capture(aggressive);
    expect(d.length).toBeGreaterThan(0);
    // 100% of the reference captures ~100% of its drawdown, by definition.
    for (const c of g) expect(c).toBeCloseTo(1, 1);
    // A mostly-bond portfolio must fall less in an equity drawdown.
    expect(d.reduce((s, x) => s + x, 0) / d.length).toBeLessThan(0.8);
  });

  it('surfaces a clear error when the reference index cannot be loaded', async () => {
    const failing = {
      ...provider,
      id: 'broken',
      getHistoricalPrices: async () => {
        throw new Error('nope');
      },
    } as unknown as DemoDataProvider;

    const a = await runScenarioAnalysis({
      portfolio,
      config: testConfig(),
      provider: failing,
      reference: 'SPY',
    });
    expect(a.outcomes).toHaveLength(0);
    expect(a.warnings.some((w) => w.severity === 'error')).toBe(true);
  });
});
