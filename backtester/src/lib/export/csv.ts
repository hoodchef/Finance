import type { BacktestResult } from '@/lib/backtest';
import { CASH_SYMBOL } from '@/lib/types';
import { MONTH_LABELS } from '@/lib/format';

/**
 * CSV export.
 *
 * Values are written unrounded and unformatted — a spreadsheet should receive
 * the number the engine computed, not the string the dashboard displayed.
 * PDF export would slot in beside this as another `ExportFormat` producing a
 * Blob from the same `BacktestResult`; nothing here is display-coupled.
 */

export type ExportKind =
  | 'summary'
  | 'annual'
  | 'monthly'
  | 'holdings'
  | 'transactions'
  | 'timeseries'
  | 'gains'
  | 'config';

function escape(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Shared so that every CSV the platform emits quotes identically. Duplicated
 * escaping is how one exporter learns to handle a comma in a company name and
 * another does not.
 */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

export function buildCsv(result: BacktestResult, kind: ExportKind): string {
  switch (kind) {
    case 'summary':
      return toCsv(summaryRows(result));
    case 'annual':
      return toCsv(annualRows(result));
    case 'monthly':
      return toCsv(monthlyRows(result));
    case 'holdings':
      return toCsv(holdingRows(result));
    case 'transactions':
      return toCsv(transactionRows(result));
    case 'timeseries':
      return toCsv(timeseriesRows(result));
    case 'gains':
      return toCsv(gainsRows(result));
    case 'config':
      return toCsv(configRows(result));
  }
}

function summaryRows(r: BacktestResult): Array<Array<string | number>> {
  const m = r.metrics;
  const rows: Array<Array<string | number>> = [
    ['Metric', r.portfolio.name || 'Portfolio', ...r.benchmarks.map((b) => b.symbol)],
  ];
  const add = (
    label: string,
    pick: (x: { metrics: typeof m; final: number }) => number | string,
  ) => {
    rows.push([
      label,
      pick({ metrics: m, final: r.totals.finalValue }),
      ...r.benchmarks.map((b) => pick({ metrics: b.metrics, final: b.finalValue })),
    ]);
  };

  add('Final value', (x) => x.final);
  add('Total return', (x) => x.metrics.returns.totalReturn);
  add('CAGR', (x) => x.metrics.returns.cagr);
  add('Arithmetic annual return', (x) => x.metrics.returns.arithmeticAnnualReturn);
  add('Volatility', (x) => x.metrics.risk.volatility);
  add('Downside deviation', (x) => x.metrics.risk.downsideDeviation);
  add('Max drawdown', (x) => x.metrics.risk.maxDrawdown);
  add('Average drawdown', (x) => x.metrics.risk.averageDrawdown);
  add('Longest drawdown (days)', (x) => x.metrics.risk.longestDrawdownDays);
  add('Time underwater', (x) => x.metrics.risk.timeUnderwater);
  add('Daily VaR 95%', (x) => x.metrics.risk.var95);
  add('Expected shortfall 95%', (x) => x.metrics.risk.cvar95);
  add('Sharpe', (x) => x.metrics.ratios.sharpe);
  add('Sortino', (x) => x.metrics.ratios.sortino);
  add('Calmar', (x) => x.metrics.ratios.calmar);
  add('Best year', (x) => x.metrics.annualSummary.best?.return ?? '');
  add('Worst year', (x) => x.metrics.annualSummary.worst?.return ?? '');
  add('Positive years', (x) => x.metrics.annualSummary.positiveRate);
  add('Positive months', (x) => x.metrics.monthlySummary.positiveRate);

  if (r.inflation && r.realMetrics) {
    rows.push([]);
    rows.push(['Real terms', r.inflation.label]);
    rows.push(['Cumulative inflation', r.inflation.totalInflation]);
    rows.push(['Annualised inflation', r.inflation.annualisedInflation]);
    rows.push(['Inflation basis', r.inflation.synthetic ? 'ASSUMED RATE — not measured' : 'measured CPI']);
    rows.push(['Real total return', r.realMetrics.returns.totalReturn]);
    rows.push(['Real CAGR', r.realMetrics.returns.cagr]);
    rows.push(['Real max drawdown', r.realMetrics.risk.maxDrawdown]);
    rows.push(['Real final value', r.series[r.series.length - 1]?.realValue ?? '']);
  }

  rows.push([]);
  rows.push(['Totals']);
  rows.push(['Initial investment', r.totals.initialInvestment]);
  rows.push(['Total contributions', r.totals.totalContributions]);
  rows.push(['Total withdrawals', r.totals.totalWithdrawals]);
  rows.push(['Net invested', r.totals.netInvested]);
  rows.push(['Investment gain', r.totals.investmentGain]);
  rows.push(['Dividends received', r.totals.totalDividends]);
  rows.push(['Management fees', r.totals.totalManagementFees]);
  rows.push(['Fund expense ratio cost', r.totals.totalExpenseRatioCost]);
  rows.push(['Trading costs', r.totals.totalTradingCosts]);
  rows.push(['Cash interest', r.totals.totalCashInterest]);
  rows.push(['Rebalances', r.totals.rebalanceCount]);
  rows.push(['Trades', r.totals.tradeCount]);
  if (r.metrics.returns.moneyWeightedReturn != null) {
    rows.push(['Money-weighted return (IRR)', r.metrics.returns.moneyWeightedReturn]);
  }
  return rows;
}

function annualRows(r: BacktestResult): Array<Array<string | number>> {
  const header = ['Year', r.portfolio.name || 'Portfolio', ...r.benchmarks.map((b) => b.symbol), 'Partial'];
  const byYear = new Map<number, Array<string | number>>();
  for (const a of r.metrics.annual) {
    byYear.set(a.year, [a.year, a.return, ...r.benchmarks.map(() => ''), a.partial ? 'yes' : '']);
  }
  r.benchmarks.forEach((b, i) => {
    for (const a of b.metrics.annual) {
      const row = byYear.get(a.year);
      if (row) row[2 + i] = a.return;
    }
  });
  return [header, ...[...byYear.values()].sort((a, b) => Number(a[0]) - Number(b[0]))];
}

function monthlyRows(r: BacktestResult): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [['Year', ...MONTH_LABELS, 'Year total']];
  const byYear = new Map<number, Array<string | number>>();
  for (const m of r.metrics.monthly) {
    if (m.month == null) continue;
    if (!byYear.has(m.year)) byYear.set(m.year, [m.year, ...new Array(12).fill(''), '']);
    byYear.get(m.year)![m.month + 1] = m.return;
  }
  for (const a of r.metrics.annual) {
    const row = byYear.get(a.year);
    if (row) row[13] = a.return;
  }
  rows.push(...[...byYear.values()].sort((a, b) => Number(a[0]) - Number(b[0])));
  return rows;
}

