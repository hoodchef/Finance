import { MarketDataError, UnknownSymbolError } from '@/lib/market-data/provider';

/**
 * Company fundamentals from SEC EDGAR.
 * =============================================================================
 * The filings themselves, not a vendor's reading of them. Every figure here is
 * an XBRL fact a company tagged in its own 10-K or 10-Q.
 *
 * Chosen over the alternatives on three grounds, in order of weight:
 *
 *  1. It is the primary source. A vendor's fundamentals database is a
 *     transcription of this with its own errors and its own lag.
 *  2. Public domain. US government work carries no licence, which makes it the
 *     only fundamentals source surveyed that a commercial product may show to
 *     its users. Alpha Vantage's are personal-use, and its free tier is 25
 *     requests a day against the five this page needs per company.
 *  3. No key, and a published rate limit of ten requests a second rather than
 *     a daily quota.
 *
 * WHAT IT DOES NOT COVER: US filers only. A TSX-only listing files with SEDAR,
 * not the SEC, and is reported as unsupported rather than shown empty. And it
 * contains no market price and no analyst estimates — price comes from the
 * existing provider chain, and estimates have no free licensable source at all.
 */

const SEC_HOST = 'https://data.sec.gov';
const TICKER_INDEX = 'https://www.sec.gov/files/company_tickers.json';

/**
 * SEC asks for a contact address in the User-Agent and throttles requests
 * without one. Configurable so a deployment identifies itself; the default is
 * generic rather than anyone's personal address.
 */
function userAgent(): string {
  return process.env.SEC_USER_AGENT?.trim() || 'CanPath fundamentals research (contact via repo)';
}

/** Exported so the filings feed reaches EDGAR the same way, with the same
 * contact header SEC asks for and the same error mapping. */
export async function secGetJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  return getJson<T>(url, timeoutMs);
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    });
    if (res.status === 404) throw new UnknownSymbolError(url.split('/').pop() ?? '');
    if (!res.ok) throw new MarketDataError(`SEC EDGAR returned HTTP ${res.status}.`);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof MarketDataError || e instanceof UnknownSymbolError) throw e;
    throw new MarketDataError('Could not reach SEC EDGAR.', undefined, e);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Ticker to CIK                                                       */
/* ------------------------------------------------------------------ */

export interface CompanyRef {
  cik: string;
  ticker: string;
  name: string;
}

let tickerIndex: Map<string, CompanyRef> | null = null;
let tickerIndexAt = 0;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

/** The full ticker-to-CIK map. Small, and it changes about daily. */
async function loadTickerIndex(): Promise<Map<string, CompanyRef>> {
  if (tickerIndex && Date.now() - tickerIndexAt < INDEX_TTL_MS) return tickerIndex;
  const raw = await getJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
    TICKER_INDEX,
  );
  const map = new Map<string, CompanyRef>();
  for (const entry of Object.values(raw)) {
    if (!entry?.ticker) continue;
    map.set(entry.ticker.toUpperCase(), {
      // CIK is zero-padded to ten digits in the facts API.
      cik: String(entry.cik_str).padStart(10, '0'),
      ticker: entry.ticker.toUpperCase(),
      name: entry.title,
    });
  }
  tickerIndex = map;
  tickerIndexAt = Date.now();
  return map;
}

export async function resolveTicker(ticker: string): Promise<CompanyRef> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketDataError('Enter a ticker symbol.');
  const index = await loadTickerIndex();

  const direct = index.get(clean);
  if (direct) return direct;

  // A Canadian or other non-US suffix is the common miss, and saying so is
  // more useful than "not found" — the company may be perfectly real.
  if (/\.(TO|V|TSX|L|AX|HK|PA|DE|SW)$/i.test(clean)) {
    throw new MarketDataError(
      `${clean} is not a US listing. SEC EDGAR covers companies that file with the SEC; ` +
        'a TSX-only listing files with SEDAR instead. Try the US listing if one exists.',
      clean,
    );
  }
  /*
   * Not UnknownSymbolError, whose message is "No price history found" —
   * inherited from the price providers and wrong here. This lookup failed in
   * the SEC's company list, which is a different fact about a different thing,
   * and telling someone their ticker has no price history when they asked for
   * financial statements sends them looking in the wrong place.
   */
  throw new MarketDataError(
    `${clean} is not in the SEC's list of filing companies. Check the symbol — and note that ` +
      'this covers US filers only, so funds, foreign issuers and private companies will not ' +
      'appear.',
    clean,
  );
}

