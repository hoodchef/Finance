import { describe, expect, it } from 'vitest';
import {
  createRun,
  fingerprintPositions,
  groupByFingerprint,
  runIncoherence,
  runProvenance,
  snapshotPortfolio,
  type SavedRun,
} from '../src/lib/runs';
import { defaultConfig } from '../src/lib/defaults';
import { runBacktest } from '../src/lib/backtest';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import { testConfig } from './helpers';
import type { Portfolio } from '../src/lib/types';

/**
 * The property under test is that a saved run cannot be changed by editing the
 * portfolio it came from. Before snapshots existed, comparisons held live
 * references and a weight edit silently rewrote what a saved result claimed to
 * have measured.
 */

const portfolio = (): Portfolio => ({
  id: 'pf1',
  name: 'Balanced',
  positions: [
    { id: 'a', symbol: 'SPY', weight: 60 },
    { id: 'b', symbol: 'BND', weight: 40 },
  ],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
});

describe('fingerprints', () => {
  it('ignores row order but not weights', () => {
    const a = fingerprintPositions([
      { id: '1', symbol: 'SPY', weight: 60 },
      { id: '2', symbol: 'BND', weight: 40 },
    ]);
    const reordered = fingerprintPositions([
      { id: '2', symbol: 'BND', weight: 40 },
      { id: '1', symbol: 'SPY', weight: 60 },
    ]);
    const reweighted = fingerprintPositions([
      { id: '1', symbol: 'SPY', weight: 70 },
      { id: '2', symbol: 'BND', weight: 30 },
    ]);

    expect(reordered).toBe(a); // Dragging a row is not a new portfolio.
    expect(reweighted).not.toBe(a); // Changing a weight is.
  });

  it('normalises ticker case and whitespace', () => {
    expect(fingerprintPositions([{ id: '1', symbol: ' spy ', weight: 100 }])).toBe(
      fingerprintPositions([{ id: '1', symbol: 'SPY', weight: 100 }]),
    );
  });

  it('distinguishes a different expense ratio', () => {
    const plain = fingerprintPositions([{ id: '1', symbol: 'SPY', weight: 100 }]);
    const costed = fingerprintPositions([
      { id: '1', symbol: 'SPY', weight: 100, expenseRatio: 0.09 },
    ]);
    expect(costed).not.toBe(plain);
  });
});

describe('snapshots are immutable', () => {
  it('does not alias the live portfolio', () => {
    const pf = portfolio();
    const snap = snapshotPortfolio(pf);

    // Mutate the source the way the builder does.
    pf.positions[0].weight = 90;
    pf.positions.push({ id: 'c', symbol: 'GLD', weight: 10 });
    pf.name = 'Renamed';

    expect(snap.positions).toHaveLength(2);
    expect(snap.positions[0].weight).toBe(60);
    expect(snap.name).toBe('Balanced');
  });

  it('keeps a run reporting what it measured after the portfolio changes', async () => {
    const pf = portfolio();
    const result = await runBacktest({
      portfolio: pf,
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: new DemoDataProvider(),
      includeAssetAnalysis: false,
    });

    const run = createRun(result);
    const originalValue = run.summary.finalValue;
    const originalWeights = run.snapshot.positions.map((p) => p.weight);

    pf.positions[0].weight = 100;
    pf.positions[1].weight = 0;

    expect(run.snapshot.positions.map((p) => p.weight)).toEqual(originalWeights);
    expect(run.summary.finalValue).toBe(originalValue);
    expect(run.config).toBeDefined();
  });

  it('deep-copies the config so later edits cannot reach it', async () => {
    const config = testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] });
    const result = await runBacktest({
      portfolio: portfolio(),
      config,
      provider: new DemoDataProvider(),
      includeAssetAnalysis: false,
    });
    const run = createRun(result);

    config.initialInvestment = 999_999;
    config.fees.managementFeePct = 5;

    expect(run.config.initialInvestment).not.toBe(999_999);
    expect(run.config.fees.managementFeePct).not.toBe(5);
  });
});

