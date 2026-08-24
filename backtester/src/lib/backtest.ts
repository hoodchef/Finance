import type {
  BacktestConfig,
  BacktestWarning,
  IsoDate,
  Portfolio,
  Position,
} from '@/lib/types';
import { CASH_SYMBOL } from '@/lib/types';
import { getProvider } from '@/lib/market-data';
import { MarketDataError } from '@/lib/market-data/provider';
import { daysBetween, minIso, todayIso } from '@/lib/market-data/dates';
import type { MarketDataProvider } from '@/lib/market-data/provider';
import { prepareData } from '@/lib/engine/prepare';
import { runEngine } from '@/lib/engine/engine';
import type { EngineResult, PreparedData, SymbolLedger, Transaction } from '@/lib/engine/types';
import type { LotSummary, RealisedByYear } from '@/lib/engine/lots';
import {
  cashFlowsFromResult,
  computeAllRolling,
  computeCorrelationMatrix,
  computeMetrics,
  drawdownSeries,
  type CorrelationMatrix,
  type PerformanceMetrics,
  type RollingSeries,
} from '@/lib/metrics';
import { buildInsights, type Insight } from '@/lib/analysis/insights';

export const ENGINE_VERSION = '1.0.0';

/** Points sent to the browser for charting. Metrics always use the full series. */
const MAX_CHART_POINTS = 1600;

export interface SeriesPoint {
  date: IsoDate;
  /** Portfolio dollar value at the close. */
  value: number;
  /** Value expressed in first-day dollars. Equal to `value` when adjustment is off. */
  realValue: number;
  /** Growth of 1.00, time-weighted. */
  index: number;
  /** Negative fraction from the prior high of `index`. */
  drawdown: number;
  /** Cumulative capital contributed by this date. */
  contributed: number;
  cash: number;
}

export interface InflationInfo {
  mode: BacktestConfig['inflation']['mode'];
  label: string;
  /** True when the price path is an assumption rather than a measurement. */
  synthetic: boolean;
  /** Total price-level increase across the backtest, as a fraction. */
  totalInflation: number;
  /** Annualised inflation across the backtest. */
  annualisedInflation: number;
}

export interface BenchmarkResult {
  symbol: string;
  name: string;
  metrics: PerformanceMetrics;
  series: SeriesPoint[];
  finalValue: number;
}

export interface AssetAnalysis {
  symbol: string;
  name: string;
  ledger: SymbolLedger | null;
  /** Standalone buy-and-hold statistics for the asset over the same window. */
  metrics: PerformanceMetrics;
  series: SeriesPoint[];
  firstDate: IsoDate;
  lastDate: IsoDate;
}

export interface AllocationPoint {
  date: IsoDate;
  weights: Record<string, number>;
}

export interface DataSourceInfo {
  providerId: string;
  providerLabel: string;
  providerDescription: string;
  synthetic: boolean;
  symbols: Array<{
    symbol: string;
    source: string;
    synthetic: boolean;
    fetchedAt?: string;
    lastBarDate?: string;
    stale?: boolean;
  }>;
  /**
   * Oldest retrieval time across every series used. The oldest, not the
   * newest: a result is only as current as its stalest input.
   */
  retrievedAt: string | null;
  /**
   * Most recent session any series covers, and how far behind today that is.
   * A backtest run on Monday against data ending Thursday is not wrong, but the
   * user should be told rather than left to assume it is current.
   */
  latestSessionDate: string | null;
  dataAgeDays: number | null;
  /** True when any series came from an expired cache after a provider failure. */
  servedFromStaleCache: boolean;
}

