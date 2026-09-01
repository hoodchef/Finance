/**
 * The chart engine's type contract.
 * =============================================================================
 * Everything here is data, geometry or configuration. No DOM types leak into
 * this module, so the pure maths (`scales`, `interactions`, `drawings`) can be
 * imported and tested under Node without a browser environment.
 *
 * COORDINATE SPACES — there are three, and keeping them straight is most of
 * what makes the chart correct:
 *
 *   1. Index space   fractional bar index. Bar `i` occupies `[i, i + 1)`, so
 *                    its centre is `i + 0.5`. The viewport is expressed here.
 *                    Trading calendars have holes (weekends, holidays); index
 *                    space closes them, which is why bars are evenly spaced
 *                    however irregular the dates are.
 *   2. Chart space   `{ t, p }` — epoch milliseconds and price. This is what
 *                    drawings persist in, so an annotation stays on the bar
 *                    the user put it on through any zoom, pan or scale change.
 *   3. Pixel space   CSS pixels relative to the chart's own box.
 *
 * Index space is the fast path (rendering); chart space is the durable one
 * (persistence). `drawings.makeProjector` is the bridge between them.
 */

/** One price bar. Produced elsewhere — this component never fetches. */
export interface Bar {
  /** ISO `YYYY-MM-DD`. Assumed ascending and unique. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A computed series aligned index-for-index with `bars`.
 *
 * `points[i]` is `null` where the indicator has no value — a moving average's
 * warm-up window, for instance. Nulls break the line rather than being
 * interpolated across, because a drawn-through gap is a claim about data that
 * does not exist.
 */
export interface Overlay {
  id: string;
  label: string;
  points: Array<number | null>;
  /** `price` draws over the candles; `separate` gets its own pane below. */
  axis: 'price' | 'separate';
}

/** A corporate action or scheduled event, marked on the time axis. */
export interface ChartEvent {
  date: string;
  kind: 'dividend' | 'split' | 'earnings' | 'ticker-change';
  label: string;
}

export type PriceScaleMode = 'linear' | 'log';
export type ChartMode = 'candlestick' | 'line' | 'area';

/** The active pointer tool. `cursor` selects and moves; the rest create. */
export type DrawingTool = 'cursor' | 'trendline' | 'horizontal' | 'rect' | 'note';

/**
 * The visible slice of the data, in fractional bar indices.
 * `end` is exclusive: `{ start: 0, end: bars.length }` shows everything.
 */
export interface Viewport {
  start: number;
  end: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Domain {
  min: number;
  max: number;
}

/** Index space → pixels along x. */
export interface TimeScale {
  /** Left edge of the viewport, in fractional bar indices. */
  start: number;
  /** Right edge of the viewport, in fractional bar indices (exclusive). */
  end: number;
  /** Pixel x of index `start`. */
  x0: number;
  width: number;
  /** Pixels per bar. Also the candle pitch. */
  pxPerBar: number;
  /** Left edge of bar `i` in pixels (accepts fractional indices). */
  toX: (index: number) => number;
  /** Centre of bar `i` in pixels. Where lines and wicks are drawn. */
  centerX: (index: number) => number;
  /** Pixels → fractional bar index. Inverse of `toX`. */
  toIndex: (x: number) => number;
}

/** Price → pixels along y, linear or logarithmic. */
export interface PriceScale {
  mode: PriceScaleMode;
  min: number;
  max: number;
  top: number;
  height: number;
  toY: (price: number) => number;
  toPrice: (y: number) => number;
}

export interface Tick {
  value: number;
  /** Pixel position along the scale's axis. */
  position: number;
  label: string;
}

export interface TimeTick {
  /** Fractional bar index the tick sits on. */
  index: number;
  position: number;
  label: string;
  /** A year boundary, or a month boundary on a day-resolution axis. */
  major: boolean;
}

/** Vertical carve-up of the chart box. Every pane shares one time scale. */
export interface PaneLayout {
  /** Width available to the plot, i.e. total width less the price gutter. */
  plotWidth: number;
  /** Right-hand strip reserved for price labels. */
  gutter: number;
  price: Rect;
  volume: Rect | null;
  /** One per `axis: 'separate'` overlay, in the order they were given. */
  panes: Rect[];
  timeAxis: Rect;
}

/**
 * Theme colours, resolved to CSS colour strings at runtime.
 *
 * A canvas takes paint, not class names, so these cannot come from Tailwind.
 * They are read out of the live CSS custom properties instead (see
 * `canvas.readPalette`) and rebuilt whenever the theme changes — which keeps
 * the single source of truth in `globals.css` where the other four themes
 * already live. Nothing in this component hardcodes a colour value.
 */
export interface ChartPalette {
  foreground: string;
  mutedForeground: string;
  border: string;
  grid: string;
  card: string;
  popover: string;
  positive: string;
  negative: string;
  primary: string;
  warning: string;
  /** `--series-0` … `--series-14`, for overlays. */
  series: string[];
  /** Same tokens with an alpha applied. Built once per theme, not per frame. */
  alpha: (token: PaletteToken, a: number) => string;
  /** Resolved font stack, so canvas text matches the surrounding page. */
  fontFamily: string;
}

export type PaletteToken =
  | 'foreground'
  | 'mutedForeground'
  | 'border'
  | 'grid'
  | 'card'
  | 'popover'
  | 'positive'
  | 'negative'
  | 'primary'
  | 'warning';
