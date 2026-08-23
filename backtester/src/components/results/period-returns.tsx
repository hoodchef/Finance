'use client';

import * as React from 'react';
import type { PeriodReturn, PeriodSummary } from '@/lib/metrics';
import type { BacktestResult } from '@/lib/backtest';
import { formatDate, formatPercent, formatSignedPercent } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  NumCell,
  NumHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

type Granularity = 'weekly' | 'monthly' | 'quarterly' | 'annual';

const OPTIONS: Array<{ id: Granularity; label: string }> = [
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'annual', label: 'Annual' },
];

const MAX_ROWS = 300;

/**
 * Period returns at every granularity the engine buckets.
 *
 * Weekly rows can run to thousands over a long backtest, so the table caps what
 * it renders and says so — the summary above it is always computed from the
 * complete set, never from the visible slice.
 */
export function PeriodReturnsTable({ result }: { result: BacktestResult }) {
  const [granularity, setGranularity] = React.useState<Granularity>('quarterly');
  const [newestFirst, setNewestFirst] = React.useState(true);

  const { rows, summary } = React.useMemo(() => {
    const m = result.metrics;
    const pick: Record<Granularity, { rows: PeriodReturn[]; summary: PeriodSummary }> = {
      weekly: { rows: m.weekly, summary: m.weeklySummary },
      monthly: { rows: m.monthly, summary: m.monthlySummary },
      quarterly: { rows: m.quarterly, summary: m.quarterlySummary },
      annual: { rows: m.annual, summary: m.annualSummary },
    };
    return pick[granularity];
  }, [result, granularity]);

  const ordered = React.useMemo(
    () => (newestFirst ? [...rows].reverse() : rows),
    [rows, newestFirst],
  );
  const visible = ordered.slice(0, MAX_ROWS);

  if (!rows.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Period returns</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Time-weighted return for each {granularity.replace('ly', '')} period, chained from
              daily returns.
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            {OPTIONS.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant={granularity === o.id ? 'default' : 'outline'}
                onClick={() => setGranularity(o.id)}
                className="h-7 px-2.5 text-xs"
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>

        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-2xs text-muted-foreground">
          <span>
            Periods <span className="numeric text-foreground">{summary.count}</span>
          </span>
          <span>
            Average{' '}
            <span className="numeric text-foreground">
              {formatSignedPercent(summary.average)}
            </span>
          </span>
          <span>
            Median{' '}
            <span className="numeric text-foreground">{formatSignedPercent(summary.median)}</span>
          </span>
          <span>
            Positive{' '}
            <span className="numeric text-foreground">
              {formatPercent(summary.positiveRate, 0)}
            </span>
          </span>
          <span>
            Best{' '}
            <span className="numeric text-positive">
              {summary.best ? formatSignedPercent(summary.best.return) : '—'}
            </span>
          </span>
          <span>
            Worst{' '}
            <span className="numeric text-negative">
              {summary.worst ? formatSignedPercent(summary.worst.return) : '—'}
            </span>
          </span>
        </dl>
      </CardHeader>

      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <button
                  type="button"
                  onClick={() => setNewestFirst((v) => !v)}
                  className="uppercase tracking-wide hover:text-foreground"
                >
                  Period {newestFirst ? '↓' : '↑'}
                </button>
              </TableHead>
              <TableHead>Dates</TableHead>
              <NumHead>Return</NumHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((p) => (
              <TableRow key={p.key}>
                <TableCell className="numeric whitespace-nowrap text-xs font-medium">
                  <span className="flex items-center gap-1.5">
                    {p.key}
                    {p.partial && <Badge variant="outline">Partial</Badge>}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  {formatDate(p.startDate)} → {formatDate(p.endDate)}
                </TableCell>
                <NumCell
                  className={cn(
                    'text-xs font-medium',
                    p.return >= 0 ? 'text-positive' : 'text-negative',
                  )}
                >
                  {formatSignedPercent(p.return)}
                </NumCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {ordered.length > MAX_ROWS && (
          <p className="px-4 py-2.5 text-2xs text-muted-foreground">
            Showing {MAX_ROWS} of {ordered.length.toLocaleString()} periods. The summary above uses
            every one; export the CSV for the complete list.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