export interface BacktestResult {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
  effectiveStart: IsoDate;
  effectiveEnd: IsoDate;
  totals: EngineResult['totals'];
  metrics: PerformanceMetrics;
  /**
   * The same statistics computed on the inflation-deflated index. Null when
   * adjustment is off or the price series could not be loaded — never a copy of
   * the nominal figures under a "real" label.
   */
  realMetrics: PerformanceMetrics | null;
  inflation: InflationInfo | null;
  series: SeriesPoint[];
  allocation: AllocationPoint[];
  ledgers: SymbolLedger[];
  /** Per-symbol cost basis and the realised/unrealised split. */
  lots: LotSummary[];
  /** Realised gains and dividend income by calendar year. */
  realisedByYear: RealisedByYear[];
  benchmarks: BenchmarkResult[];
  assets: AssetAnalysis[];
  insights: Insight[];
  /** Overlapping holding-period returns, one entry per window length. */
  rolling: RollingSeries[];
  /** Pairwise correlation between holdings and benchmarks. */
  correlation: CorrelationMatrix | null;
  warnings: BacktestWarning[];
  transactions: Transaction[];
  transactionsTruncated: boolean;
  dataSource: DataSourceInfo;
  engineVersion: string;
  generatedAt: string;
  /** Milliseconds spent inside the engine and metrics, excluding data fetch. */
  computeMs: number;
}

export interface RunBacktestOptions {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
  provider?: MarketDataProvider;
  /** Skip per-asset standalone runs when only headline numbers are needed. */
  includeAssetAnalysis?: boolean;
  maxTransactions?: number;
}

/**
 * Keeps visual extremes while reducing point count.
 *
 * Each bucket contributes its minimum, its maximum and its final point, in date
 * order. The extremes mean a one-day crash is never sampled away; the final
 * point of every bucket is at a fixed index, so two series sampled from the
 * same calendar always share that backbone of dates. Without it, each series
 * picks its own extremes, the merged chart rows only partly overlap, and
 * benchmark lines end up half empty.
 */
export function downsample(points: SeriesPoint[], max = MAX_CHART_POINTS): SeriesPoint[] {
  if (points.length <= max) return points;
  const buckets = Math.max(2, Math.floor(max / 3));
  const size = points.length / buckets;
  const keep = new Set<number>([0, points.length - 1]);

  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size);
    const hi = Math.min(points.length, Math.floor((b + 1) * size));
    if (hi <= lo) continue;
    let minIdx = lo;
    let maxIdx = lo;
    for (let i = lo; i < hi; i++) {
      if (points[i].index < points[minIdx].index) minIdx = i;
      if (points[i].index > points[maxIdx].index) maxIdx = i;
    }
    keep.add(minIdx);
    keep.add(maxIdx);
    keep.add(hi - 1);
  }

  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

/**
 * Samples a comparison series at exactly the dates the primary series kept, so
 * every row of the merged chart carries a value for every line.
 */
function alignTo(points: SeriesPoint[], dates: Set<IsoDate>): SeriesPoint[] {
  const aligned = points.filter((p) => dates.has(p.date));
  // A benchmark with a shorter history contributes nothing at those dates;
  // fall back to its own sampling rather than returning an empty line.
  return aligned.length >= 2 ? aligned : downsample(points);
}

function toSeries(result: EngineResult, deflator?: number[]): SeriesPoint[] {
  const dd = drawdownSeries(
    result.daily.map((d) => d.date),
    result.daily.map((d) => d.index),
  );
  let contributed = 0;
  return result.daily.map((d, i) => {
    contributed += d.netFlow;
    const factor = deflator?.[i] ?? 1;
    return {
      date: d.date,
      value: d.totalValue,
      realValue: factor > 0 ? d.totalValue / factor : d.totalValue,
      index: d.index,
      drawdown: dd[i]?.drawdown ?? 0,
      contributed,
      cash: d.cash,
    };
  });
}

/**
 * Deflates the engine's daily records so the same metric code can be run over
 * real terms. Only the index and the value change; external flows keep their
 * nominal timing, and the time-weighted return is recomputed from the deflated
 * index rather than being adjusted after the fact.
 */
function toRealDaily(daily: EngineResult['daily'], deflator: number[]): EngineResult['daily'] {
  const out: EngineResult['daily'] = [];
  for (let i = 0; i < daily.length; i++) {
    const factor = deflator[i] > 0 ? deflator[i] : 1;
    const realIndex = daily[i].index / factor;
    const prev = out[i - 1];
    out.push({
      ...daily[i],
      totalValue: daily[i].totalValue / factor,
      netFlow: daily[i].netFlow / factor,
      index: realIndex,
      twrReturn: prev ? realIndex / prev.index - 1 : daily[i].twrReturn,
    });
  }
  return out;
}

