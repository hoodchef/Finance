import { describe, expect, it } from 'vitest';
import { annualSeries, type CompanyFacts } from '../src/lib/fundamentals/sec';
import { buildAnnualRows, dilution, valuation } from '../src/lib/fundamentals/metrics';

/**
 * XBRL parsing, against the shapes that actually appear in EDGAR.
 * =============================================================================
 * Every case below is a real failure found by running this against live
 * filings. Offline fixtures rather than live calls, because a test that needs
 * SEC to answer is a test that stops running.
 */

type Point = {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
};

function facts(concepts: Record<string, Point[]>, units = 'USD'): CompanyFacts {
  return {
    cik: 1,
    entityName: 'Test Co',
    facts: {
      'us-gaap': Object.fromEntries(
        Object.entries(concepts).map(([k, v]) => [k, { units: { [units]: v } }]),
      ),
    },
  } as CompanyFacts;
}

const year = (endYear: number, val: number, fy: number, filed: string): Point => ({
  start: `${endYear - 1}-10-01`,
  end: `${endYear}-09-30`,
  val,
  fy,
  fp: 'FY',
  form: '10-K',
  filed,
});

describe('picking the right value for a period', () => {
  it('takes the latest filing, so restatements win', () => {
    // A 10-K restates prior years alongside the current one. The newest filing
    // is the company's current position on what happened.
    const s = annualSeries(
      facts({
        Revenues: [
          { ...year(2023, 100, 2023, '2023-11-01') },
          { ...year(2023, 95, 2024, '2024-11-01') },
        ],
      }),
      ['Revenues'],
    );
    expect(s).toHaveLength(1);
    expect(s[0].value).toBe(95);
  });

  it('merges a concept the filer switched away from', () => {
    // NVIDIA reported revenue under RevenueFromContract... until fiscal 2022
    // and under Revenues before and after. Taking the first concept with any
    // data returned periods ending in 2022 and silently dropped every year
    // since — the company shown at a quarter of its size, with nothing on
    // screen to say anything was missing.
    const s = annualSeries(
      facts({
        RevenueFromContractWithCustomerExcludingAssessedTax: [
          year(2021, 10, 2021, '2021-11-01'),
          year(2022, 20, 2022, '2022-11-01'),
        ],
        Revenues: [
          year(2020, 5, 2020, '2020-11-01'),
          year(2023, 60, 2023, '2023-11-01'),
          year(2024, 130, 2024, '2024-11-01'),
        ],
      }),
      ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'],
    );
    expect(s.map((p) => p.value)).toEqual([5, 10, 20, 60, 130]);
  });

  it('prefers the earlier concept in the chain on a same-filing tie', () => {
    const s = annualSeries(
      facts({
        RevenueFromContractWithCustomerExcludingAssessedTax: [year(2023, 100, 2023, '2023-11-01')],
        Revenues: [year(2023, 999, 2023, '2023-11-01')],
      }),
      ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'],
    );
    expect(s[0].value).toBe(100);
  });
});

