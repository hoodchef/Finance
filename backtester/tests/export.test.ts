import { describe, expect, it } from 'vitest';
import { buildCsv, safeFilename } from '../src/lib/export/csv';
import { formatCurrency, formatCurrencyCompact } from '../src/lib/format';
import { runBacktest, type BacktestResult } from '../src/lib/backtest';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import { testConfig } from './helpers';

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
