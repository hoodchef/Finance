'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Menu, TrendingUp } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NAV_GROUPS, type NavGroup, type NavItem } from './nav';
import { ThemeToggle } from './theme-toggle';
import { cn } from '@/lib/utils';

/**
 * The primary navigation bar.
 *
 * A horizontal bar of four menus rather than a column of fourteen links. The
 * four are the subjects the product deals in — you, one security, one
 * portfolio, your saved work — and the bar states only those, asking for a
 * click to see the destinations under one, where the sidebar had all of them
 * permanently on screen.
 *
 * It also returns the 224px the sidebar occupied to the page. That matters
 * more here than on most products: the reported-history table is 52rem wide
 * before it scrolls, and the earnings and news sections are two-column
 * layouts that only reach their second column on a wide viewport.
 *
 * Radix supplies the menu behaviour — roving focus, typeahead, escape to
 * close, click-outside, and the aria-expanded/aria-haspopup wiring. Hand-built
 * dropdowns almost always miss the keyboard half of that.
 */

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function groupIsActive(pathname: string, group: NavGroup): boolean {
  return group.items.some((i) => isActive(pathname, i.href));
}

/** One menu row: the destination, and the reason to go there. */
function ItemRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <DropdownMenuItem asChild>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex cursor-pointer items-start gap-2.5 px-2 py-1.5',
          active && 'bg-secondary',
        )}
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', active && 'text-primary')} />
        <span className="min-w-0">
          <span className={cn('block truncate text-sm', active && 'font-medium')}>
            {item.label}
          </span>
          <span className="block truncate text-2xs text-muted-foreground">{item.hint}</span>
        </span>
      </Link>
    </DropdownMenuItem>
  );
}

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
      <div className="flex h-12 items-center gap-1 px-3 sm:px-4">
        <Link href="/" className="mr-1 flex items-center gap-2 rounded px-1 py-1">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-primary/12 text-primary">
            <TrendingUp className="h-3.5 w-3.5" />
          </div>
          <span className="text-sm font-semibold">CanPath</span>
        </Link>

        {/* Desktop: one menu per group. */}
        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Primary">
          {NAV_GROUPS.map((group) => {
            const active = groupIsActive(pathname, group);
            return (
              <DropdownMenu key={group.id}>
                <DropdownMenuTrigger
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'data-[state=open]:bg-accent',
                    active
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {group.label}
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  {group.items.map((item) => (
                    <ItemRow key={item.href} item={item} active={isActive(pathname, item.href)} />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />

          {/*
           * Mobile: every destination in one menu.
           *
           * The bottom bar carries five of the fourteen, which is the right
           * number for a thumb-sized bar and leaves nine — Research and
           * Settings among them — with no route to them at all on a phone.
           */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="All sections"
              className={cn(
                'flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors lg:hidden',
                'hover:bg-accent hover:text-foreground data-[state=open]:bg-accent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <Menu className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[80dvh] w-64 overflow-y-auto">
              {NAV_GROUPS.map((group, i) => (
                <div key={group.id}>
                  {i > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-2xs uppercase tracking-wider text-muted-foreground/70">
                    {group.label}
                  </DropdownMenuLabel>
                  {group.items.map((item) => (
                    <ItemRow key={item.href} item={item} active={isActive(pathname, item.href)} />
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
