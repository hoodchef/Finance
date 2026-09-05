'use client';

/**
 * PriceChart — an interactive price surface.
 * =============================================================================
 * A self-contained rendering and interaction layer. It fetches nothing and
 * knows nothing about where its data came from: give it `bars`, optionally
 * `overlays` and `events`, and it draws them.
 *
 * ARCHITECTURE
 * ------------
 *   scales.ts        domains, scales, ticks, pane layout          (pure, tested)
 *   interactions.ts  zoom, pan, clamping, momentum, hit panes     (pure, tested)
 *   drawings.ts      annotation model, projection, geometry       (pure, tested)
 *   canvas.ts        drawing primitives + theme-token resolution  (DOM, untested)
 *   price-chart.tsx  this file: state, events, chrome             (thin)
 *
 * The maths lives in the pure modules on purpose. A scale that is off by half a
 * bar or a clamp that lets the viewport walk off the data is invisible in a
 * screenshot and unmissable in a test, so everything that can be a function of
 * its inputs is one, and this file is left holding React state and DOM events.
 *
 * CANVAS + SVG
 * ------------
 * The price surface is canvas: 50,000 candles is 150,000 SVG nodes, which
 * nothing pans smoothly. Everything the user can grab — drawings, their
 * handles, the crosshair, event markers — is SVG or HTML, where it can carry
 * its own hit area, hover state and accessible name.
 *
 * COLOUR
 * ------
 * There are four themes (light, dark, terminal, bloomberg) and a hardcoded
 * colour is illegible in at least one, so nothing here contains a colour value.
 *
 *   - SVG and HTML take `hsl(var(--token))` directly; the browser re-resolves
 *     them when the theme class changes, with no work from this component.
 *   - Canvas takes paint, not class names, so the same tokens are READ AT
 *     RUNTIME with `getComputedStyle(el).getPropertyValue('--positive')` (see
 *     `canvas.readPalette`) and the palette is rebuilt whenever the theme class
 *     on `<html>` changes — watched with a MutationObserver, so it works for
 *     the system theme and any future theme without this file knowing them.
 *
 * `globals.css` therefore stays the single source of truth for colour.
 */

import * as React from 'react';
import {
  AreaChart,
  CandlestickChart,
  LineChart,
  Maximize2,
  Minus,
  MousePointer2,
  Square,
  Trash2,
  TrendingUp,
  Type,
} from 'lucide-react';
import { cn, uid } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  crisp,
  drawArea,
  drawCandles,
  drawGrid,
  drawGuide,
  drawLastPrice,
  drawLineSeries,
  drawOverlaySeries,
  drawPaneLabel,
  drawPaneSeparator,
  drawPriceAxis,
  drawTimeAxis,
  drawVolume,
  drawWatermark,
  closePath,
  readPalette,
  seriesAt,
  setupCanvas,
} from './canvas';
import {
  extendDomain,
  formatVolume,
  layoutPanes,
  makePriceFormatter,
  makePriceScale,
  makeTimeScale,
  padDomain,
  priceDomain,
  priceTicks,
  seriesDomain,
  timeTicks,
  visibleRange,
  volumeMax,
} from './scales';
import {
  MOMENTUM_EPSILON,
  clampViewport,
  fitViewport,
  nearestIndex,
  panByPixels,
  panStep,
  stepMomentum,
  velocityFromSamples,
  zoomFactorFromPinch,
  zoomFactorFromWheel,
  zoomStep,
  zoomViewport,
} from './interactions';
import {
  HIT_TOLERANCE,
  MIN_DRAG_PIXELS,
  NOTE_METRICS,
  barTimes,
  createDrawing,
  dragHandle,
  extendToPlot,
  handlesOf,
  hitTestAll,
  makeProjector,
  noteBox,
  rectOf,
  type Anchor,
  type Drawing,
  type DrawingTone,
  type HandleRole,
  type Projector,
} from './drawings';
import type {
  Bar,
  ChartEvent,
  ChartMode,
  ChartPalette,
  DrawingTool,
  Overlay,
  PaneLayout,
  PriceScale,
  PriceScaleMode,
  Rect,
  TimeScale,
  Viewport,
} from './types';

export type { Bar, ChartEvent, Overlay, ChartMode, DrawingTool, PriceScaleMode, Viewport } from './types';
export type { Drawing, Anchor, DrawingTone } from './drawings';

/* =========================================================== public API === */

export interface PriceChartProps {
  /** Ascending, one per session. The only required input. */
  bars: Bar[];
  /**
   * Computed series aligned index-for-index with `bars`. `axis: 'price'` draws
   * over the candles; `axis: 'separate'` gets a proportional pane below.
   */
  overlays?: Overlay[];
  /** Corporate actions and earnings, marked on the time axis. */
  events?: ChartEvent[];
  /** Shown as a watermark and in the readout. */
  symbol?: string;

  /** CSS height of the whole chart, including axes. Defaults to 420. */
  height?: number;
  className?: string;

  /** Candlestick / line / area. Controlled when `mode` is given. */
  mode?: ChartMode;
  defaultMode?: ChartMode;
  onModeChange?: (mode: ChartMode) => void;

  /** Linear or log price axis. Controlled when `priceScale` is given. */
  priceScale?: PriceScaleMode;
  defaultPriceScale?: PriceScaleMode;
  onPriceScaleChange?: (mode: PriceScaleMode) => void;

  /** The visible slice, in fractional bar indices. Controlled when given. */
  viewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  /** Bars visible on first render. Defaults to the whole series. */
  initialBars?: number;

  /** Active pointer tool. Controlled when `tool` is given. */
  tool?: DrawingTool;
  defaultTool?: DrawingTool;
  onToolChange?: (tool: DrawingTool) => void;

  /**
   * Annotations, in chart coordinates (epoch ms + price) so they stay anchored
   * across zoom, pan, scale changes and reloads. Controlled when `drawings` is
   * given; `onDrawingsChange` fires on every edit either way, and the value is
   * JSON-serialisable for persistence (`serializeDrawings` in `drawings.ts`).
   */
  drawings?: Drawing[];
  defaultDrawings?: Drawing[];
  onDrawingsChange?: (drawings: Drawing[]) => void;

