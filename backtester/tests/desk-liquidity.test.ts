import { describe, expect, it } from 'vitest';
import { LIQUIDITY_WINDOWS, liquidityProfile } from '../src/lib/desk/liquidity';
import type { Bar } from '../src/lib/desk/models';

/**
 * Tradability, against arithmetic worked by hand.
 * =============================================================================
 * Two things are being defended here.
 *
 * The first is that every figure is a MEDIAN or an explicit exclusion rather
 * than a mean over whatever was in the array. A single earnings session prints
 * several times the ordinary day's volume, and a mean lets that one day claim
 * the security is liquid on the other sixty-two — which is exactly the error
 * that makes a signal on a thin name look actionable.
 *
 * The second is refusal. A 252-day median from forty bars, a turnover computed
 * without a share count, a price-impact figure from a session that did not
 * trade: all three have an arithmetically available answer, all three would be
 * a fabricated finding, and all three come back null.
 */

function bars(
  rows: Array<{ close: number; volume: number }>,
  start = '2026-01-05',
): Bar[] {
  const d = new Date(`${start}T00:00:00Z`);
  return rows.map(({ close, volume }) => {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date, open: close, high: close * 1.01, low: close * 0.99, close, volume };
  });
}

/** `n` identical sessions. */
const flat = (n: number, close: number, volume: number) =>
  bars(Array.from({ length: n }, () => ({ close, volume })));

const window = (p: ReturnType<typeof liquidityProfile>, days: number) =>
  p.windows.find((w) => w.window === days)!;

describe('liquidity windows', () => {
  it('reports the median dollar volume of a steady tape exactly', () => {
    // 300 sessions at $50 and 400,000 shares: $20m every single day.
    const profile = liquidityProfile(flat(300, 50, 400_000));
    for (const w of profile.windows) {
      expect(w.medianDollarVolume, w.label).toBeCloseTo(20_000_000, 6);
      expect(w.p10DollarVolume, w.label).toBeCloseTo(20_000_000, 6);
      expect(w.medianShareVolume, w.label).toBe(400_000);
      expect(w.zeroVolumeSessions, w.label).toBe(0);
      expect(w.bars, w.label).toBe(w.window);
    }
  });

  it('is not moved by one enormous session, which a mean would be', () => {
    // Sixty-two ordinary days at $1m and one that traded a hundred times as
    // much. The median is still $1m — the day almost every order will actually
    // be worked on — while the mean is dragged to $2.57m by a single session
    // nobody can rely on repeating.
    const rows = Array.from({ length: 63 }, (_, i) => ({
      close: 10,
      volume: i === 40 ? 10_000_000 : 100_000,
    }));
    const w = window(liquidityProfile(bars(rows)), 63);
    expect(w.medianDollarVolume).toBeCloseTo(1_000_000, 6);

    // (62 x $1m + $100m) / 63 = $2,571,428.57. The median does not move at all.
    const mean = rows.reduce((a, r) => a + r.close * r.volume, 0) / rows.length;
    expect(mean).toBeCloseTo(2_571_428.57, 1);
    expect(mean).toBeGreaterThan(w.medianDollarVolume! * 2.5);
  });

  it('reports the tenth percentile as the quiet day, below the median', () => {
    // Volume ramps from 10k to 640k across 63 sessions.
    const rows = Array.from({ length: 63 }, (_, i) => ({ close: 10, volume: 10_000 + i * 10_000 }));
    const w = window(liquidityProfile(bars(rows)), 63);
    expect(w.p10DollarVolume!).toBeLessThan(w.medianDollarVolume!);
    // p10 of a linear ramp of 63 points: index 6.2 between 70k and 80k shares.
    expect(w.p10DollarVolume).toBeCloseTo(10 * (70_000 + 0.2 * 10_000), 6);
  });

  it('refuses a window the history cannot cover', () => {
    // Forty bars is not a year, and "252-day median volume" computed from
    // forty is a different figure wearing the same label.
    const profile = liquidityProfile(flat(40, 50, 400_000));
    const year = window(profile, 252);
    expect(year.medianDollarVolume).toBeNull();
    expect(year.p10DollarVolume).toBeNull();
    expect(year.medianShareVolume).toBeNull();
    expect(year.amihud).toBeNull();
    expect(year.turnover).toBeNull();
    expect(year.bars).toBe(40);

    expect(window(profile, 21).medianDollarVolume).not.toBeNull();
  });

  it('returns nothing measurable from an empty series', () => {
    const profile = liquidityProfile([]);
    expect(profile.windows).toHaveLength(LIQUIDITY_WINDOWS.length);
    for (const w of profile.windows) {
      expect(w.medianDollarVolume, w.label).toBeNull();
      expect(w.amihud, w.label).toBeNull();
      expect(w.bars, w.label).toBe(0);
    }
    expect(profile.trend).toBeNull();
    expect(profile.capacity).toBeNull();
  });

  it('returns nothing measurable from a single bar', () => {
    const profile = liquidityProfile(flat(1, 50, 400_000));
    expect(window(profile, 21).medianDollarVolume).toBeNull();
    expect(window(profile, 21).bars).toBe(1);
    expect(profile.capacity).toBeNull();
  });
});

