'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  ArrowRight,
  CornerDownLeft,
  Clock,
  Search,
  Palette,
  X,
} from 'lucide-react';
import { NAV_GROUPS, TICKER_LENSES } from './nav';
import { useTickerStore } from '@/store/ticker';
import { useHydrated } from '@/hooks/use-hydrated';
import type { SecurityMeta } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The command palette.
 * =============================================================================
 * The one interaction every professional terminal is built around, and the one
 * this product did not have. Looking a security up meant finding the page that
 * owns a search box, clicking into it, and typing — three deliberate acts for
 * the thing people do most.
 *
 * Cmd-K opens it from anywhere. So does `/`, which costs nothing and is what
 * a keyboard-first reader reaches for first. Everything else is one list:
 * symbols, destinations, the securities you looked at recently, and a few
 * actions. No tabs, no modes — you type what you want and press return.
 *
 * The symbol tier is what makes this fast enough to be worth a keystroke.
 * `/api/search` answers from a 13,000-symbol directory held in memory on the
 * server, so results land in a few milliseconds and keep landing while the
 * price providers are rate-limited. The request is debounced and the response
 * is guarded by a sequence number, because a slow answer to "AA" must never
 * overwrite a fast answer to "AAPL".
 */

interface SymbolResult {
  kind: 'symbol';
  symbol: string;
  name: string;
  exchange?: string;
  recent?: boolean;
}

interface RouteResult {
  kind: 'route';
  href: string;
  label: string;
  hint: string;
  group: string;
}

interface ActionResult {
  kind: 'action';
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

type Result = SymbolResult | RouteResult | ActionResult;

const ROUTES: RouteResult[] = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({
    kind: 'route' as const,
    href: i.href,
    label: i.label,
    hint: i.hint,
    group: g.label,
  })),
);

/**
 * Does this destination match what was typed?
 *
 * A plain substring test runs against the label, its hint and its group, so
 * "filings" finds Research. The looser SUBSEQUENCE test — "prf" finding
 * "Performance" the way an editor would — runs against the LABEL ONLY.
 *
 * That split matters more than it looks. Applied to the hint as well, a
 * four-letter subsequence will match almost any sentence: "msft" pulled in
 * Research, because "Company fundamentals from SEC filings" happens to contain
 * an m, an s, an f and a t in that order. Ticker-shaped queries then dragged
 * unrelated pages under the symbol they were actually looking for.
 */
