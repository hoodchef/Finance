import { describe, expect, it } from 'vitest';
import {
  RELATION_WINDOWS,
  alignOnDate,
  benchmarkRelation,
  peerRelativeStrength,
  type DatedClose,
} from '../src/lib/desk/relative';
import { MOMENTUM_HORIZONS } from '../src/lib/desk/models';

/**
 * Relative comparisons, against arithmetic worked by hand.
 * =============================================================================
 * The whole risk in this module is ALIGNMENT, and it is a silent one. Two
 * series of closes are two parallel arrays only if they printed on exactly the
 * same days, and the moment they do not, a beta computed by zipping them
 * regresses Monday on Tuesday and returns a number that looks completely
 * ordinary. There is no output that would reveal it, so it gets its own
 * section here and several of the cases below are constructed so that a
 * misaligned implementation gives a DIFFERENT answer rather than a noisier
 * one.
 *
 * The second theme is refusal. A window the overlap cannot cover, a benchmark
 * that did not move, a peer with four months of history asked for a year:
 * every one of these has an arithmetically available answer that would be a
 * fabricated finding, and each is asserted to come back null.
 */

/** Dated closes on consecutive weekdays from a Monday, skipping weekends. */
function series(closes: number[], start = '2026-01-05'): DatedClose[] {
  const out: DatedClose[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (const close of closes) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push({ date: d.toISOString().slice(0, 10), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** A series that compounds at a fixed rate, so returns are exactly constant. */
const compounding = (n: number, from: number, rate: number) =>
  Array.from({ length: n }, (_, i) => from * (1 + rate) ** i);

/** Deterministic pseudo-random walk. Seeded so failures are reproducible. */
function walk(n: number, from: number, seed: number): number[] {
  let s = seed;
  const out = [from];
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(out[i - 1] * (1 + ((s / 2147483648) - 0.5) * 0.04));
  }
  return out;
}

describe('alignment', () => {
  it('keeps only the sessions both series printed', () => {
    const a: DatedClose[] = [
      { date: '2026-01-05', close: 10 },
      { date: '2026-01-06', close: 11 },
      { date: '2026-01-07', close: 12 },
    ];
    const b: DatedClose[] = [
      { date: '2026-01-05', close: 100 },
      // No 01-06: a halt, a holiday on the other exchange, a vendor gap.
      { date: '2026-01-07', close: 120 },
    ];
    const aligned = alignOnDate(a, b);
    expect(aligned.dates).toEqual(['2026-01-05', '2026-01-07']);
    expect(aligned.a).toEqual([10, 12]);
    expect(aligned.b).toEqual([100, 120]);
  });

  it('sorts, so a provider returning newest-first cannot invert a return', () => {
    const a = [
      { date: '2026-01-07', close: 12 },
      { date: '2026-01-05', close: 10 },
    ];
    const b = [
      { date: '2026-01-05', close: 100 },
      { date: '2026-01-07', close: 120 },
    ];
    expect(alignOnDate(a, b).a).toEqual([10, 12]);
  });

  it('drops non-positive and non-finite closes rather than dividing by them', () => {
    const a = [
      { date: '2026-01-05', close: 0 },
      { date: '2026-01-06', close: Number.NaN },
      { date: '2026-01-07', close: 12 },
    ];
    const b = [
      { date: '2026-01-05', close: 100 },
      { date: '2026-01-06', close: 110 },
      { date: '2026-01-07', close: 120 },
    ];
    expect(alignOnDate(a, b).dates).toEqual(['2026-01-07']);
  });

  it('keeps the last of a repeated date, which is the restated bar', () => {
    const a = [
      { date: '2026-01-05', close: 10 },
      { date: '2026-01-05', close: 10.5 },
    ];
    const b = [{ date: '2026-01-05', close: 100 }];
    expect(alignOnDate(a, b).a).toEqual([10.5]);
  });

  it('returns nothing when the two series never overlap', () => {
    const a = [{ date: '2026-01-05', close: 10 }];
    const b = [{ date: '2027-01-05', close: 100 }];
    expect(alignOnDate(a, b).dates).toEqual([]);
  });

  it('survives empty inputs on either side', () => {
    expect(alignOnDate([], []).dates).toEqual([]);
    expect(alignOnDate([{ date: '2026-01-05', close: 1 }], []).dates).toEqual([]);
    expect(alignOnDate([], [{ date: '2026-01-05', close: 1 }]).dates).toEqual([]);
  });
});

describe('benchmark relation', () => {
  it('recovers a beta of exactly 2 from returns built to have one', () => {
    // The benchmark walks; the subject moves twice as far every single day.
    // A correct estimator returns 2.000 and an R² of 1.
    const bench = walk(300, 100, 7);
    const subject = [100];
    for (let i = 1; i < bench.length; i++) {
      const r = (bench[i] - bench[i - 1]) / bench[i - 1];
      subject.push(subject[i - 1] * (1 + 2 * r));
    }

    const rel = benchmarkRelation(series(subject), series(bench), 'SPY')!;
    const w = rel.windows.find((x) => x.window === 252)!;
    expect(w.beta).toBeCloseTo(2, 9);
    expect(w.correlation).toBeCloseTo(1, 9);
    expect(w.r2).toBeCloseTo(1, 9);
    // Nothing is left over once the benchmark explains all of it.
    expect(w.idiosyncraticVol).toBeCloseTo(0, 6);
    expect(w.observations).toBe(252);
  });

  it('reports a negative beta rather than its magnitude', () => {
    const bench = walk(300, 100, 11);
    const subject = [100];
    for (let i = 1; i < bench.length; i++) {
      const r = (bench[i] - bench[i - 1]) / bench[i - 1];
      subject.push(subject[i - 1] * (1 - r));
    }
    const w = benchmarkRelation(series(subject), series(bench), 'SPY')!.windows.find(
      (x) => x.window === 63,
    )!;
    expect(w.beta).toBeCloseTo(-1, 6);
    expect(w.correlation).toBeCloseTo(-1, 6);
    // R² is a share of variance and stays positive even when the slope is not.
    expect(w.r2).toBeCloseTo(1, 6);
  });

  it('gives a different answer than a naive zip when the calendars differ', () => {
    /*
     * The point of the whole module. Two series where the benchmark is missing
     * one mid-series session: aligning first pairs each date with itself, and
     * zipping the raw arrays pairs everything after the gap with the wrong
     * day. Both produce a number; only one of them is a beta.
     */
    const benchAll = walk(120, 100, 3);
    const subject = [100];
    for (let i = 1; i < benchAll.length; i++) {
      const r = (benchAll[i] - benchAll[i - 1]) / benchAll[i - 1];
      subject.push(subject[i - 1] * (1 + 1.5 * r));
    }

    const subjectSeries = series(subject);
    const benchSeries = series(benchAll).filter((_, i) => i !== 40);

    const rel = benchmarkRelation(subjectSeries, benchSeries, 'SPY')!;
    const w = rel.windows.find((x) => x.window === 63)!;

    // Aligned, the relationship is still exactly 1.5 on the days both traded.
    expect(w.beta).toBeCloseTo(1.5, 9);
    // And the overlap is one session shorter than the subject's own history.
    expect(rel.overlap).toBe(subjectSeries.length - 1);
  });

  it('refuses a window the overlap cannot cover', () => {
    // Forty sessions cannot answer a 252-day question. Estimating it over the
    // forty that exist would answer a different question under the same label.
    const rel = benchmarkRelation(
      series(compounding(40, 100, 0.001)),
      series(walk(40, 100, 5)),
      'SPY',
    )!;
    const long = rel.windows.find((x) => x.window === 252)!;
    expect(long.beta).toBeNull();
    expect(long.correlation).toBeNull();
    expect(long.r2).toBeNull();
    expect(long.idiosyncraticVol).toBeNull();

    const short = rel.windows.find((x) => x.window === 21)!;
    expect(short.beta).not.toBeNull();
  });

  it('refuses a slope against a benchmark that did not move', () => {
    // Every dividing line through a vertical scatter fits equally well, and
    // 0.00 would read as "moves independently of the market".
    const flat = series(Array.from({ length: 120 }, () => 100));
    const rel = benchmarkRelation(series(walk(120, 50, 9)), flat, 'SPY')!;
    for (const w of rel.windows.filter((x) => x.observations >= x.window)) {
      expect(w.beta, w.label).toBeNull();
      expect(w.correlation, w.label).toBeNull();
      expect(w.r2, w.label).toBeNull();
    }
  });

  it('refuses everything when the subject itself did not move', () => {
    const flat = series(Array.from({ length: 120 }, () => 42));
    const rel = benchmarkRelation(flat, series(walk(120, 100, 4)), 'SPY')!;
    const w = rel.windows.find((x) => x.window === 63)!;
    // A beta of zero IS the honest slope of a constant on anything.
    expect(w.beta).toBeCloseTo(0, 12);
    // But correlation is undefined, not zero: there is no variance to share.
    expect(w.correlation).toBeNull();
    expect(w.r2).toBeNull();
  });

  it('returns null rather than an object of nulls when nothing overlaps', () => {
    expect(benchmarkRelation([], [], 'SPY')).toBeNull();
    expect(benchmarkRelation(series([1, 2, 3]), [], 'SPY')).toBeNull();
    expect(
      benchmarkRelation(
        [{ date: '2026-01-05', close: 1 }],
        [{ date: '2026-01-05', close: 1 }],
        'SPY',
      ),
      'one common session is not a comparison',
    ).toBeNull();
  });

  it('computes excess return from the aligned closes, not two separate series', () => {
    // Subject compounds at exactly 0.1%/day, benchmark at exactly 0.05%/day.
    const days = 300;
    const subject = series(compounding(days, 100, 0.001));
    const bench = series(compounding(days, 400, 0.0005));
    const rel = benchmarkRelation(subject, bench, 'SPY')!;

    for (const rung of rel.relative) {
      const s = 1.001 ** rung.days - 1;
      const b = 1.0005 ** rung.days - 1;
      expect(rung.subject, rung.label).toBeCloseTo(s, 10);
      expect(rung.benchmark, rung.label).toBeCloseTo(b, 10);
      // The printed difference is the difference of the printed numbers.
      expect(rung.excess, rung.label).toBeCloseTo(s - b, 10);
    }
  });

  it('nulls a horizon longer than the overlap instead of shortening it', () => {
    const rel = benchmarkRelation(
      series(compounding(30, 100, 0.001)),
      series(compounding(30, 400, 0.0005)),
      'SPY',
    )!;
    const year = rel.relative.find((r) => r.days === 252)!;
    expect(year.subject).toBeNull();
    expect(year.benchmark).toBeNull();
    expect(year.excess).toBeNull();

    const week = rel.relative.find((r) => r.days === 5)!;
    expect(week.excess).not.toBeNull();
  });

  it('covers exactly the horizons the momentum panel shows', () => {
    // Same rungs, so a reader can put the absolute and relative panels side by
    // side without translating between two sets of horizons.
    const rel = benchmarkRelation(
      series(compounding(300, 100, 0.001)),
      series(compounding(300, 400, 0.0005)),
      'SPY',
    )!;
    expect(rel.relative.map((r) => r.days)).toEqual(MOMENTUM_HORIZONS.map((h) => h.days));
    expect(rel.windows.map((w) => w.window)).toEqual(RELATION_WINDOWS.map((w) => w.days));
  });

  it('rebases the relative-strength line to 1 at its own first point', () => {
    // The LEVEL of a price ratio is an accident of two share counts. Only the
    // slope means anything, so the line must start at 1 whatever the prices.
    const rel = benchmarkRelation(
      series(compounding(300, 7.5, 0.002)),
      series(compounding(300, 6100, 0.0005)),
      'SPY',
      { line: 60 },
    )!;
    expect(rel.line).toHaveLength(60);
    expect(rel.line[0].ratio).toBeCloseTo(1, 12);
    // Subject compounding faster: the line rises.
    expect(rel.line[rel.line.length - 1].ratio).toBeGreaterThan(1);
    expect(rel.line[rel.line.length - 1].date).toBe(rel.to);
  });

  it('shortens the line to the overlap rather than padding it', () => {
    const rel = benchmarkRelation(
      series(compounding(9, 100, 0.001)),
      series(compounding(9, 100, 0.001)),
      'SPY',
      { line: 252 },
    )!;
    expect(rel.line).toHaveLength(9);
  });
});

describe('peer relative strength', () => {
  const days = 300;
  const subject = series(compounding(days, 100, 0.002));

  it('measures each peer over the sessions it shares with the subject', () => {
    const peers = [
      { symbol: 'AAA', bars: series(compounding(days, 50, 0.001)) },
      { symbol: 'BBB', bars: series(compounding(days, 20, 0.003)) },
    ];
    const cohort = peerRelativeStrength(subject, peers, { source: 'test' });
    const quarter = cohort.horizons.find((h) => h.days === 63)!;

    const s = 1.002 ** 63 - 1;
    const a = 1.001 ** 63 - 1;
    const b = 1.003 ** 63 - 1;

    const legA = quarter.legs.find((l) => l.symbol === 'AAA')!;
    expect(legA.subjectReturn).toBeCloseTo(s, 10);
    expect(legA.peerReturn).toBeCloseTo(a, 10);
    expect(legA.excess).toBeCloseTo(s - a, 10);

    // Beat one peer, lost to the other.
    expect(quarter.rank).toBeCloseTo(0.5, 12);
    expect(quarter.measured).toBe(2);
    expect(quarter.peerMedian).toBeCloseTo((a + b) / 2, 10);
    expect(quarter.medianExcess).toBeCloseTo((s - a + (s - b)) / 2, 10);
  });

  it('drops a peer from a horizon its overlap cannot cover, not from the cohort', () => {
    // A peer that listed four months ago has no one-year return. Measuring
    // from its IPO would give it one, and every long comparison would flatter
    // or damn the subject on a window that was never observed.
    const young = series(compounding(80, 10, 0.001)).map((b, i) => ({
      ...b,
      date: subject[subject.length - 80 + i].date,
    }));
    const cohort = peerRelativeStrength(
      subject,
      [
        { symbol: 'OLD', bars: series(compounding(days, 50, 0.001)) },
        { symbol: 'NEW', bars: young },
      ],
      { source: 'test' },
    );

    const year = cohort.horizons.find((h) => h.days === 252)!;
    expect(year.measured).toBe(1);
    expect(year.legs.find((l) => l.symbol === 'NEW')!.excess).toBeNull();
    expect(year.legs.find((l) => l.symbol === 'NEW')!.alignedBars).toBe(80);

    const month = cohort.horizons.find((h) => h.days === 21)!;
    expect(month.measured, 'the young peer is still usable at 21 days').toBe(2);
  });

  it('names a peer it could not use, with the reason', () => {
    const cohort = peerRelativeStrength(
      subject,
      [
        { symbol: 'GONE', bars: null },
        { symbol: 'EMPTY', bars: [] },
        { symbol: 'ELSEWHERE', bars: series(compounding(50, 10, 0.001), '2019-01-07') },
      ],
      { source: 'test' },
    );
    expect(cohort.skipped.map((s) => s.symbol).sort()).toEqual(['ELSEWHERE', 'EMPTY', 'GONE']);
    expect(cohort.skipped.find((s) => s.symbol === 'GONE')!.reason).toMatch(/no price history/);
    expect(cohort.skipped.find((s) => s.symbol === 'ELSEWHERE')!.reason).toMatch(/in common/);
    // The peer list stays complete even where nothing could be measured.
    expect(cohort.peers).toEqual(['GONE', 'EMPTY', 'ELSEWHERE']);
    for (const h of cohort.horizons) {
      expect(h.measured, h.label).toBe(0);
      expect(h.rank, h.label).toBeNull();
      expect(h.medianExcess, h.label).toBeNull();
      expect(h.peerMedian, h.label).toBeNull();
    }
  });

  it('handles a cohort with no peers at all', () => {
    const cohort = peerRelativeStrength(subject, [], { source: 'test' });
    expect(cohort.peers).toEqual([]);
    expect(cohort.skipped).toEqual([]);
    for (const h of cohort.horizons) {
      expect(h.legs, h.label).toEqual([]);
      expect(h.rank, h.label).toBeNull();
    }
  });

  it('handles a subject with a single bar', () => {
    const cohort = peerRelativeStrength(
      [{ date: '2026-01-05', close: 100 }],
      [{ symbol: 'AAA', bars: series(compounding(days, 50, 0.001)) }],
      { source: 'test' },
    );
    // One common session is not two, so the peer is skipped rather than
    // compared over a window of length zero.
    expect(cohort.skipped).toHaveLength(1);
    expect(cohort.horizons.every((h) => h.measured === 0)).toBe(true);
  });

  it('reports rank 1 when the subject beat every measurable peer', () => {
    const cohort = peerRelativeStrength(
      subject,
      [
        { symbol: 'A', bars: series(compounding(days, 50, 0.0001)) },
        { symbol: 'B', bars: series(compounding(days, 50, 0.0005)) },
        { symbol: 'C', bars: series(compounding(days, 50, 0.001)) },
      ],
      { source: 'test' },
    );
    const year = cohort.horizons.find((h) => h.days === 252)!;
    expect(year.rank).toBe(1);
    expect(year.measured).toBe(3);
    // `measured` is printed beside `rank` precisely so a 1.00 from three peers
    // is not read as a 1.00 from thirty.
    expect(year.legs.every((l) => (l.excess ?? 0) > 0)).toBe(true);
  });

  it('carries the source through, so the cohort can never look self-derived', () => {
    const cohort = peerRelativeStrength(subject, [], { source: 'polygon:related-companies' });
    expect(cohort.source).toBe('polygon:related-companies');
  });
});
