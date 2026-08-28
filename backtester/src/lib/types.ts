/**
 * Core domain types shared by the market-data layer, the backtesting engine and
 * the UI. Nothing in here depends on React or on Next.js — the engine is meant
 * to be usable from a script, a worker or a test runner.
 */

/** Calendar date in `YYYY-MM-DD` form. All dates in this app are exchange-local. */
export type IsoDate = string;

export type AssetClass =
  | 'equity'
  | 'etf'
  | 'index'
  | 'mutualfund'
  | 'crypto'
  | 'cash'
  | 'other';

/** The synthetic ticker used for an explicit cash sleeve in a portfolio. */
export const CASH_SYMBOL = 'CASH';

export interface SecurityMeta {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /**
   * Reporting currency, when the provider states it. Undefined means UNKNOWN —
   * not USD. Asserting a default here would let a CAD-denominated holding be
   * summed with USD ones as though the units matched.
   */
  currency?: string;
  exchange?: string;
  /** First date for which the provider has price data. */
  firstTradeDate?: IsoDate;
  /** Last date for which the provider has price data (used to detect delisting). */
  lastTradeDate?: IsoDate;
}

export interface PriceBar {
  date: IsoDate;
  open: number;
  high: number;
  low: number;
  /**
   * Split-adjusted close, NOT dividend-adjusted. This is the price the engine
   * transacts at. See `PriceSeries.adjustment` for the guarantee.
   */
  close: number;
  /**
   * Total-return adjusted close (splits *and* dividends). Used only for
   * data-integrity cross-checks and for quick single-asset reference maths —
   * the engine never transacts at this price.
   */
  adjClose: number;
  volume: number;
}

export interface DividendEvent {
  /** Ex-dividend date. */
  date: IsoDate;
  /** Cash per share, in the same split-adjusted units as `PriceBar.close`. */
  amount: number;
}

export interface SplitEvent {
  date: IsoDate;
  numerator: number;
  denominator: number;
}

export interface CorporateActions {
  dividends: DividendEvent[];
  splits: SplitEvent[];
}

/**
 * How the price series has been adjusted. The engine behaves differently for
 * each, so providers must state this explicitly rather than leaving it implied.
 *
 * - `split-adjusted`: `close` and `DividendEvent.amount` are both retroactively
 *   restated into current-share units. Share counts therefore need no split
 *   handling — a split is a no-op for portfolio value. (Yahoo Finance behaves
 *   this way; `tests/market-data.test.ts` asserts it against real data.)
 * - `raw`: prices are as-traded. The engine multiplies share counts by the
 *   split ratio on the ex-date.
 */
export type PriceAdjustment = 'split-adjusted' | 'raw';

/**
 * Spacing of the bars in a series.
 *
 * Not cosmetic: it sets how returns annualise, and it decides whether a
 * drawdown between bars is observable at all. A weekly series cannot show a
 * Tuesday crash that recovered by Friday, so a maximum drawdown computed from
 * one is a floor, not the figure.
 */
export type BarInterval = 'daily' | 'weekly' | 'monthly';

export interface PriceSeries {
  meta: SecurityMeta;
  bars: PriceBar[];
  dividends: DividendEvent[];
  splits: SplitEvent[];
  adjustment: PriceAdjustment;
  /**
   * Bar spacing. Optional so existing daily providers need no change; absent
   * means daily.
   */
  interval?: BarInterval;
  /** Provider id the data came from, surfaced in the UI for transparency. */
  source: string;
  /** True when the numbers are generated rather than observed. */
  synthetic: boolean;
  fetchedAt: string;
  /**
   * True when this series was served from an expired cache because the
   * provider could not be reached. The prices are real, but they may be
   * missing recent sessions, and the user is told so.
   */
  stale?: boolean;
}

export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

/* ------------------------------------------------------------------ */
/* Portfolio definition                                                */
/* ------------------------------------------------------------------ */

export interface Position {
  id: string;
  symbol: string;
  name?: string;
  /** Target weight as a percentage, e.g. `40` for 40%. */
  weight: number;
  /** Annual fund expense ratio in percent, e.g. `0.03`. Charged as NAV drag. */
  expenseRatio?: number;
}

export interface Portfolio {
  id: string;
  name: string;
  positions: Position[];
  createdAt: string;
  updatedAt: string;
  /** Set when the portfolio was created from a built-in preset. */
  presetId?: string;
}

/* ------------------------------------------------------------------ */
/* Backtest configuration                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Strategy                                                            */
/* ------------------------------------------------------------------ */

