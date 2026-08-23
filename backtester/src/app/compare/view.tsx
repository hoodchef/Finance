'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, AlertTriangle, History, Play, Trash2 } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
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
import {
  AXIS_PROPS,
  ChartFrame,
  ChartTooltip,
  GRID_PROPS,
  makeDateTickFormatter,
  makeDateTicks,
  tooltipDate,
} from '@/components/charts/chart-chrome';
import { DataFreshness, SyntheticDataBanner } from '@/components/results/panels';
import { postBacktestCompare, type ApiError } from '@/hooks/use-backtest';
import { useHydrated } from '@/hooks/use-hydrated';
import { useWorkspace } from '@/store/workspace';
import { runProvenance, type RunProvenance, type SavedRun } from '@/lib/runs';
import type { BacktestResult } from '@/lib/backtest';
import { daysBetween } from '@/lib/market-data/dates';
import {
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
  formatNumber,
  formatPercent,
  formatSignedPercent,
} from '@/lib/format';
import { cn, seriesColor } from '@/lib/utils';

/**
 * Comparison operates on saved RUNS, not on live portfolios.
 *
 * A run holds an immutable snapshot of the portfolio and configuration it
 * executed under, so a comparison always shows what was actually measured. When
 * comparison referenced live portfolios, editing a weight silently rewrote every
 * saved comparison that mentioned it.
 */
export function CompareView() {
  const hydrated = useHydrated();
  const runs = useWorkspace((s) => s.runs);
  const portfolios = useWorkspace((s) => s.portfolios);
  const compareRunIds = useWorkspace((s) => s.compareRunIds);
  const toggleCompareRun = useWorkspace((s) => s.toggleCompareRun);
  const deleteRun = useWorkspace((s) => s.deleteRun);

  const [results, setResults] = React.useState<BacktestResult[] | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const selected = React.useMemo(
    () => runs.filter((r) => compareRunIds.includes(r.runId)),
    [runs, compareRunIds],
  );

  // Comparing runs measured over different windows or different starting
  // capital is the most common way to draw a false conclusion here, so it is
  // stated rather than left for the reader to notice.
  const mismatches = React.useMemo(() => {
    if (selected.length < 2) return [] as string[];
    const out: string[] = [];
    const windows = new Set(selected.map((r) => `${r.summary.start}|${r.summary.end}`));
    if (windows.size > 1) {
      out.push(
        `These runs cover different periods (${selected
          .map((r) => `${r.label}: ${formatDate(r.summary.start)}–${formatDate(r.summary.end)}`)
          .join('; ')}). Returns measured over different windows are not directly comparable.`,
      );
    }
    const capital = new Set(selected.map((r) => r.config.initialInvestment));
    if (capital.size > 1) {
      out.push(
        'These runs started from different amounts of capital, so final values are not comparable. The growth chart is indexed, and remains valid.',
      );
    }
    const dividends = new Set(selected.map((r) => r.config.dividends));
    if (dividends.size > 1) {
      out.push('Some runs reinvest dividends and others take them as cash.');
    }
    return out;
  }, [selected]);

  async function run() {
    if (!selected.length) return;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const data = await postBacktestCompare(
        selected.map((r) => ({
          portfolio: {
            id: r.runId,
            name: r.label,
            positions: r.snapshot.positions,
          },
          config: r.config,
        })),
        ac.signal,
      );
      if (!ac.signal.aborted) setResults(data.results);
    } catch (err) {
      if (!ac.signal.aborted) {
        setError(
          (err as ApiError)?.error
            ? (err as ApiError)
            : { error: 'Could not reach the comparison service.' },
        );
      }
    } finally {
      if (!ac.signal.aborted) setPending(false);
    }
  }

  React.useEffect(() => () => controller.current?.abort(), []);

  return (
    <>
      <PageHeader
        title="Compare"
        description="Saved backtest runs, side by side. Each replays from its own snapshot."
        actions={
          <Button size="lg" onClick={run} disabled={!selected.length || pending}>
            {pending ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Replaying {selected.length}…
              </>
            ) : (
              <>
                <Play />
                Compare {selected.length || ''}
              </>
            )}
          </Button>
        }
      />

      <PageBody className="space-y-5">
        {!hydrated ? (
          <Skeleton className="h-40 w-full" />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={History}
            title="No saved runs yet"
            description="Every backtest you run is recorded here automatically, with a snapshot of the portfolio and settings behind it. Run one to get started."
            action={
              <Button asChild>
                <Link href="/backtest">Open the backtester</Link>
              </Button>
            }
            className="py-20"
          />
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Select runs</CardTitle>
              <p className="text-xs text-muted-foreground">
                Up to six. Each run replays from the portfolio and settings it originally used, so
                editing a portfolio afterwards never changes what a saved run reports.
              </p>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {runs.map((r) => (
                <RunCard
                  key={r.runId}
                  run={r}
                  selected={compareRunIds.includes(r.runId)}
                  provenance={runProvenance(r, portfolios)}
                  disabled={!compareRunIds.includes(r.runId) && compareRunIds.length >= 6}
                  onToggle={() => toggleCompareRun(r.runId)}
                  onDelete={() => deleteRun(r.runId)}
                />
              ))}
            </CardContent>
          </Card>
        )}

        {mismatches.map((m) => (
          <div
            key={m}
            className="flex items-start gap-2.5 rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--warning))]" />
            <span className="leading-relaxed">{m}</span>
          </div>
        ))}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/8 p-4"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
            <p className="text-xs leading-relaxed">{error.error}</p>
          </div>
        )}

        {pending && !results && (
          <div className="space-y-5">
            <Skeleton className="h-80 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {results && results.length > 0 && (
          <div className={cn('space-y-5', pending && 'opacity-60')}>
            {/* Comparison charts are as capable of misleading as any single
                result, so the same provenance rules apply here. */}
            <SyntheticDataBanner result={results[0]} />
            <DataFreshness dataSource={results[0].dataSource} />
            <ComparisonChart results={results} />
            <ComparisonTable results={results} />
          </div>
        )}
      </PageBody>
    </>
  );
}

