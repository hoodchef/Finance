/**
 * Canvas drawing primitives, and the bridge from CSS theme tokens to paint.
 * =============================================================================
 * Everything here takes a `CanvasRenderingContext2D` and a pre-resolved
 * palette; nothing decides *what* to show, only how to put it on the surface.
 *
 * WHY CANVAS AT ALL. 50,000 candles is 150,000 DOM nodes as SVG, which no
 * browser pans at 60fps. The price surface is therefore canvas, and everything
 * the user actually grabs — drawings, handles, the crosshair, event markers —
 * stays as SVG/HTML where it can carry its own events, focus and accessible
 * names.
 *
 * WHY COLOURS ARE READ AT RUNTIME. A canvas takes paint, not class names, so
 * the Tailwind tokens the rest of the app uses cannot reach it. Hardcoding
 * values would break in at least one of the four themes (light, dark, terminal,
 * bloomberg) — that is exactly the failure `UI-CONVENTIONS.md` describes. So
 * the palette is read out of the LIVE CSS custom properties with
 * `getComputedStyle(el).getPropertyValue('--positive')` and rebuilt whenever
 * the theme class on `<html>` changes. `globals.css` stays the single source of
 * truth for colour, and this file contains no colour value of its own.
 *
 * The tokens come in two spellings, both handled by `resolveToken`:
 *   `--positive: 156 62% 32%`   a bare HSL triple, wrapped as `hsl(...)`
 *   `--series-0: #0284c7`       a literal, used as-is (parsed when alpha < 1)
 */

import type { Bar, ChartPalette, PaletteToken, PriceScale, Rect, TimeScale, Tick, TimeTick } from './types';

/* ------------------------------------------------------------- palette --- */

const TOKEN_VARS: Record<PaletteToken, string> = {
  foreground: '--foreground',
  mutedForeground: '--muted-foreground',
  border: '--border',
  grid: '--grid',
  card: '--card',
  popover: '--popover',
  positive: '--positive',
  negative: '--negative',
  primary: '--primary',
  warning: '--warning',
};

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → `rgba(...)`. */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 'transparent';
  return `rgba(${r}, ${g}, ${b}, ${a * alpha})`;
}

/**
 * A CSS custom property value → a colour string a canvas accepts.
 * Unrecognised shapes are passed through untouched at full opacity, which
 * degrades to "the right colour, no transparency" rather than to nothing.
 */