function toAllocation(result: EngineResult, max = 400): AllocationPoint[] {
  const rows = result.daily;
  if (!rows.length) return [];
  const stride = Math.max(1, Math.ceil(rows.length / max));
  const out: AllocationPoint[] = [];
  for (let i = 0; i < rows.length; i += stride) {
    const d = rows[i];
    const total = d.totalValue || 1;
    const weights: Record<string, number> = {};
    for (const [sym, v] of Object.entries(d.positionValues)) weights[sym] = v / total;
    if (Math.abs(d.cash) > 0.005) weights[CASH_SYMBOL] = d.cash / total;
    out.push({ date: d.date, weights });
  }
  const lastRow = rows[rows.length - 1];
  if (out[out.length - 1]?.date !== lastRow.date) {
    const total = lastRow.totalValue || 1;
    const weights: Record<string, number> = {};
    for (const [sym, v] of Object.entries(lastRow.positionValues)) weights[sym] = v / total;
    if (Math.abs(lastRow.cash) > 0.005) weights[CASH_SYMBOL] = lastRow.cash / total;
    out.push({ date: lastRow.date, weights });
  }
  return out;
}

/** A config for a passive single-asset comparison run: no fees, no trading. */
function passiveConfig(config: BacktestConfig, keepContributions: boolean): BacktestConfig {
  return {
    ...config,
    rebalance: 'never',
    contributionFrequency: keepContributions ? config.contributionFrequency : 'none',
    contributionAmount: keepContributions ? config.contributionAmount : 0,
    fees: {
      managementFeePct: 0,
      tradingCostBps: 0,
      commissionPerTrade: 0,
      defaultExpenseRatioPct: 0,
    },
    benchmarks: [],
  };
}

function singleAssetPortfolio(symbol: string, name: string) {
  return {
    id: `single-${symbol}`,
    name,
    positions: [{ id: symbol, symbol, weight: 100 }] as Position[],
  };
}

/** Reuses one prepared dataset for a single-symbol run. */
function narrowData(data: PreparedData, symbol: string, expenseRatioPct = 0): PreparedData {
  const asset = data.assets.find((a) => a.symbol === symbol);
  return {
    ...data,
    assets: asset ? [{ ...asset, targetWeight: 100, expenseRatioPct }] : [],
  };
}

