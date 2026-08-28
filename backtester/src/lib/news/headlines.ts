import { MarketDataError } from '@/lib/market-data/provider';

/**
 * Press headlines from Alpha Vantage's NEWS_SENTIMENT endpoint.
 * =============================================================================
 * Optional, and secondary to the filings feed, for a licensing reason rather
 * than a technical one: Alpha Vantage is `personal-only` in
 * `market-data/licence.ts`, so these headlines may be shown to the person
 * holding the key and not to a product's users. The filings feed carries the
 * page when this is absent, which is the normal case — no key, no headlines,
 * no error.
 *
 * THE RELEVANCE FLOOR IS NOT A GUESS
 *
 * Alpha Vantage returns anything that *mentions* a ticker, and returns it in
 * an order that is not relevance. Asking for AAPL, the first article back was
 * about Seagate. Each article carries a per-ticker relevance score, so the
 * question was where "about this company" separates from "mentions it".
 *
 * Measured across two tickers, 100 articles:
 *
 *   score ≥ 0.9   38 articles, 36 named the company in the headline
 *   0.7 – 0.9     23 articles,  9 named it
 *   0.5 – 0.7     36 articles,  1 named it
 *
 * Hence 0.9. Below it the feed fills with articles about competitors — asking
 * for KO returned five PepsiCo stories, which is exactly the kind of thing
 * that makes a news section worse than no news section.
 */

const RELEVANCE_FLOOR = 0.9;
const ENDPOINT = 'https://www.alphavantage.co/query';

export interface Headline {
  title: string;
  url: string;
  source: string;
  /** ISO instant, converted from Alpha Vantage's compact form. */
  published: string;
  summary: string | null;
  /** How much this article is about the ticker asked for, 0 to 1. */
  relevance: number;
  /** Alpha Vantage's own label. Reported as theirs, never as a finding. */
  sentiment: string | null;
}

interface AvTickerSentiment {
  ticker?: string;
  relevance_score?: string;
  ticker_sentiment_label?: string;
}

interface AvItem {
  title?: string;
  url?: string;
  source?: string;
  summary?: string;
  time_published?: string;
  ticker_sentiment?: AvTickerSentiment[];
}

interface AvResponse {
  feed?: AvItem[];
  /** Alpha Vantage reports quota exhaustion in prose under these keys. */
  Information?: string;
  Note?: string;
  'Error Message'?: string;
}

/** `20260826T194905` — not a format anything else parses. */
function parseTime(compact: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(compact ?? '');
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/**
 * Alpha Vantage explains a spent quota in a paragraph that is half marketing
 * and links to its pricing page. That is their message to the key holder, not
 * something to reprint in the product, so the quota case is restated plainly
 * and anything unrecognised is passed through rather than guessed at.
 */
function explain(prose: string): string {
  if (/\b25 requests per day\b|\brate limit\b|\bhigher API call/i.test(prose)) {
    return 'Alpha Vantage’s free allowance of 25 requests a day is spent. Headlines resume tomorrow; the filings below are unaffected.';
  }
  if (/premium|subscribe/i.test(prose)) {
    return 'Alpha Vantage does not serve headlines on this key’s plan. The filings below are unaffected.';
  }
  return prose;
}

export class HeadlinesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlinesUnavailableError';
  }
}

export function headlinesConfigured(): boolean {
  return Boolean(process.env.ALPHA_VANTAGE_API_KEY?.trim());
}

export async function fetchHeadlines(ticker: string, limit = 12): Promise<Headline[]> {
  const key = process.env.ALPHA_VANTAGE_API_KEY?.trim();
  if (!key) throw new HeadlinesUnavailableError('No Alpha Vantage key is configured.');

  const url = new URL(ENDPOINT);
  url.searchParams.set('function', 'NEWS_SENTIMENT');
  url.searchParams.set('tickers', ticker.toUpperCase());
  url.searchParams.set('limit', '50');
  url.searchParams.set('apikey', key);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let body: AvResponse;
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new MarketDataError(`Alpha Vantage returned HTTP ${res.status}.`);
    body = (await res.json()) as AvResponse;
  } catch (e) {
    if (e instanceof MarketDataError) throw e;
    throw new MarketDataError('Could not reach Alpha Vantage.', undefined, e);
  } finally {
    clearTimeout(timer);
  }

  // Alpha Vantage answers HTTP 200 with a prose explanation when the daily
  // quota is spent, so a successful status is not a successful request.
  const prose = body.Information ?? body.Note ?? body['Error Message'];
  if (prose) throw new HeadlinesUnavailableError(explain(prose));
  if (!body.feed) throw new HeadlinesUnavailableError('Alpha Vantage returned no news feed.');

  const want = ticker.toUpperCase();
  const out: Headline[] = [];
  for (const item of body.feed) {
    const ts = item.ticker_sentiment?.find((t) => t.ticker?.toUpperCase() === want);
    const relevance = Number(ts?.relevance_score);
    if (!Number.isFinite(relevance) || relevance < RELEVANCE_FLOOR) continue;
    if (!item.title || !item.url) continue;
    const published = parseTime(item.time_published);
    if (!published) continue;
    out.push({
      title: item.title,
      url: item.url,
      source: item.source ?? 'Unknown',
      published,
      summary: item.summary?.trim() || null,
      relevance,
      sentiment: ts?.ticker_sentiment_label ?? null,
    });
  }

  // Newest first. Alpha Vantage's own ordering is neither time nor relevance.
  out.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
  return out.slice(0, limit);
}