function holdingRows(r: BacktestResult): Array<Array<string | number>> {
  return [
    [
      'Symbol', 'Name', 'Target weight', 'Final weight', 'Drift', 'Final shares', 'Final value',
      'Cash invested', 'Cash from sales', 'Dividends', 'Expense ratio cost', 'Trading cost',
      'Profit and loss', 'Share of gain',
    ],
    ...r.ledgers.map((l) => [
      l.symbol, l.name, l.targetWeight, l.endWeight, l.endWeight - l.targetWeight,
      l.endingShares, l.endingValue, l.invested, l.divested, l.dividends,
      l.expenseRatioCost, l.tradingCost, l.profitAndLoss, l.shareOfGain,
    ]),
  ];
}

function transactionRows(r: BacktestResult): Array<Array<string | number>> {
  return [
    ['Date', 'Type', 'Symbol', 'Shares', 'Price', 'Cash impact', 'Note'],
    ...r.transactions.map((t) => [
      t.date, t.type, t.symbol ?? '', t.shares ?? '', t.price ?? '', t.amount, t.note ?? '',
    ]),
  ];
}

function timeseriesRows(r: BacktestResult): Array<Array<string | number>> {
  const benchCols = r.benchmarks.map((b) => b.symbol);
  const benchByDate = r.benchmarks.map((b) => new Map(b.series.map((p) => [p.date, p.index])));
  return [
    ['Date', 'Portfolio value', 'Real value', 'Growth index', 'Drawdown', 'Cumulative contributed', 'Cash', ...benchCols.map((s) => `${s} index`)],
    ...r.series.map((p) => [
      p.date, p.value, p.realValue, p.index, p.drawdown, p.contributed, p.cash,
      ...benchByDate.map((m) => m.get(p.date) ?? ''),
    ]),
  ];
}

