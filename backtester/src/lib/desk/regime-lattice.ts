import { mean, stdev } from '@/lib/metrics/stats';
import type { Bar } from './models';

/**
 * The 5D regime lattice.
 * =============================================================================
 * A five-dimensional hypercube has 32 vertices and 80 edges, and drawn for its
 * own sake it is a pretty piece of geometry that says nothing. Here each axis
 * is a REAL condition, so a vertex is a state the security has actually been
 * in and an edge is a single condition flipping.
 *
 * The five axes are the desk's own models, reduced to yes-or-no:
 *
 *   TREND    price above its own 200-day average
 *   VOL      21-day realised volatility above its own median
 *   FLOW     21-day flow pressure positive — closes in the upper half of range
 *   POS      close in the upper half of the 21-day high–low range
 *   WIDE     21-day ATR above its own median
 *
 * Each trading day lands on exactly one vertex. Counting the days gives the
 * shape of where this security actually lives — most names occupy a handful of
 * the 32 and never visit the rest — and the forward return from each vertex
 * says what tended to happen next.
 *
 * WHAT THIS IS NOT. The forward returns are a description of a record, not a
 * signal and not a forecast. They use data after the day they are attached to,
 * which is legitimate for a historical study and would be look-ahead if traded.
 * Overlapping windows make the samples dependent, so a vertex with nine visits
 * has not shown you anything; `minSamples` exists to stop those being reported
 * at all rather than leaving a reader to notice the sample size themselves.
 */

export const AXES = ['TREND', 'VOL', 'FLOW', 'POS', 'WIDE'] as const;
export type AxisName = (typeof AXES)[number];
export const DIMENSIONS = AXES.length;
export const VERTEX_COUNT = 1 << DIMENSIONS; // 32
/** Each vertex has `DIMENSIONS` neighbours; each edge is counted twice. */
export const EDGE_COUNT = (VERTEX_COUNT * DIMENSIONS) / 2; // 80

export interface LatticeVertex {
  /** 0–31. Bit i is set when axis i held that day. */
  code: number;
  /** The five conditions, in `AXES` order. */
  bits: boolean[];
  /** Trading days that landed here. */
  visits: number;
  /** Share of all classified days. */
  share: number;
  /**
   * Mean forward return over the study horizon, or null when the vertex was
   * visited too rarely for the figure to mean anything.
   */
  forward: number | null;
  /** Standard deviation of those forward returns. */
  forwardSd: number | null;
  /** Forward-return observations behind `forward`. */
  samples: number;
  /** Projected position for drawing, in [-1, 1]. */
  x: number;
  y: number;
  /** True when the most recent classified day sits here. */
  current: boolean;
}

export interface LatticeEdge {
  from: number;
  to: number;
  /** Which axis differs across this edge. */
  axis: AxisName;
  /** Times the security moved along this edge on consecutive days. */
  traversals: number;
}

export interface RegimeLattice {
  vertices: LatticeVertex[];
  edges: LatticeEdge[];
  axes: readonly AxisName[];
  /** Days that could be classified at all. */
  classified: number;
  /** Trading days ahead the forward return was measured over. */
  horizon: number;
  /** The vertex the latest classified day sits on. */
  currentCode: number | null;
  /** Vertices ever visited, of 32. */
  occupied: number;
}

/**
 * Projects a 5-bit coordinate onto the plane.
 *
 * The five axes are drawn at evenly spaced angles, and a vertex is the sum of
 * the axes that hold. That is the standard way a hypercube's shadow is made,
 * and it has the property that matters here: two vertices one condition apart
 * land one axis-vector apart, so an edge is always the same length and
 * direction for a given axis, and the eye can follow "which condition changed"
 * without reading a label.
 *
 * The angles are offset so no two axes overlap and no edge is exactly
 * vertical, which would otherwise stack labels on top of one another.
 */
function project(code: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    if (!(code & (1 << i))) continue;
    const angle = (Math.PI * 2 * i) / DIMENSIONS + Math.PI / 10;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  // The furthest a vertex can reach is the sum of all five unit vectors; for
  // five evenly spaced ones that cancels to nearly zero, so normalise by the
  // largest magnitude actually produced instead of by a formula.
  return { x, y };
}

