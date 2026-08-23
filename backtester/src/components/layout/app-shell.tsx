'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TrendingUp } from 'lucide-react';
import { NAV_ITEMS } from './nav';
import { ThemeToggle } from './theme-toggle';
import { cn } from '@/lib/utils';

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 z-30 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/12 text-primary">
            <TrendingUp className="h-4 w-4" />
          </div>
          <div className="leading-none">
            <div className="text-sm font-semibold">Backtester</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">Portfolio analytics</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className={cn('h-4 w-4', active && 'text-primary')} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-3">
          <ThemeToggle />
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Backtester</span>
        </Link>
        <ThemeToggle />
      </header>

      <main className="min-w-0 flex-1 pb-16 lg:pb-0">{children}</main>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-7 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV_ITEMS.map(({ href, short, icon: Icon }) => {
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
