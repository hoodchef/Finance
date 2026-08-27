import { describe, expect, it } from 'vitest';
import {
  buildCsv,
  buildOptimisationCsv,
  buildSimulationCsv,
  safeFilename,
} from '../src/lib/export/csv';
import { formatCurrency, formatCurrencyCompact } from '../src/lib/format';
import { runBacktest, type BacktestResult } from '../src/lib/backtest';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import { testConfig } from './helpers';
import { buildFundamentalsCsv, type FundamentalsExport } from '@/lib/export/fundamentals-csv';
import type { YearRow } from '@/lib/fundamentals/metrics';

/**
 * Export is the boundary where numbers leave the product, so the tests care
 * about two things: the values are the engine's unrounded ones, and the CSV is
 * well-formed for anything a fund name can contain.
 */

let cached: BacktestResult | null = null;

async function result(): Promise<BacktestResult> {
  if (cached) return cached;
  cached = await runBacktest({
    portfolio: {
      id: 'p',
      name: 'Test Portfolio',
      positions: [
        { id: '1', symbol: 'SPY', weight: 60 },
        { id: '2', symbol: 'BND', weight: 40, expenseRatio: 0.03 },
      ],
    },
    config: testConfig({
      start: '2016-01-04',
      end: '2020-12-31',
      rebalance: 'annual',
      contributionAmount: 500,
      contributionFrequency: 'monthly',
      benchmarks: ['QQQ'],
      fees: {
        managementFeePct: 0.25,
        tradingCostBps: 5,
        commissionPerTrade: 1,
        defaultExpenseRatioPct: 0,
      },
    }),
    provider: new DemoDataProvider(),
  });
  return cached;
}

const parse = (csv: string) => csv.split('\n').map((line) => line.split(','));

describe('csv export', () => {
  it('writes a summary with one column per series', async () => {
    const csv = buildCsv(await result(), 'summary');
    const rows = parse(csv);
    expect(rows[0]).toEqual(['Metric', 'Test Portfolio', 'QQQ']);
    expect(csv).toContain('CAGR');
    expect(csv).toContain('Max drawdown');
    expect(csv).toContain('Money-weighted return (IRR)');
  });

  it('exports unrounded values, not the formatted display strings', async () => {
    const r = await result();
    const csv = buildCsv(r, 'summary');
    const cagrRow = parse(csv).find((row) => row[0] === 'CAGR')!;
    // A display string would be "4.96%"; the file must hold the raw number.
    expect(cagrRow[1]).not.toContain('%');
    expect(Number(cagrRow[1])).toBeCloseTo(r.metrics.returns.cagr, 12);
  });

  it('writes a monthly grid with twelve month columns plus a total', async () => {
    const rows = parse(buildCsv(await result(), 'monthly'));
    expect(rows[0]).toEqual([
      'Year', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Year total',
    ]);
    expect(rows.length).toBeGreaterThan(4);
  });

  it('writes one holdings row per position with a closing attribution', async () => {
    const r = await result();
    const rows = parse(buildCsv(r, 'holdings'));
    expect(rows).toHaveLength(r.ledgers.length + 1);
    const pnlIndex = rows[0].indexOf('Profit and loss');
    const total = rows.slice(1).reduce((s, row) => s + Number(row[pnlIndex]), 0);
    expect(total).toBeCloseTo(
      r.ledgers.reduce((s, l) => s + l.profitAndLoss, 0),
      6,
    );
  });

  it('writes every transaction the engine recorded', async () => {
    const r = await result();
    const rows = parse(buildCsv(r, 'transactions'));
    expect(rows).toHaveLength(r.transactions.length + 1);
    const types = new Set(rows.slice(1).map((row) => row[1]));
    expect(types.has('contribution')).toBe(true);
    expect(types.has('buy')).toBe(true);
    expect(types.has('management-fee')).toBe(true);
  });

  it('writes a daily time series aligned across benchmarks', async () => {
    const r = await result();
    const rows = parse(buildCsv(r, 'timeseries'));
    expect(rows[0]).toContain('QQQ index');
    expect(rows).toHaveLength(r.series.length + 1);
  });

  it('records the provider and flags synthetic data in the config export', async () => {
    const csv = buildCsv(await result(), 'config');
    expect(csv).toContain('Synthetic data');
    expect(csv).toContain('YES — NOT REAL MARKET DATA');
    expect(csv).toContain('Effective start');
    expect(csv).toContain('Engine version');
  });

  it('quotes fields containing commas or quotes', async () => {
    const r = await result();
    const withComma: BacktestResult = {
      ...r,
      portfolio: { ...r.portfolio, name: 'Growth, "aggressive"' },
    };
    const header = buildCsv(withComma, 'summary').split('\n')[0];
    expect(header).toBe('Metric,"Growth, ""aggressive""",QQQ');
  });
});

