import type { BacktestConfig, IsoDate } from '../src/lib/types';
import type { PreparedAsset, PreparedData } from '../src/lib/engine/types';
import { defaultConfig } from '../src/lib/defaults';

/** Weekday calendar starting at `start` (which must itself be a weekday). */
export function makeCalendar(start: IsoDate, days: number): IsoDate[] {
  const out: IsoDate[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  while (out.length < days) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

export interface AssetSpec {
  symbol: string;
  /** One price per calendar day. Use `null` for "did not trade" (stale). */
  prices: Array<number | null>;
  weight: number;
  /** Per-share dividend keyed by calendar index. */
  dividends?: Record<number, number>;
  /** Split factor keyed by calendar index (only used with raw prices). */
  splitFactors?: Record<number, number>;
  expenseRatioPct?: number;
  isCash?: boolean;
  /** Index of the last day this security traded; defaults to the last day. */
  lastIndex?: number;
  /** Index of the first day this security traded; defaults to the first. */
  firstIndex?: number;
}

export function buildPrepared(
  calendar: IsoDate[],
  specs: AssetSpec[],
  riskFreeAnnual = 0,
  /** Price level relative to day 0; defaults to no inflation. */
  deflator?: number[],
): PreparedData {
  const assets: PreparedAsset[] = specs.map((spec) => {
    const n = calendar.length;
    const prices = new Array<number>(n).fill(Number.NaN);
    const stale = new Array<boolean>(n).fill(false);
    const dividends = new Array<number>(n).fill(0);
    const splitFactors = new Array<number>(n).fill(1);

    const firstIndex = spec.firstIndex ?? 0;
    const lastIndex = spec.lastIndex ?? n - 1;

    let carried = Number.NaN;
    for (let i = firstIndex; i <= lastIndex && i < n; i++) {
      const p = spec.prices[i];
      if (p == null) {
        if (Number.isFinite(carried)) {
          prices[i] = carried;
          stale[i] = true;
        }
      } else {
        prices[i] = p;
        carried = p;
      }
    }
    for (const [k, v] of Object.entries(spec.dividends ?? {})) dividends[Number(k)] = v;
    for (const [k, v] of Object.entries(spec.splitFactors ?? {})) splitFactors[Number(k)] = v;

    return {
      symbol: spec.symbol,
      name: spec.symbol,
      isCash: spec.isCash ?? false,
      targetWeight: spec.weight,
      expenseRatioPct: spec.expenseRatioPct ?? 0,
      prices: spec.isCash ? new Array(n).fill(1) : prices,
      stale,
      dividends,
      splitFactors,
      firstIndex,
      lastIndex,
    };
  });

  return {
    calendar,
    assets,
    warnings: [],
    riskFree: new Array(calendar.length).fill(riskFreeAnnual),
    deflator: deflator ?? new Array(calendar.length).fill(1),
    inflationSource: deflator ? { label: 'Test deflator', synthetic: true } : null,
    periodsPerYear: 252,
    sources: specs.map((s) => ({ symbol: s.symbol, source: 'test', synthetic: true })),
    anySynthetic: true,
  };
}

export function testConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    ...defaultConfig(),
    initialInvestment: 10_000,
    rebalance: 'never',
    dividends: 'reinvest',
    benchmarks: [],
    fees: {
      managementFeePct: 0,
      tradingCostBps: 0,
      commissionPerTrade: 0,
      defaultExpenseRatioPct: 0,
    },
    riskFree: { source: 'zero', constantPct: 0 },
    costBasisMethod: 'fifo',
    cashflows: [],
    inflation: { mode: 'off', constantPct: 2.5, adjustContributions: false },
    ...overrides,
  };
}

export const TEST_PORTFOLIO = { id: 'test', name: 'Test', positions: [] };

/** Straight-line price path from `from` to `to` over `n` days. */
export function ramp(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

/** Constant price path. */
export function flat(price: number, n: number): number[] {
  return new Array(n).fill(price);
}
