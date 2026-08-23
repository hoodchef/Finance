import type { MarketDataProvider } from './provider';
import { YahooFinanceProvider } from './yahoo';
import { TiingoProvider } from './tiingo';
import { DemoDataProvider } from './demo';

export type ProviderId = 'yahoo' | 'tiingo' | 'demo';

const providers: Record<ProviderId, MarketDataProvider> = {
  yahoo: new YahooFinanceProvider(),
  tiingo: new TiingoProvider(),
  demo: new DemoDataProvider(),
};

/** Providers that serve observed market data, in preference order. */
const REAL_PROVIDER_IDS: ProviderId[] = ['tiingo', 'yahoo'];

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

  // Unset or unrecognised: prefer a keyed, documented provider when one is
  // configured, and fall back to Yahoo. Never to synthetic — a typo in an
  // environment variable must not downgrade a deployment to invented prices.
  if (process.env.TIINGO_API_KEY?.trim()) return providers.tiingo;
  return providers.yahoo;
}

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

export { YahooFinanceProvider, TiingoProvider, DemoDataProvider };
export * from './licence';
export { REAL_PROVIDER_IDS };
export * from './provider';
export * from './integrity';
