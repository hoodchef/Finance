/**
 * Scales, domains, ticks and pane layout. Pure — no DOM, no React, no canvas.
 * =============================================================================
 * Everything the chart draws is positioned by something in this file, which is
 * why it is separated out: a scale that is wrong by half a bar is invisible in
 * a screenshot and obvious in a round-trip test.
 *
 * See `types.ts` for the three coordinate spaces.
 */

import type {
  Bar,
  Domain,
  PaneLayout,
  PriceScale,
  PriceScaleMode,
  Rect,
  Tick,
  TimeScale,
  TimeTick,
  Viewport,
} from './types';

/** A viewport narrower than this is treated as degenerate. */
const MIN_SPAN = 1e-6;

/**
 * In log mode, prices at or below zero cannot be placed. Rather than refuse to
 * draw, the axis floors at this fraction of the top of the domain — six
 * decades, which is far below anything a price series reaches and keeps the
 * scale monotonic.
 */
export const LOG_FLOOR_RATIO = 1e-6;

/* ------------------------------------------------------------------ time -- */

/**
 * Index space → pixels.
 *
 * `toX(i)` is the LEFT edge of bar `i` and `centerX(i)` its middle. Wicks,
 * line vertices and crosshair snapping all use the centre; candle bodies and
 * volume columns are laid out from the edge. Mixing the two shifts a series
 * half a bar against the candles it is drawn over, which reads as a lag that
 * is not in the data.
 */
export function makeTimeScale(viewport: Viewport, x: number, width: number): TimeScale {
  const span = Math.max(viewport.end - viewport.start, MIN_SPAN);
  const start = viewport.start;
  const pxPerBar = width / span;
  return {
    start,
    end: start + span,
    x0: x,
    width,
    pxPerBar,
    toX: (index) => x + (index - start) * pxPerBar,
    centerX: (index) => x + (index + 0.5 - start) * pxPerBar,
    toIndex: (px) => start + (px - x) / pxPerBar,
  };
}

/**
 * The integer bar range to iterate when drawing, with one bar of bleed on each
 * side so a line entering the plot from off-screen has somewhere to come from.
 * Returns an inclusive `[from, to]`; `to < from` means nothing is visible.
 */
export function visibleRange(viewport: Viewport, count: number): { from: number; to: number } {
  if (count <= 0) return { from: 0, to: -1 };
  const from = Math.max(0, Math.floor(viewport.start) - 1);
  const to = Math.min(count - 1, Math.ceil(viewport.end) + 1);
  return { from, to: Math.max(from - 1, to) };
}

/* ----------------------------------------------------------------- price -- */

/**
 * Price → pixels, linear or logarithmic.
 *
 * Log mode is not decoration on a price chart: over a long history a linear
 * axis compresses every early move to nothing, so a 40% drawdown in 1995 and a
 * 4% wobble in 2024 occupy the same height. On a log axis equal vertical
 * distances are equal PERCENTAGE moves, which is the thing being compared.
 *
 * A log scale whose domain reaches zero or below falls back to linear — that
 * domain has no logarithm and silently clamping it would misplace every point.
 */
export function makePriceScale(
  domain: Domain,
  top: number,
  height: number,
  mode: PriceScaleMode = 'linear',
): PriceScale {
  let min = Number.isFinite(domain.min) ? domain.min : 0;
  let max = Number.isFinite(domain.max) ? domain.max : 1;
  if (max < min) [min, max] = [max, min];
  if (max - min < Math.max(Math.abs(max) * 1e-9, Number.MIN_VALUE)) {
    // A flat series still needs a scale with height, or every point lands on
    // one row and the chart looks broken rather than calm.
    const pad = Math.max(Math.abs(max) * 0.01, 1e-6);
    min -= pad;
    max += pad;
  }
  const h = Math.max(height, 1);

  /*
   * Log needs a domain that is positive at BOTH ends. Checking only the top
   * let a domain spanning zero through log, where the floor silently clamped
   * the bottom and every point below it landed on the same row — a chart that
   * looks fine and is wrong. Falling back to linear admits the mismatch.
   */
  if (mode === 'log' && min > 0 && max > 0) {
    const floor = Math.max(max * LOG_FLOOR_RATIO, Number.MIN_VALUE);
    const lo = Math.max(min, floor);
    const hi = Math.max(max, lo * (1 + 1e-9));
    const lMin = Math.log(lo);
    const lMax = Math.log(hi);
    const range = lMax - lMin;
    return {
      mode: 'log',
      min: lo,
      max: hi,
      top,
      height: h,
      toY: (price) => top + ((lMax - Math.log(Math.max(price, floor))) / range) * h,
      toPrice: (y) => Math.exp(lMax - ((y - top) / h) * range),
    };
  }

  const range = max - min;
  return {
    mode: 'linear',
    min,
    max,
    top,
    height: h,
    toY: (price) => top + ((max - price) / range) * h,
    toPrice: (y) => max - ((y - top) / h) * range,
  };
}