export async function runBacktest({
  portfolio,
  config,
  provider = getProvider(),
  includeAssetAnalysis = true,
  maxTransactions = 3000,
}: RunBacktestOptions): Promise<BacktestResult> {
  const positions = portfolio.positions.filter(
    (p) => p.symbol.trim() && Number.isFinite(p.weight),
  );
  const benchmarkSymbols = [...new Set(config.benchmarks.map((b) => b.trim().toUpperCase()))]
    .filter(Boolean)
    .filter((b) => b !== CASH_SYMBOL);

  const data = await prepareData({
    symbols: positions,
    config,
    provider,
    extraSymbols: benchmarkSymbols,
  });

  /**
   * A funded holding whose data could not be loaded makes the requested
   * portfolio unanswerable. Refusing is the only honest default: the
   * alternative is reporting a number for a portfolio the user never asked
   * about, which the warning alone did not make obvious enough.
   *
   * `inceptionPolicy: 'cash'` is an explicit opt-in to continue, and the
   * missing weight then sits in cash rather than inflating the survivors.
   */
  if (data.unavailableHoldings.length > 0 && config.inceptionPolicy !== 'cash') {
    const names = data.unavailableHoldings.join(', ');
    const plural = data.unavailableHoldings.length > 1;
    throw new MarketDataError(
      `No price history could be loaded for ${names}, so this portfolio cannot be evaluated. ` +
        `Running without ${plural ? 'them' : 'it'} would silently redistribute ${plural ? 'their' : 'its'} weight ` +
        `across the remaining holdings and report a different portfolio than the one you asked for. ` +
        `Check the ${plural ? 'tickers' : 'ticker'}, or set the inception policy to "hold that weight in cash" to continue deliberately.`,
      data.unavailableHoldings[0],
    );
  }

  /**
   * Data problems that invalidate the arithmetic itself, as distinct from the
   * many that merely deserve a note beside the result.
   *
   * A missing exchange rate makes a mixed-currency total meaningless — the
   * engine would be adding incompatible units. An unapplied split manufactures
   * or destroys a large chunk of return. Neither is something to render with a
   * caveat underneath; a plausible-looking wrong number is more dangerous than
   * no number.
   */
  const BLOCKING_CODES = new Set(['fx-unavailable', 'unadjusted-split']);
  const blocking = data.warnings.filter(
    (w) => w.severity === 'error' && BLOCKING_CODES.has(w.code),
  );
  if (blocking.length > 0) {
    throw new MarketDataError(blocking.map((w) => w.message).join(' '), blocking[0].symbol);
  }

  const t0 = Date.now();

  const result = runEngine({ portfolio: { ...portfolio, positions }, config, data });
  const portfolioSeries = downsample(toSeries(result, data.deflator));
  const chartDates = new Set(portfolioSeries.map((p) => p.date));

  const metrics = computeMetrics({
    daily: result.daily,
    periodsPerYear: result.periodsPerYear,
    riskFree: data.riskFree,
    cashFlows: cashFlowsFromResult(result),
  });

  /* Benchmarks: same cash-flow schedule, but no portfolio fees or fund drag —
     an index is not a product and does not charge anything. */
  const benchConfig = passiveConfig(config, true);
  const benchmarks: BenchmarkResult[] = [];
  for (const symbol of benchmarkSymbols) {
    const asset = data.assets.find((a) => a.symbol === symbol);
    if (!asset) continue;
    const run = runEngine({
      portfolio: singleAssetPortfolio(symbol, asset.name),
      config: benchConfig,
      data: narrowData(data, symbol),
      applyPortfolioFees: false,
    });
    if (run.daily.length < 2) continue;
    const benchMetrics = computeMetrics({
      daily: run.daily,
      periodsPerYear: run.periodsPerYear,
      riskFree: data.riskFree,
      cashFlows: cashFlowsFromResult(run),
    });
    benchmarks.push({
      symbol,
      name: asset.name,
      metrics: benchMetrics,
      series: alignTo(toSeries(run, data.deflator), chartDates),
      finalValue: run.totals.finalValue,
    });
  }

  // Relative statistics need the benchmark's daily returns on the same calendar.
  const primary = benchmarkSymbols[0];
  if (primary) {
    const asset = data.assets.find((a) => a.symbol === primary);
    if (asset) {
      const run = runEngine({
        portfolio: singleAssetPortfolio(primary, asset.name),
        config: passiveConfig(config, false),
        data: narrowData(data, primary),
        applyPortfolioFees: false,
      });
      if (run.daily.length === result.daily.length) {
        const withRelative = computeMetrics({
          daily: result.daily,
          periodsPerYear: result.periodsPerYear,
          riskFree: data.riskFree,
          benchmarkReturns: run.daily.map((d) => d.twrReturn),
          cashFlows: cashFlowsFromResult(result),
        });
        metrics.ratios = withRelative.ratios;
      }
    }
  }

  /* Per-asset standalone analysis: what a 100% buy-and-hold in each holding
     would have done over the identical window. */
  const assets: AssetAnalysis[] = [];
  if (includeAssetAnalysis) {
    const holdingSymbols = [
      ...new Set(positions.map((p) => p.symbol.trim().toUpperCase())),
    ].filter((s) => s !== CASH_SYMBOL);

    for (const symbol of holdingSymbols) {
      const asset = data.assets.find((a) => a.symbol === symbol);
      if (!asset) continue;
      const run = runEngine({
        portfolio: singleAssetPortfolio(symbol, asset.name),
        config: passiveConfig(config, false),
        data: narrowData(data, symbol),
        applyPortfolioFees: false,
      });
      if (run.daily.length < 2) continue;
      assets.push({
        symbol,
        name: asset.name,
        ledger: result.ledgers.find((l) => l.symbol === symbol) ?? null,
        metrics: computeMetrics({
          daily: run.daily,
          periodsPerYear: run.periodsPerYear,
          riskFree: data.riskFree,
          benchmarkReturns: result.daily.map((d) => d.twrReturn),
        }),
        series: alignTo(toSeries(run, data.deflator), chartDates),
        firstDate: run.start,
        lastDate: run.end,
      });
    }
  }

  const rolling = computeAllRolling(
    result.daily.map((d) => d.date),
    result.daily.map((d) => d.index),
    result.daily.slice(1).map((d) => d.twrReturn),
    result.periodsPerYear,
  );

  /* Real terms ------------------------------------------------------- */
  let realMetrics: PerformanceMetrics | null = null;
  let inflation: InflationInfo | null = null;

  if (data.inflationSource && data.deflator.length === result.daily.length) {
    const realDaily = toRealDaily(result.daily, data.deflator);
    realMetrics = computeMetrics({
      daily: realDaily,
      periodsPerYear: result.periodsPerYear,
      riskFree: data.riskFree,
      cashFlows: realDaily
        .filter((d) => Math.abs(d.netFlow) > 1e-9)
        .map((d) => ({ date: d.date, amount: -d.netFlow }))
        .concat([
          {
            date: realDaily[realDaily.length - 1].date,
            amount: realDaily[realDaily.length - 1].totalValue,
          },
        ]),
    });

    const totalInflation = data.deflator[data.deflator.length - 1] - 1;
    const years = Math.max(1 / 365.25, metrics.returns.years);
    inflation = {
      mode: config.inflation.mode,
      label: data.inflationSource.label,
      synthetic: data.inflationSource.synthetic,
      totalInflation,
      annualisedInflation: Math.pow(1 + totalInflation, 1 / years) - 1,
    };
  }

  /* Correlations ------------------------------------------------------ */
  const correlationInputs = data.assets
    .filter((a) => !a.isCash)
    .map((a) => ({
      symbol: a.symbol,
      returns: data.calendar.map((_, i) => {
        if (i === 0) return null;
        const prev = a.prices[i - 1];
        const curr = a.prices[i];
        // A carried-forward price is not an observed return; excluding it keeps
        // a thinly-traded holding from looking artificially uncorrelated.
        if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) return null;
        if (a.stale[i]) return null;
        return curr / prev - 1;
      }),
    }));

  const correlation =
    correlationInputs.length >= 2
      ? computeCorrelationMatrix(data.calendar, correlationInputs, result.periodsPerYear)
      : null;

  const insights = buildInsights({ result, metrics, benchmarks });
  const computeMs = Date.now() - t0;

  const transactions = result.transactions.slice(0, maxTransactions);

  return {
    portfolio: { ...portfolio, positions },
    config,
    effectiveStart: result.start,
    effectiveEnd: result.end,
    totals: result.totals,
    metrics,
    realMetrics,
    inflation,
    series: portfolioSeries,
    allocation: toAllocation(result),
    ledgers: result.ledgers,
    lots: result.lots,
    realisedByYear: result.realisedByYear,
    benchmarks,
    assets,
    insights,
    rolling,
    correlation,
    warnings: dedupeWarnings(result.warnings),
    transactions,
    transactionsTruncated: result.transactions.length > transactions.length,
    dataSource: buildDataSourceInfo(provider, data, config.end),
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    computeMs,
  };
}