/** Rolling median of a series, used to split "high" from "low" per axis. */
function medianOf(values: number[]): number {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface LatticeOptions {
  /** Trading days ahead to measure the forward return over. */
  horizon?: number;
  /** Below this many observations a vertex reports no forward return. */
  minSamples?: number;
  trendWindow?: number;
  conditionWindow?: number;
}

/**
 * Classifies every day onto a vertex and measures what followed.
 *
 * The thresholds are the security's OWN medians rather than fixed levels: "high
 * volatility" for a utility and for a biotech are different numbers, and a
 * fixed cut would put one name entirely on one face of the cube and tell you
 * nothing about either.
 */
export function buildRegimeLattice(bars: readonly Bar[], options: LatticeOptions = {}): RegimeLattice {
  const {
    horizon = 21,
    minSamples = 12,
    trendWindow = 200,
    conditionWindow = 21,
  } = options;

  const empty: RegimeLattice = {
    vertices: [],
    edges: [],
    axes: AXES,
    classified: 0,
    horizon,
    currentCode: null,
    occupied: 0,
  };
  if (bars.length < trendWindow + conditionWindow + 2) return empty;

  const closes = bars.map((b) => b.close);
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(closes[i] > 0 && closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    trueRanges.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }

  /** Per-day raw measures, computed once so the medians can be taken over them. */
  interface Day {
    index: number;
    trendGap: number;
    vol: number;
    flow: number;
    position: number;
    atr: number;
  }
  const days: Day[] = [];

  for (let i = trendWindow; i < bars.length; i++) {
    const sma = mean(closes.slice(i - trendWindow, i));
    const window = bars.slice(i - conditionWindow + 1, i + 1);

    const hi = Math.max(...window.map((b) => b.high));
    const lo = Math.min(...window.map((b) => b.low));

    // Flow over the condition window: dollar volume signed by close location,
    // as a share of gross. Same convention as `flowPressure`.
    let net = 0;
    let gross = 0;
    for (const b of window) {
      const range = b.high - b.low;
      const clv = range > 1e-12 ? ((b.close - b.low) - (b.high - b.close)) / range : 0;
      const dollars = b.close * b.volume;
      net += clv * dollars;
      gross += Math.abs(dollars);
    }

    days.push({
      index: i,
      trendGap: sma > 0 ? closes[i] / sma - 1 : 0,
      vol: stdev(logReturns.slice(i - conditionWindow, i)),
      flow: gross > 1e-12 ? net / gross : 0,
      position: hi > lo ? (closes[i] - lo) / (hi - lo) : 0.5,
      atr: closes[i] > 0 ? mean(trueRanges.slice(i - conditionWindow, i)) / closes[i] : 0,
    });
  }

  if (!days.length) return empty;

  const volMedian = medianOf(days.map((d) => d.vol));
  const atrMedian = medianOf(days.map((d) => d.atr));

  const codeOf = (d: Day): number =>
    (d.trendGap > 0 ? 1 : 0) |
    (d.vol > volMedian ? 2 : 0) |
    (d.flow > 0 ? 4 : 0) |
    (d.position > 0.5 ? 8 : 0) |
    (d.atr > atrMedian ? 16 : 0);

  const visits = new Array<number>(VERTEX_COUNT).fill(0);
  const forwards: number[][] = Array.from({ length: VERTEX_COUNT }, () => []);
  const traversals = new Map<string, number>();

  let previousCode: number | null = null;
  let previousIndex = -2;

  for (const d of days) {
    const code = codeOf(d);
    visits[code]++;

    // The forward return, where the window has actually elapsed. The last
    // `horizon` days have no future in the data and contribute no observation
    // — counting them as zero would drag every vertex toward nothing.
    const ahead = d.index + horizon;
    if (ahead < closes.length && closes[d.index] > 0) {
      forwards[code].push(closes[ahead] / closes[d.index] - 1);
    }

    // An edge traversal only counts between CONSECUTIVE days. A gap in the
    // series is not a move along an edge.
    if (previousCode != null && d.index === previousIndex + 1 && previousCode !== code) {
      const diff = previousCode ^ code;
      // Only single-condition moves are edges of the cube; a day that flips
      // two conditions at once has cut across the interior.
      if ((diff & (diff - 1)) === 0) {
        const key = previousCode < code ? `${previousCode}-${code}` : `${code}-${previousCode}`;
        traversals.set(key, (traversals.get(key) ?? 0) + 1);
      }
    }
    previousCode = code;
    previousIndex = d.index;
  }

  const classified = days.length;
  const currentCode = days.length ? codeOf(days[days.length - 1]) : null;

  const raw = Array.from({ length: VERTEX_COUNT }, (_, code) => project(code));
  const extent = Math.max(1e-9, ...raw.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));

  const vertices: LatticeVertex[] = Array.from({ length: VERTEX_COUNT }, (_, code) => {
    const f = forwards[code];
    const enough = f.length >= minSamples;
    return {
      code,
      bits: AXES.map((_, i) => Boolean(code & (1 << i))),
      visits: visits[code],
      share: classified > 0 ? visits[code] / classified : 0,
      forward: enough ? mean(f) : null,
      forwardSd: enough && f.length > 1 ? stdev(f) : null,
      samples: f.length,
      x: raw[code].x / extent,
      y: raw[code].y / extent,
      current: code === currentCode,
    };
  });

  const edges: LatticeEdge[] = [];
  for (let code = 0; code < VERTEX_COUNT; code++) {
    for (let i = 0; i < DIMENSIONS; i++) {
      const other = code ^ (1 << i);
      if (other <= code) continue; // Each edge once.
      const key = `${code}-${other}`;
      edges.push({
        from: code,
        to: other,
        axis: AXES[i],
        traversals: traversals.get(key) ?? 0,
      });
    }
  }

  return {
    vertices,
    edges,
    axes: AXES,
    classified,
    horizon,
    currentCode,
    occupied: visits.filter((v) => v > 0).length,
  };
}

/** The axes that hold at a vertex, as a readable label. */
export function describeVertex(code: number): string {
  const on = AXES.filter((_, i) => code & (1 << i));
  return on.length ? on.join(' · ') : 'none';
}
