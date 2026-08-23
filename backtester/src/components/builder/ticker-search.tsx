'use client';

import * as React from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import type { SecurityMeta } from '@/lib/types';
import { searchCatalog } from '@/lib/market-data/catalog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Ticker combobox. The local catalogue renders on the first keystroke so the
 * list never appears empty while the network call is in flight, and the remote
 * results merge in when they arrive.
 */
export function TickerSearch({
  value,
  onSelect,
  placeholder = 'Search ticker or name…',
  autoFocus,
  className,
  id,
}: {
  value?: string;
  onSelect: (meta: SecurityMeta) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  id?: string;
}) {
  const [query, setQuery] = React.useState(value ?? '');
  const [results, setResults] = React.useState<SecurityMeta[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  React.useEffect(() => setQuery(value ?? ''), [value]);

  // Local results are synchronous; remote results are debounced and abortable.
  React.useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    const local: SecurityMeta[] = searchCatalog(trimmed).map((e) => ({
      symbol: e.symbol,
      name: e.name,
      assetClass: e.assetClass,
      currency: 'USD',
    }));
    setResults(local);
    setHighlight(0);
    setLoading(true);

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { results: SecurityMeta[] };
        setResults(data.results);
      } catch {
        // Aborted or offline — the catalogue results stay on screen.
      } finally {
        setLoading(false);
      }
    }, 220);

    return () => {
      controller.abort();
      clearTimeout(timer);
      setLoading(false);
    };
  }, [query]);

  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  function choose(meta: SecurityMeta) {
    onSelect(meta);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = results[highlight];
      if (picked) choose(picked);
      else if (query.trim()) {
        // Let the user commit a ticker the search did not return; the backtest
        // will report clearly if the provider has no data for it.
        choose({
          symbol: query.trim().toUpperCase(),
          name: query.trim().toUpperCase(),
          assetClass: 'other',
          currency: 'USD',
        });
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="pl-8 pr-8"
      />
      {loading && (
        <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}

      {open && query.trim() && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg animate-slide-up"
        >
          {results.length === 0 && !loading && (
            <li className="px-2 py-3 text-xs text-muted-foreground">
              No match. Press Enter to use{' '}
              <span className="numeric font-medium text-foreground">
                {query.trim().toUpperCase()}
              </span>{' '}
              anyway.
            </li>
          )}
          {results.map((r, i) => (
            <li key={r.symbol}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(r)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                  i === highlight ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <span className="numeric w-20 shrink-0 font-medium">{r.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {r.name}
                </span>
                <span className="shrink-0 text-2xs uppercase text-muted-foreground/70">
                  {r.assetClass}
                </span>
                {i === highlight && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