/**
 * A rule for deciding target weights, stored as data rather than as a function.
 *
 * The engine's strategies are closures over their options, which is the right
 * shape for the day loop and the wrong shape for everything around it: a
 * config is JSON, saved to the database, shared by link, replayed from a URL
 * and compared against other runs. A closure survives none of that. So the
 * product stores a description of the strategy and `buildStrategy` turns it
 * into the closure at the point of use.
 *
 * It also makes a strategy inspectable — a saved run can say what rule
 * produced it, which matters more here than usual, because a portfolio's
 * weights no longer tell you what it did.
 */
/** A rule that decides target weights from nothing. */
export type StrategyBaseSpec =
  | { kind: 'fixed' }
  | { kind: 'equal' }
  | {
      kind: 'glidepath';
      /** Symbols forming the growth sleeve; the rest are defensive. */
      growthSymbols: string[];
      /** Growth allocation at the start and end, as percentages. */
      startGrowthPct: number;
      endGrowthPct: number;
    }
  | {
      kind: 'momentum';
      /** Trailing ranking window, in trading days. */
      lookbackDays: number;
      /** How many of the strongest holdings to hold. */
      holdCount: number;
      /** Holdings below this trailing return are left in cash. */
      minimumReturnPct: number;
    }
  | {
      kind: 'inverseVolatility';
      /** Window over which volatility is measured, in trading days. */
      lookbackDays: number;
    }
  | {
      kind: 'minimumVariance';
      /** Window the covariance is estimated over, in trading days. */
      lookbackDays: number;
      /** Ledoit–Wolf shrinkage toward constant correlation. */
      shrink: boolean;
      /** Upper bound per holding, so a solution cannot be one asset. */
      maxWeightPct: number;
    }
  | {
      kind: 'riskParity';
      lookbackDays: number;
      shrink: boolean;
      maxWeightPct: number;
    };

/**
 * A transform applied to the weights a base produced.
 *
 * Overlays may only reduce or redistribute — none can invent exposure the base
 * did not ask for, and anything removed falls to cash. That is what makes a
 * stack of them safe to reason about.
 */
export type StrategyOverlaySpec =
  | {
      kind: 'trend';
      /** Moving-average window, in trading days. */
      windowDays: number;
    }
  | {
      kind: 'volatilityTarget';
      /** Annualised portfolio volatility to aim for, as a percentage. */
      targetVolPct: number;
      lookbackDays: number;
    }
  | {
      kind: 'cap';
      /** Ceiling on any single holding, as a percentage. */
      maxWeightPct: number;
    };

/**
 * A strategy: one base, and any number of overlays over it.
 *
 * The flat forms are kept because configs written before composition existed
 * use them, and they arrive from saved runs and shared links. A flat `trend`
 * normalises to a fixed base under a trend overlay, which is exactly what it
 * has always done — it read the declared weights and zeroed the holdings below
 * their average.
 */
export type StrategySpec =
  | StrategyBaseSpec
  | StrategyOverlaySpec
  | {
      kind: 'composed';
      base: StrategyBaseSpec;
      overlays: StrategyOverlaySpec[];
    };

export type StrategyKind = StrategySpec['kind'];
export type StrategyBaseKind = StrategyBaseSpec['kind'];
export type StrategyOverlayKind = StrategyOverlaySpec['kind'];

export const DEFAULT_STRATEGY: StrategySpec = { kind: 'fixed' };

export type RebalanceFrequency =
  | 'never'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'threshold';

export type ContributionFrequency = 'none' | 'monthly' | 'quarterly' | 'annual';

export type CashflowFrequency =
  | 'once'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

/**
 * How a leg's amount is determined at each occurrence.
 *
 * - `fixed` — a dollar amount, optionally grown by a rate or by inflation.
 * - `percentOfPortfolio` — a share of the balance on the day it fires, which is
 *   how percentage withdrawal rules actually behave.
 */
export type CashflowKind = 'fixed' | 'percentOfPortfolio';

/**
 * One scheduled stream of money into or out of the account. Several can run at
 * once — a monthly contribution that stops at retirement alongside an annual
 * withdrawal that starts there is two legs, not a special case.
 */