function matches(route: RouteResult, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  if (`${route.label} ${route.hint} ${route.group}`.toLowerCase().includes(n)) return true;
  const label = route.label.toLowerCase();
  let i = 0;
  for (const ch of label) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

export function CommandPalette() {
  const router = useRouter();
  const hydrated = useHydrated();
  const { setTheme } = useTheme();
  const setTicker = useTickerStore((s) => s.setTicker);
  const recent = useTickerStore((s) => s.recent);

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [symbols, setSymbols] = React.useState<SymbolResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [cursor, setCursor] = React.useState(0);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  /**
   * Whether the pointer has actually moved since the palette opened.
   *
   * The dialog appears under wherever the mouse was resting, and the browser
   * fires `mousemove` as the list renders beneath it — so without this, opening
   * with the keyboard highlights whatever row happened to land under a
   * stationary cursor instead of the first result.
   */
  const pointerMoved = React.useRef(false);
  /** Guards against an older response landing after a newer one. */
  const sequence = React.useRef(0);

  /* ---- opening ---------------------------------------------------- */

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // `/` opens too, but only when the reader is not already typing
      // somewhere — otherwise it swallows a slash in a ticker or a note.
      if (event.key === '/' && !meta) {
        const el = document.activeElement;
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable);
        if (typing) return;
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setSymbols([]);
      setCursor(0);
      pointerMoved.current = false;
      // Focus after paint, or the input is not in the document yet.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /* ---- symbol search ------------------------------------------------ */

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setSymbols([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++sequence.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { results?: SecurityMeta[] };
        // A stale answer must not overwrite a fresher one.
        if (seq !== sequence.current) return;
        setSymbols(
          (body.results ?? []).slice(0, 7).map((r) => ({
            kind: 'symbol' as const,
            symbol: r.symbol,
            name: r.name,
            exchange: r.exchange,
          })),
        );
      } catch {
        // Search failing is not worth an error state in a palette; the
        // destinations below still work, which is most of what it is for.
        if (seq === sequence.current) setSymbols([]);
      } finally {
        if (seq === sequence.current) setLoading(false);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [query]);

  /* ---- the one list ------------------------------------------------- */

  const actions: ActionResult[] = React.useMemo(
    () => [
      {
        kind: 'action',
        id: 'theme-dark',
        label: 'Switch to dark',
        hint: 'Theme',
        run: () => setTheme('dark'),
      },
      {
        kind: 'action',
        id: 'theme-terminal',
        label: 'Switch to terminal',
        hint: 'Theme',
        run: () => setTheme('terminal'),
      },
      {
        kind: 'action',
        id: 'theme-bloomberg',
        label: 'Switch to bloomberg',
        hint: 'Theme',
        run: () => setTheme('bloomberg'),
      },
      {
        kind: 'action',
        id: 'theme-light',
        label: 'Switch to light',
        hint: 'Theme',
        run: () => setTheme('light'),
      },
    ],
    [setTheme],
  );

  const results: Result[] = React.useMemo(() => {
    const q = query.trim();
    const out: Result[] = [];

    // Recents lead an empty palette: reopening it usually means going back to
    // something, not somewhere new.
    if (!q && hydrated) {
      out.push(
        ...recent.slice(0, 5).map((r) => ({
          kind: 'symbol' as const,
          symbol: r.symbol,
          name: r.name ?? '',
          recent: true,
        })),
      );
    }
    out.push(...symbols);
    out.push(...ROUTES.filter((r) => matches(r, q)));
    out.push(
      ...actions.filter((a) =>
        q ? `${a.label} ${a.hint}`.toLowerCase().includes(q.toLowerCase()) : false,
      ),
    );
    return out;
  }, [query, symbols, recent, hydrated, actions]);

  React.useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, results.length - 1)));
  }, [results.length]);

  /* ---- choosing ----------------------------------------------------- */

  const choose = React.useCallback(
    (result: Result | undefined) => {
      if (!result) return;
      setOpen(false);
      if (result.kind === 'symbol') {
        setTicker(result.symbol, result.name || undefined);
        // Straight to the price, which is the first question asked about a
        // security; the ticker bar carries it to the other lenses from there.
        router.push(TICKER_LENSES[0]?.href ?? '/chart');
        return;
      }
      if (result.kind === 'route') {
        router.push(result.href);
        return;
      }
      result.run();
    },
    [router, setTicker],
  );

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[cursor]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }

  // Keep the cursor in view without scrolling the page behind the dialog.
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return <PaletteHint onOpen={() => setOpen(true)} />;

  return (
    <>
      <PaletteHint onOpen={() => setOpen(true)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      >
        <button
          type="button"
          aria-label="Close command palette"
          className="absolute inset-0 cursor-default bg-background/70 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
        <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
          <div className="flex items-center gap-2.5 border-b border-border px-3.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search a ticker, jump to a page…"
              aria-label="Search a ticker or jump to a page"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {loading && (
              <span className="text-2xs text-muted-foreground" aria-live="polite">
                …
              </span>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
            {results.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                {query.trim()
                  ? `Nothing matches “${query.trim()}”. Tickers and page names both work here.`
                  : 'Type a ticker, or the name of a page.'}
              </p>
            ) : (
              results.map((r, i) => (
                <Row
                  key={rowKey(r)}
                  result={r}
                  active={i === cursor}
                  onHover={() => {
                    if (pointerMoved.current) setCursor(i);
                  }}
                  onPick={() => choose(r)}
                />
              ))
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border px-3.5 py-2 text-2xs text-muted-foreground">
            <span className="flex items-center gap-3">
              <Key>↑↓</Key>
              <span>navigate</span>
              <Key>↵</Key>
              <span>open</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Key>esc</Key>
              <span>close</span>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function rowKey(r: Result): string {
  if (r.kind === 'symbol') return `s:${r.symbol}${r.recent ? ':recent' : ''}`;
  if (r.kind === 'route') return `r:${r.href}`;
  return `a:${r.id}`;
}

function Row({
  result,
  active,
  onHover,
  onPick,
}: {
  result: Result;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const Icon =
    result.kind === 'symbol'
      ? result.recent
        ? Clock
        : Search
      : result.kind === 'action'
        ? Palette
        : ArrowRight;

  return (
    <button
      type="button"
      data-active={active}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors',
        active ? 'bg-accent' : 'bg-transparent',
      )}
    >
      <Icon
        className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden
      />
      {result.kind === 'symbol' ? (
        <>
          <span className="numeric w-16 shrink-0 text-xs font-semibold">{result.symbol}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {result.name}
          </span>
          {result.exchange && (
            <span className="shrink-0 text-2xs text-muted-foreground">{result.exchange}</span>
          )}
        </>
      ) : (
        <>
          <span className="shrink-0 text-xs font-medium">{result.label}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {result.hint}
          </span>
          {result.kind === 'route' && (
            <span className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">
              {result.group}
            </span>
          )}
        </>
      )}
      {active && <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
    </button>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-sans text-2xs">
      {children}
    </kbd>
  );
}

/**
 * The affordance in the nav bar.
 *
 * A keyboard shortcut nobody knows about is a feature nobody has, so the
 * shortcut is printed where the search box people expect would be — and the
 * thing itself is clickable, for readers who never learn it.
 */
function PaletteHint({ onOpen }: { onOpen: () => void }) {
  const [mac, setMac] = React.useState(true);
  React.useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform ?? ''));
  }, []);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open the command palette"
      className="hidden items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-input hover:text-foreground sm:flex"
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      <span>Search</span>
      <kbd className="ml-2 rounded border border-border bg-background px-1.5 py-0.5 font-sans text-2xs">
        {mac ? '⌘' : 'Ctrl '}K
      </kbd>
    </button>
  );
}
