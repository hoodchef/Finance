import type { MarketDataProvider } from './provider';
import { YahooFinanceProvider } from './yahoo';
import { TiingoProvider } from './tiingo';
import { PolygonProvider } from './polygon';
import { AlphaVantageProvider } from './alphavantage';
import { DemoDataProvider } from './demo';
import { FailoverProvider } from './failover';

export type ProviderId = 'yahoo' | 'tiingo' | 'alphavantage' | 'polygon' | 'demo';

const providers: Record<ProviderId, MarketDataProvider> = {
  yahoo: new YahooFinanceProvider(),
  tiingo: new TiingoProvider(),
  alphavantage: new AlphaVantageProvider(),
  polygon: new PolygonProvider(),
  demo: new DemoDataProvider(),
};

/** Providers that serve observed market data, in preference order. */
const REAL_PROVIDER_IDS: ProviderId[] = ['tiingo', 'yahoo', 'alphavantage'];

/**
 * Resolves the market-data provider for this deployment.
 *
 * DELIBERATELY TAKES NO ARGUMENT.
 *
 * This previously accepted an id, and the API routes passed `body.provider`
 * straight through — meaning any client could ask for synthetic prices and
 * receive a result that walked and talked like a real backtest. Which data a
 * deployment serves is an operator decision, not something a request may
 * choose. Demo mode is enabled by setting `MARKET_DATA_PROVIDER=demo` on the
 * server, and everything it produces is stamped synthetic all the way to the
 * screen.
 *
 * An unrecognised value falls back to real data rather than synthetic: a typo
 * in an environment variable must never silently downgrade a deployment to
 * invented prices.
 */
export function getProvider(): MarketDataProvider {
  const configured = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();

  if (configured === 'demo') return providers.demo;
  if (configured === 'tiingo') return providers.tiingo;
  if (configured === 'yahoo') return providers.yahoo;
  if (configured === 'alphavantage') return providers.alphavantage;
  if (configured === 'polygon') return providers.polygon;

  // Unset or unrecognised: chain the real providers so a coverage gap in one
  // is filled by the next. Never synthetic — a typo in an environment variable
  // must not downgrade a deployment to invented prices.
  // Order matters. Tiingo first for its quota and explicit corporate actions;
  // Yahoo behind it; Alpha Vantage last, and only for Canadian listings, which
  // it serves at WEEKLY resolution. Putting it last means a US symbol never
  // reaches it, so an otherwise-daily backtest cannot be silently coarsened.
  const tail: MarketDataProvider[] = process.env.ALPHA_VANTAGE_API_KEY?.trim()
    ? [providers.alphavantage]
    : [];

  /*
   * Polygon sits between Tiingo and Yahoo.
   *
   * Two reasons, and the first is about budget rather than coverage. Each
   * vendor rate-limits separately — Tiingo about fifty an hour, Polygon about
   * five a minute — so chaining them adds the allowances together instead of
   * making one vendor's ceiling the whole application's. A five-symbol
   * optimisation that exhausted Polygon alone now finishes on Tiingo.
   *
   * The second is reach: Polygon is the only one here that serves crypto
   * (`X:BTCUSD`) and individual option contracts, so a symbol the others
   * cannot resolve falls through to something that can. The universe becomes
   * the union rather than the intersection.
   *
   * It goes behind Tiingo because Tiingo's quota is larger per hour and its
   * corporate actions are explicit, and ahead of Yahoo because Yahoo is an
   * undocumented endpoint that rate-limits by IP without notice.
   */
  const polygon: MarketDataProvider[] = process.env.POLYGON_API_KEY?.trim()
    ? [providers.polygon]
    : [];

  if (process.env.TIINGO_API_KEY?.trim()) {
    chained ??= new FailoverProvider([
      providers.tiingo,
      ...polygon,
      providers.yahoo,
      ...tail,
    ]);
    return chained;
  }
  if (polygon.length) {
    chained ??= new FailoverProvider([...polygon, providers.yahoo, ...tail]);
    return chained;
  }
  if (tail.length) {
    chained ??= new FailoverProvider([providers.yahoo, ...tail]);
    return chained;
  }
  return providers.yahoo;
}

/** Built once; the providers behind it hold their own caches. */
let chained: MarketDataProvider | undefined;

/** True when this deployment is serving generated prices. */
export function isDemoMode(): boolean {
  return getProvider().synthetic;
}

/**
 * The demo provider, for tests and for the explicitly-labelled demo surfaces.
 * Never reachable from a request.
 */
export function getDemoProvider(): MarketDataProvider {
  return providers.demo;
}

export function listProviders(): MarketDataProvider[] {
  return Object.values(providers);
}

export {
  YahooFinanceProvider,
  TiingoProvider,
  AlphaVantageProvider,
  DemoDataProvider,
  FailoverProvider,
};
export { isCanadianSymbol, toAlphaVantageSymbol } from './alphavantage';
export * from './licence';
export { REAL_PROVIDER_IDS };
export * from './provider';
export * from './integrity';