/* ------------------------------------------------------------------ */
/* Facts                                                               */
/* ------------------------------------------------------------------ */

interface XbrlPoint {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, XbrlPoint[]> }>>;
}

const factsCache = new Map<string, { facts: CompanyFacts; at: number }>();
const FACTS_TTL_MS = 6 * 60 * 60 * 1000;

export async function fetchCompanyFacts(cik: string): Promise<CompanyFacts> {
  const hit = factsCache.get(cik);
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts;
  const facts = await getJson<CompanyFacts>(`${SEC_HOST}/api/xbrl/companyfacts/CIK${cik}.json`, 40_000);
  factsCache.set(cik, { facts, at: Date.now() });
  // Bounded: these payloads run to several megabytes each.
  if (factsCache.size > 12) {
    const oldest = [...factsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) factsCache.delete(oldest[0]);
  }
  return facts;
}

/* ------------------------------------------------------------------ */
/* Series extraction                                                   */
/* ------------------------------------------------------------------ */

export interface AnnualPoint {
  /** Fiscal year as the filer labels it. */
  fiscalYear: number;
  /** Period end date. */
  end: string;
  value: number;
  /** Which XBRL concept supplied it, so the figure can be traced. */
  concept: string;
  /** Date the filing that reported this value was submitted. */
  filed: string;
}

