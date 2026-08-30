import { spanDays, type CompanyFacts } from '@/lib/fundamentals/sec';
import type { Filing } from '@/lib/news/filings';

/**
 * Past earnings, from what the company reported and when it reported it.
 * =============================================================================
 * Two facts joined: the quarterly figures from XBRL, and the date the company
 * announced them, taken from the 8-K that carried item 2.02 — "Results of
 * Operations and Financial Condition". That 8-K *is* the earnings release, so
 * its filing date is the announcement date rather than an approximation of it.
 * The 10-Q follows weeks later and would date the quarter wrongly.
 *
 * WHY THE FOURTH QUARTER IS MISSING
 *
 * There is no 10-Q for the fourth quarter — the 10-K covers it — so most
 * filers never tag a fourth-quarter duration. Apple has 67 quarters of diluted
 * EPS in EDGAR and none of them is a Q4.
 *
 * It could be derived by subtracting three quarters from the annual figure.
 * Revenue and net income would be exact, since both are additive. Diluted EPS
 * would not: it is struck on a weighted average share count that differs each
 * quarter, so the annual figure is not the sum of the four. A quarter where
 * revenue is measured and EPS is estimated, sitting in a column of quarters
 * where both are reported, is the kind of row that gets read as reported. So
 * the fourth quarter is absent and labelled absent, and its figures are on the
 * annual statements above.
 */

interface RawPoint {
  start?: string;
  end: string;
  val: number;
  fp?: string;
  form?: string;
  filed?: string;
}

/** A quarter is 13 weeks; the band allows for 52/53-week fiscal calendars. */
const MIN_DAYS = 80;
const MAX_DAYS = 100;

const QUARTER_FORMS = new Set(['10-Q', '10-Q/A', '10-K', '10-K/A']);

/**
 * Quarterly values for one concept chain, resolved per period the same way the
 * annual series resolves: pool the chain, latest filing wins, ties broken by
 * chain order so the more specific concept is preferred.
 */
function quarterlySeries(
  facts: CompanyFacts,
  concepts: readonly string[],
): Map<string, { value: number; start: string; fp: string | null }> {
  const bucket = facts.facts?.['us-gaap'];
  const out = new Map<string, { value: number; start: string; fp: string | null; filed: string; rank: number }>();
  if (!bucket) return new Map();

  concepts.forEach((concept, rank) => {
    const entry = bucket[concept];
    if (!entry) return;
    for (const point of Object.values(entry.units).flat() as RawPoint[]) {
      if (!point.start) continue;
      if (!QUARTER_FORMS.has(point.form ?? '')) continue;
      const days = spanDays(point.start, point.end);
      if (days < MIN_DAYS || days > MAX_DAYS) continue;
      const filed = point.filed ?? '';
      const seen = out.get(point.end);
      if (seen && !(filed > seen.filed || (filed === seen.filed && rank < seen.rank))) continue;
      out.set(point.end, { value: point.val, start: point.start, fp: point.fp ?? null, filed, rank });
    }
  });

  return new Map([...out].map(([end, v]) => [end, { value: v.value, start: v.start, fp: v.fp }]));
}

const EPS_CONCEPTS = ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] as const;
const REVENUE_CONCEPTS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
] as const;
const INCOME_CONCEPTS = ['NetIncomeLoss', 'ProfitLoss'] as const;

export interface EarningsQuarter {
  /** Period covered. */
  start: string;
  end: string;
  /** The filer's own label for the quarter, where it gave one. */
  fiscalPeriod: string | null;
  /** When the results were announced, from the 8-K carrying item 2.02. */
  reportedOn: string | null;
  /** Link to that announcement, so a figure can be traced to its release. */
  reportUrl: string | null;
  epsDiluted: number | null;
  revenue: number | null;
  netIncome: number | null;
}

/**
 * Finds the 8-K that announced a quarter's results: the earliest one carrying
 * item 2.02 filed after the quarter ended.
 *
 * Bounded to 120 days after the period end. Beyond that the filing belongs to
 * a later quarter — a company that has not reported within four months has
 * missed the deadline, and the next 2.02 is the following quarter's.
 */
function announcementFor(end: string, releases: Filing[]): Filing | null {
  const endMs = Date.parse(end);
  let best: Filing | null = null;
  for (const f of releases) {
    const filedMs = Date.parse(f.filed);
    if (Number.isNaN(filedMs) || filedMs < endMs) continue;
    if (filedMs - endMs > 120 * 86_400_000) continue;
    if (!best || f.filed < best.filed) best = f;
  }
  return best;
}

export function earningsHistory(
  facts: CompanyFacts,
  filings: Filing[],
  limit = 12,
): EarningsQuarter[] {
  const eps = quarterlySeries(facts, EPS_CONCEPTS);
  const revenue = quarterlySeries(facts, REVENUE_CONCEPTS);
  const income = quarterlySeries(facts, INCOME_CONCEPTS);

  const releases = filings.filter(
    (f) => f.form.startsWith('8-K') && f.events.includes('Reported results of operations'),
  );

  // Every quarter any of the three concepts covers, so a period with revenue
  // but no tagged EPS still appears rather than vanishing.
  const ends = new Set([...eps.keys(), ...revenue.keys(), ...income.keys()]);

  const quarters: EarningsQuarter[] = [...ends]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, limit)
    .map((end) => {
      const anchor = eps.get(end) ?? revenue.get(end) ?? income.get(end)!;
      const release = announcementFor(end, releases);
      return {
        start: anchor.start,
        end,
        fiscalPeriod: anchor.fp,
        reportedOn: release?.filed ?? null,
        reportUrl: release?.url ?? null,
        epsDiluted: eps.get(end)?.value ?? null,
        revenue: revenue.get(end)?.value ?? null,
        netIncome: income.get(end)?.value ?? null,
      };
    });

  return quarters;
}
