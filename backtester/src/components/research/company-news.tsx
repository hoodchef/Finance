'use client';

import * as React from 'react';
import { AlertTriangle, ExternalLink, FileText, Newspaper } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Recent news for a company, from two sources shown separately.
 *
 * They are not merged into one list. Filings are the company's own statements
 * to the market and are public domain; headlines are a third party's account
 * of them under a personal-use licence. Interleaving them would imply an
 * equivalence in both authority and licence that does not exist, and would
 * leave a reader unable to tell which is which.
 */

interface Filing {
  form: string;
  formLabel: string;
  filed: string;
  reportDate: string | null;
  events: string[];
  notable: boolean;
  url: string;
  accession: string;
}

interface Headline {
  title: string;
  url: string;
  source: string;
  published: string;
  summary: string | null;
  relevance: number;
  sentiment: string | null;
}

interface NewsResponse {
  company: { ticker: string; name: string; cik: string };
  filings: Filing[];
  filingsNote: string | null;
  headlines: Headline[];
  headlinesNote: string | null;
  headlinesConfigured: boolean;
  provenance: {
    filings: string;
    filingsUrl: string;
    headlines: string | null;
    headlinesLicence: string | null;
    headlinesCommercial: string | null;
    sentimentNote: string;
  };
}

/**
 * Formatted in UTC. A filing date is a calendar day, not an instant: parsing
 * "2026-07-31" gives UTC midnight, and rendering that in a timezone behind UTC
 * moves it to the 30th. Every filing date west of Greenwich was a day early.
 */
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function day(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.valueOf()) ? iso : dayFormat.format(d);
}

/** Relative age, because "how long ago" is what a news list is read for. */
function age(iso: string): string {
  const then = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).valueOf();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function CompanyNews({ ticker }: { ticker: string }) {
  const [data, setData] = React.useState<NewsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch('/api/news', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(body.error ?? 'Could not load news.');
        else setData(body as NewsResponse);
      })
      .catch(() => {
        // The fundamentals above have already rendered. News failing is a
        // missing section, not a broken page.
        if (!cancelled) setError('Could not load news.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent news</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent news</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{error ?? 'No news available.'}</p>
        </CardContent>
      </Card>
    );
  }

  const { filings, headlines } = data;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {/* Headlines */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Newspaper className="h-3.5 w-3.5" />
            Headlines
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {headlines.length > 0 ? (
            headlines.map((h) => (
              <a
                key={h.url}
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block border-b border-border/50 pb-2.5 last:border-0 last:pb-0"
              >
                <p className="text-xs font-medium leading-snug group-hover:underline">
                  {h.title}
                  <ExternalLink className="ml-1 inline h-2.5 w-2.5 align-baseline opacity-50" />
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
                  <span>{h.source}</span>
                  <span aria-hidden>·</span>
                  <span className="numeric">{age(h.published)}</span>
                  {h.sentiment && (
                    <>
                      <span aria-hidden>·</span>
                      {/* Attributed, not asserted. This is Alpha Vantage's
                          classification of the article, not our view. */}
                      <span title="Alpha Vantage's classification of this article">
                        {h.sentiment.toLowerCase()} (AV)
                      </span>
                    </>
                  )}
                </p>
              </a>
            ))
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {data.headlinesNote ??
                (data.headlinesConfigured
                  ? 'No headlines above the relevance threshold. Articles that only mention the ticker in passing are excluded.'
                  : 'Headlines are not configured. Set ALPHA_VANTAGE_API_KEY to enable them — note that Alpha Vantage licenses its data for personal use only.')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Filings */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <FileText className="h-3.5 w-3.5" />
            Filings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {filings.length > 0 ? (
            filings.slice(0, 12).map((f) => (
              <a
                key={f.accession}
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block border-b border-border/50 pb-2.5 last:border-0 last:pb-0"
              >
                <p className="flex items-center gap-1.5 text-xs font-medium leading-snug">
                  {f.notable && (
                    <AlertTriangle className="h-3 w-3 shrink-0 text-[hsl(var(--negative))]" />
                  )}
                  <span className="group-hover:underline">{f.formLabel}</span>
                  <Badge variant="outline" className="px-1 py-0 text-2xs font-normal">
                    {f.form}
                  </Badge>
                </p>
                {f.events.length > 0 && (
                  <p
                    className={cn(
                      'mt-0.5 text-2xs leading-snug',
                      f.notable ? 'text-[hsl(var(--negative))]' : 'text-muted-foreground',
                    )}
                  >
                    {f.events.join(' · ')}
                  </p>
                )}
                <p className="mt-1 text-2xs text-muted-foreground">
                  <span className="numeric">{day(f.filed)}</span>
                  <span aria-hidden> · </span>
                  <span className="numeric">{age(f.filed)}</span>
                  {f.reportDate && <span className="numeric"> · covers {day(f.reportDate)}</span>}
                </p>
              </a>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              {data.filingsNote ?? 'No recent filings.'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Provenance, for both sources. */}
      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground lg:col-span-2">
        <p>
          <span className="font-medium text-foreground">Filings.</span> {data.provenance.filings}{' '}
          Insider transactions (Forms 3/4/5 and 144), prospectus supplements and investors&rsquo;
          13D/G schedules are excluded — they are filed constantly, and by people other than the
          company.{' '}
          <a
            className="underline hover:no-underline"
            href={data.provenance.filingsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            All filings on EDGAR
          </a>
          .
        </p>
        {data.provenance.headlines && (
          <p className="mt-1.5">
            <span className="font-medium text-foreground">Headlines.</span>{' '}
            {data.provenance.headlines}. {data.provenance.sentimentNote}
            {data.provenance.headlinesCommercial !== 'permitted' && (
              <>
                {' '}
                <span className="font-medium text-foreground">Licence:</span>{' '}
                {data.provenance.headlinesLicence}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
