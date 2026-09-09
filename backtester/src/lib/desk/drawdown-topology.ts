import { drawdownSeries, type DrawdownPoint } from '@/lib/metrics/drawdown';
import { ulcerIndex } from '@/lib/metrics/extended';
import { mean, median, percentile } from '@/lib/metrics/stats';
import type { Bar } from './models';

/**
 * Drawdown recovery topology: how this security comes back, given how far down it is.
 * =============================================================================
 * "Maximum drawdown 42%" is one day's reading from years of history, and it
 * answers none of the questions a desk sitting in a hole actually has. Those
 * questions are conditional: we are down ten percent — for this name, how much
 * further has that usually gone, how long has it taken to get the money back,
 * and how often did it simply never come back?
 *
 * So this measures the whole shape rather than the extremum. At each depth
 * threshold it collects every time the security crossed that depth and reports
 * what followed: additional decline, time to trough, time to recovery, and the
 * share that recovered at all.
 *
 * CONVENTIONS. All of these have a common alternative, and the alternatives
 * disagree by a lot.
 *
 *  - DEPTH is peak-to-current on the split-adjusted CLOSE, as an arithmetic
 *    fraction of the running peak. Not total return: a dividend payer looks
 *    slower to recover here than a holder collecting the cash experienced,
 *    because the cash is not in the series. Not intraday lows either — a close
 *    series cannot see a hole that opened and filled inside one session, so
 *    every depth here is a floor on what a low-watermark measure would report.
 *
 *  - TIME is counted in TRADING BARS, not calendar days. `metrics/drawdown`
 *    reports the same episodes in calendar days, and the two differ by roughly
 *    1.45×; a figure from one must never be pasted into a sentence about the
 *    other. Bars are the right unit here because the conditional question is
 *    "how many more sessions of this", and weekends are not sessions.
 *
 *  - The conditioning event is the CROSSING, not the trough. Statistics
 *    measured from the trough are the classic way to make every drawdown look
 *    survivable: the trough is only identifiable afterwards, and by definition
 *    nothing goes lower from it. Everything below is measured from the first
 *    bar at which the reader could have known the security was down that far,
 *    which is why `furtherFall` is frequently large and frequently the number
 *    that matters.
 *
 *  - One crossing per episode per threshold. A drawdown that wobbles across
 *    −10% five times on its way down is one −10% event, not five.
 *
 *  - Recovery is a close back at or above the PRIOR PEAK — the peak that
 *    defined the drawdown — not merely a bounce off the low.
 *
 * RIGHT-CENSORING, which is the honest weakness here. Recovery-time figures
 * are computed over episodes that HAVE recovered inside the sample; the ones
 * still under water contribute to `episodes` and `unrecovered` but cannot
 * contribute a duration, so the median recovery time is biased short by
 * exactly the cases a reader most wants to know about. `unrecovered` is
 * reported alongside every duration so the bias is visible rather than
 * implied, and the currently-open drawdown is flagged separately.
 *
 * WHAT THIS IS NOT. A description of a record. Every figure reads data from
 * after the day it is attached to, which is legitimate for a historical study
 * and would be look-ahead if traded. Overlapping regimes make the episodes
 * dependent — a security has perhaps a dozen genuine 20% drawdowns in a
 * decade — so a threshold with four episodes has shown you an anecdote.
 */

/** A ratio whose denominator was zero has no value, and says so. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) < 1e-12) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

/** Depths the topology is measured at, as positive fractions. */
export const DEPTH_THRESHOLDS: readonly number[] = [0.05, 0.1, 0.2, 0.35, 0.5];

/**
 * Whether a drawdown has reached a depth, with the boundary included.
 *
 * 90/100 − 1 is −0.09999999999999998 in binary floating point, so a bare
 * `dd <= -0.1` says a security that fell exactly ten percent did not fall ten
 * percent — and it then reports the crossing one bar later, at whatever depth
 * happened to be next. The tolerance is far below any depth worth a row and
 * far above the representation error.
 */
function reached(drawdown: number, threshold: number): boolean {
  return drawdown <= -threshold + 1e-12;
}

export interface DepthCrossing {
  /** Bar at which the drawdown first reached this depth. */
  crossedDate: string;
  /** Drawdown at that bar, a negative fraction, at or just beyond −threshold. */
  depthAtCrossing: number;
  /** The episode's worst drawdown, a negative fraction. */
  troughDepth: number;
  /**
   * Return from the crossing close to the trough close: what the remaining
   * decline cost someone who only bought once the depth was visible.
   */
  furtherFall: number;
  /** Bars from the crossing to the trough. */
  barsToTrough: number;
  /** Bars from the crossing back to the prior peak. Null when never regained. */
  barsToRecover: number | null;
  recovered: boolean;
  /** True when this episode is the one still open at the end of the sample. */
  open: boolean;
}