export function resolveToken(raw: string, alpha = 1): string {
  const v = (raw || '').trim();
  if (!v) return 'transparent';
  if (v.startsWith('#')) return alpha >= 1 ? v : hexToRgba(v, alpha);
  if (/^(rgb|hsl|oklch|lab|color)\(/.test(v)) return v;
  // Bare HSL components, the shape every non-series token uses here.
  return alpha >= 1 ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
}

/**
 * Reads the whole palette off an element once, so a frame does not call
 * `getComputedStyle` a thousand times. Call again on a theme change.
 */
export function readPalette(el: Element): ChartPalette {
  const cs = getComputedStyle(el);
  const get = (name: string) => cs.getPropertyValue(name);
  const resolved = {} as Record<PaletteToken, string>;
  const rawByToken = {} as Record<PaletteToken, string>;
  (Object.keys(TOKEN_VARS) as PaletteToken[]).forEach((token) => {
    const raw = get(TOKEN_VARS[token]);
    rawByToken[token] = raw;
    resolved[token] = resolveToken(raw);
  });

  const series: string[] = [];
  for (let i = 0; i < 15; i++) series.push(resolveToken(get(`--series-${i}`)));

  // Canvas text in the surface's own face, so the terminal and bloomberg
  // themes — which set everything in mono — do not get a sans-serif axis.
  const fontFamily = cs.fontFamily || 'ui-monospace, monospace';

  const cache = new Map<string, string>();
  return {
    ...resolved,
    series,
    fontFamily,
    alpha: (token, a) => {
      const key = `${token}:${a}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = resolveToken(rawByToken[token], a);
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

/** Series colour by index, wrapping. Used for indicator overlays. */
export function seriesAt(palette: ChartPalette, index: number): string {
  if (palette.series.length === 0) return palette.foreground;
  return palette.series[index % palette.series.length];
}

/* -------------------------------------------------------------- surface -- */

/**
 * Sizes the backing store to the device pixel ratio and returns a context
 * whose coordinates are CSS pixels.
 *
 * Without this the chart is soft on every retina display — the canvas is
 * stretched from a half-resolution bitmap. `setTransform` (not `scale`) so
 * repeated calls do not compound, which they silently would on every resize.
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): CanvasRenderingContext2D | null {
  const ratio = Math.max(1, Math.min(dpr || 1, 3));
  const w = Math.max(1, Math.round(cssWidth * ratio));
  const h = Math.max(1, Math.round(cssHeight * ratio));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

/** Half-pixel alignment, so a 1px line is one crisp line and not two grey ones. */
export function crisp(v: number): number {
  return Math.round(v) + 0.5;
}

/* --------------------------------------------------------------- chrome -- */

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  yTicks: Tick[],
  xTicks: TimeTick[],
  palette: ChartPalette,
): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.grid;
  ctx.beginPath();
  for (const t of yTicks) {
    if (t.position < rect.y - 1 || t.position > rect.y + rect.height + 1) continue;
    ctx.moveTo(rect.x, crisp(t.position));
    ctx.lineTo(rect.x + rect.width, crisp(t.position));
  }
  ctx.stroke();

  // Verticals only on major boundaries. A full grid competes with the candles;
  // a year line is a landmark.
  ctx.beginPath();
  for (const t of xTicks) {
    if (!t.major) continue;
    if (t.position < rect.x || t.position > rect.x + rect.width) continue;
    ctx.moveTo(crisp(t.position), rect.y);
    ctx.lineTo(crisp(t.position), rect.y + rect.height);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawPaneSeparator(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  palette: ChartPalette,
): void {
  ctx.save();
  ctx.strokeStyle = palette.alpha('border', 0.9);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rect.x, crisp(rect.y));
  ctx.lineTo(rect.x + rect.width, crisp(rect.y));
  ctx.stroke();
  ctx.restore();
}

export function drawPriceAxis(
  ctx: CanvasRenderingContext2D,
  ticks: Tick[],
  rect: Rect,
  gutterX: number,
  palette: ChartPalette,
): void {
  ctx.save();
  ctx.font = `11px ${palette.fontFamily}`;
  ctx.fillStyle = palette.mutedForeground;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const t of ticks) {
    if (t.position < rect.y + 6 || t.position > rect.y + rect.height - 4) continue;
    ctx.fillText(t.label, gutterX + 6, t.position);
  }
  ctx.restore();
}

export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  ticks: TimeTick[],
  rect: Rect,
  palette: ChartPalette,
): void {
  ctx.save();
  ctx.font = `11px ${palette.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const y = rect.y + rect.height / 2;
  let lastRight = -Infinity;
  for (const t of ticks) {
    const half = ctx.measureText(t.label).width / 2 + 6;
    if (t.position - half < lastRight) continue; // never overlap two labels
    if (t.position - half < rect.x - 4 || t.position + half > rect.x + rect.width + 4) continue;
    ctx.fillStyle = t.major ? palette.foreground : palette.mutedForeground;
    ctx.fillText(t.label, t.position, y);
    lastRight = t.position + half;
  }
  ctx.restore();
}

/** A large, very quiet ticker in the corner. Orientation, not decoration. */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  text: string,
  palette: ChartPalette,
): void {
  if (!text || rect.width < 240) return;
  ctx.save();
  ctx.font = `600 ${Math.min(34, rect.height / 5)}px ${palette.fontFamily}`;
  ctx.fillStyle = palette.alpha('mutedForeground', 0.16);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(text, rect.x + 12, rect.y + 10);
  ctx.restore();
}

/* ----------------------------------------------------------------- data -- */

export interface CandleOptions {
  /** Below this pitch, bars are aggregated into one column per pixel. */
  aggregateBelowPx?: number;
}

/**
 * Candles, with a density fallback.
 *
 * At more than about one bar per two pixels, individual candles are physically
 * unresolvable: the bodies overlap into a smear and the browser still pays for
 * every one of them. Past that threshold the visible bars are folded into one
 * column PER PIXEL — true high/low, first open, last close — which is both
 * faster and more honest, because the drawn extremes are the real extremes
 * rather than whichever bars happened to land on integer pixels.
 *
 * Paths are batched into two (up, down) and stroked once each. Per-candle
 * `beginPath`/`stroke` is the single biggest cost in a naive implementation.
 */
export function drawCandles(
  ctx: CanvasRenderingContext2D,
  bars: Bar[],
  from: number,
  to: number,
  ts: TimeScale,
  ps: PriceScale,
  palette: ChartPalette,
  opts: CandleOptions = {},
): void {
  if (to < from) return;
  const pitch = ts.pxPerBar;
  const threshold = opts.aggregateBelowPx ?? 2.5;
  const up = palette.positive;
  const down = palette.negative;

  if (pitch < threshold) {
    drawCandleColumns(ctx, bars, from, to, ts, ps, up, down);
    return;
  }

  const bodyWidth = Math.max(1, Math.floor(pitch * 0.7));
  const halfBody = bodyWidth / 2;
  const wickUp = new Path2D();
  const wickDown = new Path2D();
  const bodyUp = new Path2D();
  const bodyDown = new Path2D();

  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const rising = b.close >= b.open;
    const x = ts.centerX(i);
    const cx = pitch >= 3 ? crisp(x) : x;
    const yHigh = ps.toY(b.high);
    const yLow = ps.toY(b.low);
    const yOpen = ps.toY(b.open);
    const yClose = ps.toY(b.close);
    const top = Math.min(yOpen, yClose);
    // A doji has zero body height; give it one pixel or it vanishes.
    const height = Math.max(Math.abs(yClose - yOpen), 1);

    const wick = rising ? wickUp : wickDown;
    wick.moveTo(cx, yHigh);
    wick.lineTo(cx, yLow);
    const body = rising ? bodyUp : bodyDown;
    body.rect(cx - halfBody, top, bodyWidth, height);
  }

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = up;
  ctx.stroke(wickUp);
  ctx.fillStyle = up;
  ctx.fill(bodyUp);
  ctx.strokeStyle = down;
  ctx.stroke(wickDown);
  ctx.fillStyle = down;
  ctx.fill(bodyDown);
  ctx.restore();
}

function drawCandleColumns(
  ctx: CanvasRenderingContext2D,
  bars: Bar[],
  from: number,
  to: number,
  ts: TimeScale,
  ps: PriceScale,
  up: string,
  down: string,
): void {
  const upPath = new Path2D();
  const downPath = new Path2D();
  let col = Math.round(ts.centerX(from));
  let high = -Infinity;
  let low = Infinity;
  let open = bars[from].open;
  let close = bars[from].close;

  const flush = () => {
    if (high === -Infinity) return;
    const path = close >= open ? upPath : downPath;
    const x = col + 0.5;
    path.moveTo(x, ps.toY(high));
    path.lineTo(x, ps.toY(low));
  };

  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const x = Math.round(ts.centerX(i));
    if (x !== col) {
      flush();
      col = x;
      high = -Infinity;
      low = Infinity;
      open = b.open;
    }
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    close = b.close;
  }
  flush();

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = up;
  ctx.stroke(upPath);
  ctx.strokeStyle = down;
  ctx.stroke(downPath);
  ctx.restore();
}

/** Close-price polyline. Also the spine of the area mode. */
export function closePath(
  bars: Bar[],
  from: number,
  to: number,
  ts: TimeScale,
  ps: PriceScale,
): Path2D {
  const path = new Path2D();
  let started = false;
  // At sub-pixel density, plotting every bar issues thousands of no-op line
  // segments to the same column. One point per pixel looks identical.
  const stride = ts.pxPerBar < 0.5 ? Math.max(1, Math.floor(0.5 / ts.pxPerBar)) : 1;
  for (let i = from; i <= to; i += stride) {
    const x = ts.centerX(i);
    const y = ps.toY(bars[i].close);
    if (!started) {
      path.moveTo(x, y);
      started = true;
    } else path.lineTo(x, y);
  }
  if (stride > 1 && to >= from) path.lineTo(ts.centerX(to), ps.toY(bars[to].close));
  return path;
}

export function drawLineSeries(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  color: string,
  width = 1.5,
): void {
  ctx.save();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(path);
  ctx.restore();
}

/**
 * Area fill under the close line. The gradient fades to nothing at the foot of
 * the pane so the fill never competes with the grid underneath it.
 */
export function drawArea(
  ctx: CanvasRenderingContext2D,
  bars: Bar[],
  from: number,
  to: number,
  ts: TimeScale,
  ps: PriceScale,
  rect: Rect,
  color: string,
  fadeColor: string,
): void {
  if (to < from) return;
  const path = new Path2D();
  const stride = ts.pxPerBar < 0.5 ? Math.max(1, Math.floor(0.5 / ts.pxPerBar)) : 1;
  path.moveTo(ts.centerX(from), rect.y + rect.height);
  for (let i = from; i <= to; i += stride) path.lineTo(ts.centerX(i), ps.toY(bars[i].close));
  path.lineTo(ts.centerX(to), ps.toY(bars[to].close));
  path.lineTo(ts.centerX(to), rect.y + rect.height);
  path.closePath();

  const grad = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
  grad.addColorStop(0, color);
  grad.addColorStop(1, fadeColor);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fill(path);
  ctx.restore();
}

/**
 * An indicator series, broken at nulls.
 *
 * The gaps are the point: a 200-day average has no value on day 12, and
 * joining day 11 to day 201 draws a line through 189 days of nothing.
 */
export function drawOverlaySeries(
  ctx: CanvasRenderingContext2D,
  points: Array<number | null>,
  from: number,
  to: number,
  ts: TimeScale,
  ps: PriceScale,
  color: string,
  width = 1.25,
): void {
  const path = new Path2D();
  let pen = false;
  const stride = ts.pxPerBar < 0.5 ? Math.max(1, Math.floor(0.5 / ts.pxPerBar)) : 1;
  for (let i = from; i <= to && i < points.length; i += stride) {
    const v = points[i];
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = ts.centerX(i);
    const y = ps.toY(v);
    if (!pen) {
      path.moveTo(x, y);
      pen = true;
    } else path.lineTo(x, y);
  }
  drawLineSeries(ctx, path, color, width);
}

/** Volume columns, coloured by the bar's own direction. */
export function drawVolume(
  ctx: CanvasRenderingContext2D,
  bars: Bar[],
  from: number,
  to: number,
  ts: TimeScale,
  rect: Rect,
  max: number,
  palette: ChartPalette,
): void {
  if (to < from || !(max > 0)) return;
  const base = rect.y + rect.height;
  const width = Math.max(1, Math.floor(ts.pxPerBar * 0.7));
  const half = width / 2;
  const up = new Path2D();
  const down = new Path2D();
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const h = Math.max(1, (b.volume / max) * rect.height);
    const x = ts.centerX(i) - half;
    (b.close >= b.open ? up : down).rect(x, base - h, width, h);
  }
  ctx.save();
  // Volume is context, not the subject; it reads at a third of the weight so
  // it never pulls the eye off the price pane.
  ctx.fillStyle = palette.alpha('positive', 0.45);
  ctx.fill(up);
  ctx.fillStyle = palette.alpha('negative', 0.45);
  ctx.fill(down);
  ctx.restore();
}