describe('price impact', () => {
  it('recovers Amihud from returns and volumes built to have one', () => {
    // Every session moves exactly +1% on exactly $1m of dollar volume, so the
    // impact per $1m traded is exactly 0.01.
    const closes = [100];
    for (let i = 1; i < 22; i++) closes.push(closes[i - 1] * 1.01);
    const rows = closes.map((close) => ({ close, volume: 1_000_000 / close }));

    const w = window(liquidityProfile(bars(rows)), 21);
    expect(w.amihud).toBeCloseTo(0.01, 12);
  });

  it('uses the bar before the window as the first return base, where one exists', () => {
    // 22 bars for a 21-day window gives 21 measured returns; 21 bars gives 20,
    // because there is nothing before the first one to measure it against.
    const closes22 = [100];
    for (let i = 1; i < 22; i++) closes22.push(closes22[i - 1] * 1.01);
    const rows22 = closes22.map((close) => ({ close, volume: 1_000_000 / close }));

    const withPrior = window(liquidityProfile(bars(rows22)), 21).amihud!;
    const withoutPrior = window(liquidityProfile(bars(rows22.slice(1))), 21).amihud!;

    // Both are 0.01 here by construction — the point is that neither invents
    // an observation nor silently drops the window.
    expect(withPrior).toBeCloseTo(0.01, 12);
    expect(withoutPrior).toBeCloseTo(0.01, 12);
  });

  it('reads a thin name as more impactful than a liquid one at the same move', () => {
    const closes = [100];
    for (let i = 1; i < 30; i++) closes.push(closes[i - 1] * 1.01);
    const liquid = window(
      liquidityProfile(bars(closes.map((close) => ({ close, volume: 50_000_000 / close })))),
      21,
    ).amihud!;
    const thin = window(
      liquidityProfile(bars(closes.map((close) => ({ close, volume: 200_000 / close })))),
      21,
    ).amihud!;
    expect(thin / liquid).toBeCloseTo(250, 6);
  });

  it('is zero, not null, for a security that traded and did not move', () => {
    // Zero impact is a real observation: volume arrived and the price held.
    expect(window(liquidityProfile(flat(30, 50, 400_000)), 21).amihud).toBeCloseTo(0, 12);
  });

  it('excludes an untraded session instead of calling it infinite impact', () => {
    // A halted day is missing data, not an observation of unbounded impact,
    // and one division by zero would swamp the mean for the whole window.
    const closes = [100];
    for (let i = 1; i < 30; i++) closes.push(closes[i - 1] * 1.01);
    const rows = closes.map((close, i) => ({
      close,
      volume: i === 15 ? 0 : 1_000_000 / close,
    }));
    const w = window(liquidityProfile(bars(rows)), 21);
    expect(Number.isFinite(w.amihud!)).toBe(true);
    expect(w.amihud).toBeCloseTo(0.01, 12);
  });

  it('has no impact figure at all when nothing in the window traded', () => {
    const w = window(liquidityProfile(flat(30, 50, 0)), 21);
    expect(w.amihud).toBeNull();
    // The median dollar volume of a window that did not trade IS zero. That is
    // an observation, not a hole, and it is the reading the panel should show.
    expect(w.medianDollarVolume).toBe(0);
    expect(w.zeroVolumeSessions).toBe(21);
  });

  it('counts untraded sessions rather than averaging them away', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      close: 10,
      volume: i % 5 === 0 ? 0 : 100_000,
    }));
    expect(window(liquidityProfile(bars(rows)), 21).zeroVolumeSessions).toBe(4);
  });
});

