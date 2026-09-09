'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/format';

/** Shared axis/grid styling so every chart in the product reads as one system. */
export const AXIS_PROPS = {
  stroke: 'hsl(var(--muted-foreground))',
  tick: { fontSize: 11, fill: 'hsl(var(--muted-foreground))' },
  tickLine: false,
  axisLine: false,
} as const;

export const GRID_PROPS = {
  stroke: 'hsl(var(--grid))',
  strokeDasharray: '0',
  vertical: false,
} as const;

/**
 * The hairline a Recharts tooltip drops at the hovered category.
 *
 * Spelled once because it is the thing that makes a tooltip read as a
 * measurement rather than a floating box: without it the reader has to guess
 * which bar the numbers belong to, and on a 63-bar chart that guess is wrong
 * about as often as it is right.
 */
export const CURSOR_PROPS = {
  stroke: 'hsl(var(--muted-foreground))',
  strokeDasharray: '3 3',
} as const;

/**
 * The rendered width of an element, for drawings that must REFLOW.
 * =============================================================================
 * `viewBox` alone only ever scales: a 460-wide drawing in a 1100px column is
 * drawn at 460 and centred, leaving two thirds of the panel empty, and the same
 * drawing on a phone is either squeezed to illegibility or put behind a
 * horizontal scrollbar. Both happened on this page.
 *
 * Measuring instead lets the SVG use a 1:1 pixel viewBox, so the geometry
 * spreads into the space it has and — the part scaling cannot do — 9px labels
 * stay 9px at every width.
 *
 * Returns 0 before the first measurement, which callers must treat as "do not
 * draw yet" rather than as a width.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Rounded to whole pixels: a fractional width from a flex parent otherwise
    // oscillates by hundredths and re-renders the drawing on every frame.
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    setWidth(Math.round(node.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
  muted?: boolean;
}

/**
 * One tooltip shell for every chart. Recharts' default is a white box that
 * ignores the theme, so all charts pass their rows through here instead.
 */
