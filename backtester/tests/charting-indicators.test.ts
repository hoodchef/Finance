import { describe, expect, it } from 'vitest';
import {
  bollingerBands,
  computeIndicators,
  ema,
  emaOfSeries,
  macd,
  parseIndicatorSpec,
  rsi,
  sma,
  vwap,
  warmupBars,
} from '../src/lib/charting/indicators';
import {
  exchangeDate,
  exchangeDateTime,
  findGaps,
  normaliseAggregates,
  type ChartBar,
  type PolygonAggregate,
} from '../src/lib/charting/bars';
import {
  buildEventTimeline,
  toDividendEvent,
  toSplitEvent,
  toTickerEvent,
  type DividendEventDetail,
  type SplitEventDetail,
} from '../src/lib/charting/events';

/**
 * Indicators are checked against values worked out by hand, not against a
 * snapshot of what the code currently returns.
 *
 * A snapshot test on an indicator locks in whatever it did the day it was
 * written, including the off-by-one and the wrong seed. Every expectation
 * below is a number somebody can rederive with a calculator, and the
 * derivation is in the comment beside it.
 */

const bar = (
  timestamp: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): ChartBar => ({
  date: new Date(timestamp).toISOString(),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
  vwap: null,
  trades: null,
  timestamp,
});

describe('simple moving average', () => {
  it('averages [1,2,3,4,5] over 5 to exactly 3', () => {
    // (1+2+3+4+5)/5 = 15/5 = 3, defined only on the last bar.
    expect(sma([1, 2, 3, 4, 5], 5)).toEqual([null, null, null, null, 3]);
  });

  it('walks a 3-window across [1..5] as 2, 3, 4', () => {
    // (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4.
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('is the identity at period 1', () => {
    expect(sma([2, 4, 6], 1)).toEqual([2, 4, 6]);
  });

  it('leaves the whole series null when there are fewer bars than the period', () => {
    // Not an empty array and not a shortened one: an all-null series keeps
    // every index aligned with its bar.
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it('rejects a period of zero rather than dividing by it', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('exponential moving average', () => {
  it('seeds with the SMA and then weights by 2/(n+1)', () => {
    // period 3 → k = 2/4 = 0.5.
    // seed at index 2 = SMA(1,2,3) = 2.
    // index 3 = 4(0.5) + 2(0.5) = 3.
    // index 4 = 5(0.5) + 3(0.5) = 4.
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('matches a second hand-worked case at period 5', () => {
    // k = 2/6 = 1/3. seed at index 4 = (1+2+3+4+5)/5 = 3.
    // index 5 = 6(1/3) + 3(2/3) = 2 + 2 = 4.
    const out = ema([1, 2, 3, 4, 5, 6], 5);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out[4]).toBeCloseTo(3, 12);
    expect(out[5]).toBeCloseTo(4, 12);
  });

  it('agrees with the SMA at the seed index, by construction', () => {
    const values = [11, 9, 14, 12, 15, 13, 18, 16];
    expect(ema(values, 4)[3]).toBeCloseTo(sma(values, 4)[3] as number, 12);
  });

  it('holds a constant series flat', () => {
    // Any weighting of x and x is x. A drifting EMA here would mean the seed
    // or the recurrence is wrong.
    for (const v of ema([7, 7, 7, 7, 7, 7], 3)) {
      if (v != null) expect(v).toBeCloseTo(7, 12);
    }
  });
});

describe('exponential moving average over a sparse series', () => {
  it('seeds on the first run of defined values, not at index 0', () => {
    // [null,null,1,2,3,4,5] with period 3 seeds at index 4 = SMA(1,2,3) = 2,
    // then index 5 = 4(0.5)+2(0.5) = 3, index 6 = 5(0.5)+3(0.5) = 4.
    const out = emaOfSeries([null, null, 1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, null, null, 2, 3, 4]);
  });

  it('returns all nulls when no run is long enough', () => {
    expect(emaOfSeries([1, null, 2, null, 3], 3)).toEqual([null, null, null, null, null]);
  });
});

describe('relative strength index', () => {
  it('reads 100 for a monotonically rising series', () => {
    // Every change is a gain, so average loss is zero and there is no
    // downside to weigh against. The formula divides by zero here; the
    // implementation must decide this case rather than emit NaN.
    const rising = Array.from({ length: 20 }, (_, i) => i + 1);
    const out = rsi(rising, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    for (let i = 14; i < out.length; i++) expect(out[i]).toBe(100);
  });

  it('reads 0 for a monotonically falling series', () => {
    const falling = Array.from({ length: 20 }, (_, i) => 20 - i);
    const out = rsi(falling, 14);
    for (let i = 14; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('reads 50 for a perfectly flat series', () => {
    // No gains and no losses. 0/0 is not a signal, and 0 or 100 would read as
    // the strongest possible one.
    const out = rsi(new Array(20).fill(42), 14);
    for (let i = 14; i < out.length; i++) expect(out[i]).toBe(50);
  });

  it('follows Wilder smoothing on a hand-worked case', () => {
    // values [10,11,10,12], period 2. Changes: +1, -1, +2.
    //   seed over the first two changes: avgGain = 1/2, avgLoss = 1/2
    //     → RS = 1, RSI = 100 - 100/2 = 50 at index 2.
    //   index 3: up = 2, down = 0
    //     avgGain = (0.5 * 1 + 2) / 2 = 1.25
    //     avgLoss = (0.5 * 1 + 0) / 2 = 0.25
    //     RS = 5, RSI = 100 - 100/6 = 83.333...
    const out = rsi([10, 11, 10, 12], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(50, 12);
    expect(out[3]).toBeCloseTo(100 - 100 / 6, 12);
  });

  it('stays inside 0..100 on noisy input', () => {
    const values = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84,
      46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46, 46.03, 46.41, 46.22, 45.64];
    for (const v of rsi(values, 14)) {
      if (v != null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('MACD', () => {
  const ramp = Array.from({ length: 60 }, (_, i) => i + 1);

  it('is exactly the fast EMA minus the slow EMA', () => {
    const { macd: line } = macd(ramp, 12, 26, 9);
    const fast = ema(ramp, 12);
    const slow = ema(ramp, 26);
    for (let i = 0; i < ramp.length; i++) {
      if (fast[i] == null || slow[i] == null) expect(line[i]).toBeNull();
      else expect(line[i] as number).toBeCloseTo((fast[i] as number) - (slow[i] as number), 12);
    }
  });

  it('starts the line at the slow EMA seed and the signal nine bars later', () => {
    // The slow EMA seeds at index 25 (26 values), so the MACD line is null
    // before it. The signal is a 9-period EMA of that line, seeding at
    // 25 + 8 = 33.
    const { macd: line, signal, histogram } = macd(ramp, 12, 26, 9);
    expect(line[24]).toBeNull();
    expect(line[25]).not.toBeNull();
    expect(signal[32]).toBeNull();
    expect(signal[33]).not.toBeNull();
    expect(histogram[32]).toBeNull();
    expect(histogram[33]).toBeCloseTo((line[33] as number) - (signal[33] as number), 12);
  });

  it('is zero throughout for a constant series', () => {
    // Two EMAs of the same flat series are the same number, so their
    // difference is zero and so is the histogram.
    const { macd: line, signal, histogram } = macd(new Array(60).fill(25), 12, 26, 9);
    for (let i = 0; i < 60; i++) {
      if (line[i] != null) expect(line[i] as number).toBeCloseTo(0, 12);
      if (signal[i] != null) expect(signal[i] as number).toBeCloseTo(0, 12);
      if (histogram[i] != null) expect(histogram[i] as number).toBeCloseTo(0, 12);
    }
  });

  it('is positive on a rising ramp, where the fast average leads', () => {
    const { macd: line } = macd(ramp, 12, 26, 9);
    expect(line[40] as number).toBeGreaterThan(0);
  });
});

describe('Bollinger bands', () => {
  it('matches the textbook population-stdev case', () => {
    // [2,4,4,4,5,5,7,9] has mean 5 and POPULATION standard deviation 2:
    //   deviations 9,1,1,1,0,0,4,16 → sum 32, /8 = 4, sqrt = 2.
    // At two standard deviations the bands are 5 ± 4 → 9 and 1.
    // The sample stdev of the same data is 2.138, which would give 9.28/0.72 —
    // this test is what pins the convention down.
    const { middle, upper, lower } = bollingerBands([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(middle[7]).toBeCloseTo(5, 12);
    expect(upper[7]).toBeCloseTo(9, 12);
    expect(lower[7]).toBeCloseTo(1, 12);
  });

  it('collapses both bands onto the middle for a constant series', () => {
    const { middle, upper, lower } = bollingerBands(new Array(10).fill(3), 5, 2);
    expect(middle[9]).toBeCloseTo(3, 12);
    expect(upper[9]).toBeCloseTo(3, 12);
    expect(lower[9]).toBeCloseTo(3, 12);
  });

  it('keeps the middle band identical to the SMA', () => {
    const values = [10, 12, 11, 15, 14, 13, 16, 18, 17, 20];
    expect(bollingerBands(values, 5, 2).middle).toEqual(sma(values, 5));
  });

  it('widens with the multiplier symmetrically', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const one = bollingerBands(values, 8, 1);
    const two = bollingerBands(values, 8, 2);
    expect(one.upper[7]).toBeCloseTo(7, 12);
    expect(one.lower[7]).toBeCloseTo(3, 12);
    expect((two.upper[7] as number) - 5).toBeCloseTo(5 - (two.lower[7] as number), 12);
  });
});

describe('VWAP', () => {
  // 2026-08-19 and 2026-08-20 at 14:30Z, which is 10:30 in New York on both.
  const day1 = Date.UTC(2026, 7, 19, 14, 30);
  const day2 = Date.UTC(2026, 7, 20, 14, 30);

  it('accumulates typical price weighted by volume', () => {
    // typical = (H+L+C)/3
    //   bar 1: (11+9+10)/3 = 10,  v=100 → 1000 / 100            = 10
    //   bar 2: (13+11+12)/3 = 12, v=300 → (1000+3600) / 400     = 11.5
    //   bar 3: (16+14+15)/3 = 15, v=100 → (4600+1500) / 500     = 12.2
    const bars = [
      bar(day1, 10, 11, 9, 10, 100),
      bar(day1 + 60_000, 12, 13, 11, 12, 300),
      bar(day1 + 120_000, 15, 16, 14, 15, 100),
    ];
    const out = vwap(bars, 'session');
    expect(out[0]).toBeCloseTo(10, 12);
    expect(out[1]).toBeCloseTo(11.5, 12);
    expect(out[2]).toBeCloseTo(12.2, 12);
  });

  it('restarts at each exchange session under the session anchor', () => {
    const bars = [
      bar(day1, 10, 11, 9, 10, 100),
      bar(day2, 20, 21, 19, 20, 100),
    ];
    // The second day starts over, so it reads its own typical price, not the
    // blend of 10 and 20 that a running total would give.
    expect(vwap(bars, 'session')[1]).toBeCloseTo(20, 12);
    // Anchored to the series instead: (1000 + 2000) / 200 = 15.
    expect(vwap(bars, 'series')[1]).toBeCloseTo(15, 12);
  });

  it('returns null rather than a price when no volume has traded', () => {
    // With zero cumulative volume there is no volume-weighted price. Returning
    // the close would relabel an unweighted number as a weighted one.
    expect(vwap([bar(day1, 10, 11, 9, 10, 0)], 'session')).toEqual([null]);
  });
});

describe('bar normalisation', () => {
  it('dates a daily bar by its exchange calendar day', () => {
    // Polygon stamps a daily bar at midnight New York, which is 04:00Z in
    // summer. The trading date is the tenth, not the ninth.
    const t = Date.UTC(2026, 7, 10, 4, 0);
    expect(exchangeDate(t)).toBe('2026-08-10');
    const { bars } = normaliseAggregates([{ t, o: 1, h: 2, l: 1, c: 2, v: 10 }], 'day');
    expect(bars[0].date).toBe('2026-08-10');
  });

  it('keeps a late intraday bar on its own session, not the next UTC day', () => {
    // 2026-08-20T00:00Z is 20:00 on the nineteenth in New York. Formatting in
    // UTC would move the last after-hours bar of a session into the next day.
    const t = Date.UTC(2026, 7, 20, 0, 0);
    expect(exchangeDateTime(t)).toBe('2026-08-19T20:00');
    const { bars } = normaliseAggregates([{ t, o: 1, h: 2, l: 1, c: 2, v: 10 }], 'hour');
    expect(bars[0].date).toBe('2026-08-19T20:00');
  });

  it('drops rows with no timestamp or no usable close, and counts them', () => {
    const raw: PolygonAggregate[] = [
      { t: Date.UTC(2026, 7, 10, 4), c: 10, o: 9, h: 11, l: 9, v: 1 },
      { c: 11 },
      { t: Date.UTC(2026, 7, 11, 4) },
      { t: Date.UTC(2026, 7, 12, 4), c: 0 },
    ];
    const { bars, dropped } = normaliseAggregates(raw, 'day');
    expect(bars).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it('never invents a bar for an interval the provider omitted', () => {
    // Friday and the following Tuesday, with Monday absent. Two bars in, two
    // bars out — no zero-volume filler and no carried-forward close.
    const fri = Date.UTC(2026, 7, 14, 4);
    const tue = Date.UTC(2026, 7, 18, 4);
    const { bars } = normaliseAggregates(
      [
        { t: fri, o: 10, h: 11, l: 9, c: 10, v: 100 },
        { t: tue, o: 12, h: 13, l: 11, c: 12, v: 100 },
      ],
      'day',
    );
    expect(bars.map((b) => b.date)).toEqual(['2026-08-14', '2026-08-18']);
  });

  it('sorts out-of-order rows and collapses a repeated interval', () => {
    const a = Date.UTC(2026, 7, 10, 4);
    const b = Date.UTC(2026, 7, 11, 4);
    const { bars } = normaliseAggregates(
      [
        { t: b, o: 2, h: 2, l: 2, c: 2, v: 1 },
        { t: a, o: 1, h: 1, l: 1, c: 1, v: 1 },
        { t: b, o: 3, h: 3, l: 3, c: 3, v: 9 },
      ],
      'day',
    );
    expect(bars.map((x) => x.date)).toEqual(['2026-08-10', '2026-08-11']);
    // The later read of a settling bar wins.
    expect(bars[1].close).toBe(3);
  });

  it('fills a missing open/high/low from the close without inventing a range', () => {
    const { bars } = normaliseAggregates([{ t: Date.UTC(2026, 7, 10, 4), c: 5 }], 'day');
    expect(bars[0]).toMatchObject({ open: 5, high: 5, low: 5, close: 5, volume: 0 });
  });
});

describe('gap reporting', () => {
  const daily = (dates: string[]) =>
    normaliseAggregates(
      dates.map((d) => ({ t: Date.parse(`${d}T04:00:00Z`), o: 1, h: 1, l: 1, c: 1, v: 1 })),
      'day',
    ).bars;

  it('does not call an ordinary weekend a gap', () => {
    // Friday to Monday has no missing weekday between it.
    expect(findGaps(daily(['2026-08-14', '2026-08-17']), 'day')).toEqual([]);
  });

  it('reports a missing weekday between two sessions', () => {
    const gaps = findGaps(daily(['2026-08-14', '2026-08-18']), 'day');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ after: '2026-08-14', before: '2026-08-18', missing: 1 });
  });

  it('counts a run of missing sessions', () => {
    const gaps = findGaps(daily(['2026-08-10', '2026-08-14']), 'day');
    expect(gaps[0].missing).toBe(3);
  });
});

describe('event timeline', () => {
  it('takes the split-adjusted dividend amount, not the raw one', () => {
    // The real AAPL row: 2.65 as paid in 2013, 0.094643 restated through the
    // 7:1 in 2014 and the 4:1 in 2020. The chart it annotates is drawn on
    // split-adjusted prices, so the raw amount would sit 28x above the price
    // it relates to.
    const event = toDividendEvent({
      ticker: 'AAPL',
      cash_amount: 2.65,
      split_adjusted_cash_amount: 0.094643,
      ex_dividend_date: '2013-02-07',
      pay_date: '2013-02-14',
      currency: 'USD',
      frequency: 0,
    }) as DividendEventDetail;
    expect(event.amount).toBeCloseTo(0.094643, 9);
    expect(event.date).toBe('2013-02-07');
    expect(event.dateBasis).toBe('ex_dividend_date');
    // 2.65 / (7 * 4) = 0.0946428..., which is what Polygon reports.
    expect(event.amount).toBeCloseTo(2.65 / 28, 5);
  });

  it('falls back to the pay date and says so when there is no ex date', () => {
    const event = toDividendEvent({
      cash_amount: 1,
      pay_date: '2024-03-01',
    }) as DividendEventDetail;
    expect(event.date).toBe('2024-03-01');
    expect(event.dateBasis).toBe('pay_date');
  });

  it('marks an amount the provider did not split-adjust', () => {
    const event = toDividendEvent({
      cash_amount: 0.5,
      ex_dividend_date: '2024-03-01',
    }) as DividendEventDetail;
    expect(event.amount).toBe(0.5);
    expect(event.detail).toContain('not split-adjusted');
  });

  it('reads a forward split from split_from and split_to', () => {
    const event = toSplitEvent({
      execution_date: '2020-08-31',
      split_from: 1,
      split_to: 4,
    }) as SplitEventDetail;
    expect(event).toMatchObject({ date: '2020-08-31', from: 1, to: 4, ratio: 4, label: '4:1' });
    expect(event.detail).toContain('4-for-1 split');
  });

  it('names a reverse split as one', () => {
    const event = toSplitEvent({
      execution_date: '2024-01-05',
      split_from: 10,
      split_to: 1,
    }) as SplitEventDetail;
    expect(event.ratio).toBeCloseTo(0.1, 12);
    expect(event.detail).toContain('reverse split');
  });

  it('drops rows it cannot date or ratio rather than guessing', () => {
    expect(toSplitEvent({ split_from: 1, split_to: 2 })).toBeNull();
    expect(toSplitEvent({ execution_date: '2020-01-01', split_from: 0, split_to: 2 })).toBeNull();
    expect(toDividendEvent({ cash_amount: 1 })).toBeNull();
    expect(toDividendEvent({ ex_dividend_date: '2020-01-01', cash_amount: 0 })).toBeNull();
    expect(toTickerEvent({ type: 'ticker_change' })).toBeNull();
  });

  it('merges the three feeds in date order, split first within a date', () => {
    const timeline = buildEventTimeline({
      dividends: [
        { ex_dividend_date: '2020-08-31', cash_amount: 0.205 },
        { ex_dividend_date: '2019-05-10', cash_amount: 0.77 },
      ],
      splits: [{ execution_date: '2020-08-31', split_from: 1, split_to: 4 }],
      tickerEvents: [{ type: 'ticker_change', date: '2003-09-10', ticker_change: { ticker: 'AAPL' } }],
    });
    expect(timeline.map((e) => [e.date, e.kind])).toEqual([
      ['2003-09-10', 'ticker_change'],
      ['2019-05-10', 'dividend'],
      // The split takes effect first, and the dividend is quoted in
      // post-split units, so it is read second.
      ['2020-08-31', 'split'],
      ['2020-08-31', 'dividend'],
    ]);
  });

  it('honours the requested range', () => {
    const timeline = buildEventTimeline(
      {
        dividends: [
          { ex_dividend_date: '2019-01-01', cash_amount: 1 },
          { ex_dividend_date: '2021-01-01', cash_amount: 1 },
          { ex_dividend_date: '2023-01-01', cash_amount: 1 },
        ],
      },
      { from: '2020-01-01', to: '2022-01-01' },
    );
    expect(timeline.map((e) => e.date)).toEqual(['2021-01-01']);
  });
});

describe('indicator specs', () => {
  it('parses a name with parameters and canonicalises the id', () => {
    expect(parseIndicatorSpec('sma:50')).toMatchObject({ kind: 'sma', params: [50], id: 'sma:50' });
    expect(parseIndicatorSpec('MACD')).toMatchObject({ kind: 'macd', params: [12, 26, 9] });
    expect(parseIndicatorSpec('bb:20:2').id).toBe('bbands:20:2');
    expect(parseIndicatorSpec({ kind: 'ema', period: 200 }).id).toBe('ema:200');
  });

  it('rejects an unknown name instead of substituting a default', () => {
    // Quietly serving an SMA for a misspelt indicator would put a line on the
    // chart under a label it does not match.
    expect(() => parseIndicatorSpec('smaa:50')).toThrow(/Unknown indicator/);
    expect(() => parseIndicatorSpec('sma:0')).toThrow(/out-of-range/);
    expect(() => parseIndicatorSpec('sma:-5')).toThrow(/out-of-range/);
  });

  it('states the warm-up each indicator needs', () => {
    expect(warmupBars(parseIndicatorSpec('sma:50'))).toBe(50);
    expect(warmupBars(parseIndicatorSpec('rsi:14'))).toBe(15);
    expect(warmupBars(parseIndicatorSpec('macd:12:26:9'))).toBe(35);
  });

  it('computes every requested indicator over one set of bars', () => {
    const base = Date.UTC(2026, 0, 5, 14, 30);
    const bars = Array.from({ length: 40 }, (_, i) =>
      bar(base + i * 86_400_000, 10 + i, 11 + i, 9 + i, 10 + i, 100),
    );
    const out = computeIndicators(bars, [
      parseIndicatorSpec('sma:5'),
      parseIndicatorSpec('rsi:14'),
      parseIndicatorSpec('vwap'),
    ]);
    expect(Object.keys(out).sort()).toEqual(['rsi:14', 'sma:5', 'vwap']);
    // Closes are 10..49, so the 5-window ending at index 4 averages 12.
    expect((out['sma:5'] as Array<number | null>)[4]).toBeCloseTo(12, 12);
    // A strictly rising close is maximal RSI.
    expect((out['rsi:14'] as Array<number | null>)[20]).toBe(100);
  });

  it('returns an all-null series rather than omitting an indicator it cannot fill', () => {
    // A requested overlay that simply vanished from the response reads as a
    // rendering bug rather than as too short a range.
    const bars = [bar(Date.UTC(2026, 0, 5, 14, 30), 1, 1, 1, 1, 1)];
    const out = computeIndicators(bars, [parseIndicatorSpec('sma:200')]);
    expect(out['sma:200']).toEqual([null]);
  });
});
