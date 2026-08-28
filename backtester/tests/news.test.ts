import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchFilings } from '../src/lib/news/filings';
import { fetchHeadlines, HeadlinesUnavailableError } from '../src/lib/news/headlines';

/**
 * Company news, against the shapes EDGAR and Alpha Vantage actually return.
 * =============================================================================
 * Both fixtures below are trimmed from live responses recorded on 2026-08-27,
 * including the two that caused real defects: JPMorgan's prospectus flood and
 * Alpha Vantage answering HTTP 200 with prose instead of a feed.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

function mockJson(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const submissions = (recent: Record<string, unknown[]>) => ({
  name: 'Test Co',
  filings: { recent },
});

describe('filings feed', () => {
  it('keeps material forms and drops the paperwork around them', async () => {
    mockJson(
      submissions({
        form: ['4', '8-K', '144', '424B2', '10-Q', 'SC 13G/A', 'DEF 14A'],
        filingDate: [
          '2026-08-20', '2026-08-19', '2026-08-18',
          '2026-08-17', '2026-08-16', '2026-08-15', '2026-08-14',
        ],
        reportDate: ['', '2026-08-19', '', '', '2026-06-30', '', ''],
        items: ['', '2.02,9.01', '', '', '', '', ''],
        accessionNumber: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
        primaryDocument: ['d1.htm', 'd2.htm', 'd3.htm', 'd4.htm', 'd5.htm', 'd6.htm', 'd7.htm'],
      }),
    );
    const out = await fetchFilings('320193');
    expect(out.map((f) => f.form)).toEqual(['8-K', '10-Q', 'DEF 14A']);
  });

  it('survives a company whose recent filings are almost entirely prospectuses', async () => {
    // JPMorgan's recent filings contain 22,497 Form 424B2 supplements. Before
    // the allowlist its news feed was twenty identical prospectuses.
    const n = 500;
    const forms = Array.from({ length: n }, (_, i) => (i === 400 ? '8-K' : '424B2'));
    mockJson(
      submissions({
        form: forms,
        filingDate: forms.map(() => '2026-08-01'),
        reportDate: forms.map(() => ''),
        items: forms.map((f) => (f === '8-K' ? '2.02' : '')),
        accessionNumber: forms.map((_, i) => `acc-${i}`),
        primaryDocument: forms.map(() => 'doc.htm'),
      }),
    );
    const out = await fetchFilings('19617');
    expect(out).toHaveLength(1);
    expect(out[0].form).toBe('8-K');
    expect(out[0].events).toEqual(['Reported results of operations']);
  });

  it('translates 8-K item codes into what happened', async () => {
    mockJson(
      submissions({
        form: ['8-K'],
        filingDate: ['2026-08-19'],
        reportDate: [''],
        items: ['5.02,7.01'],
        accessionNumber: ['a1'],
        primaryDocument: ['d.htm'],
      }),
    );
    const [f] = await fetchFilings('1');
    expect(f.events).toEqual(['Director or officer change', 'Regulation FD disclosure']);
    expect(f.formLabel).toBe('Current report');
  });

  it('marks a non-reliance filing as notable', async () => {
    // Item 4.02 says previously issued financial statements were wrong. It is
    // among the most consequential things a filing can say and reads like
    // boilerplate as a bare code.
    mockJson(
      submissions({
        form: ['8-K', '8-K'],
        filingDate: ['2026-08-19', '2026-08-18'],
        reportDate: ['', ''],
        items: ['4.02', '7.01'],
        accessionNumber: ['a1', 'a2'],
        primaryDocument: ['d1.htm', 'd2.htm'],
      }),
    );
    const out = await fetchFilings('1');
    expect(out[0].notable).toBe(true);
    expect(out[0].events[0]).toMatch(/no longer be relied on/);
    expect(out[1].notable).toBe(false);
  });

  it('shows an unmapped item as its code rather than dropping it', async () => {
    mockJson(
      submissions({
        form: ['8-K'],
        filingDate: ['2026-08-19'],
        reportDate: [''],
        items: ['9.99'],
        accessionNumber: ['a1'],
        primaryDocument: ['d.htm'],
      }),
    );
    const [f] = await fetchFilings('1');
    expect(f.events).toEqual(['Item 9.99']);
  });

  it('builds a document URL EDGAR will serve', async () => {
    // Leading zeros stripped from the CIK, dashes stripped from the accession.
    mockJson(
      submissions({
        form: ['10-K'],
        filingDate: ['2026-08-19'],
        reportDate: ['2026-06-30'],
        items: [''],
        accessionNumber: ['0000320193-26-000081'],
        primaryDocument: ['aapl-20260630.htm'],
      }),
    );
    const [f] = await fetchFilings('0000320193');
    expect(f.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000081/aapl-20260630.htm',
    );
    expect(f.reportDate).toBe('2026-06-30');
  });

  it('returns nothing rather than throwing when a company has no filings', async () => {
    mockJson({ name: 'Test Co', filings: { recent: {} } });
    await expect(fetchFilings('1')).resolves.toEqual([]);
  });
});

describe('headlines', () => {
  const item = (title: string, relevance: string, ticker = 'AAPL') => ({
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    source: 'Example Wire',
    time_published: '20260826T194905',
    summary: 'Summary text.',
    ticker_sentiment: [
      { ticker, relevance_score: relevance, ticker_sentiment_label: 'Somewhat-Bullish' },
    ],
  });

  it('drops articles that only mention the ticker in passing', async () => {
    // Asking Alpha Vantage for AAPL, the first article back was about Seagate.
    // Measured over 100 articles, ≥0.9 named the company 36 times in 38;
    // between 0.5 and 0.7 it named it once in 36.
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key');
    mockJson({
      feed: [
        item('Seagate stock closed up 3.01%', '0.613137'),
        item('Apple set to debut foldable iPhone', '1.0'),
        item('Intel CPU market share falls', '0.577'),
      ],
    });
    const out = await fetchHeadlines('AAPL');
    expect(out.map((h) => h.title)).toEqual(['Apple set to debut foldable iPhone']);
  });

  it('scores relevance against the ticker asked for, not the first one listed', async () => {
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key');
    mockJson({
      feed: [
        {
          ...item('PepsiCo raises guidance', '0.99', 'PEP'),
          ticker_sentiment: [
            { ticker: 'PEP', relevance_score: '0.99', ticker_sentiment_label: 'Bullish' },
            { ticker: 'KO', relevance_score: '0.74', ticker_sentiment_label: 'Neutral' },
          ],
        },
      ],
    });
    // A PepsiCo story is not Coca-Cola news, however relevant it is to PepsiCo.
    await expect(fetchHeadlines('KO')).resolves.toEqual([]);
  });

  it('orders newest first, because Alpha Vantage orders by neither time nor relevance', async () => {
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key');
    mockJson({
      feed: [
        { ...item('Older', '1.0'), time_published: '20260820T120000' },
        { ...item('Newer', '1.0'), time_published: '20260826T120000' },
        { ...item('Middle', '1.0'), time_published: '20260823T120000' },
      ],
    });
    const out = await fetchHeadlines('AAPL');
    expect(out.map((h) => h.title)).toEqual(['Newer', 'Middle', 'Older']);
    expect(out[0].published).toBe('2026-08-26T12:00:00Z');
  });

  it('treats a spent quota as unavailable, not as an empty feed', async () => {
    // Alpha Vantage answers HTTP 200 with prose when the daily limit is gone.
    // Reading that as "no news" would state something false about the company.
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key');
    mockJson({
      Information:
        'Thank you for using Alpha Vantage! Please consider spreading out your free API ' +
        'requests more sparingly (1 request per second). You may subscribe to any of the ' +
        'premium plans to lift the free key rate limit (25 requests per day).',
    });
    await expect(fetchHeadlines('AAPL')).rejects.toBeInstanceOf(HeadlinesUnavailableError);
    await expect(fetchHeadlines('AAPL')).rejects.toThrow(/free allowance of 25 requests a day/);
  });

  it('does not reprint the vendor’s pricing pitch', async () => {
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key');
    mockJson({ Information: 'Please subscribe to a premium plan at https://example.com/premium/' });
    await expect(fetchHeadlines('AAPL')).rejects.toThrow(/does not serve headlines on this key/);
  });

  it('reports a missing key as unavailable without calling out', async () => {
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', '');
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(fetchHeadlines('AAPL')).rejects.toBeInstanceOf(HeadlinesUnavailableError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips an article with no parseable timestamp rather than dating it now', async () => {
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key');
    mockJson({
      feed: [
        { ...item('Undated', '1.0'), time_published: 'not-a-date' },
        item('Dated', '1.0'),
      ],
    });
    const out = await fetchHeadlines('AAPL');
    expect(out.map((h) => h.title)).toEqual(['Dated']);
  });
});