/**
 * The figures a taxable-account return would be built from. No tax rate is
 * applied and none is implied — this is the input to that calculation, not its
 * result.
 */
function gainsRows(r: BacktestResult): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    ['Cost basis method', r.config.costBasisMethod],
    [],
    ['Year', 'Sales', 'Short-term gain', 'Long-term gain', 'Unclassified gain', 'Realised total', 'Dividend income'],
    ...r.realisedByYear.map((y) => [
      y.year, y.saleCount, y.shortTerm, y.longTerm, y.unclassified, y.realisedGain, y.dividends,
    ]),
    [],
    ['Symbol', 'Shares held', 'Open cost basis', 'Unrealised gain', 'Realised gain', 'Realised short-term', 'Realised long-term', 'Dividends'],
    ...r.lots.map((l) => [
      l.symbol, l.openShares, l.openCostBasis, l.unrealisedGain,
      l.realisedGain, l.realisedShortTerm, l.realisedLongTerm, l.dividends,
    ]),
    [],
    ['Total realised gain', r.totals.totalRealisedGain],
    ['Total unrealised gain', r.totals.totalUnrealisedGain],
    ['Note', 'No tax rates are applied. These are the amounts a tax calculation would use.'],
  ];
  return rows;
}

function configRows(r: BacktestResult): Array<Array<string | number>> {
  const c = r.config;
  const rows: Array<Array<string | number>> = [
    ['Setting', 'Value'],
    ['Portfolio', r.portfolio.name],
    ['Requested start', c.start],
    ['Requested end', c.end],
    ['Effective start', r.effectiveStart],
    ['Effective end', r.effectiveEnd],
    ['Initial investment', c.initialInvestment],
    ['Contribution amount', c.contributionAmount],
    ['Contribution frequency', c.contributionFrequency],
    ['Treated as withdrawal', c.contributionIsWithdrawal ? 'yes' : 'no'],
    ['Rebalancing', c.rebalance],
    ['Drift band (pp)', c.rebalanceThresholdPct],
    ['Dividends', c.dividends],
    ['Management fee (%/yr)', c.fees.managementFeePct],
    ['Trading cost (bps)', c.fees.tradingCostBps],
    ['Commission per trade', c.fees.commissionPerTrade],
    ['Default expense ratio (%)', c.fees.defaultExpenseRatioPct],
    ['Cash yield (%/yr)', c.cashYieldPct],
    ['Risk-free source', c.riskFree.source],
    ['Risk-free constant (%)', c.riskFree.constantPct],
    ['Inception policy', c.inceptionPolicy],
    ['Cost basis method', c.costBasisMethod],
    ['Inflation mode', c.inflation.mode],
    ['Assumed inflation (%/yr)', c.inflation.mode === 'constant' ? c.inflation.constantPct : ''],
    ['Contributions grown with inflation', c.inflation.adjustContributions ? 'yes' : 'no'],
    ['Benchmarks', c.benchmarks.join(' ')],
    [],
    ['Holding', 'Weight (%)', 'Expense ratio (%)'],
    ...r.portfolio.positions.map((p) => [p.symbol, p.weight, p.expenseRatio ?? '']),
    [],
    ['Data source', r.dataSource.providerLabel],
    ['Synthetic data', r.dataSource.synthetic ? 'YES — NOT REAL MARKET DATA' : 'no'],
    ['Engine version', r.engineVersion],
    ['Generated at', r.generatedAt],
  ];
  if (r.portfolio.positions.some((p) => p.symbol.toUpperCase() === CASH_SYMBOL)) {
    rows.push([], ['Note', 'CASH is a non-traded sleeve earning the configured cash yield.']);
  }
  return rows;
}

