import { annualSeries, latest, type AnnualPoint, type CompanyFacts } from './sec';

/**
 * Derived fundamentals.
 * =============================================================================
 * Everything here is arithmetic over reported facts. Nothing is estimated, and
 * where an input is missing the output is null rather than a plausible number —
 * a fundamentals page that quietly substitutes zero for missing debt reports a
 * flattering EV/EBITDA and looks completely normal doing it.
 *
 * Concept fallback chains appear throughout because filers do not tag the same
 * thing the same way. The chains are ordered most-specific first; the concept
 * that actually supplied each figure travels with the result so a number can be
 * traced back to the tag in the filing.
 */

/* Concept chains, most specific first. */
const C = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
  ],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  epsBasic: ['EarningsPerShareBasic'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  shortTermInvestments: ['ShortTermInvestments', 'MarketableSecuritiesCurrent'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  shortTermDebt: ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'],
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ],
  dividendsPaid: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
  sharesDiluted: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  sharesBasic: ['WeightedAverageNumberOfSharesOutstandingBasic', 'WeightedAverageNumberOfSharesOutstanding'],
  interestExpense: ['InterestExpense', 'InterestIncomeExpenseNet'],
  taxExpense: ['IncomeTaxExpenseBenefit'],
  depreciation: [
    'DepreciationDepletionAndAmortization',
    'DepreciationAmortizationAndAccretionNet',
    'Depreciation',
  ],
} as const;

export interface YearRow {
  fiscalYear: number;
  end: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null;
  assets: number | null;
  liabilities: number | null;
  equity: number | null;
  cash: number | null;
  totalDebt: number | null;
  sharesDiluted: number | null;
  dividendsPaid: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  fcfMargin: number | null;
  roe: number | null;
  roic: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
}

/** Divides, returning null rather than Infinity or NaN. */
function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

function add(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Year-over-year growth, null when the base is absent or non-positive. */
function growth(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior <= 0) return null;
  return current / prior - 1;
}

/** Indexes a series by fiscal-year end for row assembly. */
function byEnd(points: AnnualPoint[]): Map<string, number> {
  return new Map(points.map((p) => [p.end, p.value]));
}

export interface ConceptUse {
  field: string;
  concept: string;
}

/**
 * Drops a diluted share count that was filed at the wrong scale.
 *
 * Early XBRL filings sometimes tagged share counts in thousands or millions
 * while the surrounding years used absolute counts. Merck's 2010 count is
 * 3,120 where 2009 is 2,273,000,000 and 2011 is 3,094,000,000; NVIDIA's 2008
 * and 2009 are in thousands. Rendered literally, Merck reported a diluted
 * share count of three thousand.
 *
 * Detection is not an outlier test — a company really can change its share
 * count sharply, and a reverse split really can divide it by a hundred. It is
 * an arithmetic one: diluted EPS times diluted shares is income available to
 * common shareholders, so the ratio between that product and net income is
 * near one for most companies, and further from one for a company paying large
 * preferred dividends — Bank of America's 2011 ratio is 14. A scale error is a
 * different animal: it lands within a whisker of a power of a thousand, 985,126
 * for Merck and 1,004 for NVIDIA, because that is what a units mistake does.
 * So only ratios close to 1,000, a million or a billion are treated as one.
 *
 * The count is dropped rather than multiplied back. Inferring the intended
 * scale from EPS is convincing enough to disbelieve the figure and not enough
 * to publish a number the filer did not file, and dilution already skips years
 * with no count — which is better than the alternative it faced before, where
 * the jump back to billions read as a stock split.
 */
function withoutMisscaledShares(row: YearRow): YearRow {
  const { netIncome: ni, epsDiluted: eps, sharesDiluted: shares } = row;
  if (ni == null || eps == null || shares == null) return row;
  if (ni <= 0 || eps <= 0 || shares <= 0) return row;

  const ratio = ni / (eps * shares);
  const misscaled = [1e3, 1e6, 1e9].some((scale) => Math.abs(ratio / scale - 1) < 0.2);
  return misscaled ? { ...row, sharesDiluted: null } : row;
}

