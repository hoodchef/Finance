/**
 * Zoom, pan, clamping, momentum and pointer→data hit resolution. Pure.
 * =============================================================================
 * The whole interaction model is a function from (current viewport, gesture) to
 * (new viewport). Keeping it here — rather than inside pointer handlers — means
 * the part that can strand a user in empty space is the part that is tested.
 *
 * THE CLAMP IS THE POINT. A chart that lets you scroll into nothing is a chart
 * you have to rescue yourself from, usually by reloading. Every function that
 * returns a viewport passes through `clampViewport`, so no gesture, however
 * fast or however compounded, can produce a viewport that is not a real slice
 * of the data.
 */

import type { PaneLayout, TimeScale, Viewport } from './types';

/** Fewer bars than this on screen and candles become decoration. */
export const MIN_BARS = 8;

export interface ViewportLimits {
  minBars?: number;
  maxBars?: number;
}

/**
 * Forces a viewport to be a real slice of `[0, count]`.
 *
 * Order matters: the SPAN is clamped first, then the position. Clamping the
 * edges first and the span afterwards lets a fast zoom-out at the right-hand
 * end walk `start` negative, and the chart drifts a little further off the data
 * with every wheel notch.
 */
export function clampViewport(vp: Viewport, count: number, limits: ViewportLimits = {}): Viewport {
  if (count <= 0) return { start: 0, end: 1 };
  const minBars = Math.min(limits.minBars ?? MIN_BARS, count);
  const maxBars = Math.min(limits.maxBars ?? count, count);

  let start = Number.isFinite(vp.start) ? vp.start : 0;
  let end = Number.isFinite(vp.end) ? vp.end : count;
  if (end < start) [start, end] = [end, start];

  let span = end - start;
  if (!(span > 0)) span = minBars;
  span = Math.min(Math.max(span, minBars), maxBars);

  // Hold the centre while the span is corrected, so a clamped zoom stays put
  // instead of jumping to an edge.
  const centre = (start + end) / 2;
  start = centre - span / 2;
  start = Math.min(Math.max(start, 0), count - span);

  return { start, end: start + span };
}

/** The whole series, or the last `preferredBars` of it if that is fewer. */
export function fitViewport(count: number, preferredBars?: number): Viewport {
  if (count <= 0) return { start: 0, end: 1 };
  const span = Math.min(count, Math.max(preferredBars ?? count, MIN_BARS));
  return clampViewport({ start: count - span, end: count }, count);
}

/**
 * Scales the viewport about `anchorIndex`, which stays under the cursor.
 *
 * `factor` multiplies the SPAN: 0.9 zooms in, 1.1 zooms out. Anchoring on the
 * cursor rather than the centre is what makes wheel zoom feel like the chart is
 * being pulled rather than replaced — the bar you are pointing at is the bar
 * you keep.
 */
export function zoomViewport(
  vp: Viewport,
  count: number,
  factor: number,
  anchorIndex: number,
  limits: ViewportLimits = {},
): Viewport {
  if (count <= 0 || !Number.isFinite(factor) || factor <= 0) return clampViewport(vp, count, limits);
  const span = vp.end - vp.start;
  const minBars = Math.min(limits.minBars ?? MIN_BARS, count);
  const maxBars = Math.min(limits.maxBars ?? count, count);
  const nextSpan = Math.min(Math.max(span * factor, minBars), maxBars);

  const anchor = Number.isFinite(anchorIndex) ? anchorIndex : (vp.start + vp.end) / 2;
  /*
   * Anchor on the bar's CENTRE, not its left edge.
   *
   * `centerX` places bar i at (i + 0.5 - start) * pxPerBar, so preserving the
   * fraction of the left edge leaves the centre drifting by half a bar-width —
   * which grows with the zoom factor and makes the bar under the cursor slide
   * out from under it. Measured: 242px before a 0.5x zoom, 244px after.
   */
  /*
   * A supplied anchor is a BAR INDEX, whose centre is index + 0.5. The
   * fallback is already the viewport midpoint in continuous coordinates, so
   * adding half a bar to it would shift a keyboard zoom off centre.
   */
  const anchorCentre = Number.isFinite(anchorIndex) ? anchor + 0.5 : anchor;
  const at = span > 0 ? (anchorCentre - vp.start) / span : 0.5;
  const start = anchorCentre - at * nextSpan;
  return clampViewport({ start, end: start + nextSpan }, count, limits);
}

/** Slides the viewport by a number of bars. Positive moves forward in time. */
export function panViewport(
  vp: Viewport,
  count: number,
  deltaBars: number,
  limits: ViewportLimits = {},
): Viewport {
  const d = Number.isFinite(deltaBars) ? deltaBars : 0;
  return clampViewport({ start: vp.start + d, end: vp.end + d }, count, limits);
}

/**
 * Drag pan. `dx` is the pointer's pixel movement; the chart moves WITH the
 * pointer, so dragging right reveals earlier bars.
 */
export function panByPixels(
  vp: Viewport,
  count: number,
  dx: number,
  plotWidth: number,
  limits: ViewportLimits = {},
): Viewport {
  if (!(plotWidth > 0)) return vp;
  const barsPerPixel = (vp.end - vp.start) / plotWidth;
  return panViewport(vp, count, -dx * barsPerPixel, limits);
}

