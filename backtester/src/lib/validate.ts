import type {
  BacktestConfig,
  ContributionFrequency,
  CashflowFrequency,
  CashflowKind,
  CashflowLeg,
  CostBasisMethod,
  InflationMode,
  DividendPolicy,
  InceptionPolicy,
  Portfolio,
  Position,
  RebalanceFrequency,
  RiskFreeSource,
} from '@/lib/types';
import { defaultConfig, MAX_HISTORY_START } from '@/lib/defaults';
import { isValidIso, todayIso } from '@/lib/market-data/dates';

/**
 * Request validation for the API routes.
 *
 * Written by hand rather than pulled from a schema library because every rule
 * here is a financial constraint with a specific message — "weights must not be
 * negative unless short positions are enabled" is more useful to a user than
 * "expected number, received number".
 */

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

function num(value: unknown, field: string, fallback?: number): number {
  if (value == null || value === '') {
    if (fallback != null) return fallback;
    throw new ValidationError(`${field} is required.`, field);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number.`, field);
  return n;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value == null) return fallback;
  if (!allowed.includes(value as T)) {
    throw new ValidationError(
      `${field} must be one of: ${allowed.join(', ')}.`,
      field,
    );
  }
  return value as T;
}

const REBALANCE: readonly RebalanceFrequency[] = [
  'never', 'monthly', 'quarterly', 'semiannual', 'annual', 'threshold',
];
const CONTRIBUTION: readonly ContributionFrequency[] = ['none', 'monthly', 'quarterly', 'annual'];
const DIVIDENDS: readonly DividendPolicy[] = ['reinvest', 'cash'];
const INCEPTION: readonly InceptionPolicy[] = ['truncate', 'error', 'cash'];
const RISK_FREE: readonly RiskFreeSource[] = ['zero', 'constant', 'tbill'];
const COST_BASIS: readonly CostBasisMethod[] = ['fifo', 'average', 'hifo'];
const INFLATION: readonly InflationMode[] = ['off', 'cpi', 'constant'];
const CASHFLOW_FREQ: readonly CashflowFrequency[] = [
  'once', 'monthly', 'quarterly', 'semiannual', 'annual',
];
const CASHFLOW_KIND: readonly CashflowKind[] = ['fixed', 'percentOfPortfolio'];
const MAX_CASHFLOW_LEGS = 8;

/** Tickers are provider identifiers, so keep the character set tight. */
const SYMBOL_RE = /^[A-Za-z0-9.^=:-]{1,20}$/;

export function parseSymbol(raw: unknown, field = 'symbol'): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new ValidationError(`${field} is required.`, field);
  if (!SYMBOL_RE.test(s)) {
    throw new ValidationError(
      `"${s}" is not a valid ticker. Use letters, digits and . ^ - = : only.`,
      field,
    );
  }
  return s;
}

export function parsePositions(raw: unknown): Position[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('Add at least one holding before running a backtest.', 'positions');
  }
  if (raw.length > 40) {
    throw new ValidationError('A portfolio is limited to 40 holdings.', 'positions');
  }

  const positions = raw.map((p, i) => {
    const record = (p ?? {}) as Record<string, unknown>;
    const symbol = parseSymbol(record.symbol, `holding ${i + 1}`);
    const weight = num(record.weight, `weight for ${symbol}`, 0);
    if (weight < 0) {
      throw new ValidationError(
        `${symbol} has a negative weight (${weight}%). Short positions are not supported yet.`,
        'positions',
      );
    }
    const expenseRatio = record.expenseRatio == null ? undefined : num(record.expenseRatio, `expense ratio for ${symbol}`, 0);
    if (expenseRatio != null && (expenseRatio < 0 || expenseRatio > 10)) {
      throw new ValidationError(
        `${symbol} has an expense ratio of ${expenseRatio}%. Enter it as a percentage, e.g. 0.03 for 3 basis points.`,
        'positions',
      );
    }
    return {
      id: String(record.id ?? `${symbol}-${i}`),
      symbol,
      name: record.name ? String(record.name) : undefined,
      weight,
      expenseRatio,
    } satisfies Position;
  });

  const total = positions.reduce((a, p) => a + p.weight, 0);
  if (total <= 0) {
    throw new ValidationError(
      'Total allocation is 0%. Give at least one holding a weight.',
      'positions',
    );
  }
  return positions;
}

export function parsePortfolio(raw: unknown): Pick<Portfolio, 'id' | 'name' | 'positions'> {
  const record = (raw ?? {}) as Record<string, unknown>;
  const name = String(record.name ?? 'Portfolio').slice(0, 120) || 'Portfolio';
  return {
    id: String(record.id ?? 'portfolio'),
    name,
    positions: parsePositions(record.positions),
  };
}

export function parseConfig(raw: unknown): BacktestConfig {
  const d = defaultConfig();
  const record = (raw ?? {}) as Record<string, unknown>;

  const start = String(record.start ?? d.start);
  const end = String(record.end ?? d.end);
  if (!isValidIso(start)) throw new ValidationError('Start date must be YYYY-MM-DD.', 'start');
  if (!isValidIso(end)) throw new ValidationError('End date must be YYYY-MM-DD.', 'end');
  if (start >= end) {
    throw new ValidationError('The start date must be before the end date.', 'start');
  }
  if (start < MAX_HISTORY_START) {
    throw new ValidationError(
      `The earliest supported start date is ${MAX_HISTORY_START}.`,
      'start',
    );
  }
  const today = todayIso();

  const initialInvestment = num(record.initialInvestment, 'Initial investment', d.initialInvestment);
  if (initialInvestment < 0) {
    throw new ValidationError('Initial investment cannot be negative.', 'initialInvestment');
  }
  const contributionAmount = Math.abs(num(record.contributionAmount, 'Contribution', 0));
  const contributionFrequency = oneOf(record.contributionFrequency, CONTRIBUTION, 'Contribution frequency', d.contributionFrequency);
  if (initialInvestment === 0 && (contributionFrequency === 'none' || contributionAmount === 0)) {
    throw new ValidationError(
      'With no initial investment and no recurring contribution there is nothing to invest.',
      'initialInvestment',
    );
  }

  const feesRaw = (record.fees ?? {}) as Record<string, unknown>;
  const managementFeePct = num(feesRaw.managementFeePct, 'Management fee', 0);
  const tradingCostBps = num(feesRaw.tradingCostBps, 'Trading cost', 0);
  const commissionPerTrade = num(feesRaw.commissionPerTrade, 'Commission', 0);
  const defaultExpenseRatioPct = num(feesRaw.defaultExpenseRatioPct, 'Default expense ratio', 0);
  for (const [label, value, max] of [
    ['Management fee', managementFeePct, 20],
    ['Trading cost', tradingCostBps, 1000],
    ['Commission', commissionPerTrade, 1000],
    ['Default expense ratio', defaultExpenseRatioPct, 10],
  ] as const) {
    if (value < 0) throw new ValidationError(`${label} cannot be negative.`, 'fees');
    if (value > max) throw new ValidationError(`${label} of ${value} is out of range.`, 'fees');
  }

  const rebalanceThresholdPct = num(record.rebalanceThresholdPct, 'Drift band', d.rebalanceThresholdPct);
  if (rebalanceThresholdPct <= 0 || rebalanceThresholdPct > 50) {
    throw new ValidationError('The drift band must be between 0 and 50 percentage points.', 'rebalanceThresholdPct');
  }

  const cashYieldPct = num(record.cashYieldPct, 'Cash yield', 0);
  if (cashYieldPct < 0 || cashYieldPct > 25) {
    throw new ValidationError('Cash yield must be between 0% and 25%.', 'cashYieldPct');
  }

  const riskFreeRaw = (record.riskFree ?? {}) as Record<string, unknown>;
  const constantPct = num(riskFreeRaw.constantPct, 'Risk-free rate', d.riskFree.constantPct);
  if (constantPct < 0 || constantPct > 25) {
    throw new ValidationError('The risk-free rate must be between 0% and 25%.', 'riskFree');
  }

  const benchmarks = Array.isArray(record.benchmarks)
    ? [...new Set(record.benchmarks.map((b) => parseSymbol(b, 'benchmark')))].slice(0, 6)
    : d.benchmarks;

  return {
    start,
    end: end > today ? today : end,
    initialInvestment,
    contributionAmount,
    contributionFrequency,
    contributionIsWithdrawal: Boolean(record.contributionIsWithdrawal),
    rebalance: oneOf(record.rebalance, REBALANCE, 'Rebalancing', d.rebalance),
    rebalanceThresholdPct,
    dividends: oneOf(record.dividends, DIVIDENDS, 'Dividend policy', d.dividends),
    fees: { managementFeePct, tradingCostBps, commissionPerTrade, defaultExpenseRatioPct },
    inceptionPolicy: oneOf(record.inceptionPolicy, INCEPTION, 'Inception policy', d.inceptionPolicy),
    cashYieldPct,
    riskFree: {
      source: oneOf(riskFreeRaw.source, RISK_FREE, 'Risk-free source', d.riskFree.source),
      constantPct,
    },
    costBasisMethod: oneOf(
      record.costBasisMethod,
      COST_BASIS,
      'Cost basis method',
      d.costBasisMethod,
    ),
    inflation: parseInflation(record.inflation, d),
    cashflows: parseCashflows(record.cashflows),
    benchmarks,
  };
}

function parseInflation(
  raw: unknown,
  d: BacktestConfig,
): BacktestConfig['inflation'] {
  const record = (raw ?? {}) as Record<string, unknown>;
  const constantPct = num(record.constantPct, 'Assumed inflation rate', d.inflation.constantPct);
  if (constantPct < -20 || constantPct > 50) {
    throw new ValidationError(
      'The assumed inflation rate must be between -20% and 50% a year.',
      'inflation',
    );
  }
  return {
    mode: oneOf(record.mode, INFLATION, 'Inflation mode', d.inflation.mode),
    constantPct,
    adjustContributions: Boolean(record.adjustContributions),
  };
}

/**
 * Cashflow legs. The bounds here are the difference between a model and a
 * fantasy: a leg growing 500% a year, or one that fires every day for a
 * century, produces numbers that look precise and mean nothing.
 */
function parseCashflows(raw: unknown): CashflowLeg[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError('Cashflows must be a list.', 'cashflows');
  }
  if (raw.length > MAX_CASHFLOW_LEGS) {
    throw new ValidationError(
      `At most ${MAX_CASHFLOW_LEGS} cashflow legs are supported.`,
      'cashflows',
    );
  }

  return raw.map((entry, i) => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const label = `Cashflow ${i + 1}`;
    const kind = oneOf(r.kind, CASHFLOW_KIND, `${label} type`, 'fixed');
    const amount = num(r.amount, `${label} amount`, 0);

    if (kind === 'percentOfPortfolio' && Math.abs(amount) > 100) {
      throw new ValidationError(
        `${label} takes ${Math.abs(amount)}% of the portfolio, which is more than exists.`,
        'cashflows',
      );
    }

    const offsetMonths = num(r.offsetMonths, `${label} offset`, 0);
    if (offsetMonths < 0 || offsetMonths > 1200) {
      throw new ValidationError(
        `${label} offset must be between 0 and 1200 months.`,
        'cashflows',
      );
    }

    const rawDuration = r.durationMonths;
    const durationMonths =
      rawDuration == null || rawDuration === '' ? null : num(rawDuration, `${label} duration`, 0);
    if (durationMonths != null && (durationMonths <= 0 || durationMonths > 1200)) {
      throw new ValidationError(
        `${label} duration must be between 1 and 1200 months, or left blank to run to the end.`,
        'cashflows',
      );
    }

    const annualGrowthPct = num(r.annualGrowthPct, `${label} growth`, 0);
    if (annualGrowthPct < -50 || annualGrowthPct > 50) {
      throw new ValidationError(
        `${label} grows ${annualGrowthPct}% a year, which is outside the supported range.`,
        'cashflows',
      );
    }

    return {
      id: String(r.id ?? `leg-${i}`),
      label: r.label ? String(r.label).slice(0, 60) : undefined,
      amount,
      kind,
      frequency: oneOf(r.frequency, CASHFLOW_FREQ, `${label} frequency`, 'monthly'),
      offsetMonths,
      durationMonths,
      annualGrowthPct,
      adjustForInflation: Boolean(r.adjustForInflation),
    } satisfies CashflowLeg;
  });
}
