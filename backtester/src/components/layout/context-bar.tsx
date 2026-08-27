'use client';

import Link from 'next/link';
import { ArrowRight, Briefcase, CalendarRange } from 'lucide-react';
import { useWorkspace } from '@/store/workspace';
import { useHydrated } from '@/hooks/use-hydrated';
import { cn } from '@/lib/utils';

/**
 * What every analysis surface is looking at.
 *
 * Studies, the Simulator and the Lab all operate on "the portfolio currently
 * loaded", which was stated nowhere. Arriving on one of them, you could not
 * tell which allocation or which window you were about to reason about without
 * navigating back to the Backtest page and losing your place.
 *
 * Naming it in one line, in the same place on each page, is most of what makes
 * these read as one workspace rather than four tools that happen to share a
 * sidebar.
 */
export function ContextBar({ className }: { className?: string }) {
  const hydrated = useHydrated();
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);

  // Rendering the placeholder before hydration keeps the height stable, so the
  // page does not jump once the store loads.
  const holdings = hydrated ? draft.positions.filter((p) => p.symbol.trim()) : [];
  const summary = holdings
    .slice(0, 4)
    .map((p) => `${p.symbol.toUpperCase()} ${Math.round(Number(p.weight) || 0)}%`)
    .join(' · ');
  const more = holdings.length > 4 ? ` +${holdings.length - 4}` : '';

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-xs sm:px-6 lg:px-8',
        className,
      )}
    >
      <span className="flex items-center gap-1.5 font-medium">
        <Briefcase className="h-3.5 w-3.5 text-primary" />
        {hydrated ? draft.name || 'Untitled' : '—'}
      </span>

      {holdings.length > 0 && (
        <span className="numeric truncate text-muted-foreground">
          {summary}
          {more}
        </span>
      )}

      <span className="flex items-center gap-1.5 text-muted-foreground">
        <CalendarRange className="h-3.5 w-3.5" />
        <span className="numeric">
          {hydrated ? `${config.start} → ${config.end}` : '—'}
        </span>
      </span>

      <Link
        href="/backtest"
        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Change
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
