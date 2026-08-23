import * as React from 'react';
import { cn } from '@/lib/utils';
import { InfoTip } from './tooltip';

/**
 * The KPI tile used across the dashboards. `tone` colours the value by sign so
 * a page of figures can be read at a glance without reading each number.
 */
export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  hint,
  className,
  size = 'default',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'negative';
  hint?: React.ReactNode;
  className?: string;
  size?: 'default' | 'lg';
}) {
  return (
    <div className={cn('flex flex-col gap-1 p-4', className)}>
      <div className="flex items-center gap-1.5">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {hint && <InfoTip label={`About ${label}`}>{hint}</InfoTip>}
      </div>
      <span
        className={cn(
          'numeric font-semibold leading-tight',
          size === 'lg' ? 'text-2xl' : 'text-lg',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
        )}
      >
        {value}
      </span>
      {sub && <span className="text-2xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function toneOf(v: number | null | undefined): 'neutral' | 'positive' | 'negative' {
  if (v == null || !Number.isFinite(v) || v === 0) return 'neutral';
  return v > 0 ? 'positive' : 'negative';
}
