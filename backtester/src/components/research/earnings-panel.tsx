'use client';

import * as React from 'react';
import { CalendarDays, ExternalLink, History } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrencyCompact } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/store/workspace';

/**
 * Earnings: the month ahead, and what was reported before.
 *
 * The two halves have different provenance and are kept apart for it. Past
 * earnings are EDGAR facts dated by the release that announced them. Upcoming
 * dates are a vendor's schedule, because a date that has not happened is not
 * in any filing — the one part of this page with no primary source.
 */

interface Quarter {
  start: string;
  end: string;
  fiscalPeriod: string | null;
  reportedOn: string | null;
  reportUrl: string | null;
  epsDiluted: number | null;
  revenue: number | null;
  netIncome: number | null;
}

interface Upcoming {
  symbol: string;
  name: string;
  reportDate: string;
  fiscalDateEnding: string | null;
  timeOfDay: string | null;
}

interface EarningsResponse {
  company: { ticker: string; name: string; cik: string };
  history: Quarter[];
  historyNote: string | null;
  upcoming: Upcoming[];
  upcomingNote: string | null;
  upcomingConfigured: boolean;
  unlisted: string[];
  inCalendar: boolean;
  provenance: {
    history: string;
    fourthQuarter: string;
    upcoming: string | null;
    upcomingLicence: string | null;
    upcomingCommercial: string | null;
    coverageNote: string;
    estimatesNote: string;
  };
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthFormat = new Intl.DateTimeFormat('en-CA', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Dates here are calendar days; formatting them in local time shifts them. */
function fmt(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.valueOf()) ? iso : dayFormat.format(d);
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * A month grid built entirely in UTC.
 *
 * Using the local calendar would put a company reporting on the 1st into the
 * previous month for anyone west of Greenwich, which is the same off-by-one
 * that made filings render a day early.
 */
function MonthGrid({
  monthStart,
  events,
  highlight,
}: {
  monthStart: Date;
  events: Map<string, Upcoming[]>;
  highlight: string;
}) {
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const leading = first.getUTCDay();
  const today = new Date().toISOString().slice(0, 10);

  const cells: Array<{ iso: string; day: number } | null> = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ iso: new Date(Date.UTC(year, month, d)).toISOString().slice(0, 10), day: d });
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium">{monthFormat.format(first)}</p>
      <div className="grid grid-cols-7 gap-px">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="pb-1 text-center text-2xs text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} />;
          const on = events.get(cell.iso) ?? [];
          const isToday = cell.iso === today;
          return (
            <div
              key={i}
              className={cn(
                'min-h-[3.1rem] rounded-sm border border-border/40 p-1',
                on.length > 0 && 'bg-muted/50',
                isToday && 'border-foreground/40',
              )}
            >
              <div
                className={cn(
                  'numeric text-2xs',
                  isToday ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {cell.day}
              </div>
              <div className="mt-0.5 space-y-0.5">
                {on.map((e) => (
                  <div
                    key={e.symbol}
                    title={`${e.name} — ${e.timeOfDay ?? 'time not stated'}`}
                    className={cn(
                      'truncate rounded-sm px-1 text-2xs leading-tight',
                      e.symbol === highlight
                        ? 'bg-[hsl(var(--accent))] font-semibold text-[hsl(var(--accent-foreground))]'
                        : 'bg-border/60',
                    )}
                  >
                    {e.symbol}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EarningsPanel({ ticker }: { ticker: string }) {
  const positions = useWorkspace((s) => s.draft.positions);
  const [data, setData] = React.useState<EarningsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  // The holdings are what make a month view worth looking at; the researched
  // company alone is one date. Stringified so the effect keys on the symbols
  // rather than on a new array identity each render.
  const watchlist = React.useMemo(
    () =>
      [...new Set(positions.map((p) => p.symbol.trim().toUpperCase()).filter(Boolean))]
        .sort()
        .join(','),
    [positions],
  );

  React.useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch('/api/earnings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker, watchlist: watchlist ? watchlist.split(',') : [] }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(body.error ?? 'Could not load earnings.');
        else setData(body as EarningsResponse);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load earnings.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, watchlist]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Earnings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Earnings</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{error ?? 'No earnings data.'}</p>
        </CardContent>
      </Card>
    );
  }

  const next = data.upcoming.find((u) => u.symbol === data.company.ticker) ?? null;

  /*
   * A contiguous run of months from this one to the last scheduled date.
   *
   * Rendering only the months that contain an event printed August beside
   * October with September missing, which reads as a calendar with a hole in
   * it rather than as a month where nothing is scheduled.
   */
  const now = new Date();
  const startY = now.getUTCFullYear();
  const startM = now.getUTCMonth();
  const last = data.upcoming.reduce((a, u) => (u.reportDate > a ? u.reportDate : a), '');
  const spanMonths = last
    ? (Number(last.slice(0, 4)) - startY) * 12 + (Number(last.slice(5, 7)) - 1 - startM)
    : 0;
  const months = Array.from({ length: Math.min(Math.max(spanMonths + 1, 1), 3) }, (_, i) =>
    new Date(Date.UTC(startY, startM + i, 1)),
  );

  const byDate = new Map<string, Upcoming[]>();
  for (const u of data.upcoming) {
    const list = byDate.get(u.reportDate) ?? [];
    list.push(u);
    byDate.set(u.reportDate, list);
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {/* Upcoming */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <CalendarDays className="h-3.5 w-3.5" />
            Upcoming earnings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {next ? (
            <p className="text-xs">
              <span className="font-medium">{data.company.ticker}</span> reports on{' '}
              <span className="numeric font-medium">{fmt(next.reportDate)}</span>
              {next.fiscalDateEnding && (
                <span className="text-muted-foreground">
                  , covering the quarter ending{' '}
                  <span className="numeric">{fmt(next.fiscalDateEnding)}</span>
                </span>
              )}
              {next.timeOfDay && <span className="text-muted-foreground"> ({next.timeOfDay})</span>}.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {data.upcomingNote ??
                (!data.upcomingConfigured
                  ? 'Upcoming dates are not configured. Set ALPHA_VANTAGE_API_KEY to enable them — the data is licensed for personal use only.'
                  : `No scheduled date is published for ${data.company.ticker}. A filing records what has happened, so a future date has no primary source; this comes from a vendor whose calendar does not cover every company.`)}
            </p>
          )}

          {data.upcoming.length > 0 && (
            <div className="space-y-3">
              {months.map((m) => (
                <MonthGrid
                  key={m.toISOString()}
                  monthStart={m}
                  events={byDate}
                  highlight={data.company.ticker}
                />
              ))}
            </div>
          )}

          {data.unlisted.length > 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              No date published for {data.unlisted.join(', ')}. Funds and ETFs do not report
              earnings at all, and the vendor&rsquo;s calendar does not cover every operating
              company either — so this means no date was found, not that nothing is scheduled.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Past */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <History className="h-3.5 w-3.5" />
            Past earnings
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.history.length > 0 ? (
            <table className="w-full min-w-[24rem] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Quarter</th>
                  <th className="py-1.5 pr-3 font-medium">Reported</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Revenue</th>
                  <th className="py-1.5 text-right font-medium">EPS</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((q) => (
                  <tr key={q.end} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3">
                      <span className="numeric">{fmt(q.end)}</span>
                      {q.fiscalPeriod && (
                        <Badge
                          variant="outline"
                          className="ml-1.5 px-1 py-0 text-2xs font-normal"
                        >
                          {q.fiscalPeriod}
                        </Badge>
                      )}
                    </td>
                    <td className="numeric py-1.5 pr-3 text-muted-foreground">
                      {q.reportedOn ? (
                        q.reportUrl ? (
                          <a
                            className="hover:underline"
                            href={q.reportUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {fmt(q.reportedOn)}
                            <ExternalLink className="ml-0.5 inline h-2.5 w-2.5 align-baseline opacity-50" />
                          </a>
                        ) : (
                          fmt(q.reportedOn)
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="numeric py-1.5 pr-3 text-right">
                      {q.revenue == null ? '—' : formatCurrencyCompact(q.revenue)}
                    </td>
                    <td className="numeric py-1.5 text-right">
                      {q.epsDiluted == null ? '—' : q.epsDiluted.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">
              {data.historyNote ?? 'No quarterly figures available.'}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground lg:col-span-2">
        <p>
          <span className="font-medium text-foreground">Past.</span> {data.provenance.history}{' '}
          {data.provenance.fourthQuarter}
        </p>
        {data.provenance.upcoming && (
          <p className="mt-1.5">
            <span className="font-medium text-foreground">Upcoming.</span>{' '}
            {data.provenance.upcoming}. {data.provenance.estimatesNote}{' '}
            {data.provenance.coverageNote}
            {data.provenance.upcomingCommercial !== 'permitted' && (
              <>
                {' '}
                <span className="font-medium text-foreground">Licence:</span>{' '}
                {data.provenance.upcomingLicence}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