describe('excluding periods that are not years', () => {
  it('drops year-to-date figures from quarterly filings', () => {
    // A nine-month YTD figure taken as annual makes a company look like it
    // earned three quarters of revenue in a year.
    const s = annualSeries(
      facts({
        Revenues: [
          year(2023, 100, 2023, '2023-11-01'),
          { start: '2023-01-01', end: '2023-09-30', val: 70, fy: 2023, fp: 'Q3', form: '10-Q', filed: '2023-10-01' },
          { start: '2023-01-01', end: '2023-09-30', val: 70, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-01' },
        ],
      }),
      ['Revenues'],
    );
    expect(s).toHaveLength(1);
    expect(s[0].value).toBe(100);
  });

  it('accepts a 52- and a 53-week year', () => {
    const s = annualSeries(
      facts({
        Revenues: [
          { start: '2022-01-02', end: '2022-12-31', val: 50, fy: 2022, fp: 'FY', form: '10-K', filed: '2023-02-01' },
          { start: '2023-01-01', end: '2023-12-30', val: 60, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' },
        ],
      }),
      ['Revenues'],
    );
    expect(s).toHaveLength(2);
  });

  it('reads balance-sheet facts, which have no start date', () => {
    const s = annualSeries(
      facts({
        Assets: [
          { end: '2023-09-30', val: 500, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-01' },
        ],
      }),
      ['Assets'],
      { instant: true },
    );
    expect(s[0].value).toBe(500);
  });
});

describe('fiscal year labels', () => {
  it('counts back from the newest, which is the only reliable anchor', () => {
    // Older periods survive in the API only as comparatives, and a comparative
    // carries the FILING's fiscal year rather than the period's. Trusting each
    // row's own label gave correct recent years and drifting old ones.
    const s = annualSeries(
      facts({
        Revenues: [
          year(2021, 10, 2024, '2024-11-01'),
          year(2022, 20, 2024, '2024-11-01'),
          year(2023, 30, 2024, '2024-11-01'),
          year(2024, 40, 2024, '2024-11-01'),
        ],
      }),
      ['Revenues'],
    );
    expect(s.map((p) => p.fiscalYear)).toEqual([2021, 2022, 2023, 2024]);
  });

  it('reflects a genuine missing year in the spacing', () => {
    const s = annualSeries(
      facts({
        Revenues: [year(2020, 10, 2024, '2024-11-01'), year(2022, 20, 2022, '2022-11-01')],
      }),
      ['Revenues'],
    );
    // Two years apart in dates must be two years apart in labels.
    expect(s[1].fiscalYear - s[0].fiscalYear).toBe(2);
  });
});

describe('derived figures', () => {
  const full = facts({
    Revenues: [year(2023, 1000, 2023, '2023-11-01'), year(2024, 1200, 2024, '2024-11-01')],
    GrossProfit: [year(2023, 400, 2023, '2023-11-01'), year(2024, 540, 2024, '2024-11-01')],
    OperatingIncomeLoss: [year(2023, 200, 2023, '2023-11-01'), year(2024, 300, 2024, '2024-11-01')],
    NetIncomeLoss: [year(2023, 150, 2023, '2023-11-01'), year(2024, 240, 2024, '2024-11-01')],
    NetCashProvidedByUsedInOperatingActivities: [year(2024, 320, 2024, '2024-11-01')],
    PaymentsToAcquirePropertyPlantAndEquipment: [year(2024, 80, 2024, '2024-11-01')],
    Assets: [{ end: '2024-09-30', val: 2000, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }],
    StockholdersEquity: [{ end: '2024-09-30', val: 800, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }],
    LongTermDebtNoncurrent: [{ end: '2024-09-30', val: 400, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }],
    CashAndCashEquivalentsAtCarryingValue: [{ end: '2024-09-30', val: 100, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }],
  });

  it('computes margins and growth from the reported figures', () => {
    const { rows } = buildAnnualRows(full);
    const last = rows[rows.length - 1];
    expect(last.grossMargin).toBeCloseTo(540 / 1200, 10);
    expect(last.operatingMargin).toBeCloseTo(300 / 1200, 10);
    expect(last.netMargin).toBeCloseTo(240 / 1200, 10);
    expect(last.revenueGrowth).toBeCloseTo(0.2, 10);
    expect(last.roe).toBeCloseTo(240 / 800, 10);
  });

  it('subtracts capex from operating cash flow, since capex is reported positive', () => {
    const { rows } = buildAnnualRows(full);
    expect(rows[rows.length - 1].freeCashFlow).toBe(240);
  });

  it('puts ROIC on equity plus debt, not equity alone', () => {
    const { rows } = buildAnnualRows(full);
    expect(rows[rows.length - 1].roic).toBeCloseTo(300 / (800 + 400), 10);
  });

  it('returns null rather than a plausible number when an input is missing', () => {
    // A page that substitutes zero for missing debt reports a flattering
    // EV/EBITDA and looks entirely normal doing it.
    const thin = facts({ Revenues: [year(2024, 1000, 2024, '2024-11-01')] });
    const { rows } = buildAnnualRows(thin);
    const r = rows[0];
    expect(r.grossMargin).toBeNull();
    expect(r.freeCashFlow).toBeNull();
    expect(r.roe).toBeNull();
    expect(r.totalDebt).toBeNull();
  });

  it('records which concept supplied each figure', () => {
    const { conceptsUsed } = buildAnnualRows(full);
    expect(conceptsUsed.find((c) => c.field === 'revenue')?.concept).toBe('Revenues');
  });
});

describe('valuation', () => {
  const full = facts({
    Revenues: [year(2024, 1000, 2024, '2024-11-01')],
    NetIncomeLoss: [year(2024, 100, 2024, '2024-11-01')],
    EarningsPerShareDiluted: [year(2024, 2, 2024, '2024-11-01')],
    StockholdersEquity: [{ end: '2024-09-30', val: 500, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }],
    CommonStockSharesOutstanding: [{ end: '2024-09-30', val: 50, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }],
  });

  it('derives the standard multiples from price and the last full year', () => {
    const { rows } = buildAnnualRows(full);
    const v = valuation(full, rows, 40)!;
    expect(v.marketCap).toBe(2000);
    expect(v.peRatio).toBe(20);
    expect(v.psRatio).toBe(2);
    expect(v.pbRatio).toBe(4);
    // And says what it is on, so it is not compared against a TTM figure.
    expect(v.basis).toMatch(/fiscal 2024/);
  });

  it('refuses a nonsensical price', () => {
    const { rows } = buildAnnualRows(full);
    expect(valuation(full, rows, 0)).toBeNull();
    expect(valuation(full, rows, Number.NaN)).toBeNull();
  });
});

describe('dilution across a split', () => {
  const shares = (vals: number[]) =>
    facts({
      Revenues: vals.map((_, i) => year(2018 + i, 100, 2018 + i, `${2018 + i}-11-01`)),
      WeightedAverageNumberOfDilutedSharesOutstanding: vals.map((v, i) =>
        year(2018 + i, v, 2018 + i, `${2018 + i}-11-01`),
      ),
    });

  it('reports buybacks as a reduction', () => {
    const { rows } = buildAnnualRows(shares([100, 95, 90, 85]));
    const d = dilution(rows)!;
    expect(d.changePct).toBeCloseTo(85 / 100 - 1, 10);
    expect(d.splitNote).toBeNull();
  });

  it('does not read a stock split as issuance', () => {
    // SEC share counts are as reported and carry no split adjustment. Measured
    // naively across a 4-for-1, a company that buys back every year appears to
    // have diluted shareholders enormously.
    const { rows } = buildAnnualRows(shares([100, 95, 380, 360, 340]));
    const d = dilution(rows)!;
    expect(d.splitNote).toMatch(/split/i);
    // Measured after the split only, so the trend is a reduction.
    expect(d.changePct).toBeLessThan(0);
  });
});

describe('placeholder zeros in balance-sheet totals', () => {
  /**
   * Regression: Coca-Cola's research page reported 2007 shareholders' equity as
   * $0. EDGAR really does carry that fact — value 0 at 2006-12-31 and
   * 2007-12-31 for StockholdersEquityIncludingPortionAttributableToNoncontroll-
   * ingInterest, both filed with the 2009 10-K, with the first real figure
   * (20,862,000,000) at 2008-12-31. They come from the statement of shareowners'
   * equity tagging comparative years the statement does not actually present.
   *
   * A company that filed a 10-K does not have equity of exactly nil to the
   * dollar, so the figure is absent rather than zero. A missing figure and a
   * figure of zero say very different things, and only one of them is true.
   */
  const instant = (endYear: number, val: number): Point => ({
    end: `${endYear}-09-30`,
    val,
    fy: 2009,
    fp: 'FY',
    form: '10-K',
    filed: '2010-02-26',
  });

  const revenues = [year(2007, 28857, 2009, '2010-02-26'), year(2008, 31944, 2009, '2010-02-26')];

  it('omits an equity figure of exactly zero rather than reporting $0', () => {
    const { rows } = buildAnnualRows(
      facts({
        Revenues: revenues,
        StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: [
          instant(2007, 0),
          instant(2008, 20862000000),
        ],
      }),
    );
    expect(rows.find((r) => r.end === '2007-09-30')?.equity).toBeNull();
    expect(rows.find((r) => r.end === '2008-09-30')?.equity).toBe(20862000000);
  });

  it('does not report a return on equity built on the placeholder', () => {
    // The divide-by-zero guard already blanked ROE, but the $0 equity itself
    // still rendered, which was the visible falsehood.
    const { rows } = buildAnnualRows(
      facts({
        Revenues: revenues,
        NetIncomeLoss: [year(2007, 5981, 2009, '2010-02-26')],
        StockholdersEquity: [instant(2007, 0), instant(2008, 20862000000)],
      }),
    );
    const y = rows.find((r) => r.end === '2007-09-30');
    expect(y?.equity).toBeNull();
    expect(y?.roe).toBeNull();
  });

  it('drops placeholder zeros in total assets too', () => {
    const { rows } = buildAnnualRows(
      facts({ Revenues: revenues, Assets: [instant(2007, 0), instant(2008, 40519000000)] }),
    );
    expect(rows.find((r) => r.end === '2007-09-30')?.assets).toBeNull();
    expect(rows.find((r) => r.end === '2008-09-30')?.assets).toBe(40519000000);
  });

  it('keeps a genuine zero debt balance, which is a real thing to report', () => {
    // A debt-free company is meaningful and must not be blanked out by the same
    // rule that removes balance-sheet placeholders.
    const { rows } = buildAnnualRows(
      facts({ Revenues: revenues, LongTermDebtNoncurrent: [instant(2008, 0)] }),
    );
    expect(rows.find((r) => r.end === '2008-09-30')?.totalDebt).toBe(0);
  });
});
