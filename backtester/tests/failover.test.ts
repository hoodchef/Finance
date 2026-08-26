import { describe, expect, it } from 'vitest';
import { FailoverProvider } from '../src/lib/market-data/failover';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import { UnknownSymbolError } from '../src/lib/market-data/provider';
import type { MarketDataProvider } from '../src/lib/market-data/provider';
import type { DateRange } from '../src/lib/types';

/**
 * No single free provider covers everything, so the chain exists to fill
 * coverage gaps. Its one non-negotiable property is that it never reaches for
 * generated data to paper over a gap.
 */

const demo = new DemoDataProvider();

function stub(
  id: string,
  serves: string[] | 'all',
  behaviour: 'ok' | 'unknown' | 'throttled' = 'ok',
): MarketDataProvider {
  const calls: string[] = [];
  const p = {
    id,
    label: id,
    synthetic: false,
    description: id,
    calls,
    async getHistoricalPrices(symbol: string, range: DateRange) {
      calls.push(symbol);
      if (behaviour === 'throttled') throw new Error('HTTP 429');
      if (serves !== 'all' && !serves.includes(symbol)) throw new UnknownSymbolError(symbol);
      if (behaviour === 'unknown') throw new UnknownSymbolError(symbol);
      const s = await demo.getHistoricalPrices(symbol, range);
      return { ...s, source: id, synthetic: false };
    },
    async getCorporateActions() {
      return { dividends: [], splits: [] };
    },
    async getDividends() {
      return [];
    },
    async getTradingCalendar() {
      return [];
    },
    async search() {
      return [{ symbol: `${id.toUpperCase()}X`, name: id, assetClass: 'etf' as const }];
    },
  };
  return p as unknown as MarketDataProvider & { calls: string[] };
}

const range = { start: '2020-01-01', end: '2020-12-31' };

describe('failover', () => {
  it('uses the first provider that can serve the symbol', async () => {
    const chain = new FailoverProvider([stub('primary', ['SPY']), stub('secondary', 'all')]);

    // Primary covers SPY.
    expect((await chain.getHistoricalPrices('SPY', range)).source).toBe('primary');
    // It does not cover XEQT.TO, so the chain falls through — the exact gap
    // this exists for.
    expect((await chain.getHistoricalPrices('XEQT.TO', range)).source).toBe('secondary');
  });

  it('falls through a throttled provider rather than failing', async () => {
    const chain = new FailoverProvider([stub('primary', 'all', 'throttled'), stub('backup', 'all')]);
    expect((await chain.getHistoricalPrices('SPY', range)).source).toBe('backup');
  });

  it('reports a genuinely unknown symbol as unknown', async () => {
    const chain = new FailoverProvider([stub('a', ['SPY']), stub('b', ['SPY'])]);
    await expect(chain.getHistoricalPrices('NOPE', range)).rejects.toThrow(UnknownSymbolError);
  });

  it('surfaces the last error when every provider is down', async () => {
    const chain = new FailoverProvider([
      stub('a', 'all', 'throttled'),
      stub('b', 'all', 'throttled'),
    ]);
    await expect(chain.getHistoricalPrices('SPY', range)).rejects.toThrow(/429/);
  });

  it('refuses to be constructed with a synthetic provider', () => {
    // The worst place for generated data is silently filling one leg of a
    // portfolio, so this is blocked at construction rather than at call time.
    expect(() => new FailoverProvider([stub('real', 'all'), demo])).toThrow(/synthetic/i);
    expect(() => new FailoverProvider([demo])).toThrow(/synthetic/i);
  });

  it('declares itself real and names its chain', () => {
    const chain = new FailoverProvider([stub('tiingo', 'all'), stub('yahoo', 'all')]);
    expect(chain.synthetic).toBe(false);
    expect(chain.id).toBe('tiingo+yahoo');
    expect(chain.label).toContain('→');
  });

  it('keeps provenance truthful per symbol', async () => {
    // A portfolio assembled from two providers must not claim one source.
    const chain = new FailoverProvider([stub('tiingo', ['SPY']), stub('yahoo', 'all')]);
    const us = await chain.getHistoricalPrices('SPY', range);
    const ca = await chain.getHistoricalPrices('XEQT.TO', range);
    expect(us.source).toBe('tiingo');
    expect(ca.source).toBe('yahoo');
  });

  it('merges search results across the chain', async () => {
    const chain = new FailoverProvider([stub('one', 'all'), stub('two', 'all')]);
    const results = await chain.search('x');
    expect(results.map((r) => r.symbol)).toEqual(['ONEX', 'TWOX']);
  });
});

describe('attributing the failure correctly', () => {
  /**
   * Found against live data: Tiingo does not list XEQT.TO and Yahoo was
   * throttled, and the chain reported "unknown symbol" — sending the user to
   * hunt a typo that was not there. It may only claim a symbol does not exist
   * when every provider agreed it does not.
   */
  it('does not call a symbol unknown when a provider was merely unreachable', async () => {
    const chain = new FailoverProvider([
      stub('tiingo', ['SPY']), // genuinely does not list it
      stub('yahoo', 'all', 'throttled'), // would have, but is down
    ]);

    const err = await chain.getHistoricalPrices('XEQT.TO', range).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnknownSymbolError);
    expect(String(err.message)).toMatch(/could not be reached|429/i);
  });

  it('names which providers could not be reached', async () => {
    const chain = new FailoverProvider([
      stub('tiingo', ['SPY']),
      stub('yahoo', 'all', 'throttled'),
    ]);
    const err = await chain.getHistoricalPrices('XEQT.TO', range).catch((e) => e);
    expect(String(err.message)).toContain('yahoo');
  });

  it('still reports unknown when every provider agrees', async () => {
    const chain = new FailoverProvider([stub('a', ['SPY']), stub('b', ['SPY'])]);
    await expect(chain.getHistoricalPrices('NOPE', range)).rejects.toBeInstanceOf(
      UnknownSymbolError,
    );
  });
});