/**
 * Assembles the provenance block shown under every result: who supplied the
 * prices, when they were retrieved, and how current they are.
 */
function buildDataSourceInfo(
  provider: MarketDataProvider,
  data: PreparedData,
  requestedEnd: IsoDate,
): DataSourceInfo {
  const retrievals = data.sources
    .map((s) => s.fetchedAt)
    .filter((d): d is string => Boolean(d))
    .sort();
  const sessions = data.sources
    .map((s) => s.lastBarDate)
    .filter((d): d is string => Boolean(d))
    .sort();

  const latestSessionDate = sessions.length ? sessions[sessions.length - 1] : null;

  return {
    providerId: provider.id,
    providerLabel: provider.label,
    providerDescription: provider.description,
    synthetic: data.anySynthetic,
    symbols: data.sources,
    // Oldest retrieval: a result is only as current as its stalest input.
    retrievedAt: retrievals.length ? retrievals[0] : null,
    latestSessionDate,
    // Age is measured against the earlier of today and the requested end date.
    // A backtest deliberately ending in 2024 is not working from stale data —
    // it got exactly what it asked for — and calling that "601 days behind"
    // would cry wolf on every historical study.
    dataAgeDays: latestSessionDate
      ? Math.max(0, daysBetween(latestSessionDate, minIso(todayIso(), requestedEnd)))
      : null,
    servedFromStaleCache: data.sources.some((s) => s.stale),
  };
}