export interface CashflowLeg {
  id: string;
  label?: string;
  /** Positive pays in, negative takes out. Percent for `percentOfPortfolio`. */
  amount: number;
  kind: CashflowKind;
  frequency: CashflowFrequency;
  /** Months after the backtest start before the first occurrence. */
  offsetMonths: number;
  /** Stop after this many months; null runs to the end of the backtest. */
  durationMonths: number | null;
  /** Compound growth applied to the amount each year, percent. */
  annualGrowthPct: number;
  /** Also grow with the price level, holding purchasing power constant. */
  adjustForInflation: boolean;
}

/**
 * What happens to a cash dividend.
 *
 * `ignore` excludes them entirely, producing a PRICE RETURN rather than a total
 * return. It exists for one honest reason: comparing against a price index such
 * as ^GSPC, which itself excludes dividends. It is not a data-availability
 * workaround — both supported providers supply dividends for free — and using
 * it for a normal backtest understates results badly: roughly 40% of a 30-year
 * equity result and 70% of a bond result. Every run that uses it says so.
 */
export type DividendPolicy = 'reinvest' | 'cash' | 'ignore';

/**
 * How to handle assets whose price history starts after the requested start
 * date (or ends before the requested end date).
 */
export type InceptionPolicy = 'truncate' | 'error' | 'cash';

export type RiskFreeSource = 'zero' | 'constant' | 'tbill';

/**
 * How the cost basis of a sold holding is determined.
 *
 * - `fifo` — oldest shares first. The US default when no other election is made.
 * - `average` — one pooled average cost across all shares. Mandatory for
 *   Canadian taxable accounts (adjusted cost base), and so the holding period
 *   of an individual share is not meaningful under it.
 * - `hifo` — highest cost first, which realises the smallest gain.
 */
export type CostBasisMethod = 'fifo' | 'average' | 'hifo';

/**
 * How results are expressed in real terms.
 *
 * - `off` — nominal only.
 * - `cpi` — deflated by the published US CPI series. Measured data.
 * - `constant` — deflated by a rate the user supplied. An assumption, and
 *   labelled as one everywhere a figure derived from it appears.
 */
export type InflationMode = 'off' | 'cpi' | 'constant';

export interface FeeConfig {
  /** Annual portfolio-level advisory/management fee, percent per year. */
  managementFeePct: number;
  /** Per-trade cost in basis points of traded notional. */
  tradingCostBps: number;
  /** Flat cost per executed trade, in account currency. */
  commissionPerTrade: number;
  /**
   * Fallback annual expense ratio (percent) applied to any position that does
   * not carry its own. Fund expense ratios are modelled as NAV drag and are
   * reported separately from the portfolio-level management fee.
   */
  defaultExpenseRatioPct: number;
}

export interface BacktestConfig {
  start: IsoDate;
  end: IsoDate;
  initialInvestment: number;
  contributionAmount: number;
  contributionFrequency: ContributionFrequency;
  /** Negative contributions are withdrawals; this flips the sign for clarity. */
  contributionIsWithdrawal: boolean;
  rebalance: RebalanceFrequency;
  /** Drift band in percentage points, used when `rebalance === 'threshold'`. */
  rebalanceThresholdPct: number;
  /**
   * Rule deciding target weights at each rebalance. Absent means the declared
   * weights, which is what every run did before strategies were reachable.
   */
  strategy?: StrategySpec;
  dividends: DividendPolicy;
  fees: FeeConfig;
  inceptionPolicy: InceptionPolicy;
  /** Annual yield on the CASH sleeve and on idle cash, percent. */
  cashYieldPct: number;
  riskFree: {
    source: RiskFreeSource;
    /** Used when `source === 'constant'`, percent per year. */
    constantPct: number;
  };
  /** Basis method used to split gains into realised and unrealised. */
  costBasisMethod: CostBasisMethod;
  /**
   * Currency every holding is translated into before being valued.
   *
   * When unset, the currency held by the largest share of the portfolio is
   * used, so a single-currency portfolio is never converted and gains no FX
   * noise it did not actually experience.
   */
  baseCurrency?: string;
  /** Additional scheduled flows, on top of the simple recurring contribution. */
  cashflows: CashflowLeg[];
  inflation: {
    mode: InflationMode;
    /** Assumed annual rate, percent, used when `mode === 'constant'`. */
    constantPct: number;
    /** Grow recurring contributions with inflation so they stay constant in real terms. */
    adjustContributions: boolean;
  };
  benchmarks: string[];
}

/* ------------------------------------------------------------------ */
/* Warnings                                                            */
/* ------------------------------------------------------------------ */

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface BacktestWarning {
  severity: WarningSeverity;
  code: string;
  message: string;
  symbol?: string;
}