export function buildAnnualRows(facts: CompanyFacts): {
  rows: YearRow[];
  conceptsUsed: ConceptUse[];
} {
  const conceptsUsed: ConceptUse[] = [];
  const series = (
    field: string,
    concepts: readonly string[],
    instant = false,
    filedCap?: Map<string, string>,
  ) => {
    const s = annualSeries(facts, [...concepts], { instant, filedCap });
    if (s.length) conceptsUsed.push({ field, concept: s[0].concept });
    return s;
  };

  /**
   * Drops balance-sheet totals reported as exactly zero.
   *
   * A company that filed a 10-K does not have zero total assets, zero total
   * liabilities, or equity of exactly nil to the dollar. Those zeros come from
   * the statement of shareowners' equity, where a roll-forward line is tagged
   * for comparative years that the statement does not actually present —
   * Coca-Cola carries `StockholdersEquityIncludingPortionAttributableToNon-
   * controllingInterest` of 0 at both 2006-12-31 and 2007-12-31, filed with the
   * 2009 10-K, and then 20,862,000,000 at 2008-12-31 where the real balance
   * sheet begins. Rendered literally, the research page reported Coca-Cola's
   * 2007 equity as $0.
   *
   * A missing figure and a figure of zero say very different things, and only
   * one of them is true here, so the placeholder becomes "not reported".
   *
   * Deliberately NOT applied to debt or cash: a company with no debt is a real
   * and important thing to be able to see, and zeroing it out would hide it.
   */
  const withoutPlaceholderZeros = (points: AnnualPoint[]) => points.filter((p) => p.value !== 0);

  const revenue = series('revenue', C.revenue);
  const grossProfit = series('grossProfit', C.grossProfit);
  const operatingIncome = series('operatingIncome', C.operatingIncome);
  const netIncome = series('netIncome', C.netIncome);
  const eps = series('epsDiluted', C.epsDiluted);
  const ocf = series('operatingCashFlow', C.operatingCashFlow);
  const capex = series('capex', C.capex);
  const dividends = series('dividendsPaid', C.dividendsPaid);
  const sharesD = series('sharesDiluted', C.sharesDiluted);

  /*
   * Total assets dates the balance sheet.
   *
   * It is the one line every balance sheet reports, so the filing that most
   * recently stated it is the most recent reading of the statement as a whole.
   * The other lines are then taken as of that reading: each still resolves to
   * its own newest value, but none may come from a later filing than the one
   * total assets came from. See the note on `filedCap` in sec.ts.
   */
  const assets = withoutPlaceholderZeros(series('assets', C.assets, true));
  const asOf = new Map(assets.map((p) => [p.end, p.filed]));

  const liabilities = withoutPlaceholderZeros(series('liabilities', C.liabilities, true, asOf));
  const equity = withoutPlaceholderZeros(series('equity', C.equity, true, asOf));
  const cash = series('cash', C.cash, true, asOf);
  const ltDebt = series('longTermDebt', C.longTermDebt, true, asOf);
  const stDebt = series('shortTermDebt', C.shortTermDebt, true, asOf);

  const maps = {
    revenue: byEnd(revenue),
    grossProfit: byEnd(grossProfit),
    operatingIncome: byEnd(operatingIncome),
    netIncome: byEnd(netIncome),
    eps: byEnd(eps),
    ocf: byEnd(ocf),
    capex: byEnd(capex),
    dividends: byEnd(dividends),
    sharesD: byEnd(sharesD),
    assets: byEnd(assets),
    liabilities: byEnd(liabilities),
    equity: byEnd(equity),
    cash: byEnd(cash),
    ltDebt: byEnd(ltDebt),
    stDebt: byEnd(stDebt),
  };

  // Revenue defines the reporting calendar; a year with no revenue reported is
  // not a year this company filed an annual report for.
  const rows: YearRow[] = revenue.map((r) => {
    const end = r.end;
    const rev = maps.revenue.get(end) ?? null;
    const gp = maps.grossProfit.get(end) ?? null;
    const op = maps.operatingIncome.get(end) ?? null;
    const ni = maps.netIncome.get(end) ?? null;
    const cfo = maps.ocf.get(end) ?? null;
    const cx = maps.capex.get(end) ?? null;
    const eq = maps.equity.get(end) ?? null;
    // Capex is reported as a positive payment, so free cash flow subtracts it.
    const fcf = cfo != null && cx != null ? cfo - cx : null;
    const debt = maps.ltDebt.has(end) || maps.stDebt.has(end)
      ? add(maps.ltDebt.get(end) ?? null, maps.stDebt.get(end) ?? null)
      : null;

    // ROIC on invested capital = equity + debt, which is the capital the
    // business actually employs rather than the accounting equity alone.
    const invested = eq != null ? add(eq, debt ?? 0) : null;

    return {
      fiscalYear: r.fiscalYear,
      end,
      revenue: rev,
      grossProfit: gp,
      operatingIncome: op,
      netIncome: ni,
      epsDiluted: maps.eps.get(end) ?? null,
      operatingCashFlow: cfo,
      capex: cx,
      freeCashFlow: fcf,
      assets: maps.assets.get(end) ?? null,
      liabilities: maps.liabilities.get(end) ?? null,
      equity: eq,
      cash: maps.cash.get(end) ?? null,
      totalDebt: debt,
      sharesDiluted: maps.sharesD.get(end) ?? null,
      dividendsPaid: maps.dividends.get(end) ?? null,
      grossMargin: ratio(gp, rev),
      operatingMargin: ratio(op, rev),
      netMargin: ratio(ni, rev),
      fcfMargin: ratio(fcf, rev),
      roe: ratio(ni, eq),
      roic: ratio(op, invested),
      revenueGrowth: null,
      epsGrowth: null,
    };
  });

  // Growth needs the prior row, so it is filled after assembly.
  for (let i = 1; i < rows.length; i++) {
    rows[i].revenueGrowth = growth(rows[i].revenue, rows[i - 1].revenue);
    rows[i].epsGrowth = growth(rows[i].epsDiluted, rows[i - 1].epsDiluted);
  }

  return { rows: rows.map(withoutMisscaledShares), conceptsUsed };
}

