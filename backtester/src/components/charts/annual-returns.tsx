'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacktestResult } from '@/lib/backtest';
import { formatPercent, formatSignedPercent } from '@/lib/format';
import { seriesColor } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  AXIS_PROPS,
  ChartFrame,
  ChartTooltip,
  GRID_PROPS,
  SeriesToggles,
} from './chart-chrome';

/** Calendar-year returns, portfolio against every benchmark. */
export function AnnualReturnsChart({ result }: { result: BacktestResult }) {
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());

  const series = React.useMemo(
    () => [
      { key: 'portfolio', label: result.portfolio.name || 'Portfolio', color: 'hsl(var(--primary))' },
      ...result.benchmarks.map((b, i) => ({
        key: b.symbol,
        label: b.symbol,
        color: seriesColor(b.symbol, i + 1),
      })),
    ],
    [result],
  );

  const rows = React.useMemo(() => {
    const byYear = new Map<number, Record<string, number | boolean | string>>();
    for (const a of result.metrics.annual) {
      byYear.set(a.year, { year: String(a.year), portfolio: a.return, partial: a.partial });
    }
    for (const b of result.benchmarks) {
      for (const a of b.metrics.annual) {
        const row = byYear.get(a.year);
        if (row) row[b.symbol] = a.return;
      }
    }
    return [...byYear.values()].sort((a, b) => Number(a.year) - Number(b.year));
  }, [result]);

  const hasPartial = result.metrics.annual.some((a) => a.partial);
  const visible = series.filter((s) => !hidden.has(s.key));

  if (!rows.length) return null;

  return (
    <ChartFrame
      title="Annual returns"
      description="Time-weighted return for each calendar year."
      actions={
        hasPartial ? (
          <Badge variant="outline" className="text-2xs">
            Hatched years are partial
          </Badge>
        ) : null
      }
      footer={
        <SeriesToggles
          series={series}
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
    >
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} barGap={2}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="year" {...AXIS_PROPS} minTickGap={8} />
            <YAxis
              {...AXIS_PROPS}
              width={52}
              tickFormatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} />

            {visible.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {rows.map((row, i) => (
                  <Cell
                    key={i}
                    // The portfolio is coloured by sign so a bad year reads
                    // instantly; benchmarks keep their identity colour so the
                    // comparison stays legible.
                    fill={
                      s.key === 'portfolio'
                        ? Number(row.portfolio) >= 0
                          ? 'hsl(var(--positive))'
                          : 'hsl(var(--negative))'
                        : s.color
                    }
                    fillOpacity={s.key === 'portfolio' ? (row.partial ? 0.45 : 1) : 0.75}
                  />
                ))}
              </Bar>
            ))}

            <Tooltip
              cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.4 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number | boolean>;
                return (
                  <ChartTooltip
                    title={String(label)}
                    rows={visible
                      .filter((s) => typeof row[s.key] === 'number')
                      .map((s) => ({
                        label: s.label,
                        color:
                          s.key === 'portfolio'
                            ? Number(row.portfolio) >= 0
                              ? 'hsl(var(--positive))'
                              : 'hsl(var(--negative))'
                            : s.color,
                        value: formatSignedPercent(Number(row[s.key])),
                      }))}
                    footer={row.partial ? 'Partial year — the backtest does not span all of it.' : undefined}
                  />
                );
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

/** Compact summary strip used under the annual chart. */
export function AnnualSummary({ result }: { result: BacktestResult }) {
  const s = result.metrics.annualSummary;
  if (!s.count) return null;
  const items = [
    { label: 'Best year', value: s.best ? `${formatSignedPercent(s.best.return)} · ${s.best.year}` : '—' },
    { label: 'Worst year', value: s.worst ? `${formatSignedPercent(s.worst.return)} · ${s.worst.year}` : '—' },
    { label: 'Average', value: formatSignedPercent(s.average) },
    { label: 'Median', value: formatSignedPercent(s.median) },
    { label: 'Positive years', value: `${formatPercent(s.positiveRate, 0)} of ${s.count}` },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
      {items.map((i) => (
        <div key={i.label} className="bg-card p-3">
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{i.label}</dt>
          <dd className="numeric mt-0.5 text-sm font-medium">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