describe('filenames', () => {
  it('strips characters that break a download', () => {
    expect(safeFilename('My 60/40 Portfolio!')).toBe('My-60-40-Portfolio');
    expect(safeFilename('../../etc/passwd')).toBe('etc-passwd');
    expect(safeFilename('')).toBe('portfolio');
  });
});

describe('chart series alignment', () => {
  it('samples every benchmark at the portfolio\'s own chart dates', async () => {
    // Independently downsampled series pick different extremes, which leaves
    // benchmark lines with a value on only about half the chart rows.
    const r = await result();
    const portfolioDates = new Set(r.series.map((p) => p.date));
    expect(r.benchmarks.length).toBeGreaterThan(0);
    for (const b of r.benchmarks) {
      expect(b.series.length).toBe(r.series.length);
      expect(b.series.every((p) => portfolioDates.has(p.date))).toBe(true);
    }
  });

  it('keeps the first and last observation after downsampling', async () => {
    const r = await result();
    expect(r.series[0].date).toBe(r.effectiveStart);
    expect(r.series[r.series.length - 1].date).toBe(r.effectiveEnd);
  });
});

describe('gains export', () => {
  it('writes yearly taxable events and per-holding basis', async () => {
    const r = await result();
    const csv = buildCsv(r, 'gains');
    expect(csv).toContain('Cost basis method');
    expect(csv).toContain('Short-term gain');
    expect(csv).toContain('Open cost basis');
    expect(csv).toContain('No tax rates are applied');

    const rows = parse(csv);
    const total = rows.find((row) => row[0] === 'Total realised gain')!;
    expect(Number(total[1])).toBeCloseTo(r.totals.totalRealisedGain, 8);
  });

  it('reconciles realised plus unrealised against the reported gain', async () => {
    const r = await result();
    const perHolding = r.lots.reduce(
      (s, l) => s + l.realisedGain + l.unrealisedGain + l.dividends,
      0,
    );
    const ledgerTotal = r.ledgers
      .filter((l) => l.symbol !== 'CASH')
      .reduce((s, l) => s + l.profitAndLoss, 0);
    expect(perHolding).toBeCloseTo(ledgerTotal, 4);
  });
});

describe('currency formatting never shows a negative zero', () => {
  it('renders a residual that rounds to zero as zero', () => {
    // The Lab's reconciliation showed "-$0.00" for a residual of about -1e-12.
    // In a panel whose whole job is to demonstrate that two figures agree, a
    // minus sign reads as a discrepancy too small to display.
    expect(formatCurrency(-1e-12)).toBe('$0.00');
    expect(formatCurrency(-0.0001)).toBe('$0.00');
    expect(formatCurrency(-0)).toBe('$0.00');
    expect(formatCurrencyCompact(-1e-9)).toBe('$0');
  });

  it('still shows real negatives', () => {
    expect(formatCurrency(-12.5)).toMatch(/^-/);
    expect(formatCurrency(-5000)).toMatch(/^-/);
    expect(formatCurrencyCompact(-25_000)).toBe('-$25K');
  });

  it('leaves positive values untouched', () => {
    expect(formatCurrency(1234.56)).toMatch(/1,235|1,234/);
    expect(formatCurrencyCompact(1_500_000)).toBe('$1.5M');
  });
});

