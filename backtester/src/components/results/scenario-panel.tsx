'use client';

import * as React from 'react';
import { AlertCircle, Play, RefreshCw, Waypoints } from 'lucide-react';
import type { ScenarioAnalysis } from '@/lib/analysis/scenarios';
import type { BacktestConfig, Portfolio } from '@/lib/types';
import { postScenarioAnalysis, type ApiError } from '@/hooks/use-backtest';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { WarningsPanel } from './panels';
import { formatDate, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

const REFERENCES = [
  { symbol: 'SPY', label: 'S&P 500 (SPY)' },
  { symbol: 'QQQ', label: 'Nasdaq-100 (QQQ)' },
  { symbol: 'VTI', label: 'US total market (VTI)' },
  { symbol: 'BND', label: 'US aggregate bonds (BND)' },
];

/**
 * Crisis-period analysis. The periods are whatever the reference index's own
 * history says they were, so switching the reference genuinely changes which
 * episodes appear — a bond investor's bad years are not an equity investor's.
 */
export function ScenarioPanel({
  portfolio,
  config,
}: {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
}) {
  const [reference, setReference] = React.useState('SPY');
  const [analysis, setAnalysis] = React.useState<ScenarioAnalysis | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const run = React.useCallback(
    async (ref: string) => {
      controller.current?.abort();
      const ac = new AbortController();
      controller.current = ac;
      setPending(true);
      setError(null);
      try {
        const data = await postScenarioAnalysis(portfolio, config, ref, ac.signal);
        if (!ac.signal.aborted) setAnalysis(data);
      } catch (err) {
        if (!ac.signal.aborted) {
          setError(
            (err as ApiError)?.error
              ? (err as ApiError)
              : { error: 'Could not reach the scenario service.' },
          );
        }
      } finally {
        if (!ac.signal.aborted) setPending(false);
      }
    },
    [portfolio, config],
  );

  React.useEffect(() => () => controller.current?.abort(), []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Scenario analysis</CardTitle>
              <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                How this portfolio behaved during the worst periods in market history. The periods
                are not a fixed list — they are computed from the reference index&rsquo;s own
                drawdowns, so the dates are whatever the prices actually did.
              </p>
              {analysis && (
                <p className="mt-1 text-2xs text-muted-foreground">
                  Drawn from {analysis.reference.symbol} history since{' '}
                  <span className="numeric text-foreground">
                    {formatDate(analysis.referenceStart ?? '')}
                  </span>
                  {analysis.portfolioStart && (
                    <>
                      {' · this portfolio has history from '}
                      <span className="numeric text-foreground">
                        {formatDate(analysis.portfolioStart)}
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Select
                value={reference}
                onValueChange={(v) => {
                  setReference(v);
                  if (analysis) void run(v);
                }}
              >
                <SelectTrigger className="h-9 w-52 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFERENCES.map((r) => (
                    <SelectItem key={r.symbol} value={r.symbol}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => void run(reference)} disabled={pending}>
                {pending ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Running…
                  </>
                ) : (
                  <>
                    {analysis ? <RefreshCw /> : <Play />}
                    {analysis ? 'Rerun' : 'Run analysis'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardHeader>

        {error && (
          <CardContent>
            <div
              role="alert"
              className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/8 p-3"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
              <p className="text-xs">{error.error}</p>
            </div>
          </CardContent>
        )}

        {pending && !analysis && (
          <CardContent>
            <Skeleton className="h-64 w-full" />
          </CardContent>
        )}

        {!analysis && !pending && !error && (
          <CardContent>
            <EmptyState
              icon={Waypoints}
              title="Not run yet"
              description="This searches the reference index's full history for its deepest drawdowns, then measures the portfolio through each one."
              className="border-0 py-10"
            />
          </CardContent>
        )}

        {analysis && (
          <CardContent className={cn('space-y-3 px-0 pb-0', pending && 'opacity-60')}>
            {analysis.warnings.length > 0 && (
              <div className="px-4 sm:px-5">
                <WarningsPanel warnings={analysis.warnings} />
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <NumHead>
                    <span className="inline-flex items-center gap-1">
                      {analysis.reference.symbol} fell
                      <InfoTip label="About the reference decline">
                        The reference index&rsquo;s own peak-to-trough loss. This is what defines
                        the period; every other column measures the portfolio across those dates.
                      </InfoTip>
                    </span>
                  </NumHead>
                  <NumHead>Portfolio fell</NumHead>
                  <NumHead>
                    <span className="inline-flex items-center gap-1">
                      Capture
                      <InfoTip label="About downside capture">
                        Portfolio decline divided by the reference decline. Below 1.00 means the
                        portfolio lost less than the index; above 1.00 means it lost more.
                      </InfoTip>
                    </span>
                  </NumHead>
                  <NumHead>Worst point</NumHead>
                  <NumHead>Decline</NumHead>
                  <NumHead>
                    <span className="inline-flex items-center gap-1">
                      To recovery
                      <InfoTip label="About recovery">
                        Portfolio return from the start of the period to the date the reference
                        index regained its prior high. A positive figure means the portfolio was
                        already ahead by the time the index merely broke even.
                      </InfoTip>
                    </span>
                  </NumHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysis.outcomes.map((o) => {
                  const e = o.episode;
                  const uncovered = o.coverage === 'none';
                  return (
                    <TableRow key={e.id} className={cn(uncovered && 'opacity-55')}>
                      <TableCell className="min-w-[15rem]">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium">
                            {e.name ?? `${e.peakDate.slice(0, 4)} drawdown`}
                          </span>
                          {o.coverage === 'partial' && (
                            <Badge variant="warning">Partial</Badge>
                          )}
                          {uncovered && <Badge variant="outline">Before this portfolio</Badge>}
                          {!e.recovered && <Badge variant="outline">Unrecovered</Badge>}
                        </div>
                        <div className="mt-0.5 text-2xs text-muted-foreground">
                          {formatDate(e.peakDate)} → {formatDate(e.troughDate)}
                          {e.recovered && ` · back to even ${formatDate(e.recoveryDate!)}`}
                        </div>
                      </TableCell>

                      <NumCell className="text-xs font-medium text-negative">
                        {formatPercent(e.referenceDepth, 1)}
                      </NumCell>

                      <NumCell
                        className={cn(
                          'text-xs font-medium',
                          o.portfolioDecline == null
                            ? 'text-muted-foreground'
                            : o.portfolioDecline < 0
                              ? 'text-negative'
                              : 'text-positive',
                        )}
                      >
                        {o.portfolioDecline == null ? '—' : formatPercent(o.portfolioDecline, 1)}
                      </NumCell>

                      <NumCell
                        className={cn(
                          'text-xs',
                          o.downsideCapture != null &&
                            (o.downsideCapture < 1 ? 'text-positive' : 'text-negative'),
                        )}
                      >
                        {o.downsideCapture == null ? '—' : `${formatNumber(o.downsideCapture)}×`}
                      </NumCell>

                      <NumCell className="text-xs text-muted-foreground">
                        {o.portfolioMaxDrawdown == null
                          ? '—'
                          : formatPercent(o.portfolioMaxDrawdown, 1)}
                      </NumCell>

                      <NumCell className="text-xs text-muted-foreground">
                        {formatDuration(e.declineDays)}
                      </NumCell>

                      <NumCell
                        className={cn(
                          'text-xs',
                          o.portfolioThroughRecovery != null &&
                            (o.portfolioThroughRecovery >= 0 ? 'text-positive' : 'text-negative'),
                        )}
                      >
                        {o.portfolioThroughRecovery == null
                          ? '—'
                          : formatPercent(o.portfolioThroughRecovery, 1)}
                      </NumCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <p className="px-4 pb-4 text-2xs leading-relaxed text-muted-foreground sm:px-5">
              Periods come from the drawdowns of {analysis.reference.symbol} over its full
              available history, deepest first. The portfolio is run with your own rebalancing rule
              and fees, but without contributions — a scheduled deposit landing mid-crash would
              flatter the decline. Named periods are labelled only where a computed trough falls in
              the month that name refers to; the dates themselves always come from prices.
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
