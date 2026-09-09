import type { PriceAdjustment, SplitEvent } from '@/lib/types';

/**
 * Back-adjusting a raw price series for splits.
 * =============================================================================
 * Some vendors return prices exactly as they printed on the day. Tiingo does,
 * and says so: its series carries `adjustment: 'raw'` and a separate list of
 * split events, and the backtest engine reads both — `prepare.ts` builds a
 * per-day split factor and applies it as a change in SHARE COUNT, which is
 * what a split actually is.
 *
 * Anything that reads `bars` and ignores `splits` gets a series with a cliff in
 * it. AAPL split four-for-one on 31 August 2020, so a raw series steps from
 * $499.23 to $129.04 overnight — a 135% single-day "move" that never happened.
 * That one bar is enough to fabricate a −78.89% maximum drawdown, drive the
 * ulcer index to 58%, and flatten the autocorrelation of absolute returns to
 * 0.046 when equities normally sit near 0.2, because a single enormous outlier
 * dominates every second moment in the sample.
 *
 * The convention here is BACK-adjustment: today's price is left alone and
 * history is restated in today's terms, which is what makes a chart's
 * right-hand edge match the quote a reader can actually see. Prices before a
 * split are divided by its ratio and volumes multiplied by it, so dollar
 * volume — price times shares — is preserved exactly.
 *
 * A series already declared `split-adjusted` is returned untouched. Adjusting
 * twice is worse than not adjusting at all: it looks plausible and is wrong in
 * the opposite direction.
 */

export interface AdjustableBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Restates `bars` in the terms of the most recent bar.
 *
 * Walks backwards accumulating the ratio of every split at or after each bar,
 * so a series with two splits compounds them rather than applying only the
 * nearest. A split dated on or before the first bar affects nothing, which is
 * correct — the whole window is already on the far side of it.
 */
export function backAdjustForSplits<T extends AdjustableBar>(
  bars: readonly T[],
  splits: readonly SplitEvent[],
  adjustment: PriceAdjustment,
): T[] {
  if (adjustment === 'split-adjusted' || !bars.length || !splits.length) {
    return bars as T[];
  }

  // Ratios greater than one are forward splits; a reverse split is < 1. Either
  // way the arithmetic is identical, which is why the sign is not special-cased.
  const usable = splits
    .filter((s) => Number.isFinite(s.numerator) && Number.isFinite(s.denominator))
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ date: s.date, ratio: s.numerator / s.denominator }))
    .filter((s) => Math.abs(s.ratio - 1) > 1e-9)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // Latest first.

  if (!usable.length) return bars as T[];

  const out = bars.slice() as T[];
  let factor = 1;
  let next = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    // Every split strictly AFTER this bar has already been folded in. A bar
    // dated on the split date is the first to trade at the new price, so it is
    // not adjusted by its own split.
    while (next < usable.length && usable[next].date > out[i].date) {
      factor *= usable[next].ratio;
      next++;
    }
    if (factor === 1) continue;

    const b = out[i];
    out[i] = {
      ...b,
      open: b.open / factor,
      high: b.high / factor,
      low: b.low / factor,
      close: b.close / factor,
      // Shares move the other way, so price x volume is unchanged.
      volume: b.volume * factor,
    };
  }

  return out;
}