/** A dashed reference level, e.g. RSI 30 / 70 or a zero line. */
export function drawGuide(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  y: number,
  palette: ChartPalette,
  label?: string,
): void {
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = palette.alpha('mutedForeground', 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rect.x, crisp(y));
  ctx.lineTo(rect.x + rect.width, crisp(y));
  ctx.stroke();
  ctx.setLineDash([]);
  if (label) {
    ctx.font = `10px ${palette.fontFamily}`;
    ctx.fillStyle = palette.alpha('mutedForeground', 0.8);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, rect.x + 4, y - 2);
  }
  ctx.restore();
}

/**
 * The last close, tagged against the price axis and carried across the pane as
 * a hairline. It is the one number on the chart that is always wanted, and
 * without it the reader has to find the right-hand candle and follow it by eye.
 */
export function drawLastPrice(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  gutterX: number,
  gutterWidth: number,
  y: number,
  label: string,
  rising: boolean,
  palette: ChartPalette,
): void {
  if (y < rect.y || y > rect.y + rect.height) return;
  const token: PaletteToken = rising ? 'positive' : 'negative';
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = palette.alpha(token, 0.55);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rect.x, crisp(y));
  ctx.lineTo(rect.x + rect.width, crisp(y));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `11px ${palette.fontFamily}`;
  const h = 15;
  ctx.fillStyle = palette[token];
  ctx.beginPath();
  ctx.rect(gutterX + 1, y - h / 2, gutterWidth - 2, h);
  ctx.fill();
  ctx.fillStyle = palette.card;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, gutterX + 5, y + 0.5);
  ctx.restore();
}

/** A pane's name and current value, set into its top-left corner. */
export function drawPaneLabel(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  label: string,
  value: string,
  color: string,
  palette: ChartPalette,
): void {
  ctx.save();
  ctx.font = `10px ${palette.fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = palette.mutedForeground;
  ctx.fillText(label, rect.x + 4, rect.y + 3);
  const w = ctx.measureText(label).width;
  ctx.fillStyle = color;
  ctx.fillText(value, rect.x + 8 + w, rect.y + 3);
  ctx.restore();
}
