import { describe, expect, it } from 'vitest';
import { alignWeeks, liveMarketFrom, reconcile, resampleWeekly } from '../src/lib/valuation/asts/market-live';
import { assessFilings } from '../src/lib/valuation/asts/filings';
import { marketStats } from '../src/lib/valuation/asts/engine';
import { SNAPSHOT_ASTS, SNAPSHOT_SPY, SNAPSHOT_TIME } from '../src/lib/valuation/asts/market-snapshot';

describe('weekly resampling — dated the way IBKR dates a weekly bar', () => {
  it('keys on the Monday, dates by the first trading day, closes on the last', () => {
    const w = resampleWeekly([
      { date: '2025-01-17', close: 10 }, // Friday
      { date: '2025-01-21', close: 11 }, // Tuesday: MLK Monday was a holiday
      { date: '2025-01-22', close: 12 },
      { date: '2025-01-24', close: 13 }, // Friday
      { date: '2025-01-27', close: 14 }, // Monday
    ]);
    expect(w).toEqual([
      { week: '2025-01-13', start: '2025-01-17', close: 10 },
      { week: '2025-01-20', start: '2025-01-21', close: 13 },
      { week: '2025-01-27', start: '2025-01-27', close: 14 },
    ]);
  });

  it('drops non-positive and non-finite closes rather than letting them into a return', () => {
    expect(resampleWeekly([{ date: '2025-01-20', close: 0 }, { date: '2025-01-21', close: Number.NaN }])).toEqual([]);
  });

  it('rebuilds the snapshot exactly from its own weekly closes', () => {
    // The snapshot's weeks, fed back as "daily" closes one per week, must key
    // to the same weeks — including its first bar, which starts on a Wednesday.
    const w = resampleWeekly(SNAPSHOT_TIME.map((d, i) => ({ date: d, close: SNAPSHOT_ASTS[i] })));
    expect(w.length).toBe(SNAPSHOT_TIME.length);
    expect(w[0]).toEqual({ week: '2024-09-09', start: '2024-09-11', close: SNAPSHOT_ASTS[0] });
  });
});

describe('reconciliation — measured, not assumed', () => {
  const live = resampleWeekly(SNAPSHOT_TIME.map((d, i) => ({ date: d, close: SNAPSHOT_ASTS[i] })));

  it('reports zero difference for an identical feed, excluding the final (partial) week', () => {
    const r = reconcile(SNAPSHOT_TIME, SNAPSHOT_ASTS, live);
    // Both feeds' final bar is the same week, so excluding each one's removes one week, not two.
    expect(r.weeksCompared).toBe(SNAPSHOT_TIME.length - 1);
    expect(r.maxAbsPctDiff).toBe(0);
    expect(r.worst).toBeNull();
  });

  it('finds the week that disagrees', () => {
    const bad = live.map((b, i) => (i === 40 ? { ...b, close: b.close * 1.01 } : b));
    const r = reconcile(SNAPSHOT_TIME, SNAPSHOT_ASTS, bad);
    expect(r.maxAbsPctDiff).toBeCloseTo(0.01, 12);
    expect(r.worst?.week).toBe(live[40].week);
  });

  it('re-estimates the snapshot’s own statistics when fed the snapshot', () => {
    const asts = SNAPSHOT_TIME.map((d, i) => ({ date: d, close: SNAPSHOT_ASTS[i] }));
    const spy = SNAPSHOT_TIME.map((d, i) => ({ date: d, close: SNAPSHOT_SPY[i] }));
    const m = liveMarketFrom(asts, spy, 0.67, { time: SNAPSHOT_TIME, asts: SNAPSHOT_ASTS, spy: SNAPSHOT_SPY }, 'test');
    const ref = marketStats(SNAPSHOT_ASTS, SNAPSHOT_SPY, 0.67);
    expect(m?.stats.betaRaw).toBe(ref.betaRaw);
    expect(m?.stats.vol).toBe(ref.vol);
    expect(m?.weeks).toBe(105);
  });

  it('aligns on shared weeks only — a holiday in one feed does not shift the other', () => {
    const a = resampleWeekly([{ date: '2025-01-06', close: 1 }, { date: '2025-01-13', close: 2 }, { date: '2025-01-21', close: 3 }]);
    const b = resampleWeekly([{ date: '2025-01-06', close: 10 }, { date: '2025-01-21', close: 30 }]);
    expect(alignWeeks(a, b, 10).map((r) => [r.close, r.bench])).toEqual([[1, 10], [3, 30]]);
  });

  it('refuses to estimate from too little history', () => {
    const short = SNAPSHOT_TIME.slice(0, 30).map((d, i) => ({ date: d, close: SNAPSHOT_ASTS[i] }));
    expect(liveMarketFrom(short, short, 0.67, { time: SNAPSHOT_TIME, asts: SNAPSHOT_ASTS, spy: SNAPSHOT_SPY }, 't')).toBeNull();
  });
});

describe('filing freshness', () => {
  const sub = (rows: Array<[form: string, filed: string, period: string]>) => ({
    filings: {
      recent: {
        accessionNumber: rows.map((_, i) => `0000000000-26-00000${i}`),
        filingDate: rows.map((r) => r[1]),
        reportDate: rows.map((r) => r[2]),
        form: rows.map((r) => r[0]),
        primaryDocument: rows.map(() => 'doc.htm'),
        primaryDocDescription: rows.map((r) => r[0]),
      },
    },
  });

  it('current when the latest periodic report is the model’s and nothing capital-related followed', () => {
    const f = assessFilings(sub([['4', '2026-09-20', ''], ['10-Q', '2026-08-10', '2026-06-30']]));
    expect(f.freshness).toBe('current');
    expect(f.latestPeriodic?.period).toBe('2026-06-30');
  });

  it('review when an 8-K lands after the valuation date', () => {
    const f = assessFilings(sub([['8-K', '2026-10-02', ''], ['10-Q', '2026-08-10', '2026-06-30']]));
    expect(f.freshness).toBe('review');
    expect(f.sinceValuation.map((x) => x.form)).toEqual(['8-K']);
  });

  it('stale when a newer quarter has been reported', () => {
    const f = assessFilings(sub([['10-Q', '2026-11-09', '2026-09-30'], ['8-K', '2026-10-02', '']]));
    expect(f.freshness).toBe('stale');
    expect(f.headline).toContain('2026-09-30');
  });

  it('builds EDGAR document links from the accession number', () => {
    const f = assessFilings(sub([['10-Q', '2026-08-10', '2026-06-30']]));
    expect(f.latestPeriodic?.url).toBe('https://www.sec.gov/Archives/edgar/data/1780312/000000000026000000/doc.htm');
  });
});
