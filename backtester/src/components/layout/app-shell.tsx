'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MOBILE_NAV } from './nav';
import { NavBar } from './nav-bar';
import { TickerBar } from './ticker-bar';
import { cn } from '@/lib/utils';

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/**
 * The application frame.
 *
 * Navigation is a bar across the top rather than a column down the side. It
 * states the four subjects the product deals in — you, a security, a portfolio,
 * your saved work — and opens the destinations under one on demand, which gives
 * the page back the width the sidebar held.
 *
 * Under it sits the ticker bar: which security is in focus, and the views you
 * can look at it through. It is the other half of the navigation. The top bar
 * answers "where do I go"; the ticker bar answers "what am I looking at", and
 * carries that answer with you when you go. It renders only when something is
 * in focus, so pages that have nothing to do with a single security are not
 * asked to make room for an empty strip.
 *
 * The mobile bottom bar stays. It carries the five destinations that make up
 * the journey end to end, at thumb size, and no dropdown beats that for the
 * routes people take constantly; the bar's own menu covers the other nine.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <NavBar />
      <TickerBar />

      <main className="min-w-0 flex-1 pb-16 lg:pb-0">{children}</main>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Frequent destinations"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {MOBILE_NAV.map(({ href, short, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-0.5 px-1 py-2 text-[10px] transition-colors',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{short}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Consistent page frame: title block plus a max-width content column. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('px-4 py-6 sm:px-6 lg:px-8', className)}>{children}</div>;
}