export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([`﻿${contents}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Turns a portfolio name into a filename. Leading dots are dropped as well as
 * illegal characters — a download called `..-etc-passwd` is merely ugly, but
 * one called `.config` is invisible in the user's Downloads folder.
 */
export function safeFilename(name: string): string {
  const cleaned = (name || 'portfolio')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/[.\-_]{2,}/g, '-')
    .replace(/^[.\-_]+|[.\-_]+$/g, '')
    .slice(0, 60)
    .replace(/[.\-_]+$/, '');
  return cleaned || 'portfolio';
}

/* ------------------------------------------------------------------ */
/* Analysis exports                                                    */
/* ------------------------------------------------------------------ */

/**
 * Simulations and optimisations produced numbers that could not leave the app.
 *
 * These matter more than the backtest export, not less: a backtest can be
 * reproduced by re-running it, but a simulation depends on a seed, a method
 * and a set of assumptions that are easy to forget and impossible to recover
 * from the chart. Every export below leads with the parameters that produced
 * it, so a file found later can be read for what it actually says.
 */

export interface SimulationExport {
  method: string;
  paths: number;
  years: number;
  parameters: {
    expectedReturn: number;
    volatility: number;
    expectedReturnSource: string;
    volatilitySource: string;
    inflation: number;
  };
  terminal: { p5: number; p25: number; median: number; p75: number; p95: number };
  terminalReal: { p5: number; median: number; p95: number };
  successRate: number;
  medianRuinYear: number | null;
  bands: Array<{ year: number; p5: number; median: number; p95: number; contributed: number }>;
  historical?: { start: string; end: string; cagr: number; volatility: number };
}

export function buildSimulationCsv(sim: SimulationExport): string {
  const rows: Array<Array<string | number | null>> = [
    ['Simulation parameters'],
    ['Method', sim.method],
    ['Paths', sim.paths],
    ['Horizon (years)', sim.years],
    // Whether each number was measured or asserted travels with the file. A
    // column of outcomes with no provenance is the thing this project exists
    // not to produce.
    ['Expected return (annual)', sim.parameters.expectedReturn, sim.parameters.expectedReturnSource],
    ['Volatility (annual)', sim.parameters.volatility, sim.parameters.volatilitySource],
    ['Inflation (annual)', sim.parameters.inflation, 'assumed'],
  ];

  if (sim.historical) {
    rows.push(
      [],
      ['Grounded in a backtest of'],
      ['Start', sim.historical.start],
      ['End', sim.historical.end],
      ['Realised CAGR', sim.historical.cagr],
      ['Realised volatility', sim.historical.volatility],
    );
  }

  rows.push(
    [],
    ['Terminal outcome', 'Nominal', "Today's dollars"],
    ['5th percentile', sim.terminal.p5, sim.terminalReal.p5],
    ['25th percentile', sim.terminal.p25, null],
    ['Median', sim.terminal.median, sim.terminalReal.median],
    ['75th percentile', sim.terminal.p75, null],
    ['95th percentile', sim.terminal.p95, sim.terminalReal.p95],
    [],
    ['Money lasts (fraction of paths)', sim.successRate],
    ['Median year of depletion', sim.medianRuinYear],
    [],
    ['Year', '5th percentile', 'Median', '95th percentile', 'Contributed'],
    ...sim.bands.map((b) => [b.year, b.p5, b.median, b.p95, b.contributed]),
  );

  return toCsv(rows);
}

export interface OptimisationExport {
  symbols: string[];
  current: number[] | null;
  portfolios: Record<string, { weights: number[]; expectedReturn: number; volatility: number; sharpe: number; concentration: number }>;
  frontier: Array<{ volatility: number; expectedReturn: number; sharpe: number }>;
  estimate: { observations: number; shrinkage: number; from: string; to: string };
}

export function buildOptimisationCsv(data: OptimisationExport): string {
  const rows: Array<Array<string | number | null>> = [
    ['Estimated from'],
    ['Start', data.estimate.from],
    ['End', data.estimate.to],
    ['Observations', data.estimate.observations],
    ['Shrinkage intensity', data.estimate.shrinkage],
    [],
    ['Allocation', ...data.symbols, 'Expected return', 'Volatility', 'Sharpe', 'Concentration'],
  ];

  if (data.current) {
    rows.push(['Current', ...data.current, null, null, null, null]);
  }
  for (const [name, p] of Object.entries(data.portfolios)) {
    rows.push([name, ...p.weights, p.expectedReturn, p.volatility, p.sharpe, p.concentration]);
  }

  rows.push(
    [],
    ['Efficient frontier'],
    ['Volatility', 'Expected return', 'Sharpe'],
    ...data.frontier.map((p) => [p.volatility, p.expectedReturn, p.sharpe]),
  );

  return toCsv(rows);
}
