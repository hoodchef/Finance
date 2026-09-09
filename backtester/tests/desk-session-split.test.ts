import { describe, expect, it } from 'vitest';
import { sessionSplit } from '../src/lib/desk/session-split';
import type { Bar } from '../src/lib/desk/models';

/**
 * The overnight/intraday split, against arithmetic worked by hand.
 * =============================================================================
 * The load-bearing property is the RECONCILIATION: the two legs must compound
 * back to the close-to-close move exactly. An implementation that adds the legs
 * instead of compounding them, or that quotes shares from arithmetic returns
 * rather than logs, passes a casual eyeball and fails here — and the error
 * grows precisely when the move is large, which is when someone reads it.
 *
 * The dividend case is the other one that matters. An unadjusted price series
 * puts the whole ex-date drop on the overnight leg, and a model that ignores it
 * reports a REIT losing its entire yield overnight every year.
 */

/** A bar with an explicit open and close. */
function bar(date: string, open: number, close: number): Bar {
  return {
    date,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
  };
}

const day = (i: number) => `2024-01-${String(i + 1).padStart(2, '0')}`;

/**
 * A series of `n` sessions whose opens and closes follow a repeating pattern of
 * per-leg factors, so every leg return is known exactly.
 */
function series(n: number, overnightFactors: number[], intradayFactors: number[]): Bar[] {
  const bars: Bar[] = [bar(day(0), 100, 100)];
  let close = 100;
  for (let i = 1; i <= n; i++) {
    const open = close * overnightFactors[(i - 1) % overnightFactors.length];
    close = open * intradayFactors[(i - 1) % intradayFactors.length];
    bars.push(bar(day(i), open, close));
  }
  return bars;
}

