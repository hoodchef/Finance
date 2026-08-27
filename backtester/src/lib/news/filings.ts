import { secGetJson } from '@/lib/fundamentals/sec';

/**
 * Company news, from the filings.
 * =============================================================================
 * What a company has actually told the market, taken from EDGAR rather than
 * from a news aggregator.
 *
 * WHY FILINGS ARE THE BACKBONE AND HEADLINES ARE NOT
 *
 * The same three reasons that made EDGAR the fundamentals source apply here,
 * and one more. It is the primary record — a story about an earnings miss is a
 * journalist's reading of the 8-K this feed links to. It is public domain, so
 * a product may display it, where every affordable headline API surveyed is
 * licensed for personal use only (see `market-data/licence.ts`). It has no
 * daily quota. And an 8-K is filed because something material happened, which
 * is a far better relevance filter than any aggregator's: nobody files a
 * Current Report to pad a feed.
 *
 * What it is not: it is slower than the wire, it carries no market commentary,
 * and it says nothing about companies that do not file with the SEC.
 *
 * AN ALLOWLIST, NOT A BLOCKLIST
 *
 * This began as a blocklist of noisy forms and that was the wrong shape.
 * JPMorgan's recent filings contain 22,497 Form 424B2 prospectus supplements —
 * a bank issuing structured notes files them continuously — so its news feed
 * was twenty identical prospectuses and nothing else. No blocklist keeps up
 * with that, because the noise differs by industry.
 *
 * So the feed names the forms that report what a company has told the market,
 * and everything else is excluded by default. Measured across Apple, Coca-Cola,
 * Tesla and JPMorgan, this reduces 25,889 recent JPMorgan filings to the 31
 * that are material, while leaving the other three with 160+ each.
 *
 * Excluded on purpose, beyond the routine paperwork: Forms 3, 4, 5 and 144 are
 * individual insiders' transactions and notices, not company events — a large
 * company files hundreds a year, and they would bury everything else. Schedules
 * 13D and 13G are filed *by investors about* the company rather than by it.
 * Both are interesting feeds; neither answers "what happened to this company".
 */

/** 8-K item codes, which are what make a Current Report readable as an event. */
const ITEM_LABELS: Record<string, string> = {
  '1.01': 'Entered a material agreement',
  '1.02': 'Terminated a material agreement',
  '1.03': 'Bankruptcy or receivership',
  '2.01': 'Completed an acquisition or disposal',
  '2.02': 'Reported results of operations',
  '2.03': 'Took on a direct financial obligation',
  '2.04': 'Triggering event accelerating an obligation',
  '2.05': 'Costs of an exit or disposal',
  '2.06': 'Material impairment',
  '3.01': 'Delisting notice or listing-rule failure',
  '3.02': 'Unregistered sale of equity',
  '3.03': 'Modified the rights of security holders',
  '4.01': 'Changed its auditor',
  '4.02': 'Previously issued statements should no longer be relied on',
  '5.01': 'Change in control',
  '5.02': 'Director or officer change',
  '5.03': 'Amended its articles or changed its fiscal year',
  '5.07': 'Shareholder vote',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'Other reported event',
  '9.01': 'Financial statements and exhibits',
};

/**
 * Items that are material enough to mark. 4.02 says earlier financial
 * statements were wrong, which is among the most consequential things a filing
 * can say and reads like routine boilerplate if left as a bare code.
 */
const NOTABLE = new Set(['1.03', '2.06', '3.01', '4.01', '4.02', '5.01']);

const FORM_LABELS: Record<string, string> = {
  '10-K': 'Annual report',
  '10-K/A': 'Annual report (amended)',
  '10-Q': 'Quarterly report',
  '10-Q/A': 'Quarterly report (amended)',
  '8-K': 'Current report',
  '8-K/A': 'Current report (amended)',
  'DEF 14A': 'Proxy statement',
  'S-1': 'Registration of new securities',
  'S-1/A': 'Registration of new securities (amended)',
  'S-4': 'Registration for a merger or exchange',
  'S-4/A': 'Registration for a merger or exchange (amended)',
  '25-NSE': 'Exchange notified the SEC of a delisting',
  '20-F': 'Annual report (foreign issuer)',
  '20-F/A': 'Annual report (foreign issuer, amended)',
  '40-F': 'Annual report (Canadian issuer)',
  '40-F/A': 'Annual report (Canadian issuer, amended)',
  '6-K': 'Foreign issuer report',
  '6-K/A': 'Foreign issuer report (amended)',
};

/**
 * The forms that carry company news. Amendments are included alongside their
 * originals: a restated annual report is news in its own right.
 */
const MATERIAL_FORMS = new Set([
  '8-K', '8-K/A',
  '10-K', '10-K/A',
  '10-Q', '10-Q/A',
  '20-F', '20-F/A',
  '40-F', '40-F/A',
  '6-K', '6-K/A',
  'DEF 14A',
  '25-NSE',
  'S-1', 'S-1/A',
  'S-4', 'S-4/A',
]);

export interface Filing {
  form: string;
  /** Plain-English form name, falling back to the form code itself. */
  formLabel: string;
  filed: string;
  /** The period the filing covers, where it reports one. */
  reportDate: string | null;
  /** What the filing says happened, for 8-Ks that declare items. */
  events: string[];
  /** True when an item is consequential enough to draw the eye. */
  notable: boolean;
  url: string;
  accession: string;
}

interface RecentFilings {
  form?: string[];
  filingDate?: string[];
  reportDate?: string[];
  items?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
}

interface Submissions {
  name?: string;
  filings?: { recent?: RecentFilings };
}

function describeItems(raw: string | undefined): { events: string[]; notable: boolean } {
  if (!raw) return { events: [], notable: false };
  const codes = raw.split(',').map((c) => c.trim()).filter(Boolean);
  return {
    // An unmapped code is shown as the code rather than dropped: a filing we
    // cannot name is still a filing that happened.
    events: codes.map((c) => ITEM_LABELS[c] ?? `Item ${c}`),
    notable: codes.some((c) => NOTABLE.has(c)),
  };
}

/**
 * EDGAR serves documents from a path built out of the accession number with
 * its dashes removed, under the CIK with leading zeros stripped.
 */
function documentUrl(cik: string, accession: string, doc: string | undefined): string {
  const bare = accession.replace(/-/g, '');
  const num = String(Number(cik));
  return doc
    ? `https://www.sec.gov/Archives/edgar/data/${num}/${bare}/${doc}`
    : `https://www.sec.gov/Archives/edgar/data/${num}/${bare}/`;
}

export async function fetchFilings(cik: string, limit = 20): Promise<Filing[]> {
  const padded = cik.padStart(10, '0');
  const data = await secGetJson<Submissions>(`https://data.sec.gov/submissions/CIK${padded}.json`);
  const r = data.filings?.recent;
  if (!r?.form?.length) return [];

  const out: Filing[] = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    const form = r.form[i];
    if (!MATERIAL_FORMS.has(form)) continue;
    const accession = r.accessionNumber?.[i];
    const filed = r.filingDate?.[i];
    if (!accession || !filed) continue;
    const { events, notable } = describeItems(r.items?.[i]);
    const reported = r.reportDate?.[i];
    out.push({
      form,
      formLabel: FORM_LABELS[form] ?? form,
      filed,
      reportDate: reported && reported.length ? reported : null,
      events,
      notable,
      url: documentUrl(cik, accession, r.primaryDocument?.[i]),
      accession,
    });
  }
  return out;
}