  showVolume?: boolean;
  showToolbar?: boolean;
  /** Suppresses the OHLCV legend if the caller shows its own. */
  showReadout?: boolean;

  /** Price label formatter. Defaults to a precision chosen from the range. */
  formatPrice?: (value: number) => string;
  /** Shown when `bars` is empty. Say what the reader should do. */
  emptyMessage?: string;
  ariaLabel?: string;
}

/* ============================================================== geometry === */

interface PaneSeries {
  overlay: Overlay;
  rect: Rect;
  scale: PriceScale;
  colorIndex: number;
}

interface Geometry {
  layout: PaneLayout;
  timeScale: TimeScale;
  priceScale: PriceScale;
  range: { from: number; to: number };
  format: (v: number) => string;
  panes: PaneSeries[];
  priceOverlays: Array<{ overlay: Overlay; colorIndex: number }>;
  maxVolume: number;
  width: number;
  height: number;
}

/**
 * Everything positional, derived from the data and the viewport in one place.
 *
 * Both the canvas renderer and the SVG layer read from this, which is what
 * guarantees a drawing's handle lands exactly on the pixel the candle was
 * painted at — two independent derivations would drift.
 */
function computeGeometry(input: {
  bars: Bar[];
  overlays: Overlay[];
  viewport: Viewport;
  width: number;
  height: number;
  priceMode: PriceScaleMode;
  showVolume: boolean;
  formatPrice?: (v: number) => string;
}): Geometry {
  const { bars, overlays, viewport, width, height, priceMode, showVolume } = input;
  const range = visibleRange(viewport, bars.length);

  const priceOverlays = overlays
    .map((overlay, i) => ({ overlay, colorIndex: i }))
    .filter((o) => o.overlay.axis === 'price');
  const separate = overlays
    .map((overlay, i) => ({ overlay, colorIndex: i }))
    .filter((o) => o.overlay.axis === 'separate');

  let domain = priceDomain(bars, range.from, range.to, priceMode);
  for (const o of priceOverlays) {
    domain = extendDomain(domain, o.overlay.points, range.from, range.to);
  }
  domain = padDomain(domain, priceMode, 0.02);

  const format = input.formatPrice ?? makePriceFormatter(domain);
  // The gutter follows the widest label it has to hold: a four-figure index
  // and a sub-dollar penny stock need very different room, and a fixed gutter
  // either clips one or wastes a strip of plot on the other.
  const sample = Math.max(format(domain.max).length, format(domain.min).length);
  const gutter = Math.max(46, Math.min(96, sample * 7 + 14));

  const layout = layoutPanes({
    width,
    height,
    gutter,
    showVolume,
    separatePanes: separate.length,
  });

  const timeScale = makeTimeScale(viewport, 0, layout.plotWidth);
  const priceScale = makePriceScale(domain, layout.price.y, layout.price.height, priceMode);

  const panes: PaneSeries[] = separate.map((o, i) => {
    const rect = layout.panes[i];
    return {
      overlay: o.overlay,
      rect,
      colorIndex: o.colorIndex,
      scale: makePriceScale(
        seriesDomain(o.overlay.points, range.from, range.to),
        rect.y,
        rect.height,
        'linear',
      ),
    };
  });

  return {
    layout,
    timeScale,
    priceScale,
    range,
    format,
    panes,
    priceOverlays,
    maxVolume: showVolume ? volumeMax(bars, range.from, range.to) : 0,
    width,
    height,
  };
}

/* =============================================================== canvas === */

