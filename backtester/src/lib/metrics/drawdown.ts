import type { IsoDate } from '@/lib/types';
import { daysBetween } from '@/lib/market-data/dates';

export interface DrawdownPoint {
  date: IsoDate;
  /** Negative fraction, e.g. −0.382 for a 38.2% drawdown. */
  drawdown: number;
  /** Running peak of the index up to and including this date. */
  peak: number;
}

export interface DrawdownEpisode {
  peakDate: IsoDate;
  troughDate: IsoDate;
  /** Null while the drawdown has not been recovered by the end of the window. */
  recoveryDate: IsoDate | null;
  /** Negative fraction. */
  depth: number;
  /** Calendar days from peak to trough. */
  declineDays: number;
  /** Calendar days from trough back to the old high; null if never recovered. */
  recoveryDays: number | null;
  /** Peak to recovery (or to the end of the window if unrecovered). */
  totalDays: number;
  recovered: boolean;
}

/**
 * Drawdown is measured on the time-weighted index, not on the dollar value —
 * otherwise a contribution would "heal" a drawdown that the market never
 * recovered from.
 */
export function drawdownSeries(dates: IsoDate[], index: number[]): DrawdownPoint[] {
  const out: DrawdownPoint[] = [];
  let peak = -Infinity;
  for (let i = 0; i < index.length; i++) {
    peak = Math.max(peak, index[i]);
    out.push({
      date: dates[i],
      drawdown: peak > 0 ? index[i] / peak - 1 : 0,
      peak,
    });
  }
  return out;
}

export function drawdownEpisodes(
  dates: IsoDate[],
  index: number[],
  minDepth = 0.01,
): DrawdownEpisode[] {
  const episodes: DrawdownEpisode[] = [];
  if (index.length < 2) return episodes;

  let peak = index[0];
  let peakIdx = 0;
  let troughIdx = -1;
  let trough = Infinity;
  let inDrawdown = false;

  const close = (recoveryIdx: number | null) => {
    if (!inDrawdown || troughIdx < 0) return;
    const depth = trough / peak - 1;
    if (depth <= -minDepth) {
      const endIdx = recoveryIdx ?? dates.length - 1;
      episodes.push({
        peakDate: dates[peakIdx],
        troughDate: dates[troughIdx],
        recoveryDate: recoveryIdx != null ? dates[recoveryIdx] : null,
        depth,
        declineDays: daysBetween(dates[peakIdx], dates[troughIdx]),
        recoveryDays:
          recoveryIdx != null ? daysBetween(dates[troughIdx], dates[recoveryIdx]) : null,
        totalDays: daysBetween(dates[peakIdx], dates[endIdx]),
        recovered: recoveryIdx != null,
      });
    }
    inDrawdown = false;
    troughIdx = -1;
    trough = Infinity;
  };

  for (let i = 1; i < index.length; i++) {
    if (index[i] >= peak) {
      close(i);
      peak = index[i];
      peakIdx = i;
    } else {
      inDrawdown = true;
      if (index[i] < trough) {
        trough = index[i];
        troughIdx = i;
      }
    }
  }
  close(null);

  return episodes.sort((a, b) => a.depth - b.depth);
}

export function maxDrawdown(index: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of index) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

/** Mean depth of completed and ongoing drawdown episodes. */
export function averageDrawdown(episodes: DrawdownEpisode[]): number {
  if (!episodes.length) return 0;
  return episodes.reduce((s, e) => s + e.depth, 0) / episodes.length;
}

/** Longest peak-to-recovery stretch, in calendar days. */
export function longestDrawdownDays(episodes: DrawdownEpisode[]): number {
  return episodes.reduce((m, e) => Math.max(m, e.totalDays), 0);
}

/** Fraction of observations spent below a prior high. */
export function timeUnderwater(series: DrawdownPoint[]): number {
  if (!series.length) return 0;
  return series.filter((p) => p.drawdown < -1e-9).length / series.length;
}
