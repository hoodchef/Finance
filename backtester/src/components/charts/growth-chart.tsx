'use client';

import * as React from 'react';
import {
  Area,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacktestResult, SeriesPoint } from '@/lib/backtest';
import { daysBetween } from '@/lib/market-data/dates';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '@/lib/format';
import { cn, seriesColor } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  AXIS_PROPS,
  ChartFrame,
  ChartTooltip,
  GRID_PROPS,
  SeriesToggles,
  makeDateTickFormatter,
  makeDateTicks,
  tooltipDate,
} from './chart-chrome';

type Scale = 'linear' | 'log';
type Mode = 'value' | 'index';

interface Row {
  date: string;
  portfolio: number;
  contributed: number;
  [key: string]: number | string;
}

const PORTFOLIO_COLOR = 'hsl(var(--primary))';

/**
 * The primary growth chart.
 *
 * Two views: dollar value (what the account was worth, including money paid in)
 * and growth of $10,000 (time-weighted, so contributions cannot flatter it).
 * Benchmarks only make sense against the latter when contributions are on, so
 * the contributed-capital band is drawn only in value mode.
 */
export function GrowthChart({ result }: { result: BacktestResult }) {
  const [scale, setScale] = React.useState<Scale>('linear');
  const [mode, setMode] = React.useState<Mode>('value');
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());

  const hasContributions =
    result.totals.totalContributions > 0 || result.totals.totalWithdrawals > 0;

  const series = React.useMemo(
    () => [
      { key: 'portfolio', label: result.portfolio.name || 'Portfolio', color: PORTFOLIO_COLOR },
      ...result.benchmarks.map((b, i) => ({
        key: b.symbol,
        label: b.symbol,
        color: seriesColor(b.symbol, i + 1),
      })),
    ],
    [result],
  );

  const rows = React.useMemo(() => {
    const byDate = new Map<string, Row>();
    const base = mode === 'index' ? 10_000 : 1;

    for (const p of result.series) {
      byDate.set(p.date, {
        date: p.date,
        portfolio: mode === 'index' ? p.index * base : p.value,
        contributed: p.contributed,
      });
    }

    for (const bench of result.benchmarks) {
      for (const p of bench.series) {
        const row = byDate.get(p.date);
        if (row) row[bench.symbol] = mode === 'index' ? p.index * base : p.value;
      }
    }

    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [result, mode]);

  const spanDays = daysBetween(result.effectiveStart, result.effectiveEnd);
  const tickFormatter = makeDateTickFormatter(spanDays);
  const dateTicks = React.useMemo(() => makeDateTicks(rows.map((r) => r.date)), [rows]);
  const fmt = mode === 'index' ? formatCurrencyCompact : formatCurrencyCompact;

  // A log axis cannot render a zero or negative floor, so clamp the domain.
  const minValue = React.useMemo(
    () =>
      rows.reduce((m, r) => {
        const vals = series
          .filter((s) => !hidden.has(s.key))
          .map((s) => r[s.key])
          .filter((v): v is number => typeof v === 'number' && v > 0);
        return vals.length ? Math.min(m, ...vals) : m;
      }, Number.POSITIVE_INFINITY),
    [rows, series, hidden],
  );

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <ChartFrame
      title="Portfolio growth"
      description={
        mode === 'value'
          ? 'Account value at each close, including capital paid in.'
          : 'Growth of $10,000, time-weighted — external cash flows removed.'
      }
      actions={
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-border p-0.5">
            {(['value', 'index'] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? 'secondary' : 'ghost'}
                onClick={() => setMode(m)}
                className="h-6 px-2 text-2xs"
              >
                {m === 'value' ? 'Value' : 'Growth of $10k'}
              </Button>
            ))}
          </div>
          <div className="flex rounded-md border border-border p-0.5">
            {(['linear', 'log'] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={scale === s ? 'secondary' : 'ghost'}
                onClick={() => setScale(s)}
                className="h-6 px-2 text-2xs uppercase"
              >
                {s === 'linear' ? 'Lin' : 'Log'}
              </Button>
            ))}
          </div>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SeriesToggles series={series} hidden={hidden} onToggle={toggle} />
          <span>Drag the handles below the chart to zoom into a period.</span>
        </div>
      }
    >
      <div className="h-[22rem] w-full sm:h-[26rem]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
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
              scale={scale === 'log' ? 'log' : 'auto'}
              domain={
                scale === 'log'
                  ? [Number.isFinite(minValue) ? minValue * 0.9 : 'auto', 'auto']
                  : ['auto', 'auto']
              }
              allowDataOverflow={scale === 'log'}
              tickFormatter={(v) => fmt(Number(v))}
            />

            {mode === 'value' && hasContributions && (
              <Area
                type="monotone"
                dataKey="contributed"
                name="Capital contributed"
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1}
                strokeDasharray="3 3"
                fill="hsl(var(--muted-foreground))"
                fillOpacity={0.07}
                isAnimationActive={false}
                dot={false}
              />
            )}

            {series.map((s) =>
              hidden.has(s.key) ? null : (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={s.key === 'portfolio' ? 2 : 1.25}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ),
            )}

            <ReferenceLine y={0} stroke="hsl(var(--border))" />

            <Tooltip
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Row;
                const portfolioValue = Number(row.portfolio);
                return (
                  <ChartTooltip
                    title={tooltipDate(label)}
                    rows={[
                      ...series
                        .filter((s) => !hidden.has(s.key) && typeof row[s.key] === 'number')
                        .map((s) => ({
                          label: s.label,
                          color: s.color,
                          value: formatCurrency(Number(row[s.key])),
                        })),
                      ...(mode === 'value' && hasContributions
                        ? [
                            {
                              label: 'Capital contributed',
                              value: formatCurrency(row.contributed),
                              muted: true,
                            },
                            {
                              label: 'Investment gain',
                              value: formatCurrency(portfolioValue - row.contributed),
                              muted: true,
                            },
                          ]
                        : []),
                    ]}
                    footer={
                      mode === 'index'
                        ? `Time-weighted return since inception: ${formatPercent(
                            portfolioValue / 10_000 - 1,
                          )}`
                        : undefined
                    }
                  />
                );
              }}
            />

            <Brush
              dataKey="date"
              height={22}
              travellerWidth={8}
              stroke="hsl(var(--border))"
              fill="hsl(var(--muted))"
              tickFormatter={tickFormatter}
              className={cn('text-2xs')}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

export function contributedAtEnd(series: SeriesPoint[]): number {
  return series.at(-1)?.contributed ?? 0;
}