export interface DepthBand {
  /** Positive fraction, e.g. 0.2 for the −20% band. */
  threshold: number;
  label: string;
  /** Times the security crossed this depth. */
  episodes: number;
  recovered: number;
  /** Episodes still under water at the end of the sample. */
  unrecovered: number;
  /** Share of crossings that got back to the old high inside the sample. */
  recoveryRate: number | null;
  /** Median additional decline after the crossing. Negative. */
  medianFurtherFall: number | null;
  /** The worst of them. Negative. */
  worstFurtherFall: number | null;
  medianBarsToTrough: number | null;
  /** Median bars to recovery, over RECOVERED episodes only. Biased short. */
  medianBarsToRecover: number | null;
  /** The longest recovery observed, over recovered episodes only. */
  maxBarsToRecover: number | null;
  /** Deepest drawdown any of these episodes reached. Negative. */
  worstDepth: number | null;
  crossings: DepthCrossing[];
}

export interface CurrentDrawdown {
  /** Negative fraction; zero at a new high. */
  drawdown: number;
  /** Bars since the peak that defines it. Zero at a new high. */
  barsUnderwater: number;
  peakDate: string;
  /**
   * Gain required from here to regain the peak — the arithmetic that makes a
   * 50% fall need a 100% rise. Knowable now; no future data involved.
   */
  gainToRecover: number | null;
  /** Deepest threshold already crossed in the open episode, or null. */
  deepestThresholdCrossed: number | null;
}

export interface DrawdownTopology {
  bands: DepthBand[];
  current: CurrentDrawdown | null;
  /** Share of bars spent below a prior high. */
  underwaterShare: number | null;
  /** Root-mean-square drawdown depth over the whole sample. */
  ulcer: number | null;
  /** Median depth of every episode, however shallow. Negative. */
  medianEpisodeDepth: number | null;
  /** 95th percentile of depth across episodes. Negative. */
  p95EpisodeDepth: number | null;
  /** Distinct underwater episodes of any depth. */
  totalEpisodes: number;
  bars: number;
}

interface Episode {
  /** First underwater bar. */
  start: number;
  /** Last underwater bar. */
  end: number;
  /** Index of the worst close in the episode. */
  troughIndex: number;
  /** First bar back at or above the peak, or null when never regained. */
  recoveryIndex: number | null;
}

/**
 * Splits the drawdown path into maximal underwater stretches.
 *
 * A bar whose drawdown is zero is at a new high by construction and belongs to
 * no episode; the bar immediately after an underwater run is the recovery. The
 * final run may have no recovery bar at all, which is the open episode.
 */
function episodesOf(points: readonly DrawdownPoint[]): Episode[] {
  const out: Episode[] = [];
  let start: number | null = null;
  let troughIndex = -1;
  let trough = 0;

  for (let i = 0; i < points.length; i++) {
    const dd = points[i].drawdown;
    if (dd < -1e-12) {
      if (start == null) {
        start = i;
        troughIndex = i;
        trough = dd;
      } else if (dd < trough) {
        trough = dd;
        troughIndex = i;
      }
    } else if (start != null) {
      out.push({ start, end: i - 1, troughIndex, recoveryIndex: i });
      start = null;
    }
  }
  if (start != null) {
    out.push({ start, end: points.length - 1, troughIndex, recoveryIndex: null });
  }
  return out;
}

export interface TopologyOptions {
  thresholds?: readonly number[];
}

/**
 * The topology, from a bar series.
 *
 * Reuses `drawdownSeries` for the underwater path and `ulcerIndex` for the
 * depth-weighted summary rather than restating either: a second drawdown
 * definition in this codebase is how two pages come to disagree about the same
 * hole.
 */
