/**
 * Annotations: the model, the projection, and the geometry. Pure.
 * =============================================================================
 * A drawing is stored in CHART coordinates — epoch milliseconds and price —
 * never in pixels and never in bar indices.
 *
 *   - Pixels are wrong because they are a function of the current zoom, pan,
 *     scale mode and window size. A trendline stored in pixels slides off its
 *     bars the moment any of those change.
 *   - Bar indices are wrong because they are a function of the data ARRAY. Load
 *     one more year of history at the front and every index shifts; the same
 *     drawing now points at a different day.
 *
 * Time and price are properties of the market, so a line drawn across two highs
 * stays across those highs through a zoom, a switch to log, a resize, a reload,
 * and a longer history. That is the whole reason for this indirection, and
 * `chart-drawings.test.ts` asserts it directly.
 *
 * The bar calendar has holes (weekends, holidays), so time is not linear in
 * index space. `timeToIndex` interpolates between the bracketing bars, which
 * lets a drawing sit at a point where no bar traded — the middle of a weekend
 * gap — and still land in the right place.
 */

import type { Point, PriceScale, Rect, TimeScale } from './types';

/** A point in chart space: epoch milliseconds, and a price. */
export interface Anchor {
  t: number;
  p: number;
}

/**
 * Tone is stored as a NAME, not a colour.
 *
 * The four themes resolve these differently, so persisting a resolved colour
 * would pin a drawing made in the light theme to a value that is unreadable in
 * the terminal one. The renderer maps the name onto a palette token.
 */
export type DrawingTone = 'default' | 'positive' | 'negative' | 'accent';

interface DrawingBase {
  id: string;
  tone?: DrawingTone;
  /** Locked drawings hit-test as normal but refuse to move. */
  locked?: boolean;
}

/** Two-point line. `extend` continues it past both anchors to the plot edges. */
export interface Trendline extends DrawingBase {
  kind: 'trendline';
  a: Anchor;
  b: Anchor;
  extend?: boolean;
}

/** A price level across the whole plot. Has no time coordinate by design. */
export interface HorizontalLevel extends DrawingBase {
  kind: 'horizontal';
  p: number;
}

/** A time/price box — a zone, a consolidation range, an event window. */
export interface Zone extends DrawingBase {
  kind: 'rect';
  a: Anchor;
  b: Anchor;
}

/** Free text pinned to a point in the data. */
export interface Note extends DrawingBase {
  kind: 'note';
  at: Anchor;
  text: string;
}

export type Drawing = Trendline | HorizontalLevel | Zone | Note;
export type DrawingKind = Drawing['kind'];

/** Which part of a drawing a hit landed on. `body` moves the whole thing. */
export type HandleRole = 'a' | 'b' | 'body';

export interface Handle {
  role: HandleRole;
  x: number;
  y: number;
}

export interface Hit {
  role: HandleRole;
  /** Pixel distance from the pointer. Used to break ties between drawings. */
  distance: number;
}

/* ------------------------------------------------------------ time index -- */

/**
 * Epoch milliseconds for every bar. Computed once per data set, not per frame.
 * A malformed date yields an interpolated placeholder rather than NaN, which
 * would poison every projection downstream of it.
 */
export function barTimes(dates: string[]): number[] {
  const out = new Array<number>(dates.length);
  for (let i = 0; i < dates.length; i++) {
    const t = Date.parse(`${dates[i]}T00:00:00Z`);
    out[i] = Number.isFinite(t) ? t : i > 0 ? out[i - 1] + 86_400_000 : 0;
  }
  return out;
}

/** Median spacing, used to extrapolate beyond the ends of the data. */
function stepOf(times: number[]): number {
  const n = times.length;
  if (n < 2) return 86_400_000;
  return Math.max((times[n - 1] - times[0]) / (n - 1), 1);
}

/**
 * Epoch ms → fractional bar index, by binary search plus linear interpolation
 * between the bracketing bars. Indices refer to bar CENTRES (`i` is the centre
 * of bar `i`), which is where a drawing's anchor visually belongs.
 *
 * Times outside the data extrapolate on the median spacing, so a drawing made
 * in the whitespace past the last bar keeps a stable position.
 */
export function timeToIndex(times: number[], t: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  const step = stepOf(times);
  if (t <= times[0]) return (t - times[0]) / step;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  return span > 0 ? lo + (t - times[lo]) / span : lo;
}