/* ------------------------------------------------------------------ */
/* Valuation                                                           */
/* ------------------------------------------------------------------ */

export interface Valuation {
  price: number;
  sharesOutstanding: number | null;
  marketCap: number | null;
  enterpriseValue: number | null;
  peRatio: number | null;
  psRatio: number | null;
  pbRatio: number | null;
  evToEbitda: number | null;
  fcfYield: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  /** Trailing twelve months is not used; these are last full fiscal year. */
  basis: string;
}

/**
 * Valuation from the latest annual figures and a current price.
 *
 * Explicitly last-full-fiscal-year rather than trailing twelve months. TTM
 * would need quarterly assembly with its own restatement handling, and a page
 * that says "P/E" without saying on what basis invites the reader to compare
 * it against a TTM figure elsewhere and conclude the stock moved.
 */
export function valuation(
  facts: CompanyFacts,
  rows: YearRow[],
  price: number,
): Valuation | null {
  if (!rows.length || !Number.isFinite(price) || price <= 0) return null;
  const last = rows[rows.length - 1];

  // Shares outstanding at the cover date of the latest filing is closer to
  // today than the weighted average used for EPS.
  const shares =
    latest(facts, ['EntityCommonStockSharesOutstanding'], true) ??
    latest(facts, ['CommonStockSharesOutstanding'], true) ??
    last.sharesDiluted;

  const marketCap = shares != null ? price * shares : null;
  const netDebt =
    last.totalDebt != null || last.cash != null
      ? (last.totalDebt ?? 0) - (last.cash ?? 0)
      : null;
  const ev = marketCap != null && netDebt != null ? marketCap + netDebt : null;

  const ebitda =
    last.operatingIncome != null
      ? last.operatingIncome + (latest(facts, [...C.depreciation]) ?? 0)
      : null;

  return {
    price,
    sharesOutstanding: shares,
    marketCap,
    enterpriseValue: ev,
    peRatio: ratio(price, last.epsDiluted),
    psRatio: ratio(marketCap, last.revenue),
    pbRatio: ratio(marketCap, last.equity),
    evToEbitda: ratio(ev, ebitda),
    fcfYield: ratio(last.freeCashFlow, marketCap),
    // Dividends paid is a cash outflow reported positive; per share against
    // price gives the yield on the last full year rather than a forward rate.
    dividendYield:
      last.dividendsPaid != null && marketCap != null && marketCap > 0
        ? last.dividendsPaid / marketCap
        : null,
    payoutRatio: ratio(last.dividendsPaid, last.netIncome),
    basis: `fiscal ${last.fiscalYear}, ended ${last.end}`,
  };
}

export interface Dilution {
  changePct: number | null;
  years: number;
  from: number;
  to: number;
  /** Set when a stock split truncated the comparable window. */
  splitNote: string | null;
}

/**
 * Change in diluted share count — buybacks against issuance.
 *
 * SEC share counts are AS REPORTED and carry no split adjustment, so the
 * series jumps discontinuously at a split. Measured naively across Apple's
 * 4-for-1 in 2020, a company that has bought back stock every year for a
 * decade appears to have diluted shareholders by 186%.
 *
 * A jump of more than 40% between consecutive years is treated as a split
 * rather than as issuance — no company issues that proportion of itself in a
 * year through ordinary dilution — and the comparison starts after it, with a
 * note saying the window was shortened and why.
 */
export function dilution(rows: YearRow[]): Dilution | null {
  const withShares = rows.filter((r) => r.sharesDiluted != null && r.sharesDiluted > 0);
  if (withShares.length < 2) return null;

  let startIndex = 0;
  let splitNote: string | null = null;
  for (let i = 1; i < withShares.length; i++) {
    const prev = withShares[i - 1].sharesDiluted!;
    const curr = withShares[i].sharesDiluted!;
    if (curr / prev > 1.4 || curr / prev < 1 / 1.4) {
      startIndex = i;
      const ratioText = (curr / prev).toFixed(1);
      splitNote =
        `Share count jumps ${ratioText}x at fiscal ${withShares[i].fiscalYear}, which is a ` +
        'stock split rather than issuance — SEC figures are not split-adjusted. Measured from ' +
        'after it.';
    }
  }

  const window = withShares.slice(startIndex);
  if (window.length < 2) return null;
  const first = window[0].sharesDiluted!;
  const last = window[window.length - 1].sharesDiluted!;

  return {
    changePct: last / first - 1,
    years: window.length - 1,
    from: first,
    to: last,
    splitNote,
  };
}
