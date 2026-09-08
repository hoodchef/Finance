import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_HORIZONS,
  flowPressure,
  momentumAgreement,
  momentumTermStructure,
  participationProfile,
  rangeState,
  volatilityCone,
  type Bar,
} from '../src/lib/desk/models';

/**
 * The desk models, against arithmetic worked by hand.
 * =============================================================================
 * Each of these exists to replace a single-number indicator with a shape, so
 * the tests are mostly about the shape being right in situations a scalar
 * cannot tell apart — a pullback inside an uptrend against a genuine reversal,
 * a gap-up that sold off against a real advance, a quiet month inside a
 * violent year.
 *
 * Degenerate inputs get their own cases throughout. A bar with no range, a
 * window longer than the history, a series of one: these are the shapes real
 * vendor data arrives in, and returning a plausible number for them is worse
 * than returning nothing.
 */

/** Bars from closes, with a range built around each close. */
function bars(closes: number[], volume = 1_000_000): Bar[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume,
  }));
}

const ramp = (n: number, from: number, step: number) =>
  Array.from({ length: n }, (_, i) => from + i * step);

describe('momentum term structure', () => {
  it('measures each horizon back from the last close', () => {
    // 300 closes rising by exactly 1 each day, from 100.
    const closes = ramp(300, 100, 1);
    const rungs = momentumTermStructure(closes);
    const last = closes[closes.length - 1];

    for (const rung of rungs) {
      const then = closes[closes.length - 1 - rung.days];
      expect(rung.ret, `${rung.label}`).toBeCloseTo((last - then) / then, 12);
    }
  });

  it('refuses a horizon the history cannot cover', () => {
    // Forty closes cannot answer a one-year question, and saying 0% would be
    // a claim about a year that was never observed.
    const rungs = momentumTermStructure(ramp(40, 100, 1));
    const year = rungs.find((r) => r.label === '1Y')!;
    expect(year.complete).toBe(false);
    expect(year.ret).toBeNull();
    expect(year.z).toBeNull();
  });

  it('separates a pullback inside an uptrend from a reversal', () => {
    // Both end lower over a week. Only one is still up over the year, and a
    // single momentum number calls them the same thing.
    const pullback = [...ramp(260, 100, 1), ...ramp(6, 360, -3)];
    const reversal = [...ramp(260, 400, -1), ...ramp(6, 140, -3)];

    const p = momentumTermStructure(pullback);
    const r = momentumTermStructure(reversal);

    expect(p.find((x) => x.label === '1W')!.ret!).toBeLessThan(0);
    expect(p.find((x) => x.label === '1Y')!.ret!).toBeGreaterThan(0);
    expect(r.find((x) => x.label === '1W')!.ret!).toBeLessThan(0);
    expect(r.find((x) => x.label === '1Y')!.ret!).toBeLessThan(0);

    expect(momentumAgreement(p).direction).toBe('mixed');
    expect(momentumAgreement(r).direction).toBe('down');
  });

  it('scores full agreement at the extremes', () => {
    expect(momentumAgreement(momentumTermStructure(ramp(300, 100, 1))).score).toBe(1);
    expect(momentumAgreement(momentumTermStructure(ramp(300, 400, -1))).score).toBe(-1);
  });

  it('reports nothing measured rather than a confident zero', () => {
    const a = momentumAgreement(momentumTermStructure([100]));
    expect(a.measured).toBe(0);
    expect(a.direction).toBe('mixed');
  });

  it('covers every horizon it advertises', () => {
    const rungs = momentumTermStructure(ramp(300, 100, 1));
    expect(rungs.map((r) => r.label)).toEqual(MOMENTUM_HORIZONS.map((h) => h.label));
  });
});