describe('provenance', () => {
  it('reports current, drifted and detached correctly', async () => {
    const pf = portfolio();
    const result = await runBacktest({
      portfolio: pf,
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: new DemoDataProvider(),
      includeAssetAnalysis: false,
    });
    const run = createRun(result);

    expect(runProvenance(run, [pf])).toBe('current');

    const edited: Portfolio = {
      ...pf,
      positions: [
        { id: 'a', symbol: 'SPY', weight: 80 },
        { id: 'b', symbol: 'BND', weight: 20 },
      ],
    };
    expect(runProvenance(run, [edited])).toBe('drifted');
    // Not 'deleted': a run from an unsaved draft looks identical.
    expect(runProvenance(run, [])).toBe('detached');
  });

  it('treats a reordered portfolio as unchanged', async () => {
    const pf = portfolio();
    const result = await runBacktest({
      portfolio: pf,
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: new DemoDataProvider(),
      includeAssetAnalysis: false,
    });
    const run = createRun(result);

    const reordered: Portfolio = { ...pf, positions: [...pf.positions].reverse() };
    expect(runProvenance(run, [reordered])).toBe('current');
  });
});

describe('grouping', () => {
  it('groups runs that measured identical holdings', async () => {
    const provider = new DemoDataProvider();
    const config = testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] });

    const a = createRun(
      await runBacktest({ portfolio: portfolio(), config, provider, includeAssetAnalysis: false }),
    );
    const b = createRun(
      await runBacktest({ portfolio: portfolio(), config, provider, includeAssetAnalysis: false }),
    );
    const different = createRun(
      await runBacktest({
        portfolio: { ...portfolio(), positions: [{ id: 'x', symbol: 'QQQ', weight: 100 }] },
        config,
        provider,
        includeAssetAnalysis: false,
      }),
    );

    const groups = groupByFingerprint([a, b, different]);
    expect(groups.size).toBe(2);
    expect(groups.get(a.snapshot.fingerprint)).toHaveLength(2);
  });
});

describe('a stored run that contradicts itself', () => {
  /**
   * Runs live in browser storage and outlive the code that produced them. A
   * snapshot written before a bug was fixed still deserializes cleanly and
   * renders as a result. The engine refuses to produce these today; this
   * catches the ones already on disk.
   */
  const base: SavedRun = {
    runId: 'r1',
    label: 'Test',
    savedAt: '2026-08-26T00:00:00.000Z',
    snapshot: { sourceId: 'p', name: 'P', positions: [], fingerprint: 'f' },
    config: defaultConfig(),
    engineVersion: '1.0.0',
    summary: {
      start: '2020-01-02',
      end: '2024-12-31',
      finalValue: 15_000,
      totalReturn: 0.5,
      cagr: 0.084,
      volatility: 0.15,
      maxDrawdown: -0.2,
      sharpe: 0.5,
      synthetic: false,
    },
  };

  const withSummary = (patch: Partial<SavedRun['summary']>): SavedRun => ({
    ...base,
    summary: { ...base.summary, ...patch },
  });

  it('accepts a coherent run', () => {
    expect(runIncoherence(base)).toBeNull();
  });

  it('rejects a zero-length window', () => {
    expect(runIncoherence(withSummary({ start: '2016-08-23', end: '2016-08-23' }))).toMatch(
      /same day/i,
    );
  });

  it('rejects any return other than a total loss against a zero balance', () => {
    // The real case on disk was finalValue 0 with cagr 0 — the money neither
    // grew nor shrank, and is also gone. A first pass caught only cagr > 0 and
    // let that through.
    expect(runIncoherence(withSummary({ finalValue: 0, cagr: 0 }))).toMatch(/total loss/i);
    expect(runIncoherence(withSummary({ finalValue: 0, cagr: 0.088 }))).toMatch(/total loss/i);
    expect(runIncoherence(withSummary({ finalValue: -5, cagr: 0.02 }))).toMatch(/total loss/i);
  });

  it('allows a total loss reported honestly', () => {
    // Zero final value with a negative CAGR is a wipeout, not a contradiction.
    expect(runIncoherence(withSummary({ finalValue: 0, cagr: -1 }))).toBeNull();
  });

  it('rejects non-finite figures', () => {
    expect(runIncoherence(withSummary({ cagr: Number.NaN }))).toMatch(/not a number/i);
    expect(runIncoherence(withSummary({ finalValue: Number.POSITIVE_INFINITY }))).toMatch(
      /not a number/i,
    );
  });

  it('rejects impossible risk figures', () => {
    expect(runIncoherence(withSummary({ volatility: -0.1 }))).toMatch(/negative/i);
    // A drawdown is a fall; a positive one is a sign error somewhere upstream.
    expect(runIncoherence(withSummary({ maxDrawdown: 0.2 }))).toMatch(/positive/i);
  });
});
