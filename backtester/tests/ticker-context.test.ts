import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_ITEMS, TICKER_LENSES } from '../src/components/layout/nav';

/**
 * The security in focus, and the trail behind it.
 * =============================================================================
 * `TickerBar` is the one piece of state every analysis page reads, so its rules
 * are worth stating twice — once in the store and once here. The failures being
 * guarded against are all quiet ones: a recents list that grows without bound
 * inside persisted storage, a switcher showing AAPL four times because
 * re-selecting appended instead of promoting, a company name overwritten by its
 * own ticker on the second visit.
 *
 * The runner is a Node environment, so `localStorage` has to exist before the
 * store module evaluates — `persist` reads it at creation. Hence the memory
 * storage below and the dynamic import after it, rather than a static one.
 */

const memory = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => {
    memory.delete(key);
  },
  setItem: (key, value) => {
    memory.set(key, String(value));
  },
};
globalThis.localStorage = memoryStorage;

const { useTickerStore, RECENT_LIMIT, normalizeSymbol } = await import('../src/store/ticker');

const set = (symbol: string, name?: string) => useTickerStore.getState().setTicker(symbol, name);
const state = () => useTickerStore.getState();
const symbols = () => state().recent.map((t) => t.symbol);

beforeEach(() => {
  useTickerStore.setState({ active: null, recent: [] });
  memory.clear();
});

describe('focusing a security', () => {
  it('makes it active and puts it at the head of the recents', () => {
    set('AAPL', 'Apple Inc.');
    expect(state().active).toEqual({ symbol: 'AAPL', name: 'Apple Inc.' });
    expect(state().recent).toEqual([{ symbol: 'AAPL', name: 'Apple Inc.' }]);
  });

  it('reads one spelling of a symbol', () => {
    // The ticker arrives from a search result, a URL, a chart legend and a
    // person typing. `aapl` and `AAPL` are one company, and two entries for
    // them would be two entries in the switcher.
    set('  aapl  ', 'Apple Inc.');
    expect(state().active?.symbol).toBe('AAPL');
    set('Aapl');
    expect(symbols()).toEqual(['AAPL']);
    expect(normalizeSymbol(' msft ')).toBe('MSFT');
  });

  it('ignores a blank symbol rather than focusing nothing', () => {
    set('AAPL', 'Apple Inc.');
    set('   ');
    expect(state().active?.symbol).toBe('AAPL');
    expect(symbols()).toEqual(['AAPL']);
  });

  it('falls back to the symbol when no name is known', () => {
    set('TSLA');
    expect(state().active).toEqual({ symbol: 'TSLA', name: 'TSLA' });
  });

  it('keeps a name a previous lookup found, and takes a better one', () => {
    // Most callers know only the symbol — a chart legend, a holdings row. If
    // those overwrote the name, the switcher would degrade to a list of
    // tickers the moment you revisited anything.
    set('MSFT', 'Microsoft Corporation');
    set('MSFT');
    expect(state().active?.name).toBe('Microsoft Corporation');
    set('MSFT', 'Microsoft Corp.');
    expect(state().active?.name).toBe('Microsoft Corp.');
    expect(symbols()).toEqual(['MSFT']);
  });
});

describe('the recents list', () => {
  it('does not duplicate a symbol focused twice', () => {
    set('AAPL', 'Apple Inc.');
    set('AAPL', 'Apple Inc.');
    expect(state().recent).toHaveLength(1);
    expect(symbols()).toEqual(['AAPL']);
  });

  it('orders most recent first', () => {
    set('AAPL');
    set('MSFT');
    set('NVDA');
    expect(symbols()).toEqual(['NVDA', 'MSFT', 'AAPL']);
  });

  it('promotes a symbol you return to instead of appending it', () => {
    set('AAPL');
    set('MSFT');
    set('NVDA');
    set('AAPL');
    expect(symbols()).toEqual(['AAPL', 'NVDA', 'MSFT']);
    expect(symbols()).toHaveLength(3);
  });

  it('caps at the limit, dropping the oldest', () => {
    // A persisted list with no cap is a slow leak into browser storage that
    // nothing ever surfaces or clears.
    const many = Array.from({ length: RECENT_LIMIT + 4 }, (_, i) => `SYM${i}`);
    for (const s of many) set(s);
    expect(state().recent).toHaveLength(RECENT_LIMIT);
    expect(symbols()[0]).toBe(many[many.length - 1]);
    expect(symbols()).not.toContain(many[0]);
    // The kept entries are the last RECENT_LIMIT, newest first.
    expect(symbols()).toEqual(many.slice(-RECENT_LIMIT).reverse());
  });

  it('counts a re-focus as recency, not as a new entry, when full', () => {
    const many = Array.from({ length: RECENT_LIMIT }, (_, i) => `SYM${i}`);
    for (const s of many) set(s);
    set('SYM0'); // the oldest, revisited
    expect(state().recent).toHaveLength(RECENT_LIMIT);
    expect(symbols()[0]).toBe('SYM0');
    expect(symbols().filter((s) => s === 'SYM0')).toHaveLength(1);
  });
});

