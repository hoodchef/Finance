'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Sigma, TriangleAlert } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Stat, toneOf } from '@/components/ui/stat';
import { InfoTip } from '@/components/ui/tooltip';
import {
  AXIS_PROPS,
  ChartFrame,
  GRID_PROPS,
  SeriesToggles,
  makeDateTickFormatter,
  makeDateTicks,
} from '@/components/charts/chart-chrome';
import { formatDate, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { cn, seriesColor } from '@/lib/utils';
import { useHydrated } from '@/hooks/use-hydrated';
import { useWorkspace } from '@/store/workspace';
import type { MetricGroup, MetricRow, PerformanceReport } from '@/lib/metrics/report';

/**
 * Performance metrics.
 * =============================================================================
 * Every statistic the engine can produce for one portfolio, on one page.
 *
 * The organising problem is not computing sixty numbers; it is that sixty
 * numbers in a column is a wall nobody reads. So they are grouped by the
 * QUESTION each answers — what was earned, what it cost, the trade between
 * them, and how much of it was just the market — and each figure carries the
 * convention it follows. Two libraries can both print "Sortino" and differ by
 * thirty percent depending on whether the threshold is the risk-free rate or
 * zero, so a bare label is not enough to make the number usable.
 *
 * Figures that cannot be computed say why rather than showing a dash. Most of
 * the missing ones are missing because no benchmark was chosen, which is a
 * thing the reader can fix in the box at the top.
 */

interface ReportResponse {
  report: PerformanceReport;
  portfolio: { id: string; name: string };
  series: Array<{ date: string; index: number; drawdown: number }>;
  benchmarkSeries: Array<{ date: string; index: number; drawdown: number }> | null;
  warnings: Array<{ message: string }>;
}

const ROLLING_SERIES = [
  { key: 'sharpe', label: 'Sharpe', color: seriesColor('sharpe', 0) },
  { key: 'sortino', label: 'Sortino', color: seriesColor('sortino', 1) },
  { key: 'volatility', label: 'Volatility', color: seriesColor('volatility', 3) },
  { key: 'beta', label: 'Beta', color: seriesColor('beta', 5) },
];

export function PerformanceView() {
  const hydrated = useHydrated();
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);

  const [benchmark, setBenchmark] = React.useState('');
  const [data, setData] = React.useState<ReportResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set(['volatility', 'beta']));

  const positions = draft.positions.filter((p) => p.symbol.trim());

  // The persisted store is empty during the first client paint, so the field
  // is filled once it arrives rather than initialised from the pre-hydration
  // default — which is a different portfolio from the user's saved one.
  const benchmarkTouched = React.useRef(false);
  React.useEffect(() => {
    if (!hydrated || benchmarkTouched.current) return;
    setBenchmark(config.benchmarks[0] ?? 'SPY');
  }, [hydrated, config.benchmarks]);

  const run = React.useCallback(async () => {
    if (!positions.length) {
      setError('Add at least one holding to the portfolio before measuring it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/performance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          portfolio: draft,
          config,
          benchmark: benchmark.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'The statistics could not be computed.');
      setData(body as ReportResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The statistics could not be computed.');
      setData(null);
    } finally {
      setBusy(false);
    }
    // `positions` is derived from `draft`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, config, benchmark]);

  /**
   * Measured once the store has arrived, then only when asked.
   *
   * The wait for hydration is not cosmetic. `useWorkspace` is persisted, so
   * during the first client paint it holds the DEFAULTS, not the user's saved
   * portfolio and date range. Firing the run on mount measured a ten-year
   * window of a preset portfolio and labelled it with the user's name for it —
   * a complete, plausible, wrong report that only differed from the right one
   * once you pressed Measure.
   *
   * Re-running is manual after that: a backtest is a real request against the
   * data plan, so reacting to every keystroke in the benchmark box would burn
   * the rate budget for no one's benefit.
   */
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!hydrated || started.current) return;
    started.current = true;
    void run();
  }, [hydrated, run]);

  const report = data?.report ?? null;

  const rollingRows = React.useMemo(() => {
    if (!report) return [];
    return report.rolling.map((r) => ({
      date: r.date,
      sharpe: r.sharpe,
      sortino: r.sortino,
      volatility: r.volatility,
      beta: r.beta,
    }));
  }, [report]);

  const spanDays = report
    ? (Date.parse(report.window.to) - Date.parse(report.window.from)) / 86_400_000
    : 0;
  const tickFormatter = React.useMemo(() => makeDateTickFormatter(spanDays), [spanDays]);
  // One tick per bucket, not one per point. Recharts spaces ticks evenly along
  // the axis by default, which on ten years of daily data prints the same year
  // four times in a row.
  const ticks = React.useMemo(
    () => makeDateTicks(rollingRows.map((r) => r.date)),
    [rollingRows],
  );

  const headline = report ? headlineStats(report) : [];

  return (
    <>
      <PageHeader
        title="Performance metrics"
        description="Every statistic for the current portfolio, with the convention each one follows."
        actions={
          <div className="flex items-center gap-2">
            <label className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Benchmark
            </label>
            <Input
              value={benchmark}
              onChange={(e) => {
                benchmarkTouched.current = true;
                setBenchmark(e.target.value.toUpperCase());
              }}
              onKeyDown={(e) => e.key === 'Enter' && void run()}
              placeholder="SPY"
              className="h-8 w-24 font-mono text-xs uppercase"
              aria-label="Benchmark symbol"
            />
            <Button size="sm" onClick={() => void run()} disabled={busy}>
              {busy ? 'Measuring…' : 'Measure'}
            </Button>
          </div>
        }
      />

      <PageBody className="space-y-4">
        {error && (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-negative">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        {!report && !error && (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-xs text-muted-foreground">
              <Sigma className="h-4 w-4 shrink-0 animate-pulse" />
              {busy
                ? 'Running the backtest and measuring it…'
                : 'Choose a benchmark and press Measure.'}
            </CardContent>
          </Card>
        )}

        {report && (
          <>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
              {headline.map((h) => (
                <Stat
                  key={h.label}
                  className="bg-card"
                  size="lg"
                  label={h.label}
                  value={h.value}
                  sub={h.sub}
                  tone={h.tone}
                  hint={h.hint}
                />
              ))}
            </div>

            <p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
              Measured on {report.window.observations.toLocaleString()} observations from{' '}
              {formatDate(report.window.from)} to {formatDate(report.window.to)} —{' '}
              {report.window.years.toFixed(1)} years at{' '}
              {report.window.periodsPerYear.toFixed(0)} periods a year, against a risk-free rate
              averaging {formatPercent(report.window.riskFree)}.{' '}
              {report.benchmark
                ? `Relative statistics use ${report.benchmark.symbol} on the trading dates both series share.`
                : 'No benchmark resolved, so alpha, beta and capture are not computed.'}{' '}
              These are historical measurements of a backtest, not forecasts.
            </p>

            {report.notes.map((n) => (
              <p
                key={n}
                className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground"
              >
                {n}
              </p>
            ))}

            <TrailingStrip report={report} />

            {report.groups.map((g) => (
              <MetricGroupCard key={g.id} group={g} />
            ))}

            <PeriodTable report={report} />

            <ChartFrame
              title="Rolling statistics"
              description={`Each point measures the trailing ${report.rollingWindow} observations, dated at the last day of the window.`}
              actions={
                <SeriesToggles
                  series={ROLLING_SERIES.filter(
                    (s) => s.key !== 'beta' || report.benchmark !== null,
                  )}
                  hidden={hidden}
                  onToggle={(key) =>
                    setHidden((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
              }
              footer="Windows overlap heavily, so neighbouring points are not independent observations. The shape is a fair description of how the risk profile moved; the spread is not a confidence interval."
            >
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rollingRows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis {...AXIS_PROPS} dataKey="date" ticks={ticks} tickFormatter={tickFormatter} />
                    {/* Two axes, because these are two kinds of quantity. Sharpe
                        and Sortino run to single digits while volatility is a
                        fraction near 0.1; sharing an axis pins volatility flat
                        against the floor and it reads as a broken series. */}
                    <YAxis
                      {...AXIS_PROPS}
                      yAxisId="ratio"
                      width={44}
                      tickFormatter={(v) => formatNumber(v, 1)}
                    />
                    <YAxis
                      {...AXIS_PROPS}
                      yAxisId="pct"
                      orientation="right"
                      width={48}
                      tickFormatter={(v) => formatPercent(v, 0)}
                    />
                    <ReferenceLine
                      yAxisId="ratio"
                      y={0}
                      stroke="var(--border)"
                      strokeDasharray="3 3"
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v: number, name: string) => [
                        name === 'Volatility' ? formatPercent(v, 1) : formatNumber(v, 2),
                        name,
                      ]}
                    />
                    {ROLLING_SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
                      <Line
                        key={s.key}
                        yAxisId={s.key === 'volatility' ? 'pct' : 'ratio'}
                        type="monotone"
                        dataKey={s.key}
                        name={s.label}
                        stroke={s.color}
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </ChartFrame>
          </>
        )}
      </PageBody>
    </>
  );
}

/* ------------------------------------------------------------------ */

function headlineStats(report: PerformanceReport) {
  const find = (group: string, key: string) =>
    report.groups.find((g) => g.id === group)?.rows.find((r) => r.key === key) ?? null;

  const pick = (group: string, key: string, format: (v: number) => string) => {
    const row = find(group, key);
    return {
      label: row?.label ?? key,
      value: row?.value == null ? '—' : format(row.value),
      hint: row?.note,
      row,
    };
  };

  const cagr = pick('returns', 'cagr', (v) => formatPercent(v));
  const vol = pick('risk', 'volatility', (v) => formatPercent(v));
  const sharpe = pick('ratios', 'sharpe', (v) => formatNumber(v));
  const sortino = pick('ratios', 'sortino', (v) => formatNumber(v));
  const mdd = pick('risk', 'maxDrawdown', (v) => formatPercent(v));
  const total = pick('returns', 'totalReturn', (v) => formatPercent(v));

  return [
    { ...total, sub: 'time-weighted', tone: toneOf(total.row?.value) },
    { ...cagr, sub: `${report.window.years.toFixed(1)} years`, tone: toneOf(cagr.row?.value) },
    { ...vol, sub: 'annualised', tone: 'neutral' as const },
    { ...sharpe, sub: 'excess / total risk', tone: 'neutral' as const },
    { ...sortino, sub: 'excess / downside', tone: 'neutral' as const },
    { ...mdd, sub: 'peak to trough', tone: toneOf(mdd.row?.value) },
  ];
}

function TrailingStrip({ report }: { report: PerformanceReport }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Trailing returns</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-5 lg:grid-cols-9">
          {report.trailing.map((t) => (
            <div key={t.label} className="flex flex-col gap-0.5">
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.label}
              </span>
              <span
                className={cn(
                  'numeric text-sm font-semibold',
                  t.value == null && 'text-muted-foreground',
                  t.value != null && t.value > 0 && 'text-positive',
                  t.value != null && t.value < 0 && 'text-negative',
                )}
              >
                {t.value == null || !t.complete ? '—' : formatPercent(t.value)}
              </span>
              {(t.value == null || !t.complete) && (
                <span className="text-2xs text-muted-foreground">not covered</span>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          A window the history does not cover reads as not covered rather than reporting the
          shorter period it does have — a two-year record shown as a ten-year return overstates
          a track record by five times.
        </p>
      </CardContent>
    </Card>
  );
}

function MetricGroupCard({ group }: { group: MetricGroup }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{group.label}</CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">{group.blurb}</p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
          {group.rows.map((row) => (
            <MetricLine key={row.key} row={row} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MetricLine({ row }: { row: MetricRow }) {
  const missing = row.value == null;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 last:border-0 sm:last:border-b">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{row.label}</span>
        <InfoTip label={`About ${row.label}`}>
          <span className="block max-w-[16rem] text-xs leading-relaxed">
            {row.note}
            {row.unavailable && (
              <span className="mt-1.5 block text-muted-foreground">{row.unavailable}</span>
            )}
          </span>
        </InfoTip>
      </span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        <span
          className={cn(
            'numeric text-xs font-semibold tabular-nums',
            missing && 'font-normal text-muted-foreground',
            !missing && row.sense === 'signed' && (row.value as number) > 0 && 'text-positive',
            !missing && row.sense === 'signed' && (row.value as number) < 0 && 'text-negative',
          )}
        >
          {formatMetric(row)}
        </span>
        {row.detail && !missing && (
          <span className="text-2xs text-muted-foreground">{row.detail}</span>
        )}
      </span>
    </div>
  );
}

function formatMetric(row: MetricRow): string {
  if (row.value == null) return row.unavailable ? 'n/a' : '—';
  switch (row.format) {
    case 'percent':
      return formatPercent(row.value);
    case 'ratio':
      return formatNumber(row.value, 2);
    case 'number':
      return formatNumber(row.value, 3);
    case 'days':
      return formatDuration(row.value);
    case 'count':
      return String(Math.round(row.value));
    default:
      return formatNumber(row.value, 2);
  }
}

function PeriodTable({ report }: { report: PerformanceReport }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">By period</CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The same history bucketed five ways. A strategy can win most days and lose most years,
          and only reading both rows shows it.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Period</th>
                <th className="py-2 pr-3 text-right font-medium">Count</th>
                <th className="py-2 pr-3 text-right font-medium">Win rate</th>
                <th className="py-2 pr-3 text-right font-medium">Average</th>
                <th className="py-2 pr-3 text-right font-medium">Median</th>
                <th className="py-2 pr-3 text-right font-medium">Best</th>
                <th className="py-2 pr-3 text-right font-medium">Worst</th>
              </tr>
            </thead>
            <tbody>
              {report.periods.map((p) => (
                <tr key={p.id} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-3">{p.label}</td>
                  <td className="numeric py-1.5 pr-3 text-right">{p.count.toLocaleString()}</td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatPercent(p.winRate, 1)}</td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatPercent(p.average)}</td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatPercent(p.median)}</td>
                  <td className="numeric py-1.5 pr-3 text-right text-positive">
                    {p.best ? formatPercent(p.best.return) : '—'}
                    {p.best && (
                      <span className="ml-1 text-2xs text-muted-foreground">{p.best.key}</span>
                    )}
                  </td>
                  <td className="numeric py-1.5 pr-3 text-right text-negative">
                    {p.worst ? formatPercent(p.worst.return) : '—'}
                    {p.worst && (
                      <span className="ml-1 text-2xs text-muted-foreground">{p.worst.key}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
