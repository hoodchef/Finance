import type {
  CorporateActions,
  DateRange,
  DividendEvent,
  IsoDate,
  PriceSeries,
  SecurityMeta,
} from '@/lib/types';

/**
 * The only surface the rest of the application is allowed to use to obtain
 * market data. Swapping Yahoo for Polygon/Tiingo/EODHD means writing one new
 * implementation of this interface — the engine, metrics and UI never change.
 */
export interface MarketDataProvider {
  /** Stable machine id, e.g. `yahoo`. Surfaced in results for transparency. */
  readonly id: string;
  /** Human label shown in the UI, e.g. "Yahoo Finance". */
  readonly label: string;
  /** True when this provider fabricates data instead of observing it. */
  readonly synthetic: boolean;
  /** Shown under results so users know exactly what they are looking at. */
  readonly description: string;

  getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries>;
  getCorporateActions(symbol: string, range: DateRange): Promise<CorporateActions>;
  getDividends(symbol: string, range: DateRange): Promise<DividendEvent[]>;
  /**
   * Trading days the given symbols actually traded on, ascending and
   * de-duplicated. Derived from observed bars rather than an exchange rule set,
   * so market holidays and half-days are handled by construction.
   */
  getTradingCalendar(range: DateRange, symbols?: string[]): Promise<IsoDate[]>;
  search(query: string): Promise<SecurityMeta[]>;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly symbol?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

export class UnknownSymbolError extends MarketDataError {
  constructor(symbol: string) {
    super(`No price history found for "${symbol}".`, symbol);
    this.name = 'UnknownSymbolError';
  }
}
