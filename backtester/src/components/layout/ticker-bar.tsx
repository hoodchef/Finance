'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Crosshair, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TICKER_LENSES } from './nav';
import { useActiveTicker, useRecentTickers, useTickerStore } from '@/store/ticker';
import { cn } from '@/lib/utils';

/**
 * The security in focus, and the lenses you can look at it through.
 * =============================================================================
 * This is the spine of the platform. Four pages answer four different questions
 * about one company — what its price did, what it reported, what its options
 * cost, what holding it would have returned — and until now each of them asked
 * you to name the company again, in its own box, as though the previous page
 * had never happened.
 *
 * So the bar is built around one claim: **the subject is fixed and the view is
 * what changes.** The symbol sits on the left, stated once and not repeated on
 * the page below. To its right the four views are a segmented strip, with the
 * one you are in filled — the shape of a control that switches between views of
 * the same thing, not of a trail showing how you arrived.
 *
 * That is also why the strip is not a breadcrumb. A breadcrumb describes a path
 * through a hierarchy and is read backwards; there is no hierarchy here. These
 * four are peers, all equally about AAPL, and the honest picture is a row of
 * lenses with the current one lit.
 *
 * Two smaller decisions follow from the same idea:
 *
 *  - The symbol itself is the switcher. Changing the subject keeps the lens —
 *    pick MSFT while on Options and you stay on Options, now about MSFT. The
 *    two axes stay independent, which is what makes this feel like one
 *    instrument rather than a set of pages.
 *  - The destinations are `TICKER_LENSES` from the navigation itself, not a
 *    private list, so the bar cannot drift into calling a page something the
 *    menus do not, and cannot outlive a route that was removed.
 */

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function TickerBar() {
  const pathname = usePathname();
  const focus = useActiveTicker();
  const recent = useRecentTickers();
  const setTicker = useTickerStore((s) => s.setTicker);
  const clearTicker = useTickerStore((s) => s.clearTicker);

  // Nothing in focus, nothing to say. The bar appears when it has a subject and
  // is absent otherwise, rather than sitting there empty asking to be filled —
  // an empty strip on every page would cost the same 36px and answer nothing.
  if (!focus) return null;

  const { symbol, name } = focus;

  return (
    <div
      role="region"
      aria-label={`${symbol} in focus`}
      /*
       * Sticky under the 3rem nav bar: the subject you are studying should not
       * scroll away from you halfway down a filings table.
       *
       * Same near-opaque card fill as the nav, not the lighter `bg-muted/40`
       * the in-page `ContextBar` uses. A sticky element at 40% opacity has the
       * page's own text sliding visibly through it, and in the light theme
       * `--muted` over `--card` is nearly no band at all — the hairline and the
       * smaller type do that work instead.
       */
      className="sticky top-12 z-20 flex min-h-9 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur sm:px-4"
    >
      {/* The subject, and the control that changes it. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Switch security — ${symbol} is in focus`}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 transition-colors',
            'hover:bg-accent data-[state=open]:bg-accent',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <Crosshair className="h-3.5 w-3.5 text-primary" />
          <span className="numeric text-sm font-semibold leading-none">{symbol}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Recently in focus</DropdownMenuLabel>
          {recent.length <= 1 && (
            <p className="px-2 pb-1.5 pt-0.5 text-xs leading-relaxed text-muted-foreground">
              Securities you look up appear here, so you can flick between them
              without searching again.
            </p>
          )}
          {recent.map((t) => {
            const current = t.symbol === symbol;
            return (
              <DropdownMenuItem
                key={t.symbol}
                onSelect={() => setTicker(t.symbol, t.name)}
                className={cn('gap-2', current && 'bg-secondary')}
              >
                <span
                  className={cn(
                    'numeric w-14 shrink-0 text-xs',
                    current ? 'font-semibold text-primary' : 'font-medium',
                  )}
                >
                  {t.symbol}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {t.name === t.symbol ? '' : t.name}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Stated once, here, instead of in four page headers. */}
      {name !== symbol && (
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
          {name}
        </span>
      )}

      <nav
        aria-label={`Views of ${symbol}`}
        className="ml-auto flex shrink-0 items-center gap-0.5 overflow-x-auto"
      >
        {TICKER_LENSES.map((lens) => {
          const active = isActive(pathname, lens.href);
          const Icon = lens.icon;
          return (
            <Link
              key={lens.href}
              href={lens.href}
              aria-current={active ? 'page' : undefined}
              title={`${lens.label} — ${lens.hint}`}
              className={cn(
                'flex items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors sm:px-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-primary/12 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {/* The label is the target on a phone too — it is just narrower
                  there, so it hides and the icon plus its title carries it. */}
              <span className="hidden md:inline">{lens.label}</span>
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={clearTicker}
        aria-label={`Clear ${symbol} from focus`}
        className={cn(
          'ml-0.5 flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
