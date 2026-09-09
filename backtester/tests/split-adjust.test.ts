import { describe, expect, it } from 'vitest';
import { backAdjustForSplits, type AdjustableBar } from '../src/lib/market-data/adjust';
import type { SplitEvent } from '../src/lib/types';

/**
 * Back-adjusting a raw series, against arithmetic worked by hand.
 * =============================================================================
 * The bug these guard against was live and quiet. Tiingo returns raw prices and
 * says so; the backtest engine reads the declaration and applies the splits,
 * and the desk and chart routes read `bars` and ignored `splits`. AAPL's
 * four-for-one on 31 August 2020 therefore appeared as a 135% single-day move
 * from $499.23 to $129.04, which fabricated a -78.89% maximum drawdown, drove
 * the ulcer index to 58%, and flattened the autocorrelation of absolute returns
 * to 0.046 where equities sit near 0.2 — one outlier is enough to dominate
 * every second moment in a sample.
 *
 * Nothing failed. Every figure was internally consistent and plausible, which
 * is exactly why this is asserted rather than left to be noticed.
 */

const bar = (date: string, price: number, volume = 1_000): AdjustableBar => ({
  date,
  open: price,
  high: price * 1.01,
  low: price * 0.99,
  close: price,
  volume,
});

const split = (date: string, numerator: number, denominator = 1): SplitEvent => ({
  date,
  numerator,
  denominator,
});

describe('back-adjusting for splits', () => {
  it('restates history in today’s terms, leaving the latest bar alone', () => {
    // The real AAPL case: $499.23 the day before a 4-for-1, $129.04 the day of.
    const bars = [bar('2020-08-28', 499.23), bar('2020-08-31', 129.04)];
    const out = backAdjustForSplits(bars, [split('2020-08-31', 4)], 'raw');

    expect(out[1].close).toBe(129.04); // Untouched: it is already post-split.
    expect(out[0].close).toBeCloseTo(124.8075, 6); // 499.23 / 4
  });

  it('removes the cliff, which is the whole point', () => {
    const bars = [bar('2020-08-28', 499.23), bar('2020-08-31', 129.04)];
    const raw = Math.abs(Math.log(bars[1].close / bars[0].close));
    const out = backAdjustForSplits(bars, [split('2020-08-31', 4)], 'raw');
    const adjusted = Math.abs(Math.log(out[1].close / out[0].close));

    expect(raw).toBeGreaterThan(1.3); // A 135% "move" that never happened.
    expect(adjusted).toBeLessThan(0.05); // The 3.4% the day actually moved.
  });

  it('preserves dollar volume exactly', () => {
    // Price down by the ratio, shares up by it: the money is unchanged. A
    // liquidity panel reading adjusted prices against raw volume would report
    // four times the turnover for every pre-split session.
    const bars = [bar('2020-08-28', 400, 1_000)];
    const out = backAdjustForSplits(bars, [split('2020-08-31', 4)], 'raw');
    expect(out[0].close * out[0].volume).toBeCloseTo(400 * 1_000, 6);
    expect(out[0].volume).toBe(4_000);
  });

  it('adjusts the whole bar, not only the close', () => {
    const out = backAdjustForSplits([bar('2020-01-02', 400)], [split('2020-08-31', 4)], 'raw');
    expect(out[0].open).toBeCloseTo(100, 9);
    expect(out[0].high).toBeCloseTo(101, 9);
    expect(out[0].low).toBeCloseTo(99, 9);
  });

  it('compounds two splits rather than applying only the nearest', () => {
    // 2-for-1 then 4-for-1: a bar before both is restated by 8.
    const bars = [bar('2019-01-02', 800), bar('2020-06-01', 800), bar('2021-01-04', 100)];
    const out = backAdjustForSplits(
      bars,
      [split('2020-01-02', 2), split('2020-12-01', 4)],
      'raw',
    );
    expect(out[0].close).toBeCloseTo(100, 9); // 800 / 8
    expect(out[1].close).toBeCloseTo(200, 9); // 800 / 4
    expect(out[2].close).toBe(100); // after both
  });

  it('handles a reverse split with the same arithmetic', () => {
    // 1-for-10: the price rises, so history is scaled UP by 10.
    const out = backAdjustForSplits(
      [bar('2021-01-04', 2), bar('2021-06-01', 20)],
      [split('2021-06-01', 1, 10)],
      'raw',
    );
    expect(out[0].close).toBeCloseTo(20, 9);
    expect(out[1].close).toBe(20);
  });

  it('leaves an already-adjusted series completely alone', () => {
    // Adjusting twice is worse than not adjusting: it looks plausible and is
    // wrong in the other direction.
    const bars = [bar('2020-08-28', 124.81), bar('2020-08-31', 129.04)];
    const out = backAdjustForSplits(bars, [split('2020-08-31', 4)], 'split-adjusted');
    expect(out).toEqual(bars);
  });

  it('does nothing when there are no splits, or none inside the window', () => {
    const bars = [bar('2024-01-02', 100), bar('2024-01-03', 101)];
    expect(backAdjustForSplits(bars, [], 'raw')).toEqual(bars);
    // A split before the first bar: the window is already past it.
    expect(backAdjustForSplits(bars, [split('2019-01-01', 4)], 'raw')).toEqual(bars);
  });

  it('ignores a malformed split rather than producing Infinity', () => {
    const bars = [bar('2020-01-02', 400), bar('2021-01-04', 100)];
    for (const bad of [split('2020-06-01', 0), split('2020-06-01', 4, 0), split('2020-06-01', Number.NaN)]) {
      const out = backAdjustForSplits(bars, [bad], 'raw');
      for (const b of out) expect(Number.isFinite(b.close)).toBe(true);
    }
  });

  it('treats a 1-for-1 as the no-op it is', () => {
    const bars = [bar('2020-01-02', 100), bar('2021-01-04', 110)];
    expect(backAdjustForSplits(bars, [split('2020-06-01', 1)], 'raw')).toEqual(bars);
  });

  it('survives an empty series', () => {
    expect(backAdjustForSplits([], [split('2020-08-31', 4)], 'raw')).toEqual([]);
  });
});
