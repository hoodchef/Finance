import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getProvider, getDemoProvider, isDemoMode } from '../src/lib/market-data';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import { YahooFinanceProvider } from '../src/lib/market-data/yahoo';
import { runBacktest } from '../src/lib/backtest';
import { testConfig } from './helpers';

/**
 * Guards against synthetic data being presented as a legitimate backtest.
 * =============================================================================
 * The failure this prevents is specific and severe: a result computed from
 * generated prices that renders exactly like one computed from market history.
 * Every number would be internally consistent, every chart would look right,
 * and someone could make a real financial decision on invented data.
 *
 * Several of these are SOURCE-LEVEL assertions rather than behavioural ones.
 * That is deliberate. The invariant "every surface that renders results also
 * renders a provenance banner" cannot be checked by exercising the components,
 * because the way it breaks is somebody adding a NEW surface and forgetting —
 * and a test that only covers today's surfaces would still pass.
 */

const SRC = path.join(__dirname, '..', 'src');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function listFiles(dir: string, filter: (f: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (filter(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('provider selection cannot be steered by a request', () => {
  it('resolves from the environment only', () => {
    // The signature takes no argument at all, so a route physically cannot
    // forward a client-supplied provider id into it.
    expect(getProvider.length).toBe(0);
  });

  it('never lets an API route pass a value into getProvider', () => {
    const routes = listFiles(path.join(SRC, 'app', 'api'), (f) => f.endsWith('route.ts'));
    expect(routes.length).toBeGreaterThan(0);

    for (const file of routes) {
      const body = fs.readFileSync(file, 'utf8');
      const calls = body.match(/getProvider\([^)]*\)/g) ?? [];
      for (const call of calls) {
        expect(call, `${path.basename(path.dirname(file))} passes an argument to getProvider`).toBe(
          'getProvider()',
        );
      }
    }
  });

  it('falls back to REAL data when the configured provider is unrecognised', () => {
    const original = process.env.MARKET_DATA_PROVIDER;
    try {
      // A typo in an environment variable must never downgrade a deployment to
      // invented prices — it must fail towards the truthful option.
      for (const bogus of ['yahooo', 'DEMOX', '', '  ', 'synthetic', 'fake']) {
        process.env.MARKET_DATA_PROVIDER = bogus;
        expect(getProvider().synthetic, `"${bogus}" must not select synthetic`).toBe(false);
      }
    } finally {
      if (original == null) delete process.env.MARKET_DATA_PROVIDER;
      else process.env.MARKET_DATA_PROVIDER = original;
    }
  });

  it('selects synthetic only for the exact opt-in value', () => {
    const original = process.env.MARKET_DATA_PROVIDER;
    try {
      process.env.MARKET_DATA_PROVIDER = 'demo';
      expect(getProvider().synthetic).toBe(true);
      expect(isDemoMode()).toBe(true);

      process.env.MARKET_DATA_PROVIDER = 'yahoo';
      expect(getProvider().synthetic).toBe(false);
      expect(isDemoMode()).toBe(false);
    } finally {
      if (original == null) delete process.env.MARKET_DATA_PROVIDER;
      else process.env.MARKET_DATA_PROVIDER = original;
    }
  });
});

describe('providers declare their own nature honestly', () => {
  it('marks the demo provider synthetic everywhere it can be observed', async () => {
    const demo = new DemoDataProvider();
    expect(demo.synthetic).toBe(true);
    expect(demo.label.toLowerCase()).toContain('synthetic');
    expect(demo.description.toUpperCase()).toContain('SYNTHETIC');

    const series = await demo.getHistoricalPrices('SPY', {
      start: '2020-01-01',
      end: '2020-12-31',
    });
    expect(series.synthetic).toBe(true);
    expect(series.source).toBe('demo');
  });

  it('marks the live provider as real', () => {
    const yahoo = new YahooFinanceProvider();
    expect(yahoo.synthetic).toBe(false);
    expect(yahoo.id).toBe('yahoo');
  });
});

describe('synthetic results stay stamped end to end', () => {
  it('flags every synthetic backtest in its data source block', async () => {
    const result = await runBacktest({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [{ id: '1', symbol: 'SPY', weight: 100 }],
      },
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: getDemoProvider(),
      includeAssetAnalysis: false,
    });

    expect(result.dataSource.synthetic).toBe(true);
    expect(result.dataSource.providerId).toBe('demo');
    // Per-series too, not only in aggregate.
    expect(result.dataSource.symbols.every((s) => s.synthetic)).toBe(true);
  });

  it('reports when the data was retrieved and what it covers', async () => {
    const result = await runBacktest({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [{ id: '1', symbol: 'SPY', weight: 100 }],
      },
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: getDemoProvider(),
      includeAssetAnalysis: false,
    });

    expect(result.dataSource.retrievedAt).toBeTruthy();
    expect(result.dataSource.latestSessionDate).toBeTruthy();
    expect(result.dataSource.dataAgeDays).toBeGreaterThanOrEqual(0);
    expect(result.dataSource.symbols[0].lastBarDate).toBeTruthy();
  });
});

describe('every surface that renders results also declares provenance', () => {
  /**
   * The list is derived, not hard-coded: a newly added page that renders a
   * BacktestResult is picked up automatically and must satisfy the rule.
   */
  const candidates = listFiles(path.join(SRC, 'app'), (f) => f.endsWith('.tsx'))
    .concat(listFiles(path.join(SRC, 'components', 'results'), (f) => f.endsWith('.tsx')))
    .filter((f) => {
      const body = fs.readFileSync(f, 'utf8');
      // Surfaces that render a full result set, as opposed to a fragment
      // rendered inside one.
      return /BacktestResult\[\]|results\[0\]|result: BacktestResult/.test(body);
    });

  it('finds the surfaces to check', () => {
    expect(candidates.length).toBeGreaterThan(2);
  });

  it.each(candidates.map((f) => path.relative(SRC, f)))(
    '%s shows a synthetic banner or is a fragment of one that does',
    (rel) => {
      const body = read(rel);
      const declaresProvenance =
        /SyntheticDataBanner|DataFreshness|dataSource\.synthetic/.test(body);
      // A fragment receives an already-provenanced result from its parent; the
      // rule applies to whole surfaces.
      const isFragment = !/PageBody|PageHeader/.test(body) && !/results-dashboard/.test(rel);
      expect(
        declaresProvenance || isFragment,
        `${rel} renders results without any provenance marker`,
      ).toBe(true);
    },
  );
});

describe('the demo provider is unreachable from the request path', () => {
  it('is not importable by any API route', () => {
    const routes = listFiles(path.join(SRC, 'app', 'api'), (f) => f.endsWith('route.ts'));
    for (const file of routes) {
      const body = fs.readFileSync(file, 'utf8');
      expect(
        /DemoDataProvider|getDemoProvider/.test(body),
        `${path.basename(path.dirname(file))} can reach the demo provider directly`,
      ).toBe(false);
    }
  });
});

describe('behaviour when the provider is unreachable', () => {
  /**
   * Yahoo rate-limits under load, so "the provider is down" is a routine
   * condition rather than an edge case. What must never happen is silently
   * substituting something that is not real market data.
   */
  it('never substitutes synthetic data for a failed real fetch', async () => {
    const failing = new YahooFinanceProvider();
    // Point it at a symbol that cannot resolve, with no cache to fall back to.
    await expect(
      failing.getHistoricalPrices('__NOT_A_REAL_TICKER_XYZ__', {
        start: '2020-01-01',
        end: '2020-12-31',
      }),
    ).rejects.toThrow();
    // Crucially: it throws. It does not quietly return a generated series.
  }, 60_000);

  it('marks a stale-cache series so the result cannot look current', async () => {
    // The flag is what carries "these prices are real but possibly behind"
    // through to the warnings and the provenance line.
    const demo = new DemoDataProvider();
    const fresh = await demo.getHistoricalPrices('SPY', {
      start: '2020-01-01',
      end: '2020-12-31',
    });
    expect(fresh.stale).toBeFalsy();

    const stale = { ...fresh, stale: true };
    expect(stale.stale).toBe(true);
    expect(stale.synthetic).toBe(true);
    // Staleness and syntheticity are independent signals; neither masks the other.
  });
});

describe('the provenance block is complete', () => {
  it('carries every field the UI needs to describe the data honestly', async () => {
    const result = await runBacktest({
      portfolio: { id: 'p', name: 'P', positions: [{ id: '1', symbol: 'SPY', weight: 100 }] },
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: getDemoProvider(),
      includeAssetAnalysis: false,
    });

    const d = result.dataSource;
    expect(d.providerLabel).toBeTruthy();
    expect(d.providerDescription).toBeTruthy();
    expect(typeof d.synthetic).toBe('boolean');
    expect(typeof d.servedFromStaleCache).toBe('boolean');
    expect(d.retrievedAt).toBeTruthy();
    expect(d.latestSessionDate).toBeTruthy();
    expect(d.symbols.length).toBeGreaterThan(0);
  });
});

describe('failure messages never steer users toward synthetic data', () => {
  /**
   * A provider outage is the exact moment a user is most likely to accept any
   * suggestion that makes the error go away. Offering demo mode there is how
   * generated numbers end up in a real decision, so the error paths are
   * checked for it directly.
   */
  const providerSources = ['lib/market-data/yahoo.ts', 'lib/market-data/tiingo.ts'];

  it.each(providerSources)('%s does not suggest demo mode on failure', (rel) => {
    const body = read(rel);
    const thrownMessages = body.match(/new MarketDataError\(\s*[\s\S]{0,600}?\)/g) ?? [];
    expect(thrownMessages.length).toBeGreaterThan(0);
    for (const message of thrownMessages) {
      expect(
        /demo (data )?provider|switch to demo|demo mode/i.test(message),
        `${rel} offers demo mode in an error message`,
      ).toBe(false);
    }
  });
});

describe('the symbol universe', () => {
  it('is large enough to be a real universe, from a named source', async () => {
    const { universeInfo, searchUniverse, normaliseSymbol } = await import(
      '../src/lib/market-data/universe'
    );
    const info = universeInfo();

    // The requirement was a four-digit universe; this is five.
    expect(info.count).toBeGreaterThan(9_000);
    expect(info.etfCount).toBeGreaterThan(2_000);
    expect(info.equityCount).toBeGreaterThan(2_000);
    expect(info.source).toContain('Nasdaq Trader');
    expect(info.sourceUrl).toMatch(/^https:/);

    // Resolves the common cases without a network call.
    for (const t of ['SPY', 'QQQ', 'VTI', 'BND', 'AAPL', 'SCHD']) {
      expect(searchUniverse(t, 1)[0]?.symbol, `${t} missing from universe`).toBe(t);
    }
    expect(normaliseSymbol('BRK.B')).toBe('BRK-B');
  });

  it('finds funds by description, not only by ticker', async () => {
    const { searchUniverse } = await import('../src/lib/market-data/universe');
    // Multi-word queries must match tokens anywhere in the name — the words are
    // not adjacent in "Schwab US Dividend Equity ETF".
    const hits = searchUniverse('schwab dividend', 5).map((r) => r.symbol);
    expect(hits).toContain('SCHD');
  });
});
