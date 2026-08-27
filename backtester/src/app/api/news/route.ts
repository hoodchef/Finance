import { NextResponse } from 'next/server';
import { resolveTicker } from '@/lib/fundamentals/sec';
import { fetchFilings, type Filing } from '@/lib/news/filings';
import {
  fetchHeadlines,
  headlinesConfigured,
  HeadlinesUnavailableError,
  type Headline,
} from '@/lib/news/headlines';
import { PROVIDER_LICENCES } from '@/lib/market-data/licence';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recent news for one company, from two sources kept visibly separate.
 *
 * Filings are the record and always load. Headlines are optional, come from a
 * personal-use-licensed source, and never take the response down with them: a
 * spent quota leaves a note where the headlines would be, and the filings are
 * still there. Merging the two into one list would hide which is which, and
 * they differ in both authority and licence.
 */

/**
 * Alpha Vantage's free tier is 25 requests a day, which a few searches would
 * exhaust. Headlines change on the order of hours, so a short cache costs
 * nothing in freshness and is the difference between the feature working all
 * day and working for the first five lookups.
 *
 * In-memory deliberately: it is a cache of third-party content under a
 * personal-use licence, and writing it to disk turns a transient copy into a
 * stored one.
 */
const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; headlines: Headline[]; note: string | null }>();

async function headlinesFor(ticker: string): Promise<{ headlines: Headline[]; note: string | null }> {
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { headlines: hit.headlines, note: hit.note };
  }
  let result: { headlines: Headline[]; note: string | null };
  try {
    result = { headlines: await fetchHeadlines(ticker), note: null };
  } catch (e) {
    // A failure here is cached too, so a spent quota does not spend another
    // request on every keystroke for the next half hour.
    result = {
      headlines: [],
      note:
        e instanceof HeadlinesUnavailableError
          ? e.message
          : 'Headlines could not be fetched. The filings below are unaffected.',
    };
  }
  cache.set(ticker, { at: Date.now(), ...result });
  return result;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const ticker = String(body.ticker ?? '').trim().toUpperCase().slice(0, 12);
    if (!ticker) {
      return NextResponse.json({ error: 'Enter a ticker.', kind: 'request' }, { status: 400 });
    }

    const company = await resolveTicker(ticker);

    // Filings define the response; headlines are additive. Settled rather than
    // awaited together so a slow aggregator cannot delay the primary source.
    let filings: Filing[] = [];
    let filingsNote: string | null = null;
    try {
      filings = await fetchFilings(company.cik);
      if (filings.length === 0) {
        filingsNote = `${company.name} has no recent filings on EDGAR.`;
      }
    } catch {
      filingsNote = 'EDGAR could not be reached for this company’s filings.';
    }

    const configured = headlinesConfigured();
    const { headlines, note } = configured
      ? await headlinesFor(ticker)
      : { headlines: [], note: null };

    const av = PROVIDER_LICENCES.alphavantage;

    return NextResponse.json({
      company: { ticker: company.ticker, name: company.name, cik: company.cik },
      filings,
      filingsNote,
      headlines,
      headlinesNote: note,
      headlinesConfigured: configured,
      provenance: {
        filings: 'SEC EDGAR, filed by the company itself. Public domain.',
        filingsUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.cik}&type=&dateb=&owner=include&count=40`,
        headlines: configured ? `Alpha Vantage NEWS_SENTIMENT (${av.label})` : null,
        // Surfaced rather than buried, because it governs whether these
        // headlines may be shown to anyone other than the key holder.
        headlinesLicence: configured ? av.summary : null,
        headlinesCommercial: configured ? av.commercial : null,
        sentimentNote:
          'Sentiment labels are Alpha Vantage’s own classification of each article, ' +
          'not an assessment of the company and not a signal.',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