describe('turnover', () => {
  it('divides median share volume by the share count it was given', () => {
    const profile = liquidityProfile(flat(300, 50, 400_000), {
      sharesOutstanding: 100_000_000,
      sharesBasis: 'polygon:share_class_shares_outstanding',
    });
    expect(window(profile, 63).turnover).toBeCloseTo(0.004, 12);
    expect(profile.sharesOutstanding).toBe(100_000_000);
    expect(profile.sharesBasis).toBe('polygon:share_class_shares_outstanding');
  });

  it('has no turnover without a share count, rather than one from market cap', () => {
    const profile = liquidityProfile(flat(300, 50, 400_000));
    for (const w of profile.windows) expect(w.turnover, w.label).toBeNull();
    expect(profile.sharesOutstanding).toBeNull();
    expect(profile.sharesBasis).toBeNull();
  });

  it('rejects a share count that is zero, negative or not a number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const profile = liquidityProfile(flat(300, 50, 400_000), { sharesOutstanding: bad });
      expect(window(profile, 21).turnover, String(bad)).toBeNull();
      expect(profile.sharesOutstanding, String(bad)).toBeNull();
      // The basis is dropped with the number: naming a source for a figure
      // that was refused would make the refusal look like a measurement.
      expect(profile.sharesBasis, String(bad)).toBeNull();
    }
  });
});

describe('trend and capacity', () => {
  it('reports the recent month against the year as a ratio of medians', () => {
    // A year at $20m a day, then a final month at $5m: participation has
    // fallen to a quarter, and an "average daily volume" would not say so.
    const rows = [
      ...Array.from({ length: 252 }, () => ({ close: 50, volume: 400_000 })),
      ...Array.from({ length: 21 }, () => ({ close: 50, volume: 100_000 })),
    ];
    const profile = liquidityProfile(bars(rows));
    expect(window(profile, 21).medianDollarVolume).toBeCloseTo(5_000_000, 6);
    // The 252-day window ends today, so it contains the quiet month too — its
    // median is still the busy level because 231 of 252 sessions were busy.
    expect(window(profile, 252).medianDollarVolume).toBeCloseTo(20_000_000, 6);
    expect(profile.trend).toBeCloseTo(0.25, 12);
  });

  it('has no trend when either window is short of history', () => {
    const profile = liquidityProfile(flat(100, 50, 400_000));
    expect(window(profile, 21).medianDollarVolume).not.toBeNull();
    expect(window(profile, 252).medianDollarVolume).toBeNull();
    expect(profile.trend).toBeNull();
  });

  it('has no trend when the year did not trade, rather than dividing by zero', () => {
    const rows = [
      ...Array.from({ length: 252 }, () => ({ close: 50, volume: 0 })),
      ...Array.from({ length: 21 }, () => ({ close: 50, volume: 0 })),
    ];
    expect(liquidityProfile(bars(rows)).trend).toBeNull();
  });

  it('states capacity as a share of a typical session, with the rate beside it', () => {
    const profile = liquidityProfile(flat(300, 50, 400_000));
    expect(profile.participationRate).toBe(0.1);
    expect(profile.capacity).toBeCloseTo(2_000_000, 6);

    const quarter = liquidityProfile(flat(300, 50, 400_000), { participationRate: 0.25 });
    expect(quarter.participationRate).toBe(0.25);
    expect(quarter.capacity).toBeCloseTo(5_000_000, 6);
  });

  it('honours a caller-supplied window set', () => {
    const profile = liquidityProfile(flat(300, 50, 400_000), {
      windows: [{ label: '5D', days: 5 }],
    });
    expect(profile.windows.map((w) => w.window)).toEqual([5]);
    // Trend and capacity are defined against the 21/252 pair, which this set
    // does not contain, so both refuse rather than substituting the 5-day.
    expect(profile.trend).toBeNull();
    expect(profile.capacity).toBeNull();
  });
});
