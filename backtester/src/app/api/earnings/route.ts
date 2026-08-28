import { NextResponse } from 'next/server';
import { fetchCompanyFacts, resolveTicker } from '@/lib/fundamentals/sec';
import { fetchFilings } from '@/lib/news/filings';
import { earningsHistory } from '@/lib/earnings/history';
import {
  calendarConfigured,
  fetchCalendar,
  type UpcomingEarnings,
} from '@/lib/earnings/calendar';
import { HeadlinesUnavailableError } from '@/lib/news/headlines';
import { PROVIDER_LICENCES } from '@/lib/market-data/licence';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Past earnings for one company, and upcoming dates for a watchlist.
 *
 * Past comes from EDGAR and always loads. Upcoming needs a vendor, because a
 * date that has not happened is not in any filing. The two are returned
 * separately and the response survives losing the second.
 */

/**
 * The whole-market calendar is one request and changes on the order of days,
 * so it is fetched once and shared by every lookup. Six hours keeps a date
 * moved by a company visible the same day without spending the daily
 * allowance on repeat views.
 */
const TTL_MS = 6 * 60 * 60 * 1000;
let calendarCache: { at: number; rows: UpcomingEarnings[] } | null = null;
let calendarError: { at: number; message: string } | null = null;

async function calendar(): Promise<{ rows: UpcomingEarnings[]; note: string | null }> {
  if (calendarCache && Date.now() - calendarCache.at < TTL_MS) {
    return { rows: calendarCache.rows, note: null };
  }
  if (calendarError && Date.now() - calendarError.at < TTL_MS) {
    return { rows: [], note: calendarError.message };
  }
  try {
    const rows = await fetchCalendar();
    calendarCache = { at: Date.now(), rows };
    calendarError = null;
    return { rows, note: null };
  } catch (e) {
    const message =
      e instanceof HeadlinesUnavailableError
        ? e.message
        : 'Upcoming earnings dates could not be fetched. Past earnings are unaffected.';
    // Cached so a spent quota does not spend a request on every page view.
    calendarError = { at: Date.now(), message };
    return { rows: [], note: message };
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const ticker = String(body.ticker ?? '').trim().toUpperCase().slice(0, 12);
    if (!ticker) {
      return NextResponse.json({ error: 'Enter a ticker.', kind: 'request' }, { status: 400 });
    }

    // Other symbols to show on the month view — the caller's holdings. Capped
    // and sanitised: this list comes from the browser.
    const watchlist = Array.isArray(body.watchlist)
      ? [...new Set(
          (body.watchlist as unknown[])
            .map((s) => String(s ?? '').trim().toUpperCase())
            .filter((s) => /^[A-Z0-9.\-]{1,12}$/.test(s)),
        )].slice(0, 60)
      : [];

    const company = await resolveTicker(ticker);

    let history: ReturnType<typeof earningsHistory> = [];
    let historyNote: string | null = null;
    try {
      const [facts, filings] = await Promise.all([
        fetchCompanyFacts(company.cik),
        fetchFilings(company.cik, 120),
      ]);
      history = earningsHistory(facts, filings);
      if (history.length === 0) {
        historyNote = `${company.name} has no quarterly figures tagged in its XBRL data.`;
      }
    } catch {
      historyNote = 'Past earnings could not be read from EDGAR.';
    }

    const configured = calendarConfigured();
    const { rows, note } = configured ? await calendar() : { rows: [], note: null };

    const wanted = [...new Set([ticker, ...watchlist])];
    const upcoming = rows
      .filter((r) => wanted.includes(r.symbol))
      .sort((a, b) => (a.reportDate < b.reportDate ? -1 : a.reportDate > b.reportDate ? 1 : 0));

    /*
     * Which requested symbols the vendor does not list.
     *
     * The calendar is not complete: it carries 1,571 companies for the next
     * three months and Microsoft, NVIDIA and Exxon are not among them. Dropping
     * them silently would leave a month view that reads as "these are not
     * reporting", which is a stronger and different claim than "no date was
     * published for these". Named, so the gap is the vendor's and visibly so.
     */
    const listed = new Set(rows.map((r) => r.symbol));
    const unlisted = rows.length > 0 ? wanted.filter((s) => !listed.has(s)) : [];

    const av = PROVIDER_LICENCES.alphavantage;

    return NextResponse.json({
      company: { ticker: company.ticker, name: company.name, cik: company.cik },
      history,
      historyNote,
      upcoming,
      upcomingNote: note,
      upcomingConfigured: configured,
      unlisted,
      /** Whether the vendor listed this company at all, as against listing it with no date. */
      inCalendar: rows.some((r) => r.symbol === ticker),
      provenance: {
        history:
          'Quarterly figures from SEC EDGAR XBRL, dated by the 8-K carrying item 2.02 — ' +
          'the earnings release itself. Public domain.',
        fourthQuarter:
          'Fourth quarters are absent: there is no 10-Q for one, so most filers never tag a ' +
          'fourth-quarter period. Deriving it would give exact revenue and an estimated EPS, ' +
          'and an estimate in a column of reported figures reads as reported. The full-year ' +
          'numbers are on the statements above.',
        upcoming: configured ? `Alpha Vantage EARNINGS_CALENDAR (${av.label})` : null,
        upcomingLicence: configured ? av.summary : null,
        upcomingCommercial: configured ? av.commercial : null,
        coverageNote:
          'The vendor’s calendar is not a complete list of what is reporting. Companies it ' +
          'does not carry are named rather than left out, so a missing company reads as a ' +
          'gap in the source and not as a company with nothing scheduled.',
        estimatesNote:
          'Scheduled dates only. The vendor also supplies a consensus EPS estimate; it is ' +
          'not shown, for the same reason the fundamentals page shows no estimates.',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