/** The inverse: fractional bar index → epoch ms. */
export function indexToTime(times: number[], index: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (n === 1) return times[0];
  const step = stepOf(times);
  if (index <= 0) return times[0] + index * step;
  if (index >= n - 1) return times[n - 1] + (index - (n - 1)) * step;
  const lo = Math.floor(index);
  const frac = index - lo;
  return times[lo] + (times[lo + 1] - times[lo]) * frac;
}

/* ------------------------------------------------------------ projection -- */

/** Chart space ⇄ pixel space, for the current scales. */
export interface Projector {
  toPoint: (anchor: Anchor) => Point;
  toAnchor: (point: Point) => Anchor;
}

export function makeProjector(
  times: number[],
  timeScale: TimeScale,
  priceScale: PriceScale,
): Projector {
  return {
    toPoint: (anchor) => ({
      x: timeScale.centerX(timeToIndex(times, anchor.t)),
      y: priceScale.toY(anchor.p),
    }),
    toAnchor: (point) => ({
      t: indexToTime(times, timeScale.toIndex(point.x) - 0.5),
      p: priceScale.toPrice(point.y),
    }),
  };
}

/* -------------------------------------------------------------- geometry -- */

/**
 * Shortest distance from a point to a line SEGMENT (not an infinite line).
 * The clamp on `t` is what makes the ends behave: without it, a click far past
 * the end of a short trendline still "hits" the line it lies along.
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Distance to the boundary of a rect; 0 anywhere on the edge. */
export function distanceToRectEdge(p: Point, r: Rect): number {
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return Math.min(
    distanceToSegment(p, { x: x1, y: y1 }, { x: x2, y: y1 }),
    distanceToSegment(p, { x: x2, y: y1 }, { x: x2, y: y2 }),
    distanceToSegment(p, { x: x2, y: y2 }, { x: x1, y: y2 }),
    distanceToSegment(p, { x: x1, y: y2 }, { x: x1, y: y1 }),
  );
}

/** Text metrics for note hit boxes. Approximate, and deliberately so — see below. */
export interface NoteMetrics {
  charWidth: number;
  lineHeight: number;
  paddingX: number;
  paddingY: number;
}

/**
 * Notes are hit-tested against an estimated box rather than a measured one.
 *
 * Measuring would need a canvas context, which would drag the DOM into this
 * module and make every geometry test require a browser. The estimate is a
 * monospace advance width; the renderer draws the note in the theme's mono
 * face, so the estimate and the drawn box agree closely, and a hit box a few
 * pixels out on a label is not a correctness problem.
 */
export const NOTE_METRICS: NoteMetrics = {
  /** An 11px monospace advance, which is what the renderer sets notes in. */
  charWidth: 6.6,
  lineHeight: 15,
  paddingX: 6,
  paddingY: 4,
};

export function noteBox(note: Note, proj: Projector, metrics: NoteMetrics = NOTE_METRICS): Rect {
  const at = proj.toPoint(note.at);
  const lines = (note.text || ' ').split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  const width = longest * metrics.charWidth + metrics.paddingX * 2;
  const height = lines.length * metrics.lineHeight + metrics.paddingY * 2;
  // Anchored bottom-left, so the note sits above the point it marks and the
  // point itself stays visible.
  return { x: at.x, y: at.y - height, width, height };
}

/* ----------------------------------------------------------- hit testing -- */

export const HIT_TOLERANCE = 7;

/**
 * The topmost drawing within `tolerance` of a point, or null.
 *
 * Handles beat bodies at equal distance — grabbing an endpoint is the more
 * specific intent, and a body drag that was meant to be an endpoint drag is
 * annoying to undo. Later drawings beat earlier ones, matching what is painted
 * on top.
 */