/** Days between two ISO dates. */
function spanDays(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

/**
 * Annual values for the first concept in `concepts` that has any.
 *
 * Filers do not agree on concept names — revenue alone appears as `Revenues`,
 * `RevenueFromContractWithCustomerExcludingAssessedTax` and `SalesRevenueNet`
 * depending on the company and the year — so a fallback chain is required
 * rather than optional.
 *
 * Two rules do the real work:
 *
 * DURATION facts (revenue, income, cash flow) are filtered to periods of
 * roughly a year. Without that, year-to-date figures from a 10-Q are picked up
 * as if they were annual and a company appears to have earned nine months of
 * revenue in a year.
 *
 * RESTATEMENTS are resolved by taking the LATEST filing for each period. A
 * 10-K restates the two prior years alongside the current one, so most periods
 * appear several times; the newest filing is the company's current position on
 * what happened.
 */
/**
 * The forms an annual figure may come from. Amendments included: see the note
 * in the pooling loop below.
 */
const ANNUAL_FORMS = new Set(['10-K', '10-K/A']);

export function annualSeries(
  facts: CompanyFacts,
  concepts: string[],
  options: {
    instant?: boolean;
    taxonomy?: string;
    /**
     * Per period end, the latest filing date a fact may come from.
     *
     * A balance sheet is one statement, and its lines have to date from one
     * reading of it. They do not have to come from the same filing — a line
     * nothing has restated since is still current — but a line from a filing
     * NEWER than the statement's own belongs to a balance sheet whose other
     * lines are not available, and standing it beside them produces a total
     * that does not add up.
     *
     * This happens systematically rather than rarely. The statement of
     * stockholders' equity presents three years where the balance sheet
     * presents two, so the oldest year's equity gets re-reported in a filing
     * that never re-reports assets or liabilities for that date. Microsoft's
     * equity at 2016-06-30 was restated to 83,090 in the fiscal 2018 10-K
     * while assets and liabilities stayed at their fiscal 2017 values, and the
     * balance sheet on screen overshot total assets by $11bn.
     */
    filedCap?: Map<string, string>;
  } = {},
): AnnualPoint[] {
  const taxonomy = options.taxonomy ?? 'us-gaap';
  const bucket = facts.facts?.[taxonomy];
  if (!bucket) return [];

  /*
   * MERGE the whole chain rather than picking the first concept with data.
   *
   * Filers change tags. NVIDIA reported revenue under
   * RevenueFromContractWithCustomerExcludingAssessedTax until fiscal 2022 and
   * under Revenues before and after. Taking the first concept that had any
   * data returned twelve periods ending in 2022 and silently dropped every
   * year since — a company shown at a quarter of its current size, with
   * nothing on screen to suggest anything was missing.
   *
   * Points from every concept are pooled and resolved per period by the same
   * rule restatements use: latest filing wins. A tie is broken by chain order,
   * so the more specific concept is preferred when a company tagged both in
   * the same filing.
   */
  const priority = new Map(concepts.map((c, i) => [c, i]));
  const pooled: Array<XbrlPoint & { concept: string }> = [];

  for (const concept of concepts) {
    const entry = bucket[concept];
    if (!entry) continue;
    for (const point of Object.values(entry.units).flat()) {
      // Amendments count. A 10-K/A is the company's corrected annual report,
      // and excluding it discards precisely the restatements this function
      // says it honours. Apple restated fiscal 2008 in a 10-K/A filed
      // 2010-01-25: total liabilities went from 18,542 to 13,874. Because
      // later plain 10-Ks happened to re-report assets and equity but not
      // liabilities, dropping the amendment left the three lines of the
      // balance sheet from three different filings, and it did not foot —
      // liabilities plus equity exceeded total assets by $4.7bn.
      if (!ANNUAL_FORMS.has(point.form ?? '') || point.fp !== 'FY') continue;
      const cap = options.filedCap?.get(point.end);
      if (cap && (point.filed ?? '') > cap) continue;
      if (options.instant) {
        if (point.start !== undefined) continue;
      } else {
        if (!point.start) continue;
        const days = spanDays(point.start, point.end);
        // A fiscal year is 52 or 53 weeks; anything else is a partial period.
        if (days <= 330 || days >= 400) continue;
      }
      pooled.push({ ...point, concept });
    }
  }
  if (pooled.length === 0) return [];

  const better = (
    a: XbrlPoint & { concept: string },
    b: XbrlPoint & { concept: string },
  ): boolean => {
    const fa = a.filed ?? '';
    const fb = b.filed ?? '';
    if (fa !== fb) return fa > fb;
    return (priority.get(a.concept) ?? 99) < (priority.get(b.concept) ?? 99);
  };

  const newest = new Map<string, XbrlPoint & { concept: string }>();
  const original = new Map<string, XbrlPoint & { concept: string }>();
  for (const point of pooled) {
    const seenNew = newest.get(point.end);
    if (!seenNew || better(point, seenNew)) newest.set(point.end, point);
    const seenOld = original.get(point.end);
    if (!seenOld || (point.filed ?? '') < (seenOld.filed ?? '')) original.set(point.end, point);
  }

  const series = [...newest.entries()]
    .map(([end, point]) => ({
      /*
       * Label from the EARLIEST filing, value from the LATEST.
       *
       * `fy` is the fiscal year of the FILING, not of the period, so a 10-K
       * stamps its two comparative years with its own year — which labelled
       * three different years of Apple revenue as 2025. The ORIGINAL 10-K for
       * a period does carry that period's own label, which is the filer's own
       * name for its fiscal year and better than any convention guessed from
       * the end date: NVIDIA's year ending January 2019 is "fiscal 2019", and
       * a rule subtracting one for early-year endings would call it 2018.
       */
      fiscalYear: original.get(end)?.fy ?? point.fy ?? Number(end.slice(0, 4)),
      end,
      value: point.val,
      concept: point.concept,
      filed: point.filed ?? '',
    }))
    .sort((a, b) => (a.end < b.end ? -1 : 1));

  /*
   * Label every year by counting back from the most recent one.
   *
   * The newest period is the only one whose ORIGINAL filing is reliably still
   * in the API — companyfacts keeps a few filings deep, so older periods
   * survive only as comparatives, and a comparative carries the filing's
   * fiscal year rather than the period's. Trusting each row's own label
   * therefore produced correct recent years and drifting old ones: NVIDIA's
   * year ending January 2014 came out as 2013, leaving a two-year gap in a
   * one-year interval.
   *
   * Counting back from the anchor by the actual spacing between period ends
   * is exact. Fiscal years are a year apart by definition, and where the data
   * genuinely skips a year the spacing says so.
   */
  if (series.length > 0) {
    const anchor = series[series.length - 1];
    for (let i = series.length - 2; i >= 0; i--) {
      const years = Math.max(
        1,
        Math.round(spanDays(series[i].end, series[i + 1].end) / 365.25),
      );
      series[i].fiscalYear = series[i + 1].fiscalYear - years;
    }
    void anchor;
  }
  return series;
}



/** The most recently reported value for a concept chain, or null. */
export function latest(facts: CompanyFacts, concepts: string[], instant = false): number | null {
  const series = annualSeries(facts, concepts, { instant });
  return series.length ? series[series.length - 1].value : null;
}