function drawChart(
  canvas: HTMLCanvasElement,
  args: {
    bars: Bar[];
    geometry: Geometry;
    palette: ChartPalette;
    mode: ChartMode;
    dpr: number;
    symbol?: string;
    dates: string[];
    viewport: Viewport;
  },
): void {
  const { bars, geometry, palette, mode, dpr, symbol, dates, viewport } = args;
  const { layout, timeScale, priceScale, range, format } = geometry;
  const ctx = setupCanvas(canvas, geometry.width, geometry.height, dpr);
  if (!ctx) return;

  const xTicks = timeTicks(dates, viewport, timeScale);
  const yTicks = priceTicks(priceScale, format, Math.max(3, Math.round(layout.price.height / 52)));

  drawGrid(ctx, layout.price, yTicks, xTicks, palette);
  if (symbol) drawWatermark(ctx, layout.price, symbol, palette);

  if (range.to >= range.from) {
    if (mode === 'candlestick') {
      drawCandles(ctx, bars, range.from, range.to, timeScale, priceScale, palette, {});
    } else {
      const rising = bars[range.to].close >= bars[range.from].open;
      const token = rising ? 'positive' : 'negative';
      if (mode === 'area') {
        drawArea(
          ctx,
          bars,
          range.from,
          range.to,
          timeScale,
          priceScale,
          layout.price,
          palette.alpha(token, 0.22),
          palette.alpha(token, 0),
        );
      }
      drawLineSeries(
        ctx,
        closePath(bars, range.from, range.to, timeScale, priceScale),
        palette[token],
        1.5,
      );
    }

    for (const o of geometry.priceOverlays) {
      drawOverlaySeries(
        ctx,
        o.overlay.points,
        range.from,
        range.to,
        timeScale,
        priceScale,
        seriesAt(palette, o.colorIndex),
      );
    }
  }

  drawPriceAxis(ctx, yTicks, layout.price, layout.plotWidth, palette);

  if (layout.volume) {
    drawPaneSeparator(ctx, layout.volume, palette);
    drawVolume(ctx, bars, range.from, range.to, timeScale, layout.volume, geometry.maxVolume, palette);
    drawPaneLabel(
      ctx,
      layout.volume,
      'VOL',
      geometry.maxVolume > 0 ? formatVolume(geometry.maxVolume) : '—',
      palette.mutedForeground,
      palette,
    );
  }

  for (const pane of geometry.panes) {
    drawPaneSeparator(ctx, pane.rect, palette);
    // A guide where the series has a meaning to read against: the 30/70 bands
    // of an oscillator, or zero for anything that crosses it.
    if (/rsi/i.test(pane.overlay.label)) {
      for (const level of [30, 70]) {
        if (level > pane.scale.min && level < pane.scale.max) {
          drawGuide(ctx, pane.rect, pane.scale.toY(level), palette, String(level));
        }
      }
    } else if (pane.scale.min < 0 && pane.scale.max > 0) {
      drawGuide(ctx, pane.rect, pane.scale.toY(0), palette);
    }
    drawOverlaySeries(
      ctx,
      pane.overlay.points,
      range.from,
      range.to,
      timeScale,
      pane.scale,
      seriesAt(palette, pane.colorIndex),
    );
    const last = lastValue(pane.overlay.points, range.to);
    drawPaneLabel(
      ctx,
      pane.rect,
      pane.overlay.label,
      last == null ? '—' : formatCompact(last),
      seriesAt(palette, pane.colorIndex),
      palette,
    );
    drawPriceAxis(
      ctx,
      [
        { value: pane.scale.max, position: pane.rect.y + 7, label: formatCompact(pane.scale.max) },
        {
          value: pane.scale.min,
          position: pane.rect.y + pane.rect.height - 6,
          label: formatCompact(pane.scale.min),
        },
      ],
      pane.rect,
      layout.plotWidth,
      palette,
    );
  }

  drawTimeAxis(ctx, xTicks, layout.timeAxis, palette);

  if (range.to >= range.from) {
    const last = bars[range.to];
    drawLastPrice(
      ctx,
      layout.price,
      layout.plotWidth,
      layout.gutter,
      priceScale.toY(last.close),
      format(last.close),
      last.close >= last.open,
      palette,
    );
  }

  // The frame, last, so nothing overlaps the gutter edge.
  ctx.save();
  ctx.strokeStyle = palette.alpha('border', 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(crisp(layout.plotWidth), 0);
  ctx.lineTo(crisp(layout.plotWidth), layout.timeAxis.y);
  ctx.moveTo(0, crisp(layout.timeAxis.y));
  ctx.lineTo(geometry.width, crisp(layout.timeAxis.y));
  ctx.stroke();
  ctx.restore();
}

function lastValue(points: Array<number | null>, to: number): number | null {
  for (let i = Math.min(to, points.length - 1); i >= 0; i--) {
    const v = points[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

function formatCompact(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/* ================================================================ state === */

/** Controlled-or-not, without calling `onChange` from inside a state updater. */
function useControllable<T>(
  controlled: T | undefined,
  fallback: T,
  onChange?: (value: T) => void,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [internal, setInternal] = React.useState<T>(fallback);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : internal;
  const ref = React.useRef(value);
  ref.current = value;

  const set = React.useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next;
      if (!isControlled) setInternal(resolved);
      ref.current = resolved;
      onChange?.(resolved);
    },
    [isControlled, onChange],
  );
  return [value, set];
}

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * The live theme palette for the canvas, rebuilt when the theme changes.
 *
 * `next-themes` swaps a class on `<html>`, so a MutationObserver on that
 * attribute catches every theme — including ones added later — without this
 * component importing the theme library or enumerating theme names.
 */
function usePalette(ref: React.RefObject<Element>): ChartPalette | null {
  const [palette, setPalette] = React.useState<ChartPalette | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setPalette(readPalette(el));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, [ref]);

  return palette;
}

/** Element size in CSS pixels, and the device pixel ratio to render it at. */
function useSurface(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const [dpr, setDpr] = React.useState(1);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  React.useEffect(() => {
    // The ratio changes when the window moves between displays or the browser
    // zoom changes; a matchMedia on the current ratio is the only event for it.
    let media: MediaQueryList | null = null;
    const update = () => {
      const next = window.devicePixelRatio || 1;
      setDpr(next);
      media?.removeEventListener('change', update);
      media = window.matchMedia(`(resolution: ${next}dppx)`);
      media.addEventListener('change', update);
    };
    update();
    return () => media?.removeEventListener('change', update);
  }, []);

  return { size, dpr };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/* ============================================================ component === */

interface Crosshair {
  x: number;
  y: number;
  index: number;
}

interface DragState {
  kind: 'pan' | 'draw' | 'move';
  pointerId: number;
  startX: number;
  startY: number;
  startViewport: Viewport;
  samples: Array<{ index: number; time: number }>;
  drawingId?: string;
  role?: HandleRole;
  original?: Drawing;
  anchor?: Anchor;
  moved: boolean;
}

interface Draft {
  kind: Exclude<DrawingTool, 'cursor'>;
  from: Anchor;
  to: Anchor;
}

/* Module-level so an omitted prop is referentially stable across renders and
 * does not invalidate every memo on the way down. */
const EMPTY_OVERLAYS: Overlay[] = [];
const EMPTY_EVENTS: ChartEvent[] = [];
const EMPTY_DRAWINGS: Drawing[] = [];

export function PriceChart({
  bars,
  overlays = EMPTY_OVERLAYS,
  events = EMPTY_EVENTS,
  symbol,
  height = 420,
  className,
  mode: modeProp,
  defaultMode = 'candlestick',
  onModeChange,
  priceScale: priceScaleProp,
  defaultPriceScale = 'linear',
  onPriceScaleChange,
  viewport: viewportProp,
  onViewportChange,
  initialBars,
  tool: toolProp,
  defaultTool = 'cursor',
  onToolChange,
  drawings: drawingsProp,
  defaultDrawings = EMPTY_DRAWINGS,
  onDrawingsChange,
  showVolume = true,
  showToolbar = true,
  showReadout = true,
  formatPrice,
  emptyMessage = 'No price history for this range. Choose a symbol and period to see prices.',
  ariaLabel,
}: PriceChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const palette = usePalette(containerRef);
  const { size, dpr } = useSurface(surfaceRef);
  const reducedMotion = usePrefersReducedMotion();

  const count = bars.length;
  const [mode, setMode] = useControllable(modeProp, defaultMode, onModeChange);
  const [priceMode, setPriceMode] = useControllable(
    priceScaleProp,
    defaultPriceScale,
    onPriceScaleChange,
  );
  const [tool, setTool] = useControllable(toolProp, defaultTool, onToolChange);
  const [drawings, setDrawings] = useControllable(drawingsProp, defaultDrawings, onDrawingsChange);
  const [viewport, setViewport] = useControllable(
    viewportProp,
    fitViewport(count, initialBars),
    onViewportChange,
  );

  const [crosshair, setCrosshair] = React.useState<Crosshair | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null);
  const [hoveredEvent, setHoveredEvent] = React.useState<number | null>(null);

  const dates = React.useMemo(() => bars.map((b) => b.date), [bars]);
  const times = React.useMemo(() => barTimes(dates), [dates]);

  /*
   * The viewport is clamped to whatever data is currently loaded. Swapping a
   * 1-year series for a 20-year one — or the reverse — otherwise leaves the
   * chart looking at bars that no longer exist.
   */
  const lastCountRef = React.useRef(count);
  React.useEffect(() => {
    if (lastCountRef.current === count) return;
    const grew = lastCountRef.current === 0;
    lastCountRef.current = count;
    setViewport((prev) => (grew ? fitViewport(count, initialBars) : clampViewport(prev, count)));
  }, [count, initialBars, setViewport]);

  const geometry = React.useMemo(
    () =>
      computeGeometry({
        bars,
        overlays,
        viewport,
        width: size.width,
        height: size.height,
        priceMode,
        showVolume,
        formatPrice,
      }),
    [bars, overlays, viewport, size.width, size.height, priceMode, showVolume, formatPrice],
  );

  const projector = React.useMemo(
    () => makeProjector(times, geometry.timeScale, geometry.priceScale),
    [times, geometry.timeScale, geometry.priceScale],
  );

  /* ------------------------------------------------------------- render -- */

  useIsomorphicLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !palette || geometry.width <= 0 || geometry.height <= 0 || count === 0) return;
    drawChart(canvas, { bars, geometry, palette, mode, dpr, symbol, dates, viewport });
  }, [bars, dates, geometry, palette, mode, dpr, symbol, viewport, count]);

  /* ---------------------------------------------------------- momentum -- */

  const viewportRef = React.useRef(viewport);
  viewportRef.current = viewport;
  const momentumRef = React.useRef<{ raf: number; velocity: number; last: number } | null>(null);

  const stopMomentum = React.useCallback(() => {
    if (momentumRef.current) cancelAnimationFrame(momentumRef.current.raf);
    momentumRef.current = null;
  }, []);

  const startMomentum = React.useCallback(
    (velocity: number) => {
      stopMomentum();
      if (reducedMotion || Math.abs(velocity) < MOMENTUM_EPSILON) return;
      const tick = (now: number) => {
        const state = momentumRef.current;
        if (!state) return;
        // Cap the step so a backgrounded tab does not resume with one enormous
        // jump when it comes back.
        const dt = Math.min(48, Math.max(1, now - state.last));
        state.last = now;
        const next = stepMomentum(viewportRef.current, state.velocity, dt, count);
        setViewport(next.viewport);
        state.velocity = next.velocity;
        if (next.done) {
          stopMomentum();
          return;
        }
        state.raf = requestAnimationFrame(tick);
      };
      momentumRef.current = {
        raf: requestAnimationFrame(tick),
        velocity,
        last: performance.now(),
      };
    },
    [count, reducedMotion, setViewport, stopMomentum],
  );

  React.useEffect(() => stopMomentum, [stopMomentum]);

  /* ------------------------------------------------------------- wheel -- */

  const geometryRef = React.useRef(geometry);
  geometryRef.current = geometry;

  React.useEffect(() => {
    const el = svgRef.current;
    if (!el || count === 0) return;
    const onWheel = (e: WheelEvent) => {
      // Non-passive: the page must not scroll while the chart is being zoomed.
      e.preventDefault();
      stopMomentum();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const g = geometryRef.current;
      if (e.shiftKey && !e.ctrlKey) {
        setViewport((prev) => panByPixels(prev, count, -e.deltaX - e.deltaY, g.layout.plotWidth));
        return;
      }
      // A trackpad pinch arrives as ctrl+wheel; it wants a firmer response
      // than a scroll gesture because the fingers are already doing the work.
      const factor = zoomFactorFromWheel(e.deltaY, e.deltaMode, e.ctrlKey ? 0.008 : 0.0018);
      const anchor = g.timeScale.toIndex(x);
      setViewport((prev) => zoomViewport(prev, count, factor, anchor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [count, setViewport, stopMomentum]);

  /* ----------------------------------------------------------- pointer -- */

  const dragRef = React.useRef<DragState | null>(null);
  const pinchRef = React.useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchDistanceRef = React.useRef(0);

  const localPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const commitDrawings = React.useCallback(
    (next: Drawing[]) => setDrawings(next),
    [setDrawings],
  );

  const updateDrawing = React.useCallback(
    (id: string, produce: (d: Drawing) => Drawing) => {
      setDrawings((prev) => prev.map((d) => (d.id === id ? produce(d) : d)));
    },
    [setDrawings],
  );

  const removeDrawing = React.useCallback(
    (id: string) => {
      setDrawings((prev) => prev.filter((d) => d.id !== id));
      setSelectedId((prev) => (prev === id ? null : prev));
    },
    [setDrawings],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (count === 0) return;
    const p = localPoint(e);
    containerRef.current?.focus({ preventScroll: true });
    stopMomentum();

    pinchRef.current.set(e.pointerId, p);
    if (pinchRef.current.size === 2) {
      const [a, b] = [...pinchRef.current.values()];
      pinchDistanceRef.current = Math.hypot(a.x - b.x, a.y - b.y);
      dragRef.current = null;
      return;
    }

    svgRef.current?.setPointerCapture(e.pointerId);

    if (tool === 'cursor') {
      const hit = hitTestAll(drawings, p, projector, geometry.layout.price, HIT_TOLERANCE);
      if (hit) {
        setSelectedId(hit.drawing.id);
        dragRef.current = {
          kind: 'move',
          pointerId: e.pointerId,
          startX: p.x,
          startY: p.y,
          startViewport: viewport,
          samples: [],
          drawingId: hit.drawing.id,
          role: hit.hit.role,
          original: hit.drawing,
          moved: false,
        };
        return;
      }
      setSelectedId(null);
      dragRef.current = {
        kind: 'pan',
        pointerId: e.pointerId,
        startX: p.x,
        startY: p.y,
        startViewport: viewport,
        samples: [{ index: viewport.start, time: e.timeStamp }],
        moved: false,
      };
      return;
    }

    const anchor = projector.toAnchor(p);
    dragRef.current = {
      kind: 'draw',
      pointerId: e.pointerId,
      startX: p.x,
      startY: p.y,
      startViewport: viewport,
      samples: [],
      anchor,
      moved: false,
    };
    setDraft({ kind: tool, from: anchor, to: anchor });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (count === 0) return;
    const p = localPoint(e);

    if (pinchRef.current.size >= 2) {
      pinchRef.current.set(e.pointerId, p);
      const [a, b] = [...pinchRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = zoomFactorFromPinch(pinchDistanceRef.current, distance);
      pinchDistanceRef.current = distance;
      const midpoint = (a.x + b.x) / 2;
      const anchor = geometry.timeScale.toIndex(midpoint);
      setViewport((prev) => zoomViewport(prev, count, factor, anchor));
      return;
    }

    // The crosshair follows the pointer whether or not a gesture is running,
    // so a drag never loses the readout.
    const index = nearestIndex(p.x, geometry.timeScale, count);
    setCrosshair(p.x <= geometry.layout.plotWidth ? { x: p.x, y: p.y, index } : null);

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;

    if (drag.kind === 'pan') {
      const next = panByPixels(drag.startViewport, count, dx, geometry.layout.plotWidth);
      drag.samples.push({ index: next.start, time: e.timeStamp });
      if (drag.samples.length > 12) drag.samples.shift();
      setViewport(next);
      return;
    }

    if (drag.kind === 'move' && drag.drawingId && drag.original) {
      // Always from the ORIGINAL: applying per-move deltas accumulates rounding
      // through the projector and the drawing creeps away from the pointer.
      const moved = dragHandle(drag.original, drag.role ?? 'body', dx, dy, projector);
      updateDrawing(drag.drawingId, () => moved);
      return;
    }

    if (drag.kind === 'draw' && drag.anchor) {
      setDraft((prev) => (prev ? { ...prev, to: projector.toAnchor(p) } : prev));
    }
  };

  const finishGesture = (e: React.PointerEvent) => {
    pinchRef.current.delete(e.pointerId);
    if (pinchRef.current.size < 2) pinchDistanceRef.current = 0;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    // `releasePointerCapture` throws if the pointer was never captured, which
    // happens whenever a gesture ends as a cancel.
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }

    if (drag.kind === 'pan') {
      startMomentum(velocityFromSamples(drag.samples));
      return;
    }

    if (drag.kind === 'draw' && drag.anchor) {
      const p = localPoint(e);
      const travelled = Math.hypot(p.x - drag.startX, p.y - drag.startY);
      const kind = draft?.kind ?? 'trendline';
      setDraft(null);
      // A click that never became a drag would leave a zero-size annotation
      // that is impossible to see and impossible to grab.
      if (kind !== 'horizontal' && kind !== 'note' && travelled < MIN_DRAG_PIXELS) {
        setTool('cursor');
        return;
      }
      const id = uid('draw');
      const created = createDrawing(kind, drag.anchor, projector.toAnchor(p), { id });
      commitDrawings([...drawings, created]);
      setSelectedId(id);
      setTool('cursor');
      if (created.kind === 'note') setEditingNoteId(id);
    }
  };

  /* ---------------------------------------------------------- keyboard -- */

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (count === 0) return;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        stopMomentum();
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        setViewport((prev) => panStep(prev, count, direction, e.shiftKey));
        break;
      }
      case '+':
      case '=':
        e.preventDefault();
        setViewport((prev) => zoomStep(prev, count, 1));
        break;
      case '-':
      case '_':
        e.preventDefault();
        setViewport((prev) => zoomStep(prev, count, -1));
        break;
      case 'Escape':
        // One key, one meaning: back out of whatever is in progress, innermost
        // first — the editor, then the half-drawn shape, then the selection.
        if (editingNoteId) {
          const editing = drawings.find((d) => d.id === editingNoteId);
          if (editing?.kind === 'note' && !editing.text) removeDrawing(editingNoteId);
          setEditingNoteId(null);
        } else if (draft) {
          setDraft(null);
          dragRef.current = null;
          setTool('cursor');
        } else if (selectedId) {
          setSelectedId(null);
        } else if (tool !== 'cursor') {
          setTool('cursor');
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (selectedId && !editingNoteId) {
          e.preventDefault();
          removeDrawing(selectedId);
        }
        break;
      case 'Home':
        e.preventDefault();
        setViewport(fitViewport(count));
        break;
      default:
        break;
    }
  };

  /* ------------------------------------------------------------ readout -- */

  const readoutIndex = crosshair
    ? crosshair.index
    : geometry.range.to >= 0
      ? Math.min(count - 1, geometry.range.to)
      : -1;
  const readoutBar = readoutIndex >= 0 ? bars[readoutIndex] : null;
  const previousBar = readoutIndex > 0 ? bars[readoutIndex - 1] : null;

  if (count === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-border bg-muted/40 p-6',
          className,
        )}
        style={{ height }}
      >
        <p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
          {emptyMessage}
        </p>
      </div>
    );
  }

  const { layout, timeScale, priceScale } = geometry;
  const plot = layout.price;
  const crosshairPrice = crosshair ? priceScale.toPrice(crosshair.y) : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={
        ariaLabel ??
        `Price chart${symbol ? ` for ${symbol}` : ''}. Arrow keys pan, plus and minus zoom.`
      }
      style={{ height }}
      className={cn(
        'relative flex flex-col rounded-lg border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {showToolbar && (
        <ChartToolbar
          mode={mode}
          onMode={setMode}
          priceMode={priceMode}
          onPriceMode={setPriceMode}
          tool={tool}
          onTool={setTool}
          canDelete={selectedId != null}
          onDelete={() => selectedId && removeDrawing(selectedId)}
          onReset={() => {
            stopMomentum();
            setViewport(fitViewport(count));
          }}
        />
      )}

      <div ref={surfaceRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0" aria-hidden />

        {showReadout && readoutBar && (
          <Readout
            symbol={symbol}
            bar={readoutBar}
            previous={previousBar}
            format={geometry.format}
            live={crosshair != null}
          />
        )}

        <svg
          ref={svgRef}
          className="absolute inset-0 h-full w-full touch-none select-none"
          style={{ cursor: tool === 'cursor' ? 'crosshair' : 'copy' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onPointerLeave={() => {
            // A captured pointer still reports leave events; clearing the
            // readout mid-drag would blank the figures the drag is aiming at.
            if (!dragRef.current) setCrosshair(null);
          }}
          onDoubleClick={(e) => {
            const p = localPoint(e);
            const hit = hitTestAll(drawings, p, projector, plot, HIT_TOLERANCE);
            if (hit?.drawing.kind === 'note') {
              setSelectedId(hit.drawing.id);
              setEditingNoteId(hit.drawing.id);
              return;
            }
            stopMomentum();
            setViewport(fitViewport(count));
          }}
        >
          {crosshair && (
            <rect
              x={timeScale.toX(crosshair.index)}
              y={plot.y}
              width={Math.max(timeScale.pxPerBar, 1)}
              height={layout.timeAxis.y - plot.y}
              fill="hsl(var(--foreground))"
              opacity={0.05}
            />
          )}

          <DrawingLayer
            drawings={drawings}
            draft={draft}
            selectedId={selectedId}
            projector={projector}
            plot={plot}
            editingNoteId={editingNoteId}
            format={geometry.format}
          />

          <EventMarkers
            events={events}
            dates={dates}
            timeScale={timeScale}
            axis={layout.timeAxis}
            plotWidth={layout.plotWidth}
            hovered={hoveredEvent}
            onHover={setHoveredEvent}
          />

          {crosshair && crosshairPrice != null && (
            <CrosshairLayer
              crosshair={crosshair}
              label={geometry.format(crosshairPrice)}
              date={dates[crosshair.index]}
              layout={layout}
            />
          )}
        </svg>

        {editingNoteId && (
          <NoteEditor
            drawing={drawings.find((d) => d.id === editingNoteId)}
            projector={projector}
            onChange={(text) =>
              updateDrawing(editingNoteId, (d) => (d.kind === 'note' ? { ...d, text } : d))
            }
            onCommit={() => {
              const note = drawings.find((d) => d.id === editingNoteId);
              if (note?.kind === 'note' && !note.text.trim()) removeDrawing(editingNoteId);
              setEditingNoteId(null);
              containerRef.current?.focus({ preventScroll: true });
            }}
          />
        )}

        {hoveredEvent != null && events[hoveredEvent] && (
          <EventDetail
            event={events[hoveredEvent]}
            x={timeScale.centerX(dates.indexOf(events[hoveredEvent].date))}
            y={layout.timeAxis.y}
            plotWidth={layout.plotWidth}
          />
        )}
      </div>
    </div>
  );
}

/* ================================================================ chrome === */

function ChartToolbar({
  mode,
  onMode,
  priceMode,
  onPriceMode,
  tool,
  onTool,
  canDelete,
  onDelete,
  onReset,
}: {
  mode: ChartMode;
  onMode: (m: ChartMode) => void;
  priceMode: PriceScaleMode;
  onPriceMode: (m: PriceScaleMode) => void;
  tool: DrawingTool;
  onTool: (t: DrawingTool) => void;
  canDelete: boolean;
  onDelete: () => void;
  onReset: () => void;
}) {
  const modes: Array<{ value: ChartMode; icon: React.ReactNode; label: string }> = [
    { value: 'candlestick', icon: <CandlestickChart />, label: 'Candlesticks' },
    { value: 'line', icon: <LineChart />, label: 'Line' },
    { value: 'area', icon: <AreaChart />, label: 'Area' },
  ];
  const tools: Array<{ value: DrawingTool; icon: React.ReactNode; label: string }> = [
    { value: 'cursor', icon: <MousePointer2 />, label: 'Select' },
    { value: 'trendline', icon: <TrendingUp />, label: 'Trendline' },
    { value: 'horizontal', icon: <Minus />, label: 'Price level' },
    { value: 'rect', icon: <Square />, label: 'Zone' },
    { value: 'note', icon: <Type />, label: 'Note' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-2 py-1.5">
      <Segmented>
        {modes.map((m) => (
          <IconToggle
            key={m.value}
            active={mode === m.value}
            label={m.label}
            onClick={() => onMode(m.value)}
          >
            {m.icon}
          </IconToggle>
        ))}
      </Segmented>

      <Segmented>
        {tools.map((t) => (
          <IconToggle
            key={t.value}
            active={tool === t.value}
            label={t.label}
            onClick={() => onTool(t.value)}
          >
            {t.icon}
          </IconToggle>
        ))}
      </Segmented>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-2xs font-medium uppercase tracking-wide"
          aria-pressed={priceMode === 'log'}
          onClick={() => onPriceMode(priceMode === 'log' ? 'linear' : 'log')}
          title="Toggle logarithmic price axis"
        >
          {priceMode === 'log' ? 'Log' : 'Linear'}
        </Button>
        <IconToggle active={false} label="Reset zoom" onClick={onReset}>
          <Maximize2 />
        </IconToggle>
        <IconToggle
          active={false}
          label="Delete selected drawing"
          onClick={onDelete}
          disabled={!canDelete}
        >
          <Trash2 />
        </IconToggle>
      </div>
    </div>
  );
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/50 bg-muted/40 p-0.5">
      {children}
    </div>
  );
}

function IconToggle({
  active,
  label,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded transition-colors [&_svg]:size-3.5',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/**
 * The OHLCV legend.
 *
 * Deliberately not the shared `Stat` strip: this is chart chrome floating over
 * the surface, and a tile strip here would cover the candles it describes. The
 * type scale is still the house one — 11px uppercase labels, monospace figures.
 */
function Readout({
  symbol,
  bar,
  previous,
  format,
  live,
}: {
  symbol?: string;
  bar: Bar;
  previous: Bar | null;
  format: (v: number) => string;
  live: boolean;
}) {
  const change = previous ? bar.close - previous.close : bar.close - bar.open;
  const changePct = previous && previous.close !== 0 ? change / previous.close : null;
  const up = change >= 0;

  return (
    <div className="pointer-events-none absolute left-2.5 top-2 z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-2xs">
      {symbol && <span className="font-semibold tracking-tight text-foreground">{symbol}</span>}
      <span className="numeric text-muted-foreground">{bar.date}</span>
      {(['open', 'high', 'low', 'close'] as const).map((key) => (
        <span key={key} className="flex items-baseline gap-1">
          <span className="font-medium uppercase tracking-wide text-muted-foreground">
            {key[0]}
          </span>
          <span className={cn('numeric font-medium', up ? 'text-positive' : 'text-negative')}>
            {format(bar[key])}
          </span>
        </span>
      ))}
      <span className="flex items-baseline gap-1">
        <span className="font-medium uppercase tracking-wide text-muted-foreground">Vol</span>
        <span className="numeric text-foreground">{formatVolume(bar.volume)}</span>
      </span>
      {changePct != null && (
        <span className={cn('numeric font-medium', up ? 'text-positive' : 'text-negative')}>
          {up ? '+' : ''}
          {(changePct * 100).toFixed(2)}%
        </span>
      )}
      {/* Says whether these figures are the bar under the cursor or the latest
          one — without it the legend silently changes meaning on hover. */}
      <span className="uppercase tracking-wide text-muted-foreground">
        {live ? 'at cursor' : 'latest'}
      </span>
    </div>
  );
}

/* ============================================================= crosshair === */

function CrosshairLayer({
  crosshair,
  label,
  date,
  layout,
}: {
  crosshair: Crosshair;
  label: string;
  date: string;
  layout: PaneLayout;
}) {
  const x = Math.round(crosshair.x) + 0.5;
  const y = Math.round(crosshair.y) + 0.5;
  const inPlot = crosshair.y < layout.timeAxis.y;
  const dateWidth = date.length * 6.6 + 12;

  return (
    <g pointerEvents="none">
      <line
        x1={x}
        y1={0}
        x2={x}
        y2={layout.timeAxis.y}
        stroke="hsl(var(--muted-foreground))"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.85}
      />
      {inPlot && (
        <line
          x1={0}
          y1={y}
          x2={layout.plotWidth}
          y2={y}
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.85}
        />
      )}
      {inPlot && (
        <>
          <rect
            x={layout.plotWidth + 1}
            y={y - 8}
            width={layout.gutter - 2}
            height={16}
            rx={2}
            fill="hsl(var(--foreground))"
          />
          <text
            x={layout.plotWidth + 5}
            y={y + 4}
            fontSize={11}
            fontFamily="var(--font-mono)"
            fill="hsl(var(--background))"
          >
            {label}
          </text>
        </>
      )}
      <rect
        x={Math.max(0, x - dateWidth / 2)}
        y={layout.timeAxis.y + 2}
        width={dateWidth}
        height={16}
        rx={2}
        fill="hsl(var(--foreground))"
      />
      <text
        x={Math.max(dateWidth / 2, x)}
        y={layout.timeAxis.y + 14}
        fontSize={11}
        fontFamily="var(--font-mono)"
        textAnchor="middle"
        fill="hsl(var(--background))"
      >
        {date}
      </text>
    </g>
  );
}

/* ============================================================== drawings === */

/**
 * Tone → token. Stored as a name so a drawing made under one theme is legible
 * under all four; the browser resolves the variable at paint time.
 */
const TONE_STROKE: Record<DrawingTone, string> = {
  default: 'hsl(var(--primary))',
  accent: 'hsl(var(--warning))',
  positive: 'hsl(var(--positive))',
  negative: 'hsl(var(--negative))',
};

function DrawingLayer({
  drawings,
  draft,
  selectedId,
  projector,
  plot,
  editingNoteId,
  format,
}: {
  drawings: Drawing[];
  draft: Draft | null;
  selectedId: string | null;
  projector: Projector;
  plot: Rect;
  editingNoteId: string | null;
  format: (v: number) => string;
}) {
  const preview: Drawing | null = draft
    ? createDrawing(draft.kind, draft.from, draft.to, { id: '__draft__' })
    : null;

  return (
    <g pointerEvents="none">
      {drawings.map((d) => (
        <DrawingShape
          key={d.id}
          drawing={d}
          projector={projector}
          plot={plot}
          format={format}
          selected={d.id === selectedId}
          hidden={d.id === editingNoteId}
        />
      ))}
      {preview && (
        <DrawingShape
          drawing={preview}
          projector={projector}
          plot={plot}
          format={format}
          selected={false}
          preview
        />
      )}
    </g>
  );
}

function DrawingShape({
  drawing,
  projector,
  plot,
  selected,
  preview,
  hidden,
  format,
}: {
  drawing: Drawing;
  projector: Projector;
  plot: Rect;
  selected: boolean;
  preview?: boolean;
  hidden?: boolean;
  format: (v: number) => string;
}) {
  const stroke = TONE_STROKE[drawing.tone ?? 'default'];
  const dash = preview ? '4 3' : undefined;
  const opacity = preview ? 0.75 : 1;
  const width = selected ? 2 : 1.5;
  if (hidden) return null;

  let body: React.ReactNode = null;
  switch (drawing.kind) {
    case 'trendline': {
      const a = projector.toPoint(drawing.a);
      const b = projector.toPoint(drawing.b);
      const [p1, p2] = drawing.extend ? extendToPlot(a, b, plot) : [a, b];
      body = (
        <line
          x1={p1.x}
          y1={p1.y}
          x2={p2.x}
          y2={p2.y}
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      );
      break;
    }
    case 'horizontal': {
      const y = projector.toPoint({ t: 0, p: drawing.p }).y;
      body = (
        <>
          <line
            x1={plot.x}
            y1={y}
            x2={plot.x + plot.width}
            y2={y}
            stroke={stroke}
            strokeWidth={width}
            strokeDasharray={dash ?? '6 3'}
          />
          <text
            x={plot.x + plot.width - 4}
            y={y - 4}
            fontSize={11}
            fontFamily="var(--font-mono)"
            textAnchor="end"
            fill={stroke}
          >
            {format(drawing.p)}
          </text>
        </>
      );
      break;
    }
    case 'rect': {
      const r = rectOf(projector.toPoint(drawing.a), projector.toPoint(drawing.b));
      body = (
        <rect
          x={r.x}
          y={r.y}
          width={r.width}
          height={r.height}
          fill={stroke}
          fillOpacity={0.1}
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={dash}
        />
      );
      break;
    }
    case 'note': {
      const box = noteBox(drawing, projector);
      const lines = (drawing.text || '').split('\n');
      body = (
        <>
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx={3}
            fill="hsl(var(--popover))"
            stroke={stroke}
            strokeWidth={1}
            fillOpacity={0.94}
          />
          {lines.map((line, i) => (
            <text
              key={i}
              x={box.x + NOTE_METRICS.paddingX}
              y={box.y + NOTE_METRICS.paddingY + (i + 0.78) * NOTE_METRICS.lineHeight}
              fontSize={11}
              fontFamily="var(--font-mono)"
              fill="hsl(var(--popover-foreground))"
            >
              {line}
            </text>
          ))}
          <circle cx={box.x} cy={box.y + box.height} r={2.5} fill={stroke} />
        </>
      );
      break;
    }
  }

  return (
    <g opacity={opacity}>
      {body}
      {selected &&
        handlesOf(drawing, projector, plot).map((h) => (
          <circle
            key={h.role}
            cx={h.x}
            cy={h.y}
            r={4}
            fill="hsl(var(--card))"
            stroke={stroke}
            strokeWidth={1.75}
          />
        ))}
    </g>
  );
}

function NoteEditor({
  drawing,
  projector,
  onChange,
  onCommit,
}: {
  drawing: Drawing | undefined;
  projector: Projector;
  onChange: (text: string) => void;
  onCommit: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);
  if (!drawing || drawing.kind !== 'note') return null;
  const at = projector.toPoint(drawing.at);
  return (
    <input
      ref={inputRef}
      value={drawing.text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCommit();
        }
      }}
      placeholder="Note"
      aria-label="Note text"
      className="numeric absolute z-20 rounded border border-primary bg-popover px-1.5 py-0.5 text-xs text-popover-foreground outline-none"
      style={{
        left: at.x,
        top: at.y - 24,
        width: Math.max(120, drawing.text.length * NOTE_METRICS.charWidth + 28),
      }}
    />
  );
}