describe('flow pressure', () => {
  it('reads a close on the high as buying and on the low as selling', () => {
    const onHigh: Bar[] = [{ date: 'd', open: 10, high: 11, low: 9, close: 11, volume: 100 }];
    const onLow: Bar[] = [{ date: 'd', open: 10, high: 11, low: 9, close: 9, volume: 100 }];
    expect(flowPressure(onHigh).points[0].clv).toBeCloseTo(1, 12);
    expect(flowPressure(onLow).points[0].clv).toBeCloseTo(-1, 12);
  });

  it('calls a gap-up that sold off distribution, which close-to-close cannot', () => {
    // Opens far above yesterday, closes on its low: up on the day, and the
    // session was sold. This is the whole reason the model reads location.
    const gapAndFade: Bar[] = [
      { date: 'd1', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
      { date: 'd2', open: 120, high: 122, low: 108, close: 108.5, volume: 5_000 },
    ];
    const flow = flowPressure(gapAndFade);
    expect(gapAndFade[1].close).toBeGreaterThan(gapAndFade[0].close); // up on the day
    expect(flow.points[1].clv).toBeLessThan(-0.8); // and heavily distributed
    expect(flow.net).toBeLessThan(0);
  });

  it('weights by dollars, not shares', () => {
    // Identical share volume, very different prices: the expensive name must
    // dominate the flow, because that is where the money went.
    const cheap: Bar[] = [{ date: 'd', open: 4, high: 4.4, low: 3.6, close: 4.4, volume: 100_000 }];
    const dear: Bar[] = [{ date: 'd', open: 400, high: 440, low: 360, close: 440, volume: 100_000 }];
    expect(flowPressure(dear).net).toBeGreaterThan(flowPressure(cheap).net * 50);
  });

  it('gives a rangeless bar no weight rather than a coin flip', () => {
    // A limit-locked or untraded print has no location to read.
    const flat: Bar[] = [{ date: 'd', open: 10, high: 10, low: 10, close: 10, volume: 5_000 }];
    const flow = flowPressure(flat);
    expect(flow.points[0].clv).toBe(0);
    expect(flow.net).toBe(0);
    expect(flow.upBarShare).toBeNull();
  });

  it('keeps pressure scale-free so two securities can share a column', () => {
    const strong = bars([10, 11, 12]).map((b) => ({ ...b, close: b.high }));
    const flow = flowPressure(strong);
    expect(flow.pressure!).toBeGreaterThan(0.9);
    expect(flow.pressure!).toBeLessThanOrEqual(1);
  });

  it('accumulates, so the running total is the sum of what came before', () => {
    const flow = flowPressure(bars([10, 11, 12, 13]));
    let running = 0;
    for (const p of flow.points) {
      running += p.signed;
      expect(p.cumulative).toBeCloseTo(running, 9);
    }
    expect(flow.net).toBeCloseTo(running, 9);
  });
});

describe('volatility cone', () => {
  // A quiet year with a violent recent month: the two ends of the cone must
  // disagree, which is exactly what one volatility number cannot say.
  const quietThenWild = [...ramp(400, 100, 0.02), ...Array.from({ length: 30 }, (_, i) => 108 + (i % 2 ? 9 : -9))];

  it('ranks the short window high and the long window lower', () => {
    const cone = volatilityCone(quietThenWild, 252);
    const short = cone.find((r) => r.label === '5D')!;
    const long = cone.find((r) => r.label === '252D')!;
    expect(short.current!).toBeGreaterThan(long.current!);
    expect(short.rank!).toBeGreaterThan(0.9);
  });

  it('orders its own percentiles', () => {
    for (const rung of volatilityCone(quietThenWild, 252)) {
      if (rung.p10 == null) continue;
      expect(rung.p10!).toBeLessThanOrEqual(rung.p50!);
      expect(rung.p50!).toBeLessThanOrEqual(rung.p90!);
    }
  });

  it('annualises by the frequency it is given, not by 252 always', () => {
    // The same series read as weekly is a much smaller annualised figure.
    const daily = volatilityCone(quietThenWild, 252).find((r) => r.label === '21D')!;
    const weekly = volatilityCone(quietThenWild, 52).find((r) => r.label === '21D')!;
    expect(daily.current! / weekly.current!).toBeCloseTo(Math.sqrt(252 / 52), 6);
  });

  it('returns nulls for a window the history cannot cover', () => {
    const cone = volatilityCone(ramp(30, 100, 1), 252);
    const year = cone.find((r) => r.label === '252D')!;
    expect(year.current).toBeNull();
    expect(year.rank).toBeNull();
  });
});

describe('intraday participation', () => {
  /** `days` sessions of half-hourly bars with the volume shape given. */
  function sessions(days: number, shape: number[]): Bar[] {
    const out: Bar[] = [];
    for (let d = 0; d < days; d++) {
      shape.forEach((vol, i) => {
        const h = String(9 + Math.floor(i / 2)).padStart(2, '0');
        const m = i % 2 ? '30' : '00';
        out.push({
          date: `2026-03-${String(d + 1).padStart(2, '0')}T${h}:${m}`,
          open: 10, high: 10.1, low: 9.9, close: 10, volume: vol,
        });
      });
    }
    return out;
  }

  const U_SHAPE = [100, 40, 20, 20, 40, 100];

  it('recovers the usual shape from prior sessions', () => {
    const p = participationProfile(sessions(5, U_SHAPE), 30);
    expect(p.sessions).toBe(4); // the latest is compared, not averaged in
    const total = p.buckets.reduce((a, b) => a + b.typical, 0);
    expect(total).toBeCloseTo(1, 9);
    // Heaviest at the open and the close, lightest in the middle.
    expect(p.buckets[0].typical).toBeGreaterThan(p.buckets[2].typical);
    expect(p.buckets[5].typical).toBeGreaterThan(p.buckets[2].typical);
  });

  it('reports no divergence when today looks like every other day', () => {
    const p = participationProfile(sessions(5, U_SHAPE), 30);
    expect(p.divergence!).toBeCloseTo(0, 9);
  });

  it('flags a session whose volume arrived at the wrong time', () => {
    // Four ordinary days, then one where everything trades mid-session.
    const odd = [...sessions(4, U_SHAPE), ...sessions(1, [10, 10, 200, 200, 10, 10]).map((b) => ({
      ...b, date: b.date.replace('2026-03-01', '2026-03-05'),
    }))];
    const p = participationProfile(odd, 30);
    expect(p.divergence!).toBeGreaterThan(0.4);
  });

  it('says nothing at all when given daily bars', () => {
    // No time component means no session to profile, and a flat line would
    // read as a finding rather than an absence.
    const p = participationProfile(bars([10, 11, 12]));
    expect(p.sessions).toBe(0);
    expect(p.buckets).toEqual([]);
    expect(p.divergence).toBeNull();
  });
});

describe('range state', () => {
  it('counts a run of inside bars', () => {
    const coiling: Bar[] = [
      { date: 'd1', open: 10, high: 12, low: 8, close: 10, volume: 1 },
      { date: 'd2', open: 10, high: 11.5, low: 8.5, close: 10, volume: 1 },
      { date: 'd3', open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { date: 'd4', open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
    ];
    expect(rangeState(coiling, 2).insideRun).toBe(3);
  });

  it('counts no run when the last bar broke out', () => {
    const breakout: Bar[] = [
      { date: 'd1', open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { date: 'd2', open: 10, high: 13, low: 9.5, close: 12.8, volume: 1 },
    ];
    expect(rangeState(breakout, 2).insideRun).toBe(0);
  });

  it('places the close within the recent range', () => {
    const b = bars([10, 12, 14, 16, 20]);
    const state = rangeState(b, 5);
    // Closing at the top of the window puts it near 1.
    expect(state.positionInRange!).toBeGreaterThan(0.9);
  });

  it('uses TRUE range, so an overnight gap counts as movement', () => {
    // Both series end at 12 with an identical final high-low range of 0.2.
    // The only difference is how they got there: one gapped from 10, the other
    // was always at 12. A high-low measure cannot tell them apart, because the
    // movement happened between bars rather than inside one.
    //
    // The price level is held constant deliberately: `atrPct` divides by
    // price, so a series that gapped UP to a higher level would show part of
    // the rise absorbed by its own denominator and understate the difference.
    const flat = (n: number, at: number, from = 0): Bar[] =>
      Array.from({ length: n }, (_, i) => ({
        date: `d${from + i}`, open: at, high: at + 0.1, low: at - 0.1, close: at, volume: 1,
      }));

    const gapped = [...flat(24, 10), ...flat(1, 12, 24)];
    const calm = flat(25, 12);

    const withGap = rangeState(gapped, 21).atrPct!;
    const withoutGap = rangeState(calm, 21).atrPct!;
    expect(withGap).toBeGreaterThan(withoutGap * 1.3);
  });

  it('survives a series too short to measure', () => {
    const state = rangeState(bars([10]), 21);
    expect(state.atrPct).toBeNull();
    expect(state.positionInRange).toBeNull();
    expect(state.insideRun).toBe(0);
  });
});
