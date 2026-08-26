import type {
  CorporateActions,
  DateRange,
  DividendEvent,
  IsoDate,
  PriceSeries,
  SecurityMeta,
} from '@/lib/types';
import { MarketDataError, UnknownSymbolError, type MarketDataProvider } from './provider';

/**
 * Tries several real providers in order, per symbol.
 *
 * No single free provider covers everything. Tiingo has the better quota and an
 * explicit corporate-actions model but does not carry XEQT.TO; Yahoo carries
 * the Canadian listings but throttles without warning. Falling back per SYMBOL
 * rather than per request means a portfolio can hold both without the user
 * having to know which provider serves which.
 *
 * The result records which provider actually served each series, so the
 * provenance shown beneath a result stays accurate rather than naming whichever
 * provider was configured.
 *
 * NEVER falls back to synthetic data. A composite of real providers is still
 * real; mixing in generated prices would defeat the entire point.
 */
export class FailoverProvider implements MarketDataProvider {
  readonly id: string;
  readonly label: string;
  readonly synthetic = false;
  readonly description: string;

  constructor(private readonly providers: MarketDataProvider[]) {
    if (!providers.length) throw new Error('FailoverProvider needs at least one provider');
    if (providers.some((p) => p.synthetic)) {
      // Guarded in the constructor rather than at call time: a synthetic
      // provider in a failover chain would silently substitute generated
      // prices for one leg of a portfolio, which is the worst possible place
      // for it to happen.
      throw new Error('FailoverProvider must not include a synthetic provider');
    }
    this.id = providers.map((p) => p.id).join('+');
    this.label = providers.map((p) => p.label).join(' → ');
    this.description = `Tries ${providers
      .map((p) => p.label)
      .join(', then ')} for each symbol, so coverage gaps in one are filled by the next.`;
  }

  private async firstThatWorks<T>(
    symbol: string,
    call: (p: MarketDataProvider) => Promise<T>,
  ): Promise<T> {
    const failures: Array<{ provider: string; error: unknown }> = [];

    for (const provider of this.providers) {
      try {
        return await call(provider);
      } catch (err) {
        // "This provider does not list that symbol" is worth trying the next
        // one for. So is a throttle. Both are provider-specific, not facts
        // about the ticker.
        failures.push({ provider: provider.label, error: err });
      }
    }

    // Only claim the symbol does not exist when EVERY provider agreed it does
    // not. If one was merely unreachable, we genuinely do not know — and
    // reporting "unknown ticker" would send someone hunting a typo that is not
    // there while the real cause was an outage.
    const allUnknown = failures.every((f) => f.error instanceof UnknownSymbolError);
    if (allUnknown) throw new UnknownSymbolError(symbol);

    const reachable = failures.filter((f) => !(f.error instanceof UnknownSymbolError));
    const detail = reachable
      .map((f) => `${f.provider}: ${f.error instanceof Error ? f.error.message : 'failed'}`)
      .join(' ');

    throw new MarketDataError(
      `"${symbol}" could not be loaded. ${
        failures.length - reachable.length > 0
          ? `Some providers do not list it, and the rest could not be reached. `
          : ''
      }${detail}`,
      symbol,
    );
  }

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    return this.firstThatWorks(symbol, async (p) => {
      const series = await p.getHistoricalPrices(symbol, range);
      if (!series.bars.length) throw new UnknownSymbolError(symbol);
      // `source` already names the provider that served it, so provenance
      // stays truthful for a portfolio assembled from several.
      return series;
    });
  }

  async getCorporateActions(symbol: string, range: DateRange): Promise<CorporateActions> {
    const s = await this.getHistoricalPrices(symbol, range);
    return { dividends: s.dividends, splits: s.splits };
  }

  async getDividends(symbol: string, range: DateRange): Promise<DividendEvent[]> {
    return (await this.getHistoricalPrices(symbol, range)).dividends;
  }

  async getTradingCalendar(range: DateRange, symbols: string[] = ['SPY']): Promise<IsoDate[]> {
    const all = await Promise.all(
      symbols.map((s) => this.getHistoricalPrices(s, range).catch(() => null)),
    );
    const days = new Set<IsoDate>();
    for (const series of all) {
      if (!series) continue;
      for (const bar of series.bars) days.add(bar.date);
    }
    return [...days].sort();
  }

  async search(query: string): Promise<SecurityMeta[]> {
    // Merged rather than first-wins: each provider knows a different corner of
    // the market, which is the reason for the chain.
    const seen = new Set<string>();
    const out: SecurityMeta[] = [];
    for (const provider of this.providers) {
      try {
        for (const r of await provider.search(query)) {
          const key = r.symbol.toUpperCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(r);
        }
      } catch {
        // A provider that cannot search still contributes prices.
      }
    }
    return out;
  }
}