/* ================================================================ events === */

const EVENT_STROKE: Record<ChartEvent['kind'], string> = {
  dividend: 'hsl(var(--positive))',
  split: 'hsl(var(--primary))',
  earnings: 'hsl(var(--warning))',
  'ticker-change': 'hsl(var(--muted-foreground))',
};

const EVENT_GLYPH: Record<ChartEvent['kind'], string> = {
  dividend: 'D',
  split: 'S',
  earnings: 'E',
  'ticker-change': 'T',
};

/**
 * Event markers sit in the time-axis strip rather than on the candles, so a
 * dense earnings history does not obscure the price it is meant to explain.
 * They are SVG because they are hovered; only ones actually on screen are
 * rendered, which keeps a 20-year dividend record cheap.
 */
function EventMarkers({
  events,
  dates,
  timeScale,
  axis,
  plotWidth,
  hovered,
  onHover,
}: {
  events: ChartEvent[];
  dates: string[];
  timeScale: TimeScale;
  axis: Rect;
  plotWidth: number;
  hovered: number | null;
  onHover: (index: number | null) => void;
}) {
  const positions = React.useMemo(() => {
    const byDate = new Map<string, number>();
    dates.forEach((d, i) => byDate.set(d, i));
    return events.map((e) => byDate.get(e.date) ?? -1);
  }, [events, dates]);

  return (
    <g>
      {events.map((event, i) => {
        const index = positions[i];
        if (index < 0) return null;
        const x = timeScale.centerX(index);
        if (x < 0 || x > plotWidth) return null;
        const stroke = EVENT_STROKE[event.kind];
        const active = hovered === i;
        return (
          <g
            key={`${event.date}-${event.kind}-${i}`}
            onPointerEnter={() => onHover(i)}
            onPointerLeave={() => onHover(null)}
            style={{ cursor: 'help' }}
          >
            <rect x={x - 7} y={axis.y} width={14} height={axis.height} fill="transparent" />
            <circle
              cx={x}
              cy={axis.y + axis.height / 2}
              r={active ? 7 : 6}
              fill="hsl(var(--card))"
              stroke={stroke}
              strokeWidth={active ? 1.75 : 1.25}
            />
            <text
              x={x}
              y={axis.y + axis.height / 2 + 3.5}
              fontSize={9}
              fontFamily="var(--font-mono)"
              textAnchor="middle"
              fill={stroke}
              pointerEvents="none"
            >
              {EVENT_GLYPH[event.kind]}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function EventDetail({
  event,
  x,
  y,
  plotWidth,
}: {
  event: ChartEvent;
  x: number;
  y: number;
  plotWidth: number;
}) {
  const width = 190;
  const left = Math.max(4, Math.min(x - width / 2, plotWidth - width - 4));
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-md border border-border bg-popover p-2 shadow-lg"
      style={{ left, top: Math.max(4, y - 62), width }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {event.kind.replace('-', ' ')}
        </span>
        <span className="numeric text-2xs text-muted-foreground">{event.date}</span>
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-popover-foreground">{event.label}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Re-exported so a caller can persist annotations without reaching into the
 * geometry module. `serializeDrawings` / `parseDrawings` round-trip through
 * JSON in chart coordinates, which is what makes a saved layout portable
 * between sessions, screens and data ranges.
 * ------------------------------------------------------------------------- */
export { serializeDrawings, parseDrawings, describeDrawing } from './drawings';
export { fitViewport, clampViewport } from './interactions';
