import { MarketDataError } from '@/lib/market-data/provider';
import { HeadlinesUnavailableError } from '@/lib/news/headlines';

/**
 * Upcoming earnings dates, from Alpha Vantage's EARNINGS_CALENDAR.
 * =============================================================================
 * EDGAR cannot answer this one. A filing is a record of something that has
 * happened, and a company's next earnings date has not happened — it is
 * announced by press release, in no structured form. So this is the one part
 * of the research page with no primary-source option, and it carries Alpha
 * Vantage's personal-use licence like the headlines do.
 *
 * ONE REQUEST FOR THE WHOLE MARKET
 *
 * Asked without a symbol the endpoint returns every listed company's next
 * three months as CSV — around 85KB, roughly 2,300 companies. That is a
 * single request covering every ticker anyone might look up, which turns the
 * free tier's 25 requests a day from a hard constraint into an irrelevance,
 * and means looking up a company costs nothing. Asking per symbol would spend
 * the day's allowance on the first two dozen lookups.
 *
 * WHAT IS NOT SHOWN
 *
 * The CSV carries a consensus EPS estimate. It is not displayed. The research
 * page states that no free source licenses analyst estimates for display, and
 * that holds here: a date is a scheduling fact, while a consensus is the
 * product the estimate vendors sell. The dates are used and the estimate
 * column is dropped on parse rather than carried unused into the response.
 */

const ENDPOINT = 'https://www.alphavantage.co/query';

export interface UpcomingEarnings {
  symbol: string;
  name: string;
  /** The date the company is scheduled to report. */
  reportDate: string;
  /** The fiscal period those results will cover. */
  fiscalDateEnding: string | null;
  /** 'pre-market', 'post-market', or null where the vendor does not say. */
  timeOfDay: string | null;
}

export function calendarConfigured(): boolean {
  return Boolean(process.env.ALPHA_VANTAGE_API_KEY?.trim());
}

/**
 * Splits one CSV line, honouring quoted fields. Company names contain commas
 * — "Alarum Technologies, Ltd." — and splitting on every comma shifts every
 * column after the name, which silently turns a date column into a name.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCalendarCsv(csv: string): UpcomingEarnings[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iSymbol = col('symbol');
  const iName = col('name');
  const iReport = col('reportdate');
  const iFiscal = col('fiscaldateending');
  const iTime = col('timeoftheday');
  if (iSymbol < 0 || iReport < 0) return [];

  const out: UpcomingEarnings[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const symbol = f[iSymbol]?.toUpperCase();
    const reportDate = f[iReport];
    // A row whose date is not a date is a malformed row, not a date of today.
    if (!symbol || !reportDate || !ISO_DATE.test(reportDate)) continue;
    const fiscal = iFiscal >= 0 ? f[iFiscal] : '';
    const time = iTime >= 0 ? f[iTime] : '';
    out.push({
      symbol,
      name: (iName >= 0 ? f[iName] : '') || symbol,
      reportDate,
      fiscalDateEnding: fiscal && ISO_DATE.test(fiscal) ? fiscal : null,
      timeOfDay: time || null,
    });
  }
  return out;
}

export async function fetchCalendar(horizon: '3month' | '6month' = '3month'): Promise<UpcomingEarnings[]> {
  const key = process.env.ALPHA_VANTAGE_API_KEY?.trim();
  if (!key) throw new HeadlinesUnavailableError('No Alpha Vantage key is configured.');

  const url = new URL(ENDPOINT);
  url.searchParams.set('function', 'EARNINGS_CALENDAR');
  url.searchParams.set('horizon', horizon);
  url.searchParams.set('apikey', key);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let text: string;
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new MarketDataError(`Alpha Vantage returned HTTP ${res.status}.`);
    text = await res.text();
  } catch (e) {
    if (e instanceof MarketDataError) throw e;
    throw new MarketDataError('Could not reach Alpha Vantage.', undefined, e);
  } finally {
    clearTimeout(timer);
  }

  // The endpoint answers 200 with a JSON explanation when the quota is gone,
  // which parses as CSV into nonsense rather than failing.
  if (text.trimStart().startsWith('{')) {
    throw new HeadlinesUnavailableError(
      'Alpha Vantage’s free allowance of 25 requests a day is spent. Upcoming dates resume tomorrow.',
    );
  }

  const rows = parseCalendarCsv(text);
  if (rows.length === 0) {
    throw new HeadlinesUnavailableError('Alpha Vantage returned no earnings calendar.');
  }
  return rows;
}
