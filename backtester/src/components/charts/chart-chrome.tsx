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
