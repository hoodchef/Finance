import type { Bar } from './models';

/**
 * Can you actually trade it, and at what cost.
 * =============================================================================
 * Every other panel on the desk assumes the answer is yes. Momentum, the
 * volatility cone and the regime lattice all describe a price you could
 * transact at, and for a thin security that assumption is the largest error in
 * the whole screen — a signal on a name that trades $200k a day is not
 * actionable at any size, however clean the signal is.
 *
 * All of this is arithmetic on volume the providers already returned with the
 * daily bars, so it costs no extra request. The one figure that needs
 * something else is turnover, which needs a share count; without one it is
 * null rather than estimated from market cap and a guessed price.
 *
 * WHY DOLLAR VOLUME AND NOT SHARE VOLUME
 *
 * Share volume is not comparable across securities and barely comparable
 * across time for one: a hundred thousand shares of a $400 stock and of a $4
 * stock are two orders of magnitude apart in the only unit a desk sizes in.
 * Share volume is still reported, because a share count is what an order is
 * written in, but every ranking here is done in dollars.
 */

export interface LiquidityWindow {
  /** Trading days asked for. */
  window: number;
  label: string;
  /**
   * Median close × volume over the window.
   *
   * Median, not mean: one earnings session routinely prints five times the
   * ordinary day's volume, and a mean lets that single day claim the security
   * is liquid on the other sixty-two. The median is what a typical day looks
   * like, which is the day most orders will be worked on.
   *
   * Close price rather than VWAP because the end-of-day providers behind this
   * desk do not all return a VWAP, and mixing a VWAP-based figure for one
   * symbol with a close-based figure for another would make the two
   * incomparable in a way nothing on screen would reveal.
   */
  medianDollarVolume: number | null;
  /** Tenth percentile of the same series: what a quiet day looks like. */
  p10DollarVolume: number | null;
  medianShareVolume: number | null;
  /**
   * Amihud illiquidity: mean |daily return| per $1m of dollar volume traded.
   *
   * A direct read on price impact — how far the price moves for a given amount
   * of trading. 0.01 means a million dollars of volume accompanies a 1bp move;
   * 5 means it accompanies a 5% move, and an order of any size will be paying
   * for that. Scaled to millions because the unscaled figure is a number with
   * nine leading zeros that nobody can compare at a glance.
   *
   * Sessions with zero dollar volume are excluded rather than treated as
   * infinitely illiquid: a halted or untraded day is missing data, not an
   * observation of infinite impact, and one of them would otherwise swamp the
   * mean for the whole window.
   */
  amihud: number | null;
  /**
   * Median share volume ÷ shares outstanding: the fraction of the class that
   * changes hands on a typical day. Null without a share count.
   */
  turnover: number | null;
  /**
   * Sessions in the window that printed no volume at all.
   *
   * Counted rather than averaged away because it is a different kind of fact
   * from a thin day. A security that does not trade on some days cannot be
   * exited on those days at any price, and an average daily volume never
   * shows it.
   */
  zeroVolumeSessions: number;
  /** Bars available for this window. Below `window`, everything above is null. */
  bars: number;
}

export const LIQUIDITY_WINDOWS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '21D', days: 21 },
  { label: '63D', days: 63 },
  { label: '252D', days: 252 },
];

export interface LiquidityProfile {
  windows: LiquidityWindow[];
  /**
   * 21-day median dollar volume ÷ 252-day median. Below 1 means participation
   * is drying up relative to the year, above 1 means it is being crowded into.
   *
   * A ratio of two medians rather than a trend fitted through the series: the
   * question is whether the recent regime differs from the longer one, not
   * whether volume happens to slope.
   */
  trend: number | null;
  /**
   * Dollars tradable in one session at `participationRate` of the 21-day
   * median dollar volume.
   *
   * Deliberately a restatement of the median rather than a model. There is no
   * public data here that could support an impact estimate, so this says only
   * what it says: at this share of a typical day, this is the notional. The
   * rate is returned alongside it so the arithmetic is checkable.
   */
  capacity: number | null;
  participationRate: number;
  /** Shares outstanding used for turnover, and the field it came from. */
  sharesOutstanding: number | null;
  sharesBasis: string | null;
}