export function drawdownTopology(
  bars: readonly Bar[],
  options: TopologyOptions = {},
): DrawdownTopology {
  const { thresholds = DEPTH_THRESHOLDS } = options;

  const empty: DrawdownTopology = {
    bands: thresholds.map((t) => emptyBand(t)),
    current: null,
    underwaterShare: null,
    ulcer: null,
    medianEpisodeDepth: null,
    p95EpisodeDepth: null,
    totalEpisodes: 0,
    bars: bars.length,
  };
  if (bars.length < 2) return empty;

  const closes = bars.map((b) => b.close);
  if (closes.some((c) => !(c > 0))) return empty;
  const dates = bars.map((b) => b.date);

  const points = drawdownSeries(dates, closes);
  const episodes = episodesOf(points);

  const bands = thresholds.map((threshold) => {
    const crossings: DepthCrossing[] = [];

    for (const ep of episodes) {
      // The FIRST bar deep enough. Everything after is measured from here, and
      // a later re-crossing of the same level inside the same episode is the
      // same event, not a new one.
      let crossIndex = -1;
      for (let i = ep.start; i <= ep.end; i++) {
        if (reached(points[i].drawdown, threshold)) {
          crossIndex = i;
          break;
        }
      }
      if (crossIndex < 0) continue;

      const troughIndex = ep.troughIndex;
      const furtherFall = ratio(closes[troughIndex] - closes[crossIndex], closes[crossIndex]);
      if (furtherFall == null) continue;

      crossings.push({
        crossedDate: dates[crossIndex],
        depthAtCrossing: points[crossIndex].drawdown,
        troughDepth: points[troughIndex].drawdown,
        furtherFall,
        barsToTrough: troughIndex - crossIndex,
        barsToRecover: ep.recoveryIndex != null ? ep.recoveryIndex - crossIndex : null,
        recovered: ep.recoveryIndex != null,
        open: ep.recoveryIndex == null,
      });
    }

    return summariseBand(threshold, crossings);
  });

  const last = points[points.length - 1];
  const lastEpisode = episodes.length ? episodes[episodes.length - 1] : null;
  const open = lastEpisode && lastEpisode.recoveryIndex == null ? lastEpisode : null;

  const crossedNow = thresholds.filter((t) => reached(last.drawdown, t));
  const current: CurrentDrawdown = {
    drawdown: last.drawdown,
    barsUnderwater: open ? points.length - open.start : 0,
    // The peak that defines the current drawdown: the bar the running peak was
    // last set on. `drawdownSeries` carries the peak level, and the date of it
    // is the last bar whose close equalled it.
    peakDate: dates[peakIndexOf(closes, last.peak)],
    gainToRecover: ratio(last.peak - closes[closes.length - 1], closes[closes.length - 1]),
    deepestThresholdCrossed: crossedNow.length ? Math.max(...crossedNow) : null,
  };

  const depths = episodes.map((e) => points[e.troughIndex].drawdown);

  return {
    bands,
    current,
    underwaterShare: points.filter((p) => p.drawdown < -1e-12).length / points.length,
    ulcer: ulcerIndex(points),
    medianEpisodeDepth: depths.length ? median(depths) : null,
    // The 5th percentile of a negative series is its deep end.
    p95EpisodeDepth: depths.length ? percentile(depths, 0.05) : null,
    totalEpisodes: episodes.length,
    bars: bars.length,
  };
}

/** Index of the last bar whose close set the running peak. */
function peakIndexOf(closes: readonly number[], peak: number): number {
  for (let i = closes.length - 1; i >= 0; i--) {
    if (Math.abs(closes[i] - peak) < 1e-9) return i;
  }
  return 0;
}

function label(threshold: number): string {
  const pct = threshold * 100;
  return `−${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function emptyBand(threshold: number): DepthBand {
  return {
    threshold,
    label: label(threshold),
    episodes: 0,
    recovered: 0,
    unrecovered: 0,
    recoveryRate: null,
    medianFurtherFall: null,
    worstFurtherFall: null,
    medianBarsToTrough: null,
    medianBarsToRecover: null,
    maxBarsToRecover: null,
    worstDepth: null,
    crossings: [],
  };
}

function summariseBand(threshold: number, crossings: DepthCrossing[]): DepthBand {
  if (!crossings.length) return emptyBand(threshold);

  const recoveredDurations = crossings
    .map((c) => c.barsToRecover)
    .filter((d): d is number => d != null);

  return {
    threshold,
    label: label(threshold),
    episodes: crossings.length,
    recovered: recoveredDurations.length,
    unrecovered: crossings.length - recoveredDurations.length,
    recoveryRate: recoveredDurations.length / crossings.length,
    medianFurtherFall: median(crossings.map((c) => c.furtherFall)),
    worstFurtherFall: Math.min(...crossings.map((c) => c.furtherFall)),
    medianBarsToTrough: median(crossings.map((c) => c.barsToTrough)),
    medianBarsToRecover: recoveredDurations.length ? median(recoveredDurations) : null,
    maxBarsToRecover: recoveredDurations.length ? Math.max(...recoveredDurations) : null,
    worstDepth: Math.min(...crossings.map((c) => c.troughDepth)),
    crossings,
  };
}

/**
 * Mean additional decline after a crossing, across every band that had one.
 *
 * A single figure for the tape line, and a deliberately blunt one — the bands
 * above are where the reading is.
 */
export function meanFurtherFall(topology: DrawdownTopology): number | null {
  const falls = topology.bands.flatMap((b) => b.crossings.map((c) => c.furtherFall));
  return falls.length ? mean(falls) : null;
}
