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
import { AlertCircle, GitCompare, Play } from 'lucide-react';
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
import { AllocationBar } from '@/components/builder/allocation-bar';
import { postBacktestCompare, type ApiError } from '@/hooks/use-backtest';
import { useHydrated } from '@/hooks/use-hydrated';
import { useWorkspace } from '@/store/workspace';
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

export function CompareView() {
  const hydrated = useHydrated();
  const portfolios = useWorkspace((s) => s.portfolios);
  const draft = useWorkspace((s) => s.draft);
  const compareIds = useWorkspace((s) => s.compareIds);
  const toggleCompare = useWorkspace((s) => s.toggleCompare);
  const config = useWorkspace((s) => s.config);

  const [results, setResults] = React.useState<BacktestResult[] | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const candidates = React.useMemo(() => {
    const list = [...portfolios];
    // The working draft is comparable too, as long as it is not already saved.
    if (draft.positions.length && !portfolios.some((p) => p.id === draft.id)) {
      list.unshift({ ...draft, name: `${draft.name} (unsaved)` });
    }
    return list;
  }, [portfolios, draft]);

  const selected = candidates.filter((p) => compareIds.includes(p.id));

  async function run() {
    if (selected.length < 1) return;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const data = await postBacktestCompare(
        selected.map((p) => ({ id: p.id, name: p.name, positions: p.positions })),
        config,
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
        description="Run several portfolios over one identical window and configuration."
        actions={
          <Button size="lg" onClick={run} disabled={selected.length === 0 || pending}>
            {pending ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Running {selected.length}…
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
        ) : candidates.length === 0 ? (
          <EmptyState
            icon={GitCompare}
            title="Nothing to compare"
            description="Save at least two portfolios in the backtester, then select them here."
            action={
              <Button asChild>
                <Link href="/backtest">Build a portfolio</Link>
              </Button>
            }
            className="py-20"
          />
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Select portfolios</CardTitle>
              <p className="text-xs text-muted-foreground">
                Up to six at once. All of them use the settings currently set in the backtester:{' '}
                {formatDate(config.start)} → {formatDate(config.end)},{' '}
                {formatCurrency(config.initialInvestment)} initial, {config.rebalance} rebalancing.
              </p>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {candidates.map((p) => {
                const on = compareIds.includes(p.id);
                const disabled = !on && compareIds.length >= 6;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => toggleCompare(p.id)}
                    className={cn(
                      'rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      on ? 'border-primary bg-primary/8' : 'border-border hover:bg-accent/40',
                      disabled && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{p.name}</span>
                      {on && <Badge variant="primary">Selected</Badge>}
                    </div>
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      {p.positions.length} holding{p.positions.length === 1 ? '' : 's'}
                    </p>
                    <div className="mt-2">
                      <AllocationBar positions={p.positions} />
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        )}

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
            <ComparisonChart results={results} />
            <ComparisonTable results={results} />
          </div>
        )}
      </PageBody>
    </>
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
      description="Time-weighted, so contributions do not distort the comparison."
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
    { label: 'Total costs', get: (r) => r.totals.totalManagementFees + r.totals.totalExpenseRatioCost + r.totals.totalTradingCosts, format: (v) => formatCurrency(v), better: 'low' },
  ];

  const window = results[0];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Side by side</CardTitle>
        <p className="text-xs text-muted-foreground">
          {formatDate(window.effectiveStart)} → {formatDate(window.effectiveEnd)}. The strongest
          value in each row is emphasised.
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