/** A ratio whose denominator was zero has no value, and says so. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) < 1e-12) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

function medianOrNull(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated percentile, or null on an empty sample. */
function percentileOrNull(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export interface LiquidityOptions {
  windows?: ReadonlyArray<{ label: string; days: number }>;
  /**
   * Shares of THIS class, not the issuer's weighted total.
   *
   * The volume being divided is volume in one listed class, so the denominator
   * has to be that class's share count. Using an issuer-wide weighted figure
   * for a multi-class company understates turnover by whatever the other
   * classes add — Shopify's weighted count exceeds its class-A count by about
   * 6%, and Alphabet's gap is far larger.
   */
  sharesOutstanding?: number | null;
  sharesBasis?: string | null;
  /** Share of a typical session's dollar volume `capacity` is stated at. */
  participationRate?: number;
}

/**
 * Tradability, from the volume the daily bars already carry.
 *
 * Several windows rather than one because liquidity migrates. A security whose
 * year-long median is $50m and whose last month is $6m has lost its market,
 * and a single "average daily volume" figure covering either period alone
 * cannot say so.
 */
export function liquidityProfile(
  bars: readonly Bar[],
  options: LiquidityOptions = {},
): LiquidityProfile {
  const windows = options.windows ?? LIQUIDITY_WINDOWS;
  const participationRate = options.participationRate ?? 0.1;
  const shares =
    typeof options.sharesOutstanding === 'number' &&
    Number.isFinite(options.sharesOutstanding) &&
    options.sharesOutstanding > 0
      ? options.sharesOutstanding
      : null;

  const rows: LiquidityWindow[] = windows.map(({ label, days }) => {
    const slice = bars.slice(-days);
    const empty: LiquidityWindow = {
      window: days,
      label,
      medianDollarVolume: null,
      p10DollarVolume: null,
      medianShareVolume: null,
      amihud: null,
      turnover: null,
      zeroVolumeSessions: 0,
      bars: slice.length,
    };
    // A window the history cannot cover is not computed over what happened to
    // be there. "252-day median volume" from forty bars is a different figure
    // wearing the same label, and nothing downstream could tell.
    if (slice.length < days) return empty;

    const shareVolumes: number[] = [];
    const dollarVolumes: number[] = [];
    let zeroVolumeSessions = 0;

    for (const b of slice) {
      const v = Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0;
      if (v === 0) zeroVolumeSessions++;
      shareVolumes.push(v);
      dollarVolumes.push(Number.isFinite(b.close) && b.close > 0 ? b.close * v : 0);
    }

    // Amihud needs a return, so it is measured over the bar BEFORE the window
    // as well where one exists. Taking the first in-window bar's return from
    // nothing would drop an observation for no reason.
    const impacts: number[] = [];
    const firstIndex = bars.length - slice.length;
    for (let i = Math.max(1, firstIndex); i < bars.length; i++) {
      const prev = bars[i - 1].close;
      const cur = bars[i];
      const dollars = cur.close * cur.volume;
      if (!(prev > 0) || !(dollars > 0)) continue;
      const r = Math.abs((cur.close - prev) / prev);
      if (Number.isFinite(r)) impacts.push((r / dollars) * 1e6);
    }

    const medianShareVolume = medianOrNull(shareVolumes);
    return {
      window: days,
      label,
      medianDollarVolume: medianOrNull(dollarVolumes),
      p10DollarVolume: percentileOrNull(dollarVolumes, 0.1),
      medianShareVolume,
      amihud: impacts.length ? impacts.reduce((a, b) => a + b, 0) / impacts.length : null,
      turnover: shares != null && medianShareVolume != null ? medianShareVolume / shares : null,
      zeroVolumeSessions,
      bars: slice.length,
    };
  });

  const short = rows.find((r) => r.window === 21)?.medianDollarVolume ?? null;
  const long = rows.find((r) => r.window === 252)?.medianDollarVolume ?? null;

  return {
    windows: rows,
    trend: short != null && long != null ? ratio(short, long) : null,
    capacity: short != null ? short * participationRate : null,
    participationRate,
    sharesOutstanding: shares,
    sharesBasis: shares != null ? (options.sharesBasis ?? null) : null,
  };
}