/**
 * The price extent of the visible bars, padded so candles do not touch the
 * frame. Padding is additive on a linear axis and multiplicative on a log one,
 * so the visual margin is the same at both ends in both modes.
 */
export function priceDomain(
  bars: Bar[],
  from: number,
  to: number,
  mode: PriceScaleMode = 'linear',
  padding = 0.06,
): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i++) {
    const b = bars[i];
    if (b.low < min) min = b.low;
    if (b.high > max) max = b.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  return padDomain({ min, max }, mode, padding);
}

/** Extends a domain to include a series' visible values (indicator overlays). */
export function extendDomain(
  domain: Domain,
  points: Array<number | null>,
  from: number,
  to: number,
): Domain {
  let { min, max } = domain;
  for (let i = Math.max(0, from); i <= Math.min(points.length - 1, to); i++) {
    const v = points[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** The extent of one overlay's visible values, for its own pane. */
export function seriesDomain(
  points: Array<number | null>,
  from: number,
  to: number,
  padding = 0.1,
): Domain {
  const d = extendDomain({ min: Infinity, max: -Infinity }, points, from, to);
  if (!Number.isFinite(d.min) || !Number.isFinite(d.max)) return { min: 0, max: 1 };
  return padDomain(d, 'linear', padding);
}

export function padDomain(domain: Domain, mode: PriceScaleMode, padding: number): Domain {
  const { min, max } = domain;
  if (padding <= 0) return { min, max };
  if (mode === 'log' && min > 0 && max > 0) {
    const factor = Math.pow(max / min, padding);
    return { min: min / factor, max: max * factor };
  }
  const span = max - min || Math.max(Math.abs(max), 1) * 0.02;
  return { min: min - span * padding, max: max + span * padding };
}

/** Largest visible volume. The volume pane always starts at zero. */
export function volumeMax(bars: Bar[], from: number, to: number): number {
  let max = 0;
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i++) {
    const v = bars[i].volume;
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

/* ----------------------------------------------------------------- ticks -- */

/** The 1 / 2 / 2.5 / 5 / 10 ladder. Any other step reads as arbitrary. */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const f = rough / base;
  if (f <= 1) return base;
  if (f <= 2) return 2 * base;
  if (f <= 2.5) return 2.5 * base;
  if (f <= 5) return 5 * base;
  return 10 * base;
}

/** Round tick values covering `domain`, roughly `target` of them. */
export function niceTickValues(domain: Domain, target = 6): number[] {
  const { min, max } = domain;
  const range = max - min;
  if (!(range > 0) || !Number.isFinite(range)) return [min];
  const step = niceStep(range / Math.max(2, target));
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  // Guard the loop on a count as well as the bound: floating-point steps can
  // otherwise fail to terminate on a pathological domain.
  for (let v = first, n = 0; v <= max + step * 1e-9 && n < 500; v += step, n++) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/**
 * Log-axis ticks on the 1 / 2 / 5 ladder per decade.
 *
 * Over a narrow range that ladder can yield one tick or none — a chart zoomed
 * into a $2 move on a $400 stock — so below three ticks this falls back to
 * linear spacing. The axis stays log; only the labelled positions change.
 */
export function logTickValues(domain: Domain, target = 6): number[] {
  const { min, max } = domain;
  if (!(min > 0) || !(max > min)) return niceTickValues(domain, target);
  const out: number[] = [];
  const startExp = Math.floor(Math.log10(min));
  const endExp = Math.ceil(Math.log10(max));
  for (let e = startExp; e <= endExp && out.length < 200; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) out.push(v);
    }
  }
  if (out.length >= 3) {
    if (out.length <= target * 2) return out;
    const stride = Math.ceil(out.length / target);
    return out.filter((_, i) => i % stride === 0);
  }
  return niceTickValues(domain, target);
}

/** Ticks with pixel positions, ready to draw. */
export function priceTicks(
  scale: PriceScale,
  format: (v: number) => string,
  target = 6,
): Tick[] {
  const domain = { min: scale.min, max: scale.max };
  const values = scale.mode === 'log' ? logTickValues(domain, target) : niceTickValues(domain, target);
  return values.map((value) => ({ value, position: scale.toY(value), label: format(value) }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Time ticks, one per calendar bucket rather than one every N bars.
 *
 * Evenly spaced ticks off a trading calendar produce labels like
 * "Jan 3, Mar 14, May 22" — technically correct, unreadable as a timeline.
 * Bucketing by year / month / day and taking the FIRST bar in each gives
 * labels a reader can navigate by, and the bucket width follows the zoom.
 *
 * Only the visible window is scanned, so this stays cheap at 50,000 bars.
 */
export function timeTicks(
  dates: string[],
  viewport: Viewport,
  scale: TimeScale,
  maxTicks = 8,
): TimeTick[] {
  const count = dates.length;
  if (count === 0) return [];
  const from = Math.max(0, Math.floor(viewport.start));
  const to = Math.min(count - 1, Math.ceil(viewport.end));
  if (to < from) return [];

  const spanDays =
    (Date.parse(`${dates[to]}T00:00:00Z`) - Date.parse(`${dates[from]}T00:00:00Z`)) / 86_400_000;
  // Year buckets when a label per month would collide; day buckets when the
  // window is short enough that a month label says almost nothing.
  /*
   * Month buckets from about six weeks out. Below that a month label says
   * almost nothing; above it, day labels crowd and — more importantly — the
   * mid-bucket rule below stops doing anything, because every bar is its own
   * bucket and so every bar looks like a bucket start.
   */
  const width = spanDays > 365 * 6 ? 4 : spanDays > 45 ? 7 : 10;

  const picked: number[] = [];
  let lastKey = '';
  for (let i = from; i <= to; i++) {
    const key = dates[i].slice(0, width);
    if (key === lastKey) continue;
    lastKey = key;
    // The leftmost visible bar is usually mid-bucket. Labelling it would put a
    // "2019" tick on a bar in the middle of 2019.
    if (i === from && i > 0 && dates[i - 1].slice(0, width) === key) continue;
    picked.push(i);
  }

  const stride = picked.length > maxTicks ? Math.ceil(picked.length / maxTicks) : 1;
  /*
   * When the visible span crosses a year, every month label carries its year.
   * Marking only the first month of each year as major left "Mar" appearing
   * twice on a chart covering two Marches — two ticks, one label, and no way
   * to tell which was which.
   */
  const multiYear = new Set(picked.map((i) => dates[i].slice(0, 4))).size > 1;
  const out: TimeTick[] = [];
  for (let n = 0; n < picked.length; n += stride) {
    const i = picked[n];
    const iso = dates[i];
    const year = iso.slice(0, 4);
    const month = Number(iso.slice(5, 7)) - 1;
    const major = width === 4 ? true : i === 0 || dates[i - 1].slice(0, 4) !== year;
    const label =
      width === 4
        ? year
        : width === 7
          ? major || multiYear
            ? `${MONTHS[month]} ${year}`
            : MONTHS[month]
          : major
            ? `${MONTHS[month]} ${iso.slice(8, 10)} ${year}`
            : `${MONTHS[month]} ${iso.slice(8, 10)}`;
    out.push({ index: i, position: scale.centerX(i), label, major });
  }
  return out;
}

/* ---------------------------------------------------------------- layout -- */

export interface LayoutOptions {
  width: number;
  height: number;
  /** Right-hand strip for price labels. */
  gutter?: number;
  /** Bottom strip for date labels and event markers. */
  timeAxisHeight?: number;
  showVolume?: boolean;
  /** How many oscillator panes to make room for. */
  separatePanes?: number;
  gap?: number;
}

const MIN_PANE_HEIGHT = 34;
const MIN_PRICE_HEIGHT = 60;

/**
 * Carves the box into price / volume / oscillator panes and the time axis.
 *
 * The lower panes are sized as a FRACTION of the box rather than in pixels, so
 * the same chart is proportionate at 360px tall on a phone and 900px on a
 * desktop. They are also collectively capped: three oscillators at a fixed
 * height each would leave the price pane — the reason the chart exists — as a
 * sliver. Below the cap they shrink together and the price pane keeps its
 * floor, which is what a reader would do by hand.
 */
export function layoutPanes(opts: LayoutOptions): PaneLayout {
  const gutter = opts.gutter ?? 56;
  const timeAxisHeight = opts.timeAxisHeight ?? 22;
  const gap = opts.gap ?? 8;
  const separate = Math.max(0, opts.separatePanes ?? 0);
  const showVolume = opts.showVolume ?? false;

  const width = Math.max(opts.width, gutter + 40);
  const height = Math.max(opts.height, MIN_PRICE_HEIGHT + timeAxisHeight);
  const plotWidth = Math.max(width - gutter, 20);

  const lowerCount = (showVolume ? 1 : 0) + separate;
  const available = height - timeAxisHeight;

  let lowerEach = 0;
  if (lowerCount > 0) {
    const share = separate > 0 ? 0.17 : 0.16;
    const wanted = Math.max(available * share, MIN_PANE_HEIGHT);
    /*
     * Everything below the price pane together may take at most 40% of the
     * box, so the price pane stays strictly the largest however many
     * oscillators are stacked. At 60% four lower panes could out-measure the
     * price on a short chart, leaving the reason the chart exists as a sliver.
     */
    const budget = Math.min(available * 0.4, available - MIN_PRICE_HEIGHT - gap * lowerCount);
    lowerEach = Math.max(0, Math.min(wanted, budget / lowerCount));
  }

  const lowerTotal = lowerEach * lowerCount + (lowerCount > 0 ? gap * lowerCount : 0);
  const priceHeight = Math.max(MIN_PRICE_HEIGHT, available - lowerTotal);

  const price: Rect = { x: 0, y: 0, width: plotWidth, height: priceHeight };
  let y = priceHeight + (lowerCount > 0 ? gap : 0);

  let volume: Rect | null = null;
  if (showVolume) {
    volume = { x: 0, y, width: plotWidth, height: lowerEach };
    y += lowerEach + gap;
  }

  const panes: Rect[] = [];
  for (let i = 0; i < separate; i++) {
    panes.push({ x: 0, y, width: plotWidth, height: lowerEach });
    y += lowerEach + gap;
  }

  return {
    plotWidth,
    gutter,
    price,
    volume,
    panes,
    timeAxis: { x: 0, y: height - timeAxisHeight, width: plotWidth, height: timeAxisHeight },
  };
}

/* ------------------------------------------------------------ formatting -- */

/**
 * Price labels at a precision that follows the magnitude AND the visible
 * range: a $4.20 stock needs cents, a $4,200 index does not, and a chart
 * zoomed into a 30-cent range needs more decimals than either rule alone
 * would give.
 */
export function makePriceFormatter(domain: Domain): (v: number) => string {
  const span = Math.abs(domain.max - domain.min);
  const scale = Math.max(Math.abs(domain.max), Math.abs(domain.min));
  let digits = 2;
  if (span >= 500 || scale >= 5000) digits = 0;
  else if (span >= 50) digits = 1;
  else if (span < 1) digits = 4;
  else if (span < 5) digits = 3;
  return (v: number) => {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    return v.toFixed(digits);
  };
}

/** Volume labels: `12.4M`, `840K`. */
export function formatVolume(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return v.toFixed(0);
}