describe('session split', () => {
  it('splits three hand-worked sessions into legs that compound back exactly', () => {
    /*
     * closes  100 → 101 → 105
     * opens         102     100
     *
     * Overnight: 102/100 and 100/101. Compounded: 102/101, a growth of 1/101.
     * Intraday:  101/102 and 105/100. Compounded: 10605/10200.
     * Product:   (102/101)(10605/10200) = 1081710/1030200 = 1.05 exactly,
     * which is 105/100 — the close-to-close move over the same two sessions.
     */
    const bars = [bar(day(0), 100, 100), bar(day(1), 102, 101), bar(day(2), 100, 105)];
    const s = sessionSplit(bars, { minSessions: 2, minBucketSessions: 1 })!;

    expect(s.sessions).toBe(2);
    expect(s.overnight.growth).toBeCloseTo(1 / 101, 12);
    expect(s.intraday.growth).toBeCloseTo(10605 / 10200 - 1, 12);
    expect(s.totalGrowth).toBeCloseTo(0.05, 12);

    // The legs COMPOUND to the total. They do not add: the arithmetic sum here
    // is 0.0099… + 0.0397… = 0.0496…, which is not 5%.
    expect((1 + s.overnight.growth!) * (1 + s.intraday.growth!) - 1).toBeCloseTo(0.05, 12);
    expect(s.overnight.growth! + s.intraday.growth!).not.toBeCloseTo(0.05, 4);

    // In logs they DO add, exactly, which is why the share is quoted in logs.
    expect(s.overnight.logSum! + s.intraday.logSum!).toBeCloseTo(Math.log(1.05), 12);
    expect(s.overnight.share!).toBeCloseTo(Math.log(102 / 101) / Math.log(1.05), 12);
    expect(s.overnight.share! + s.intraday.share!).toBeCloseTo(1, 12);
  });

  it('separates a security that drifts overnight from one that drifts in the session', () => {
    /*
     * Both end at exactly the same price. One earns it all between the bells,
     * the other all outside them. Close-to-close returns are identical and
     * cannot tell them apart; that is the whole reason this model exists.
     */
    const overnightEarner = series(60, [1.002], [1]);
    const sessionEarner = series(60, [1], [1.002]);

    const a = sessionSplit(overnightEarner, { minSessions: 10, minBucketSessions: 1 })!;
    const b = sessionSplit(sessionEarner, { minSessions: 10, minBucketSessions: 1 })!;

    expect(a.totalGrowth).toBeCloseTo(b.totalGrowth!, 12);
    expect(a.overnight.share).toBeCloseTo(1, 12);
    expect(a.intraday.share).toBeCloseTo(0, 12);
    expect(b.overnight.share).toBeCloseTo(0, 12);
    expect(b.intraday.share).toBeCloseTo(1, 12);
  });

  it('annualises each leg by the session count it was told about', () => {
    /*
     * Overnight legs alternate ×1.02 and ×1/1.02, so the log returns are
     * ±ln(1.02) and their sample standard deviation over an even, balanced
     * sample is ln(1.02)·√(n/(n−1)). Annualised by √252 at n = 60 that is
     * ln(1.02)·√(60/59)·√252 = 0.31736…
     *
     * Getting the annualiser wrong is the single most common error in this
     * family, so the figure is pinned rather than merely bounded.
     */
    const bars = series(60, [1.02, 1 / 1.02], [1]);
    const s = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1 })!;

    const expected = Math.log(1.02) * Math.sqrt(60 / 59) * Math.sqrt(252);
    expect(s.overnight.volatility).toBeCloseTo(expected, 10);
    // The intraday leg never moved, so its volatility is exactly zero — not
    // null: zero is an observed fact here, and the leg was measurable.
    expect(s.intraday.volatility).toBeCloseTo(0, 12);

    // Halving the period count divides the annualised figure by √2.
    const half = sessionSplit(bars, {
      minSessions: 10,
      minBucketSessions: 1,
      periodsPerYear: 126,
    })!;
    expect(half.overnight.volatility).toBeCloseTo(expected / Math.SQRT2, 10);
  });

  it('drops ex-dividend sessions and says how many', () => {
    /*
     * A flat security paying a 5% dividend on one day. Unadjusted, that day's
     * open is 5% below the prior close, and left in the sample the overnight
     * leg reports a loss the holder never took.
     */
    const bars = [
      bar(day(0), 100, 100),
      ...Array.from({ length: 50 }, (_, i) => bar(day(i + 1), 100, 100)),
    ];
    bars[25] = bar(day(25), 95, 95);
    for (let i = 26; i < bars.length; i++) bars[i] = bar(day(i), 95, 95);

    const included = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1 })!;
    expect(included.exDividendSessionsExcluded).toBe(0);
    expect(included.overnight.growth!).toBeCloseTo(-0.05, 12);

    const corrected = sessionSplit(bars, {
      minSessions: 10,
      minBucketSessions: 1,
      exDividendDates: [day(25)],
    })!;
    expect(corrected.exDividendSessionsExcluded).toBe(1);
    expect(corrected.sessions).toBe(included.sessions - 1);
    expect(corrected.overnight.growth!).toBeCloseTo(0, 12);
    // The reconciliation still holds over the sessions that remain.
    expect(corrected.totalGrowth).toBeCloseTo(0, 12);
  });

  it('detects gaps that fade and gaps that follow through', () => {
    /*
     * Every gap up is given back in the session and every gap down is bought:
     * the legs are exact mirrors, so the correlation between them is −1 and
     * nothing continues.
     */
    const fading = series(80, [1.02, 1 / 1.02], [1 / 1.02, 1.02]);
    const f = sessionSplit(fading, { minSessions: 10, minBucketSessions: 1 })!;
    expect(f.gapFollowThrough).toBeCloseTo(-1, 10);
    expect(f.continuationShare).toBe(0);

    // The same gaps extended rather than faded: correlation +1, always continues.
    const extending = series(80, [1.02, 1 / 1.02], [1.02, 1 / 1.02]);
    const e = sessionSplit(extending, { minSessions: 10, minBucketSessions: 1 })!;
    expect(e.gapFollowThrough).toBeCloseTo(1, 10);
    expect(e.continuationShare).toBe(1);
  });

  it('buckets gaps by the security own quantiles and reports thin buckets as counts only', () => {
    const bars = series(100, [1.03, 1.01, 1, 1 / 1.01, 1 / 1.03], [1.001]);
    const s = sessionSplit(bars, { minSessions: 10, minBucketSessions: 10 })!;

    expect(s.buckets).toHaveLength(5);
    expect(s.buckets.reduce((a, b) => a + b.sessions, 0)).toBe(s.sessions);
    // Ordered by gap size, most negative first.
    const means = s.buckets.map((b) => b.meanOvernight!);
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeGreaterThan(means[i - 1]);
    // The open ends are unbounded.
    expect(s.buckets[0].lower).toBeNull();
    expect(s.buckets[4].upper).toBeNull();

    // With a high bar for a bucket, none qualifies: counts survive, statistics
    // do not. Publishing four percentages from three sessions is the failure
    // this guards against.
    const strict = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1_000 })!;
    expect(strict.buckets.every((b) => b.sessions > 0)).toBe(true);
    expect(strict.buckets.every((b) => b.meanIntraday === null)).toBe(true);
    expect(strict.buckets.every((b) => b.continuationShare === null)).toBe(true);
  });

  it('flags a feed whose opens are just the prior close', () => {
    // Some end-of-day vendors do not carry a real open. The split is then an
    // artefact of the feed, and the reader has to be able to see that.
    const bars = series(60, [1], [1.001]);
    const s = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1 })!;
    expect(s.identicalOpenSessions).toBe(60);
    expect(s.overnight.growth).toBeCloseTo(0, 12);
  });

  it('skips a session with a broken price rather than dividing by it', () => {
    const bars = series(60, [1.001], [1.001]);
    bars[30] = { ...bars[30], open: 0 };
    const s = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1 })!;

    expect(s.unusableSessions).toBe(1);
    expect(s.sessions).toBe(59);
    expect(Number.isFinite(s.overnight.growth!)).toBe(true);
    expect(Number.isFinite(s.intraday.growth!)).toBe(true);
  });

  it('has no share to report when the security went nowhere', () => {
    // A share of a zero move is not a hundredfold contribution; it is undefined.
    const bars = series(60, [1.02, 1 / 1.02], [1]);
    const s = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1 })!;
    expect(s.totalGrowth).toBeCloseTo(0, 12);
    expect(s.overnight.share).toBeNull();
    expect(s.intraday.share).toBeNull();
  });

  it('reports nothing at all below the minimum sample', () => {
    expect(sessionSplit([])).toBeNull();
    expect(sessionSplit(series(5, [1.01], [1.01]))).toBeNull();
    expect(sessionSplit(series(39, [1.01], [1.01]))).toBeNull();
    expect(sessionSplit(series(40, [1.01], [1.01]))).not.toBeNull();
  });

  it('counts a flat leg as neither continuation nor reversal', () => {
    // sign(0) is 0, and calling that "the same direction as up" would invent a
    // decision the data did not make.
    const bars = series(60, [1], [1.001]);
    const s = sessionSplit(bars, { minSessions: 10, minBucketSessions: 1 })!;
    expect(s.continuationShare).toBeNull();
  });
});
