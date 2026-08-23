'use client';

import * as React from 'react';
import { Skeleton } from '@/components/ui/skeleton';

const STAGES = [
  'Loading price history…',
  'Aligning trading calendars…',
  'Walking the portfolio day by day…',
  'Computing risk statistics…',
];

/**
 * The results skeleton. It mirrors the real layout so the page does not jump
 * when the data lands, and it advances through the actual stages of the run so
 * a slow first fetch does not look like a hang.
 */
export function ResultsSkeleton() {
  const [stage, setStage] = React.useState(0);

  React.useEffect(() => {
    const t = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 900);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {STAGES[stage]}
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="space-y-2 bg-card p-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-2 w-20" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-4 h-[22rem] w-full" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-40 w-full" />
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