function dedupeWarnings(warnings: BacktestWarning[]): BacktestWarning[] {
  const seen = new Set<string>();
  const out: BacktestWarning[] = [];
  const order = { error: 0, warning: 1, info: 2 } as const;
  for (const w of warnings) {
    const key = `${w.code}|${w.symbol ?? ''}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ------------------------------------------------------------------ */
/* Rebalancing analysis                                               */
/* ------------------------------------------------------------------ */

export interface RebalanceScenario {
  frequency: BacktestConfig['rebalance'];
  label: string;
  cagr: number;
  volatility: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  finalValue: number;
  trades: number;
  tradingCosts: number;
  turnoverPerYear: number;
}

const REBALANCE_SCENARIOS: Array<{ frequency: BacktestConfig['rebalance']; label: string }> = [
  { frequency: 'never', label: 'Never' },
  { frequency: 'monthly', label: 'Monthly' },
  { frequency: 'quarterly', label: 'Quarterly' },
  { frequency: 'semiannual', label: 'Semi-annual' },
  { frequency: 'annual', label: 'Annual' },
  { frequency: 'threshold', label: 'Drift band' },
];

/**
 * Reruns the identical portfolio under every rebalancing rule against one
 * shared dataset, so the only difference between rows is the rule itself.
 */
export async function runRebalanceAnalysis({
  portfolio,
  config,
  provider = getProvider(),
}: {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
  provider?: MarketDataProvider;
}): Promise<{
  scenarios: RebalanceScenario[];
  warnings: BacktestWarning[];
  /** Provenance travels with every result, including derived studies. */
  dataSource: DataSourceInfo;
}> {
  const positions = portfolio.positions.filter((p) => p.symbol.trim());
  const data = await prepareData({ symbols: positions, config, provider });

  const scenarios: RebalanceScenario[] = [];
  for (const { frequency, label } of REBALANCE_SCENARIOS) {
    const run = runEngine({
      portfolio: { ...portfolio, positions },
      config: { ...config, rebalance: frequency },
      data,
    });
    if (run.daily.length < 2) continue;
    const m = computeMetrics({
      daily: run.daily,
      periodsPerYear: run.periodsPerYear,
      riskFree: data.riskFree,
    });
    const turnover = run.transactions
      .filter((t) => t.type === 'buy' || t.type === 'sell')
      .reduce((s, t) => s + Math.abs((t.shares ?? 0) * (t.price ?? 0)), 0);
    scenarios.push({
      frequency,
      label: frequency === 'threshold' ? `${label} ±${config.rebalanceThresholdPct}%` : label,
      cagr: m.returns.cagr,
      volatility: m.risk.volatility,
      maxDrawdown: m.risk.maxDrawdown,
      sharpe: m.ratios.sharpe,
      sortino: m.ratios.sortino,
      finalValue: run.totals.finalValue,
      trades: run.totals.tradeCount,
      tradingCosts: run.totals.totalTradingCosts,
      turnoverPerYear:
        m.returns.years > 0 && run.totals.finalValue > 0
          ? turnover / m.returns.years / ((run.totals.finalValue + run.totals.netInvested) / 2)
          : 0,
    });
  }

  return {
    scenarios,
    warnings: dedupeWarnings(data.warnings),
    dataSource: buildDataSourceInfo(provider, data, config.end),
  };
}