/**
 * Wheel delta → span multiplier.
 *
 * Exponential rather than linear, because zoom is multiplicative: a fixed
 * subtraction of bars per notch crawls when zoomed out and lurches when zoomed
 * in. `deltaMode` normalises the three units browsers report (pixels, lines,
 * pages) — a trackpad and a notched mouse wheel otherwise differ by ~40x.
 * The per-event delta is capped so one flung gesture cannot cross the whole
 * zoom range in a single frame.
 */
export function zoomFactorFromWheel(deltaY: number, deltaMode = 0, sensitivity = 0.0018): number {
  if (!Number.isFinite(deltaY)) return 1;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const delta = Math.max(-240, Math.min(240, deltaY * unit));
  return Math.exp(delta * sensitivity);
}

/** Pinch: the span shrinks in proportion to the fingers spreading. */
export function zoomFactorFromPinch(previousDistance: number, distance: number): number {
  if (!(previousDistance > 0) || !(distance > 0)) return 1;
  return previousDistance / distance;
}

/** The bar under a pixel x, clamped into the data. Used for crosshair snap. */
export function nearestIndex(x: number, scale: TimeScale, count: number): number {
  if (count <= 0) return 0;
  const i = Math.floor(scale.toIndex(x));
  return Math.min(count - 1, Math.max(0, i));
}

/* -------------------------------------------------------------- momentum -- */

export interface MomentumState {
  /** Bars per millisecond. Positive scrolls forward in time. */
  velocity: number;
}

/**
 * Exponential decay with a half-life, evaluated in continuous time.
 *
 * Per-frame multiplication (`v *= 0.95`) ties the feel of the flick to the
 * refresh rate, so the same gesture travels twice as far on a 120Hz display.
 * Decaying by elapsed milliseconds instead makes it frame-rate independent.
 */
export function decayVelocity(velocity: number, dtMs: number, halfLifeMs = 120): number {
  if (!Number.isFinite(velocity) || !Number.isFinite(dtMs) || dtMs <= 0) return velocity;
  return velocity * Math.pow(0.5, dtMs / Math.max(1, halfLifeMs));
}

/** Below this the flick has visually stopped and the loop can end. */
export const MOMENTUM_EPSILON = 0.0004;

/**
 * One frame of a flick: move by the current velocity, then decay it.
 *
 * `done` is reported when the velocity dies OR when the viewport stops moving
 * because it hit an end — without the second condition a flick into the edge
 * keeps a rAF loop alive, burning frames against a clamp that will not budge.
 */
export function stepMomentum(
  vp: Viewport,
  velocity: number,
  dtMs: number,
  count: number,
  limits: ViewportLimits = {},
): { viewport: Viewport; velocity: number; done: boolean } {
  const next = panViewport(vp, count, velocity * dtMs, limits);
  const moved = Math.abs(next.start - vp.start) > 1e-9;
  const v = decayVelocity(velocity, dtMs);
  return {
    viewport: next,
    velocity: v,
    done: !moved || Math.abs(v) < MOMENTUM_EPSILON,
  };
}

/**
 * Velocity from the tail of a drag, in bars per millisecond.
 *
 * Samples older than `window` are dropped so a pause before release means a
 * release, not a flick — the common case of dragging to a spot, hesitating,
 * and letting go should leave the chart exactly where it was put.
 */
export function velocityFromSamples(
  samples: Array<{ index: number; time: number }>,
  windowMs = 90,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.time - samples[i].time <= windowMs) first = samples[i];
    else break;
  }
  const dt = last.time - first.time;
  if (dt <= 0) return 0;
  return (last.index - first.index) / dt;
}

/* ------------------------------------------------------------------ hits -- */

export type PaneId = 'price' | 'volume' | 'time-axis' | 'gutter' | `pane-${number}` | null;

/** Which pane a pixel lands in. Gestures behave differently per pane. */
export function paneAt(x: number, y: number, layout: PaneLayout): PaneId {
  if (x > layout.plotWidth) return 'gutter';
  const inside = (r: { y: number; height: number }) => y >= r.y && y <= r.y + r.height;
  if (inside(layout.price)) return 'price';
  if (layout.volume && inside(layout.volume)) return 'volume';
  for (let i = 0; i < layout.panes.length; i++) {
    if (inside(layout.panes[i])) return `pane-${i}`;
  }
  if (y >= layout.timeAxis.y) return 'time-axis';
  return null;
}

/**
 * The keyboard model, resolved to a viewport.
 *
 * Arrows pan by a fraction of the visible span rather than a fixed bar count,
 * so one press means the same thing — "a bit to the left" — at every zoom
 * level. Shift makes it a page.
 */
export function panStep(vp: Viewport, count: number, direction: -1 | 1, page = false): Viewport {
  const span = vp.end - vp.start;
  return panViewport(vp, count, direction * span * (page ? 0.9 : 0.15));
}

/** `+` / `-`. Zooms about the centre, since there is no cursor to anchor on. */
export function zoomStep(vp: Viewport, count: number, direction: -1 | 1): Viewport {
  const factor = direction > 0 ? 1 / 1.3 : 1.3;
  // No anchor: the keyboard zooms about the viewport centre, and passing the
  // midpoint as an anchor would have it treated as a bar index and offset by
  // half a bar. The absent anchor IS the intent.
  return zoomViewport(vp, count, factor, Number.NaN);
}
