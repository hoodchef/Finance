'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useHydrated } from '@/hooks/use-hydrated';

/**
 * The security currently in focus.
 * =============================================================================
 * Every page here used to own its own ticker box. Researching AAPL meant typing
 * it on Research, again on Options, and again on Charts — three inputs, three
 * pieces of state, three chances to be looking at three different companies
 * while believing you were looking at one.
 *
 * This store holds that one answer for the whole application: which security am
 * I looking at. `TickerBar` renders it and moves it between views; a page reads
 * it to seed its own lookup:
 *
 * ```tsx
 * const focus = useActiveTicker();            // null until hydrated
 * const setTicker = useTickerStore((s) => s.setTicker);
 * React.useEffect(() => { if (focus) void look(focus.symbol); }, [focus]);
 * ```
 *
 * and calls `setTicker` when the user picks something on that page, so the
 * choice follows them onward.
 *
 * Deliberately separate from `useWorkspace`. A ticker in focus is not a
 * portfolio: it is a lens, it changes many times per session, and folding it
 * into the workspace store would make every symbol you glance at a mutation of
 * a document the user thinks of as saved. Different lifetime, different store.
 */

export interface TickerFocus {
  /** Uppercased and trimmed. This is the identity of the entry. */
  symbol: string;
  /** Short display name. Falls back to the symbol when nothing better is known. */
  name: string;
}

/**
 * Recents are a working set, not a history: enough to flick between the names
 * of one afternoon's work, few enough to fit a menu without scrolling.
 */
export const RECENT_LIMIT = 8;

/** One spelling of a symbol, so `aapl`, ` AAPL ` and `AAPL` are one entry. */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface TickerState {
  /** The security in focus, or null when none is. */
  active: TickerFocus | null;
  /** Most-recent-first, de-duplicated by symbol, capped at `RECENT_LIMIT`. */
  recent: TickerFocus[];

  /** Focus a symbol. Blank input is ignored — use `clearTicker` to unfocus. */
  setTicker: (symbol: string, name?: string) => void;
  /** Drop the focus. Recents survive: clearing a lens is not forgetting. */
  clearTicker: () => void;
  /** Forget one symbol, including as the current focus if it is that. */
  removeRecent: (symbol: string) => void;
}

export const useTickerStore = create<TickerState>()(
  persist(
    (set) => ({
      active: null,
      recent: [],

      setTicker: (symbol, name) =>
        set((s) => {
          const sym = normalizeSymbol(symbol);
          if (!sym) return s;

          // A name is optional at most call sites — a page that only knows the
          // symbol must not overwrite the company name an earlier lookup found.
          const known = s.recent.find((t) => t.symbol === sym);
          const label = (name ?? '').trim();
          const focus: TickerFocus = { symbol: sym, name: label || known?.name || sym };

          return {
            active: focus,
            // Re-selecting a symbol moves it to the front rather than adding a
            // second row: the list is a set ordered by recency, and a switcher
            // showing AAPL four times is worse than useless.
            recent: [focus, ...s.recent.filter((t) => t.symbol !== sym)].slice(0, RECENT_LIMIT),
          };
        }),

      clearTicker: () => set({ active: null }),

      removeRecent: (symbol) =>
        set((s) => {
          const sym = normalizeSymbol(symbol);
          return {
            recent: s.recent.filter((t) => t.symbol !== sym),
            // Staying focused on something you just erased from your history
            // is incoherent, so the focus goes with it.
            active: s.active?.symbol === sym ? null : s.active,
          };
        }),
    }),
    {
      name: 'backtester.ticker.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ active: s.active, recent: s.recent }),
    },
  ),
);

/** Stable identity, so an un-hydrated read does not re-render on every paint. */
const NO_RECENTS: TickerFocus[] = [];

/**
 * The security in focus, or null.
 *
 * Null during the first client render even when a symbol is persisted: the
 * server rendered no ticker bar, and reading persisted state during the
 * server-matched paint is a hydration mismatch. Read `useTickerStore` directly
 * inside an event handler or effect, where that does not apply.
 */
export function useActiveTicker(): TickerFocus | null {
  const hydrated = useHydrated();
  const active = useTickerStore((s) => s.active);
  return hydrated ? active : null;
}

/** Recently focused securities, most recent first. Empty until hydrated. */
export function useRecentTickers(): TickerFocus[] {
  const hydrated = useHydrated();
  const recent = useTickerStore((s) => s.recent);
  return hydrated ? recent : NO_RECENTS;
}
