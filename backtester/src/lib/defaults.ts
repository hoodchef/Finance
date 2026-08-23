import type { BacktestConfig } from '@/lib/types';
import { addYears, todayIso } from '@/lib/market-data/dates';

export const DEFAULT_BENCHMARKS = ['SPY'];

export function defaultConfig(): BacktestConfig {
  const end = todayIso();
  return {
    start: addYears(end, -10),
    end,
    initialInvestment: 10_000,
    contributionAmount: 0,
    contributionFrequency: 'none',
    contributionIsWithdrawal: false,
    rebalance: 'annual',
    rebalanceThresholdPct: 5,
    dividends: 'reinvest',
    fees: {
      managementFeePct: 0,
      tradingCostBps: 0,
      commissionPerTrade: 0,
      defaultExpenseRatioPct: 0,
    },
    inceptionPolicy: 'truncate',
    cashYieldPct: 0,
    riskFree: { source: 'zero', constantPct: 0 },
    costBasisMethod: 'fifo',
    cashflows: [],
    inflation: { mode: 'off', constantPct: 2.5, adjustContributions: false },
    benchmarks: [...DEFAULT_BENCHMARKS],
  };
}

export const RANGE_PRESETS: Array<{ id: string; label: string; years: number | 'max' }> = [
  { id: '1y', label: '1Y', years: 1 },
  { id: '3y', label: '3Y', years: 3 },
  { id: '5y', label: '5Y', years: 5 },
  { id: '10y', label: '10Y', years: 10 },
  { id: '20y', label: '20Y', years: 20 },
  { id: 'max', label: 'Max', years: 'max' },
];

/** The earliest date the app will request; providers rarely have more. */
export const MAX_HISTORY_START = '1985-01-01';