describe('letting go of a security', () => {
  it('clears the focus without forgetting where you have been', () => {
    // The bar disappears; the trail is still there to pick up. Clearing a lens
    // is not the same as erasing the afternoon's work.
    set('AAPL', 'Apple Inc.');
    set('MSFT', 'Microsoft Corporation');
    state().clearTicker();
    expect(state().active).toBeNull();
    expect(symbols()).toEqual(['MSFT', 'AAPL']);
  });

  it('clears an empty focus without complaint', () => {
    state().clearTicker();
    state().clearTicker();
    expect(state().active).toBeNull();
    expect(state().recent).toEqual([]);
  });

  it('forgets one symbol, and unfocuses it if it was the one in focus', () => {
    set('AAPL', 'Apple Inc.');
    set('MSFT', 'Microsoft Corporation');
    state().removeRecent('aapl'); // not the active one, and loosely spelled
    expect(symbols()).toEqual(['MSFT']);
    expect(state().active?.symbol).toBe('MSFT');

    state().removeRecent('MSFT');
    expect(state().recent).toEqual([]);
    expect(state().active).toBeNull();
  });
});

describe('the views the bar offers', () => {
  /**
   * `TICKER_LENSES` is built by looking four hrefs up in `NAV_ITEMS` and
   * dropping what it cannot find. That is the right failure mode at runtime —
   * a bar missing one button beats a crash — but it is silent, so a route
   * renamed underneath it would quietly remove a view from the product with
   * nothing to show for it. This is the alarm.
   */
  it('offers all four, and every one is a real destination', () => {
    expect(TICKER_LENSES.map((l) => l.href)).toEqual([
      '/chart',
      '/research',
      '/options',
      '/backtest',
    ]);
    for (const lens of TICKER_LENSES) {
      expect(NAV_ITEMS, `${lens.href} is not in the navigation`).toContain(lens);
    }
  });

  it('names them exactly as the menus do', () => {
    // Two names for one page is the thing that makes a product feel like
    // several: the menu says Charts, the bar must not say Chart.
    for (const lens of TICKER_LENSES) {
      const nav = NAV_ITEMS.find((i) => i.href === lens.href);
      expect(lens.label).toBe(nav?.label);
    }
  });
});

describe('what survives a reload', () => {
  it('persists under its own key, leaving the workspace store alone', () => {
    // A ticker in focus is not a portfolio: separate store, separate key,
    // separate lifetime. Sharing one would make every symbol you glance at a
    // write to the document the user thinks of as saved.
    set('AAPL', 'Apple Inc.');
    const raw = localStorage.getItem('backtester.ticker.v1');
    expect(raw, 'the ticker store did not persist').toBeTruthy();
    expect(raw).toContain('AAPL');
    expect(localStorage.getItem('backtester.workspace.v1')).toBeNull();
  });

  it('restores the focus and the trail', () => {
    set('AAPL', 'Apple Inc.');
    set('MSFT', 'Microsoft Corporation');

    // What a reload does: fresh in-memory state, same storage. The snapshot is
    // put back by hand because blanking the state persists the blank — the
    // store writes on every change, which is the behaviour being relied on.
    const snapshot = localStorage.getItem('backtester.ticker.v1') ?? '';
    useTickerStore.setState({ active: null, recent: [] });
    localStorage.setItem('backtester.ticker.v1', snapshot);
    useTickerStore.persist.rehydrate();

    expect(state().active).toEqual({ symbol: 'MSFT', name: 'Microsoft Corporation' });
    expect(symbols()).toEqual(['MSFT', 'AAPL']);
  });
});