export function hitTest(
  d: Drawing,
  point: Point,
  proj: Projector,
  plot: Rect,
  tolerance = HIT_TOLERANCE,
): Hit | null {
  for (const h of handlesOf(d, proj, plot)) {
    const dist = Math.hypot(point.x - h.x, point.y - h.y);
    if (dist <= tolerance + 2) return { role: h.role, distance: dist };
  }

  switch (d.kind) {
    case 'trendline': {
      const a = proj.toPoint(d.a);
      const b = proj.toPoint(d.b);
      const [p1, p2] = d.extend ? extendToPlot(a, b, plot) : [a, b];
      const dist = distanceToSegment(point, p1, p2);
      return dist <= tolerance ? { role: 'body', distance: dist } : null;
    }
    case 'horizontal': {
      const y = proj.toPoint({ t: 0, p: d.p }).y;
      const dist = Math.abs(point.y - y);
      const withinPlot = point.x >= plot.x && point.x <= plot.x + plot.width;
      return dist <= tolerance && withinPlot ? { role: 'body', distance: dist } : null;
    }
    case 'rect': {
      const a = proj.toPoint(d.a);
      const b = proj.toPoint(d.b);
      const r = rectOf(a, b);
      const inside =
        point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
      const edge = distanceToRectEdge(point, r);
      // The interior counts as a hit so a zone can be grabbed anywhere, but it
      // reports its distance to the edge so a trendline crossing the zone still
      // wins where it actually is.
      if (edge <= tolerance) return { role: 'body', distance: edge };
      return inside ? { role: 'body', distance: tolerance } : null;
    }
    case 'note': {
      const box = noteBox(d, proj);
      const inside =
        point.x >= box.x &&
        point.x <= box.x + box.width &&
        point.y >= box.y &&
        point.y <= box.y + box.height;
      if (inside) return { role: 'body', distance: 0 };
      const edge = distanceToRectEdge(point, box);
      return edge <= tolerance ? { role: 'body', distance: edge } : null;
    }
  }
}

export function hitTestAll(
  drawings: Drawing[],
  point: Point,
  proj: Projector,
  plot: Rect,
  tolerance = HIT_TOLERANCE,
): { drawing: Drawing; hit: Hit } | null {
  let best: { drawing: Drawing; hit: Hit } | null = null;
  for (const d of drawings) {
    const hit = hitTest(d, point, proj, plot, tolerance);
    if (!hit) continue;
    // `<=` so that among equals the LAST drawing wins — the one on top.
    if (!best || hit.distance <= best.hit.distance) best = { drawing: d, hit };
  }
  return best;
}