export function ChartTooltip({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: TooltipRow[];
  footer?: React.ReactNode;
}) {
  return (
    <div className="pointer-events-none min-w-[11rem] rounded-md border border-border bg-popover/98 p-2.5 text-xs shadow-lg backdrop-blur">
      <div className="mb-1.5 font-medium">{title}</div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-1.5">
              {r.color && (
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: r.color }}
                />
              )}
              <span className={cn('truncate', r.muted && 'text-muted-foreground')}>{r.label}</span>
            </span>
            <span className="numeric shrink-0 font-medium">{r.value}</span>
          </div>
        ))}
      </div>
      {footer && (
        <div className="mt-1.5 border-t border-border pt-1.5 text-2xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

export function tooltipDate(value: unknown): string {
  return typeof value === 'string' ? formatDate(value) : String(value ?? '');
}

/** Compact axis ticks: `Jan 20` for dense ranges, `2020` when zoomed out. */
export function makeDateTickFormatter(spanDays: number) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (iso: string) => {
    if (typeof iso !== 'string' || iso.length < 7) return String(iso ?? '');
    const y = iso.slice(0, 4);
    const m = Number(iso.slice(5, 7)) - 1;
    if (spanDays > 365 * 6) return y;
    if (spanDays > 400) return `${months[m]} ${y.slice(2)}`;
    return `${months[m]} ${iso.slice(8, 10)}`;
  };
}

/**
 * Explicit tick positions, one per calendar bucket.
 *
 * Letting Recharts pick ticks off a category axis produces repeated labels
 * ("2017 2017 2018 …") because the chart series is downsampled to two points
 * per bucket. Choosing the first date in each year or month instead guarantees
 * one label per period, in the right place.
 */
export function makeDateTicks(dates: string[], maxTicks = 9): string[] {
  if (dates.length === 0) return [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  const spanDays =
    (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000;

  const width = spanDays > 365 * 6 ? 4 : 7; // `YYYY` or `YYYY-MM`
  const firstOfBucket = new Map<string, string>();
  for (const d of dates) {
    const key = d.slice(0, width);
    if (!firstOfBucket.has(key)) firstOfBucket.set(key, d);
  }

  let ticks = [...firstOfBucket.values()];
  if (ticks.length > maxTicks) {
    const stride = Math.ceil(ticks.length / maxTicks);
    ticks = ticks.filter((_, i) => i % stride === 0);
  }
  return ticks;
}

/** A legend whose entries toggle their series on and off. */
export function SeriesToggles({
  series,
  hidden,
  onToggle,
  className,
}: {
  series: Array<{ key: string; label: string; color: string }>;
  hidden: Set<string>;
  onToggle: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
      {series.map((s) => {
        const off = hidden.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={!off}
            onClick={() => onToggle(s.key)}
            className={cn(
              'flex items-center gap-1.5 rounded text-xs transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              off ? 'opacity-40' : 'opacity-100',
            )}
          >
            <span
              aria-hidden
              className="h-2 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className={cn(off && 'line-through')}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ChartFrame({
  title,
  description,
  actions,
  children,
  footer,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('rounded-lg border border-border bg-card', className)}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 p-4 pb-2 sm:p-5 sm:pb-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="px-1 pb-3 sm:px-2">{children}</div>
      {footer && (
        <footer className="border-t border-border px-4 py-2.5 text-2xs text-muted-foreground sm:px-5">
          {footer}
        </footer>
      )}
    </section>
  );
}

/**
 * A static key for a chart's series.
 * =============================================================================
 * `SeriesToggles` is the interactive version, for charts where hiding a series
 * is useful. Most charts just need to say which colour is which — and until
 * now several did not say at all. "Cash generation" drew two bar series, one
 * blue and one green, with nothing on the page naming either: the only way to
 * learn that green was free cash flow was to hover a bar.
 */
export function ChartLegend({
  series,
  className,
}: {
  series: Array<{ label: string; color: string; dashed?: boolean }>;
  className?: string;
}) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3.5 gap-y-1', className)}>
      {series.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span
            aria-hidden
            className={cn('h-2 w-2.5 shrink-0 rounded-sm', s.dashed && 'h-0.5 w-3.5 rounded-none')}
            style={{ backgroundColor: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Prints each bar's value as text, just past the end of the bar.
 * =============================================================================
 * A bar chart encodes magnitude as length, which stops working the moment one
 * category dwarfs the rest. AST SpaceMobile's 2025 free cash flow is −$1.15bn
 * against an operating cash flow of −$40m five years earlier; drawn honestly on
 * one axis, five of the six years collapse into a few pixels above the zero
 * line and cannot be read at all.
 *
 * The fix is NOT to rescale. Clipping the outlier, or forcing a minimum bar
 * height, would make the chart easier to look at by making it lie about the
 * thing it exists to show. The axis stays honest and the number is printed
 * instead, so a bar too small to measure can still be read.
 *
 * Labels sit ABOVE a positive bar and BELOW a negative one, so they never sit
 * on top of the bar they describe.
 *
 * When the category is too narrow for the text to fit across it, the label
 * TURNS rather than disappearing. Twelve years of two series puts the bars at
 * 19px while "$117B" needs about thirty, and dropping the label there would
 * quietly withhold the number from exactly the chart that most needs it
 * printed. Rotated, it reads up the side of its own bar and never collides
 * with its neighbour.
 */
export function barValueLabel(format: (v: number) => string, minWidth = 30) {
  return function BarValueLabel(props: {
    x?: number | string;
    y?: number | string;
    width?: number | string;
    value?: number | string;
  }) {
    const x = Number(props.x);
    const y = Number(props.y);
    const width = Number(props.width);
    const value = Number(props.value);

    if (!Number.isFinite(value) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!Number.isFinite(width)) return null;

    /*
     * `y` is the bar's FAR end — the one away from the axis — whichever way the
     * bar points, so the height is not needed and must not be used.
     *
     * Recharts reports a bar below zero as `y` at its bottom with a NEGATIVE
     * height (y=45.4, height=−3.4 for −$23m), not as `y` at the zero line with
     * a positive one. Adding the two therefore lands back on the zero line, and
     * every label on a negative series pinned to the axis instead of following
     * its bar: on AST SpaceMobile the −$300m label sat inside the bar while the
     * −$23m label sat clear of it, at the same height.
     */
    const below = value < 0;
    const edge = y;
    const cx = x + width / 2;
    const text = format(value);

    const common = {
      fontSize: 10,
      fill: 'hsl(var(--muted-foreground))',
      style: { pointerEvents: 'none' as const },
    };

    // Wide enough to read straight across the bar.
    if (width >= minWidth) {
      return (
        <text x={cx} y={edge + (below ? 11 : -5)} textAnchor="middle" {...common}>
          {text}
        </text>
      );
    }

    /*
     * Narrow: turn the label a quarter turn so it runs along the bar.
     *
     * Rotating about the bar's own end keeps it anchored there. `start` grows
     * the text away from the axis for a bar above zero; `end` grows it the
     * other way for one below, so both read outward from the bar they belong
     * to rather than back across it.
     */
    const anchorY = edge + (below ? 4 : -4);
    return (
      <text
        x={cx}
        y={anchorY}
        textAnchor={below ? 'end' : 'start'}
        transform={`rotate(-90, ${cx}, ${anchorY})`}
        {...common}
      >
        {text}
      </text>
    );
  };
}
