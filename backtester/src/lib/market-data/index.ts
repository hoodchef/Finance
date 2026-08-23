import type { MarketDataProvider } from './provider';
import { YahooFinanceProvider } from './yahoo';
import { DemoDataProvider } from './demo';

export type ProviderId = 'yahoo' | 'demo';

const providers: Record<ProviderId, MarketDataProvider> = {
  yahoo: new YahooFinanceProvider(),
  demo: new DemoDataProvider(),
};

export function getProvider(id?: string): MarketDataProvider {
  const key = (id ?? process.env.MARKET_DATA_PROVIDER ?? 'yahoo').toLowerCase();
  return providers[key as ProviderId] ?? providers.yahoo;
}

export function listProviders(): MarketDataProvider[] {
  return Object.values(providers);
}

export { YahooFinanceProvider, DemoDataProvider };
export * from './provider';
export * from './integrity';
