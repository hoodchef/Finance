import { runBacktest, type BacktestResult, type RunBacktestOptions } from '@/lib/backtest';
import { getProvider } from '@/lib/market-data';
import { cachedResult, resultKey } from '@/lib/result-cache';

/**
 * The one way an analysis surface asks for a backtest.
 *
 * Studies, the Simulator and the Lab all need the same computed result, and
 * each running it independently is what made moving between them cost twenty
 * seconds and feel like four separate products. Routing them through here
 * means the second surface is free.
 *
 * Kept as a named helper rather than inlined so the caching cannot be wired
 * one way in one route and another way in the next.
 */
export async function sharedBacktest(options: {
  portfolio: RunBacktestOptions['portfolio'];
  config: RunBacktestOptions['config'];
  includeAssetAnalysis?: boolean;
}): Promise<{ result: BacktestResult; cached: boolean }> {
  const provider = getProvider();
  const includeAssetAnalysis = options.includeAssetAnalysis ?? false;
  const key = resultKey({
    portfolio: options.portfolio,
    config: options.config,
    providerId: provider.id,
    includeAssetAnalysis,
  });
  return cachedResult(key, () =>
    runBacktest({
      portfolio: options.portfolio,
      config: options.config,
      provider,
      includeAssetAnalysis,
    }),
  );
}