function RunCard({
  run,
  selected,
  provenance,
  disabled,
  onToggle,
  onDelete,
}: {
  run: SavedRun;
  selected: boolean;
  provenance: RunProvenance;
  disabled: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative rounded-md border p-3 transition-colors',
        selected ? 'border-primary bg-primary/8' : 'border-border hover:bg-accent/40',
        disabled && 'opacity-40',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onToggle}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between gap-2 pr-6">
          <span className="truncate text-xs font-medium">{run.label}</span>
          {selected && <Badge variant="primary">Selected</Badge>}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {provenance === 'drifted' && (
            <Badge variant="warning" title="The source portfolio has been edited since this run">
              Portfolio edited since
            </Badge>
          )}
          {provenance === 'detached' && (
            <Badge
              variant="outline"
              title="This run is not linked to a saved portfolio — it was either run from an unsaved draft, or its portfolio was removed"
            >
              Not saved
            </Badge>
          )}
          {run.summary.synthetic && <Badge variant="warning">Synthetic</Badge>}
        </div>

        <dl className="mt-2 grid grid-cols-3 gap-1 text-2xs">
          <div>
            <dt className="text-muted-foreground">CAGR</dt>
            <dd className="numeric font-medium">{formatPercent(run.summary.cagr, 1)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Max DD</dt>
            <dd className="numeric font-medium text-negative">
              {formatPercent(run.summary.maxDrawdown, 1)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Final</dt>
            <dd className="numeric font-medium">
              {formatCurrencyCompact(run.summary.finalValue)}
            </dd>
          </div>
        </dl>

        <p className="mt-1.5 truncate text-2xs text-muted-foreground">
          {run.snapshot.positions
            .filter((p) => p.weight > 0)
            .map((p) => `${p.symbol} ${p.weight}%`)
            .join(' · ')}
        </p>
        <p className="text-2xs text-muted-foreground">
          {formatDate(run.summary.start)} → {formatDate(run.summary.end)}
        </p>
      </button>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete run ${run.label}`}
        onClick={onDelete}
        className="absolute right-1.5 top-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-negative focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function ComparisonChart({ results }: { results: BacktestResult[] }) {
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());

  const rows = React.useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const r of results) {
      for (const p of r.series) {
        const row = byDate.get(p.date) ?? { date: p.date };
        row[r.portfolio.id] = p.index * 10_000;
        byDate.set(p.date, row);
      }
    }
    return [...byDate.values()].sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  }, [results]);

  const span = daysBetween(results[0].effectiveStart, results[0].effectiveEnd);
  const tickFormatter = makeDateTickFormatter(span);
  const dateTicks = React.useMemo(() => makeDateTicks(rows.map((r) => String(r.date))), [rows]);

  return (
    <ChartFrame
      title="Growth of $10,000"
      description="Time-weighted and indexed, so runs that started from different capital remain comparable."
      footer={
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {results.map((r, i) => {
            const off = hidden.has(r.portfolio.id);
            return (
              <button
                key={r.portfolio.id}
                type="button"
                aria-pressed={!off}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.portfolio.id)) next.delete(r.portfolio.id);
                    else next.add(r.portfolio.id);
                    return next;
                  })
                }
                className={cn('flex items-center gap-1.5 text-xs', off && 'opacity-40 line-through')}
              >
                <span
                  aria-hidden
                  className="h-2 w-2.5 rounded-sm"
                  style={{ backgroundColor: seriesColor(r.portfolio.id, i) }}
                />
                {r.portfolio.name}
              </button>
            );
          })}
        </div>
      }
    >
      <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis
              dataKey="date"
              {...AXIS_PROPS}
              ticks={dateTicks}
              tickFormatter={tickFormatter}
              minTickGap={20}
            />
            <YAxis
              {...AXIS_PROPS}
              width={62}
              tickFormatter={(v) => formatCurrencyCompact(Number(v))}
            />
            {results.map((r, i) =>
              hidden.has(r.portfolio.id) ? null : (
                <Line
                  key={r.portfolio.id}
                  type="monotone"
                  dataKey={r.portfolio.id}
                  name={r.portfolio.name}
                  stroke={seriesColor(r.portfolio.id, i)}
                  strokeWidth={1.75}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ),
            )}
            <Tooltip
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number>;
                return (
                  <ChartTooltip
                    title={tooltipDate(label)}
                    rows={results
                      .filter((r) => !hidden.has(r.portfolio.id) && row[r.portfolio.id] != null)
                      .sort((a, b) => row[b.portfolio.id] - row[a.portfolio.id])
                      .map((r) => ({
                        label: r.portfolio.name,
                        color: seriesColor(r.portfolio.id, results.indexOf(r)),
                        value: formatCurrency(row[r.portfolio.id]),
                      }))}
                  />
                );
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

function ComparisonTable({ results }: { results: BacktestResult[] }) {
  const rows: Array<{
    label: string;
    get: (r: BacktestResult) => number;
    format: (v: number) => string;
    better: 'high' | 'low' | null;
  }> = [
    { label: 'Final value', get: (r) => r.totals.finalValue, format: (v) => formatCurrency(v), better: 'high' },
    { label: 'Total return', get: (r) => r.metrics.returns.totalReturn, format: (v) => formatSignedPercent(v, 1), better: 'high' },
    { label: 'CAGR', get: (r) => r.metrics.returns.cagr, format: (v) => formatPercent(v), better: 'high' },
    { label: 'Volatility', get: (r) => r.metrics.risk.volatility, format: (v) => formatPercent(v), better: 'low' },
    { label: 'Max drawdown', get: (r) => r.metrics.risk.maxDrawdown, format: (v) => formatPercent(v, 1), better: 'high' },
    { label: 'Sharpe', get: (r) => r.metrics.ratios.sharpe, format: (v) => formatNumber(v), better: 'high' },
    { label: 'Sortino', get: (r) => r.metrics.ratios.sortino, format: (v) => formatNumber(v), better: 'high' },
    { label: 'Calmar', get: (r) => r.metrics.ratios.calmar, format: (v) => formatNumber(v), better: 'high' },
    { label: 'Best year', get: (r) => r.metrics.annualSummary.best?.return ?? Number.NaN, format: (v) => formatSignedPercent(v, 1), better: null },
    { label: 'Worst year', get: (r) => r.metrics.annualSummary.worst?.return ?? Number.NaN, format: (v) => formatSignedPercent(v, 1), better: null },
    { label: 'Positive years', get: (r) => r.metrics.annualSummary.positiveRate, format: (v) => formatPercent(v, 0), better: 'high' },
    { label: 'Realised gains', get: (r) => r.totals.totalRealisedGain, format: (v) => formatCurrency(v), better: 'low' },
    { label: 'Total costs', get: (r) => r.totals.totalManagementFees + r.totals.totalExpenseRatioCost + r.totals.totalTradingCosts, format: (v) => formatCurrency(v), better: 'low' },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Side by side</CardTitle>
        <p className="text-xs text-muted-foreground">
          The strongest value in each row is emphasised. &ldquo;Better&rdquo; is only meaningful
          where the runs are otherwise comparable.
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-card">Metric</TableHead>
              {results.map((r, i) => (
                <NumHead key={r.portfolio.id}>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: seriesColor(r.portfolio.id, i) }}
                    />
                    {r.portfolio.name}
                  </span>
                </NumHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="sticky left-0 whitespace-nowrap bg-card text-xs text-muted-foreground">
                Period
              </TableCell>
              {results.map((r) => (
                <NumCell key={r.portfolio.id} className="text-2xs text-muted-foreground">
                  {formatDate(r.effectiveStart)} → {formatDate(r.effectiveEnd)}
                </NumCell>
              ))}
            </TableRow>
            {rows.map((row) => {
              const values = results.map(row.get);
              const valid = values.filter((v) => Number.isFinite(v));
              const best =
                row.better && valid.length > 1
                  ? row.better === 'high'
                    ? Math.max(...valid)
                    : Math.min(...valid)
                  : null;
              return (
                <TableRow key={row.label}>
                  <TableCell className="sticky left-0 whitespace-nowrap bg-card text-xs text-muted-foreground">
                    {row.label}
                  </TableCell>
                  {values.map((v, i) => (
                    <NumCell
                      key={results[i].portfolio.id}
                      className={cn(
                        'text-xs',
                        best != null && Math.abs(v - best) < 1e-12 && 'font-semibold text-foreground',
                      )}
                    >
                      {Number.isFinite(v) ? row.format(v) : '—'}
                    </NumCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
