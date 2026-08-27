import { toCsv } from './csv';
import type { YearRow, Valuation, Dilution } from '@/lib/fundamentals/metrics';
import type { ConceptUse } from '@/lib/fundamentals/metrics';

/**
 * Fundamentals CSV export.
 *
 * Like the backtest exporter, values are written unrounded: a spreadsheet
 * should receive the figure the company filed, not the abbreviation the page
 * displayed. `$391.0B` on screen is `391035000000` here.
 *
 * WHY THE PROVENANCE BLOCK IS NOT OPTIONAL
 *
 * The research page labels every figure with its source and filing date because
 * an unlabelled fundamental is worth very little — you cannot tell a restated
 * figure from an original, or a company's own tag from someone's estimate. A
 * CSV export is precisely the moment that labelling would normally be lost: the
 * number leaves the app and lands in a spreadsheet with nothing attached, and
 * from there into a model whose author has no idea it came from a 2019 filing.
 *
 * So the export carries its own provenance — the source, the filing it was read
 * from, and the XBRL concept behind each field. The concept list matters more
 * than it looks: companies switch tags mid-history (NVIDIA changed its revenue
 * tag in 2022), and knowing which tag produced a column is the difference
 * between a comparable series and a broken one.
 */

export interface FundamentalsExport {
  company: { ticker: string; name: string; cik: string };
  rows: YearRow[];
  valuation: Valuation | null;
  dilution: Dilution | null;
  price: { close: number; asOf: string | null } | null;
  provenance: {
    financials: string;
    latestFilingDate: string;
    priceSource: string | null;
    conceptsUsed: ConceptUse[];
    estimatesNote: string;
  };
}

/** Column order follows the page: income, then cash flow, balance sheet, ratios. */
const COLUMNS: Array<[string, (r: YearRow) => number | null]> = [
  ['Revenue', (r) => r.revenue],
  ['Gross profit', (r) => r.grossProfit],
  ['Operating income', (r) => r.operatingIncome],
  ['Net income', (r) => r.netIncome],
  ['Diluted EPS', (r) => r.epsDiluted],
  ['Operating cash flow', (r) => r.operatingCashFlow],
  ['Capital expenditure', (r) => r.capex],
  ['Free cash flow', (r) => r.freeCashFlow],
  ['Total assets', (r) => r.assets],
  ['Total liabilities', (r) => r.liabilities],
  ['Shareholders equity', (r) => r.equity],
  ['Cash and equivalents', (r) => r.cash],
  ['Total debt', (r) => r.totalDebt],
  ['Diluted shares', (r) => r.sharesDiluted],
  ['Dividends paid', (r) => r.dividendsPaid],
  ['Gross margin', (r) => r.grossMargin],
  ['Operating margin', (r) => r.operatingMargin],
  ['Net margin', (r) => r.netMargin],
  ['FCF margin', (r) => r.fcfMargin],
  ['Return on equity', (r) => r.roe],
  ['Return on invested capital', (r) => r.roic],
  ['Revenue growth', (r) => r.revenueGrowth],
  ['EPS growth', (r) => r.epsGrowth],
];

export function buildFundamentalsCsv(data: FundamentalsExport): string {
  const rows: Array<Array<string | number | null | undefined>> = [];

  rows.push(['Company', data.company.name]);
  rows.push(['Ticker', data.company.ticker]);
  rows.push(['CIK', data.company.cik]);
  rows.push([]);

  // Annual figures, years as rows — consistent with the backtest exporter, and
  // the orientation a spreadsheet sorts and charts without transposing first.
  rows.push(['Fiscal year', 'Period end', ...COLUMNS.map(([label]) => label)]);
  for (const r of data.rows) {
    rows.push([r.fiscalYear, r.end, ...COLUMNS.map(([, pick]) => pick(r))]);
  }

  if (data.valuation) {
    const v = data.valuation;
    rows.push([]);
    rows.push(['Valuation', '']);
    rows.push(['Price', v.price]);
    rows.push(['Market capitalisation', v.marketCap]);
    rows.push(['Enterprise value', v.enterpriseValue]);
    rows.push(['P/E', v.peRatio]);
    rows.push(['P/S', v.psRatio]);
    rows.push(['P/B', v.pbRatio]);
    rows.push(['EV/EBITDA', v.evToEbitda]);
    rows.push(['FCF yield', v.fcfYield]);
    rows.push(['Dividend yield', v.dividendYield]);
    rows.push(['Payout ratio', v.payoutRatio]);
    rows.push(['Shares outstanding', v.sharesOutstanding]);
    rows.push(['Basis', v.basis]);
  }

  if (data.dilution) {
    rows.push([]);
    rows.push(['Share count change', data.dilution.changePct]);
    rows.push(['Over years', data.dilution.years]);
    if (data.dilution.splitNote) rows.push(['Note', data.dilution.splitNote]);
  }

  rows.push([]);
  rows.push(['Source', data.provenance.financials]);
  rows.push(['Latest filing', data.provenance.latestFilingDate]);
  if (data.price?.asOf) rows.push(['Price as of', data.price.asOf]);
  if (data.provenance.priceSource) rows.push(['Price source', data.provenance.priceSource]);
  rows.push(['Estimates', data.provenance.estimatesNote]);
  rows.push(['Exported', new Date().toISOString().slice(0, 10)]);

  if (data.provenance.conceptsUsed.length) {
    rows.push([]);
    rows.push(['Field', 'XBRL concept']);
    for (const c of data.provenance.conceptsUsed) rows.push([c.field, c.concept]);
  }

  return toCsv(rows);
}
