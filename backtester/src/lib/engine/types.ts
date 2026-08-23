import type {
  BacktestConfig,
  BacktestWarning,
  IsoDate,
  Portfolio,
  PriceSeries,
} from '@/lib/types';
import type { LotSummary, RealisedByYear, RealisedGain } from './lots';

export type TransactionType =
  | 'contribution'
  | 'withdrawal'
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'reinvest'
  | 'management-fee'
  | 'expense-ratio'
  | 'trading-cost'
  | 'cash-interest'
  | 'liquidation';

export interface Transaction {
  date: IsoDate;
  type: TransactionType;
  symbol?: string;
  shares?: number;
  price?: number;
  /** Signed cash impact on the account: positive adds cash, negative removes. */
  amount: number;
  note?: string;
}

export interface DailyRecord {
  date: IsoDate;
  /** Total portfolio value at the close: positions marked to market plus cash. */
  totalValue: number;
  cash: number;
  /** Market value per symbol at the close. */
  positionValues: Record<string, number>;
  positionShares: Record<string, number>;
  /** Net external cash flow settled today (contribution +, withdrawal −). */
  netFlow: number;
  /** Gross cash dividends with an ex-date of today. */
  dividendIncome: number;
  /** All costs charged today: management fee + fund drag + trading. */
  feesPaid: number;
  tradingCost: number;
  /** Time-weighted daily return, external flows removed. */
  twrReturn: number;
  /** Growth of 1.00 using chained time-weighted returns. */
  index: number;
  /** True when at least one price used today was carried forward. */
  hasStalePrice: boolean;
  rebalanced: boolean;
}

/** Exact dollar attribution per symbol. See `engine.ts` for the identity. */
export interface SymbolLedger {
  symbol: string;
  name: string;
  /** Cumulative cash spent buying, including reinvested dividends. */
  invested: number;
  /** Cumulative cash received from sales. */
  divested: number;
  /** Gross cash dividends received (whether or not reinvested). */
  dividends: number;
  /** Fund expense-ratio drag borne by this position. */
  expenseRatioCost: number;
  /** Trading costs attributed to this position. */
  tradingCost: number;
  endingShares: number;
  endingValue: number;
  /** endingValue + divested + dividends − invested − tradingCost. */
  profitAndLoss: number;
  /** Share of the portfolio's total gain, as a fraction. */
  shareOfGain: number;
  startWeight: number;
  endWeight: number;
  targetWeight: number;
}

export interface EngineResult {
  portfolioId: string;
  portfolioName: string;
  start: IsoDate;
  end: IsoDate;
  daily: DailyRecord[];
  transactions: Transaction[];
  ledgers: SymbolLedger[];
  warnings: BacktestWarning[];
  totals: {
    initialInvestment: number;
    totalContributions: number;
    totalWithdrawals: number;
    /** initialInvestment + contributions − withdrawals. */
    netInvested: number;
    finalValue: number;
    /** finalValue − netInvested. */
    investmentGain: number;
    totalDividends: number;
    totalManagementFees: number;
    totalExpenseRatioCost: number;
    totalTradingCosts: number;
    totalCashInterest: number;
    rebalanceCount: number;
    tradeCount: number;
    /** Gains crystallised by sales, before any tax. */
    totalRealisedGain: number;
    /** Gains still open in the positions held at the end. */
    totalUnrealisedGain: number;
  };
  /** Per-symbol cost basis and realised/unrealised split. */
  lots: LotSummary[];
  /** Every taxable disposal, in order. */
  realisedGains: RealisedGain[];
  /** Realised gains and dividend income bucketed by calendar year. */
  realisedByYear: RealisedByYear[];
  /** Observed trading periods per year, used to annualise risk statistics. */
  periodsPerYear: number;
}

export interface PreparedAsset {
  symbol: string;
  name: string;
  isCash: boolean;
  targetWeight: number;
  expenseRatioPct: number;
  /** Close aligned to the master calendar, forward-filled. NaN before inception. */
  prices: number[];
  /** True where the price is carried forward rather than observed. */
  stale: boolean[];
  /** Per-share cash dividend with an ex-date on each calendar day. */
  dividends: number[];
  /** Split factor applied on each calendar day (1 when no split). */
  splitFactors: number[];
  firstIndex: number;
  lastIndex: number;
  series?: PriceSeries;
}

export interface PreparedData {
  calendar: IsoDate[];
  assets: PreparedAsset[];
  warnings: BacktestWarning[];
  /** Annual risk-free rate as a decimal, aligned to the calendar. */
  riskFree: number[];
  /**
   * Price level relative to the first day, aligned to the calendar. Divide a
   * nominal value by it to express that value in first-day dollars. All ones
   * when inflation adjustment is off.
   */
  deflator: number[];
  /** Describes where the deflator came from; null when adjustment is off. */
  inflationSource: { label: string; synthetic: boolean } | null;
  periodsPerYear: number;
  sources: Array<{ symbol: string; source: string; synthetic: boolean }>;
  anySynthetic: boolean;
}

export interface EngineInput {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
  data: PreparedData;
  /** Benchmarks skip portfolio-level fees; see `runBacktest`. */
  applyPortfolioFees?: boolean;
}