describe('analysis exports', () => {
  const sim = {
    method: 'block',
    paths: 2000,
    years: 30,
    parameters: {
      expectedReturn: 0.0937,
      volatility: 0.1074,
      expectedReturnSource: 'history',
      volatilitySource: 'assumed',
      inflation: 0.025,
    },
    terminal: { p5: 50_000, p25: 90_000, median: 123_000, p75: 190_000, p95: 303_000 },
    terminalReal: { p5: 24_000, median: 59_000, p95: 145_000 },
    successRate: 0.93,
    medianRuinYear: 22.4,
    bands: [
      { year: 0, p5: 10_000, median: 10_000, p95: 10_000, contributed: 10_000 },
      { year: 1, p5: 9_100, median: 10_900, p95: 12_800, contributed: 10_000 },
    ],
    historical: { start: '2015-01-05', end: '2024-12-31', cagr: 0.087, volatility: 0.1076 },
  };

  it('leads with the parameters that produced it', () => {
    // A backtest can be reproduced by re-running it. A simulation depends on a
    // method and a set of assumptions that cannot be recovered from a column
    // of outcomes, so they travel with the file.
    const csv = buildSimulationCsv(sim);
    expect(csv).toMatch(/Simulation parameters/);
    expect(csv).toMatch(/Method,block/);
    expect(csv).toMatch(/Paths,2000/);
    // And crucially, whether each figure was measured or asserted.
    expect(csv).toMatch(/Expected return \(annual\),0\.0937,history/);
    expect(csv).toMatch(/Volatility \(annual\),0\.1074,assumed/);
  });

  it('carries the backtest it was grounded in', () => {
    const csv = buildSimulationCsv(sim);
    expect(csv).toMatch(/Grounded in a backtest of/);
    expect(csv).toMatch(/2015-01-05/);
  });

  it('reports nominal and real outcomes side by side', () => {
    const csv = buildSimulationCsv(sim);
    // Reporting only nominal terminal values would overstate every long
    // horizon by the compounded price level.
    expect(csv).toMatch(/Median,123000,59000/);
    expect(csv).toMatch(/Today's dollars/);
  });

  it('includes the yearly bands and the depletion figures', () => {
    const csv = buildSimulationCsv(sim);
    expect(csv).toMatch(/Money lasts \(fraction of paths\),0\.93/);
    expect(csv).toMatch(/Median year of depletion,22\.4/);
    const lines = csv.split('\n');
    expect(lines.some((l) => l.startsWith('1,9100,10900,12800,10000'))).toBe(true);
  });

  it('handles a simulation with no depletion and no backtest', () => {
    const csv = buildSimulationCsv({ ...sim, medianRuinYear: null, historical: undefined });
    expect(csv).toMatch(/Median year of depletion,/);
    expect(csv).not.toMatch(/Grounded in a backtest/);
  });

  const opt = {
    symbols: ['SPY', 'BND'],
    current: [0.6, 0.4],
    portfolios: {
      minimumVariance: { weights: [0.05, 0.95], expectedReturn: 0.019, volatility: 0.061, sharpe: -0.18, concentration: 0.905 },
      riskParity: { weights: [0.24, 0.76], expectedReturn: 0.047, volatility: 0.071, sharpe: 0.24, concentration: 0.635 },
    },
    frontier: [
      { volatility: 0.061, expectedReturn: 0.019, sharpe: -0.18 },
      { volatility: 0.12, expectedReturn: 0.08, sharpe: 0.42 },
    ],
    estimate: { observations: 2515, shrinkage: 0.023, from: '2015-01-05', to: '2024-12-31' },
  };

  it('exports every allocation against the one already held', () => {
    const csv = buildOptimisationCsv(opt);
    expect(csv).toMatch(/Allocation,SPY,BND/);
    expect(csv).toMatch(/^Current,0\.6,0\.4/m);
    expect(csv).toMatch(/^minimumVariance,0\.05,0\.95/m);
    expect(csv).toMatch(/^riskParity,0\.24,0\.76/m);
  });

  it('records what the estimate was fitted to', () => {
    const csv = buildOptimisationCsv(opt);
    expect(csv).toMatch(/Observations,2515/);
    expect(csv).toMatch(/Shrinkage intensity,0\.023/);
  });

  it('includes the frontier as its own block', () => {
    const csv = buildOptimisationCsv(opt);
    expect(csv).toMatch(/Efficient frontier/);
    expect(csv).toMatch(/^0\.12,0\.08,0\.42$/m);
  });

  it('omits the current row when there is no current allocation', () => {
    const csv = buildOptimisationCsv({ ...opt, current: null });
    expect(csv).not.toMatch(/^Current,/m);
  });
});

describe('compact currency at company scale', () => {
  it('renders trillions as trillions', () => {
    // Apple at $4.6T rendered as "$4631B" — correct, and unreadable. The
    // largest listed companies are exactly the ones people look up.
    expect(formatCurrencyCompact(4_631_000_000_000)).toBe('$4.63T');
    expect(formatCurrencyCompact(5_100_000_000_000)).toBe('$5.10T');
    expect(formatCurrencyCompact(-2_500_000_000_000)).toBe('-$2.50T');
  });

  it('keeps billions and below unchanged', () => {
    expect(formatCurrencyCompact(999_000_000_000)).toBe('$999B');
    expect(formatCurrencyCompact(1_500_000_000)).toBe('$1.5B');
    expect(formatCurrencyCompact(250_000_000)).toBe('$250M');
  });
});

describe('fundamentals CSV', () => {
  /**
   * The point of this exporter is that a figure keeps its provenance when it
   * leaves the app. A spreadsheet full of unlabelled fundamentals is how a
   * restated 2019 number ends up in someone's model as current.
   */
  const row = (over: Partial<YearRow> & { fiscalYear: number; end: string }): YearRow =>
    ({
      revenue: null, grossProfit: null, operatingIncome: null, netIncome: null,
      epsDiluted: null, operatingCashFlow: null, capex: null, freeCashFlow: null,
      assets: null, liabilities: null, equity: null, cash: null, totalDebt: null,
      sharesDiluted: null, dividendsPaid: null, grossMargin: null,
      operatingMargin: null, netMargin: null, fcfMargin: null, roe: null,
      roic: null, revenueGrowth: null, epsGrowth: null,
      ...over,
    }) as YearRow;

  const base: FundamentalsExport = {
    company: { ticker: 'AAPL', name: 'Apple Inc.', cik: '0000320193' },
    rows: [
      row({ fiscalYear: 2023, end: '2023-09-30', revenue: 383285000000, netMargin: 0.2530962 }),
      row({ fiscalYear: 2024, end: '2024-09-28', revenue: 391035000000, netMargin: 0.2397125 }),
    ],
    valuation: null,
    dilution: null,
    price: null,
    provenance: {
      financials: 'SEC EDGAR XBRL company facts, from the filings themselves',
      latestFilingDate: '2024-11-01',
      priceSource: null,
      conceptsUsed: [{ field: 'revenue', concept: 'RevenueFromContractWithCustomerExcludingAssessedTax' }],
      estimatesNote: 'No free source licenses analyst estimates for display.',
    },
  };

  it('writes figures unrounded, not as the page abbreviates them', () => {
    const csv = buildFundamentalsCsv(base);
    // The page shows "$391.0B"; a spreadsheet must receive what was filed.
    expect(csv).toContain('391035000000');
    expect(csv).toContain('0.2397125');
    expect(csv).not.toContain('391.0B');
  });

  it('leaves missing figures empty rather than writing null', () => {
    const csv = buildFundamentalsCsv(base);
    // "null" in a numeric column is a text cell that silently breaks a formula.
    expect(csv).not.toMatch(/\bnull\b/);
    expect(csv).toMatch(/2024,2024-09-28,391035000000,,/);
  });

  it('lays years out as rows, oldest first', () => {
    const lines = buildFundamentalsCsv(base).split('\n');
    const header = lines.findIndex((l) => l.startsWith('Fiscal year,'));
    expect(header).toBeGreaterThan(-1);
    expect(lines[header + 1]).toMatch(/^2023,/);
    expect(lines[header + 2]).toMatch(/^2024,/);
  });

  it('carries the source, the filing it was read from, and the XBRL concepts', () => {
    const csv = buildFundamentalsCsv(base);
    expect(csv).toContain('SEC EDGAR XBRL company facts');
    expect(csv).toContain('2024-11-01');
    // Companies switch tags mid-history; which tag produced a column is the
    // difference between a comparable series and a broken one.
    expect(csv).toContain('RevenueFromContractWithCustomerExcludingAssessedTax');
  });

  it('quotes a company name containing a comma', () => {
    const csv = buildFundamentalsCsv({
      ...base,
      company: { ticker: 'F', name: 'Ford Motor Company, Inc.', cik: '0000037996' },
    });
    // The whole field is quoted, so the comma inside it is data rather than a
    // column break — a naive split on commas would read three cells here.
    expect(csv.split('\n')[0]).toBe('Company,"Ford Motor Company, Inc."');
  });

  it('includes the split note when a split shortened the dilution window', () => {
    const csv = buildFundamentalsCsv({
      ...base,
      dilution: { changePct: -0.12, years: 4, from: 1e9, to: 8.8e8, splitNote: 'Window starts after a share split.' },
    });
    expect(csv).toContain('Window starts after a share split.');
  });

  it('omits the valuation block entirely when no price was available', () => {
    // Better an absent section than a section of empty ratios that reads as
    // "we looked and the answer is nothing".
    expect(buildFundamentalsCsv(base)).not.toContain('EV/EBITDA');
    expect(buildFundamentalsCsv({ ...base, valuation: {
      price: 227.52, sharesOutstanding: 15.1e9, marketCap: 3.4e12, enterpriseValue: 3.5e12,
      peRatio: 36.2, psRatio: 8.8, pbRatio: 51.4, evToEbitda: 26.1, fcfYield: 0.0296,
      dividendYield: 0.0044, payoutRatio: 0.159, basis: 'Last full fiscal year',
    } })).toContain('EV/EBITDA');
  });
});