/** Normalised rect from any two corners. */
export function rectOf(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Extends a two-point line to the left and right edges of the plot. */
export function extendToPlot(a: Point, b: Point, plot: Rect): [Point, Point] {
  const x1 = plot.x;
  const x2 = plot.x + plot.width;
  if (Math.abs(b.x - a.x) < 1e-9) return [a, b];
  const slope = (b.y - a.y) / (b.x - a.x);
  return [
    { x: x1, y: a.y + (x1 - a.x) * slope },
    { x: x2, y: a.y + (x2 - a.x) * slope },
  ];
}

/* --------------------------------------------------------------- handles -- */

/**
 * The grab points, in pixels. A horizontal level's handles sit at the plot
 * edges; a note has one, at its anchor.
 */
export function handlesOf(d: Drawing, proj: Projector, plot: Rect): Handle[] {
  switch (d.kind) {
    case 'trendline': {
      const a = proj.toPoint(d.a);
      const b = proj.toPoint(d.b);
      return [
        { role: 'a', x: a.x, y: a.y },
        { role: 'b', x: b.x, y: b.y },
      ];
    }
    case 'horizontal': {
      const y = proj.toPoint({ t: 0, p: d.p }).y;
      return [{ role: 'body', x: plot.x + plot.width - 6, y }];
    }
    case 'rect': {
      const a = proj.toPoint(d.a);
      const b = proj.toPoint(d.b);
      return [
        { role: 'a', x: a.x, y: a.y },
        { role: 'b', x: b.x, y: b.y },
      ];
    }
    case 'note': {
      const at = proj.toPoint(d.at);
      return [{ role: 'body', x: at.x, y: at.y }];
    }
  }
}

/* ------------------------------------------------------------- transform -- */

/**
 * Moves a drawing by a PIXEL delta, via the projector.
 *
 * Translating the stored anchors directly would be wrong on a log axis, where
 * the price change corresponding to "20 pixels down" depends on where you
 * started. Round-tripping each anchor through pixel space instead is exact in
 * both scale modes, and needs no special case for either.
 */
export function dragDrawing(d: Drawing, dx: number, dy: number, proj: Projector): Drawing {
  if (d.locked) return d;
  const move = (a: Anchor): Anchor => {
    const p = proj.toPoint(a);
    return proj.toAnchor({ x: p.x + dx, y: p.y + dy });
  };
  switch (d.kind) {
    case 'trendline':
      return { ...d, a: move(d.a), b: move(d.b) };
    case 'rect':
      return { ...d, a: move(d.a), b: move(d.b) };
    case 'note':
      return { ...d, at: move(d.at) };
    case 'horizontal':
      // No time coordinate, so it only moves vertically. Dragging it sideways
      // is a no-op rather than an error.
      return { ...d, p: move({ t: 0, p: d.p }).p };
  }
}

/** Moves one endpoint. `body` falls through to moving the whole drawing. */
export function dragHandle(
  d: Drawing,
  role: HandleRole,
  dx: number,
  dy: number,
  proj: Projector,
): Drawing {
  if (d.locked) return d;
  if (role === 'body') return dragDrawing(d, dx, dy, proj);
  const move = (a: Anchor): Anchor => {
    const p = proj.toPoint(a);
    return proj.toAnchor({ x: p.x + dx, y: p.y + dy });
  };
  if (d.kind === 'trendline' || d.kind === 'rect') {
    return role === 'a' ? { ...d, a: move(d.a) } : { ...d, b: move(d.b) };
  }
  return dragDrawing(d, dx, dy, proj);
}

/* ---------------------------------------------------------------- create -- */

export interface CreateOptions {
  id: string;
  tone?: DrawingTone;
  text?: string;
  extend?: boolean;
}

/**
 * Builds a drawing from a gesture's start and end anchors.
 *
 * A click with no drag produces a degenerate trendline or zone; the caller is
 * expected to discard anything smaller than `MIN_DRAG_PIXELS`, which is what
 * stops a mis-click leaving an invisible zero-size annotation behind.
 */
export function createDrawing(
  kind: DrawingKind,
  from: Anchor,
  to: Anchor,
  opts: CreateOptions,
): Drawing {
  const base = { id: opts.id, tone: opts.tone ?? 'default' } as const;
  switch (kind) {
    case 'trendline':
      return { ...base, kind: 'trendline', a: from, b: to, extend: opts.extend };
    case 'rect':
      return { ...base, kind: 'rect', a: from, b: to };
    case 'horizontal':
      return { ...base, kind: 'horizontal', p: to.p };
    case 'note':
      return { ...base, kind: 'note', at: from, text: opts.text ?? '' };
  }
}

export const MIN_DRAG_PIXELS = 4;

/* ----------------------------------------------------------- persistence -- */

const SCHEMA_VERSION = 1;

/**
 * Drawings serialise to plain JSON in chart coordinates, so a saved annotation
 * survives a reload, a different screen and a longer history.
 */
export function serializeDrawings(drawings: Drawing[]): string {
  return JSON.stringify({ version: SCHEMA_VERSION, drawings });
}

/**
 * Parses a serialised set, dropping anything that is not a well-formed drawing.
 *
 * Malformed entries are skipped rather than thrown on: this data can come from
 * localStorage or a saved layout, and one bad record should cost one
 * annotation, not the whole chart.
 */
export function parseDrawings(json: string): Drawing[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (raw as { drawings?: unknown })?.drawings;
  if (!Array.isArray(list)) return [];
  const out: Drawing[] = [];
  for (const item of list) {
    const d = item as Partial<Drawing> & { kind?: string; id?: string };
    if (!d || typeof d.id !== 'string') continue;
    const ok =
      (d.kind === 'trendline' && isAnchor((d as Trendline).a) && isAnchor((d as Trendline).b)) ||
      (d.kind === 'rect' && isAnchor((d as Zone).a) && isAnchor((d as Zone).b)) ||
      (d.kind === 'horizontal' && Number.isFinite((d as HorizontalLevel).p)) ||
      (d.kind === 'note' && isAnchor((d as Note).at) && typeof (d as Note).text === 'string');
    if (ok) out.push(item as Drawing);
  }
  return out;
}

function isAnchor(a: unknown): a is Anchor {
  const v = a as Anchor | undefined;
  return !!v && Number.isFinite(v.t) && Number.isFinite(v.p);
}

/** Human label for the toolbar and for accessible names. */
export function describeDrawing(d: Drawing): string {
  switch (d.kind) {
    case 'trendline':
      return 'Trendline';
    case 'horizontal':
      return 'Price level';
    case 'rect':
      return 'Zone';
    case 'note':
      return d.text ? `Note: ${d.text.slice(0, 24)}` : 'Note';
  }
}
