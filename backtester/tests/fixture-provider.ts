import fs from 'node:fs';
import path from 'node:path';
import { __testing } from '../src/lib/market-data/tiingo';
import type { MarketDataProvider } from '../src/lib/market-data/provider';
import type { DateRange, IsoDate, PriceSeries, SecurityMeta } from '../src/lib/types';

/**
 * A provider backed by recorded vendor responses, for many symbols at once.
 * =============================================================================
 * `parity-tiingo.test.ts` has a single-series stub; this is the multi-symbol
 * version, so a benchmark or an invariant test can run a real portfolio without
 * touching the network. The recordings are raw Tiingo payloads parsed by the
 * vendor's own parser, so what the engine sees here is exactly what it would
 * see live.
 *
 * The fixtures are gitignored — Tiingo's licence is personal-use — so callers
 * must check `hasFixtures` and skip rather than assume. A benchmark that
 * silently measures an empty portfolio is worse than one that does not run.
 */

const FIXTURES = path.join(__dirname, 'fixtures');

const FILES: Record<string, string> = {
  SPY: 'tiingo-spy-2015-2024.json',
  BND: 'tiingo-bnd-2015-2024.json',
};

export function hasFixtures(symbols: string[]): boolean {
  return symbols.every((s) => {
    const f = FILES[s.toUpperCase()];
    return Boolean(f) && fs.existsSync(path.join(FIXTURES, f));
  });
}

function load(symbol: string): PriceSeries {
  const file = FILES[symbol.toUpperCase()];
  if (!file) throw new Error(`No recorded fixture for ${symbol}.`);
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')) as {
    symbol: string;
    meta: Parameters<typeof __testing.parse>[1];
    prices: Parameters<typeof __testing.parse>[2];
  };
  return __testing.parse(raw.symbol, raw.meta, raw.prices);
}

export class FixtureProvider implements MarketDataProvider {
  readonly id = 'fixture';
  readonly label = 'Recorded fixtures';
  /**
   * Not synthetic: these are real recorded prices. Saying otherwise would put
   * a "synthetic data" banner on a result computed from genuine history, which
   * is the same category of lie as the reverse.
   */
  readonly synthetic = false;
  readonly description = 'Recorded Tiingo responses, replayed offline';

  private readonly cache = new Map<string, PriceSeries>();

  private series(symbol: string): PriceSeries {
    const key = symbol.toUpperCase();
    let s = this.cache.get(key);
    if (!s) {
      s = load(key);
      this.cache.set(key, s);
    }
    return s;
  }

  private slice(symbol: string, range: DateRange): PriceSeries {
    const s = this.series(symbol);
    return {
      ...s,
      bars: s.bars.filter((b) => b.date >= range.start && b.date <= range.end),
      dividends: s.dividends.filter((d) => d.date >= range.start && d.date <= range.end),
      splits: s.splits.filter((x) => x.date >= range.start && x.date <= range.end),
    };
  }

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    return this.slice(symbol, range);
  }

  async getCorporateActions(symbol: string, range: DateRange) {
    const x = this.slice(symbol, range);
    return { dividends: x.dividends, splits: x.splits };
  }

  async getDividends(symbol: string, range: DateRange) {
    return this.slice(symbol, range).dividends;
  }

  /**
   * Trading days the requested symbols actually traded on.
   *
   * Derived from the recorded bars, exactly as a live provider derives it from
   * observed ones — so holidays and half-days come out right without a rule
   * set, and a symbol that had not listed yet contributes no days.
   */
  async getTradingCalendar(range: DateRange, symbols: string[] = []): Promise<IsoDate[]> {
    const wanted = symbols.length ? symbols : Object.keys(FILES);
    const days = new Set<IsoDate>();
    for (const symbol of wanted) {
      if (!FILES[symbol.toUpperCase()]) continue;
      for (const bar of this.slice(symbol, range).bars) days.add(bar.date);
    }
    return [...days].sort();
  }

  async search(query: string): Promise<SecurityMeta[]> {
    const q = query.trim().toUpperCase();
    return Object.keys(FILES)
      .filter((s) => s.includes(q))
      .map((s) => this.series(s).meta);
  }
}

export function fixtureProvider(): MarketDataProvider {
  return new FixtureProvider();
}
