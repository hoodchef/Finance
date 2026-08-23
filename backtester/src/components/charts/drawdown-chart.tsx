'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacktestResult } from '@/lib/backtest';
import { daysBetween } from '@/lib/market-data/dates';
import { formatPercent } from '@/lib/format';
import { seriesColor } from '@/lib/utils';
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

/**
 * Underwater chart. Drawdown is computed on the time-weighted index rather than
 * the dollar balance, so a contribution cannot make a drawdown look like it
 * recovered when the market had not.
 */
export function DrawdownChart({ result }: { result: BacktestResult }) {
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());

  const series = React.useMemo(
    () => [
      { key: 'portfolio', label: result.portfolio.name || 'Portfolio', color: 'hsl(var(--negative))' },
      ...result.benchmarks.map((b, i) => ({
        key: b.symbol,
        label: b.symbol,
        color: seriesColor(b.symbol, i + 1),
      })),
    ],
    [result],
  );

  const rows = React.useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const p of result.series) {
      byDate.set(p.date, { date: p.date, portfolio: p.drawdown });
    }
    for (const b of result.benchmarks) {
      for (const p of b.series) {
        const row = byDate.get(p.date);
        if (row) row[b.symbol] = p.drawdown;
      }
    }
    return [...byDate.values()].sort((a, b) =>
      String(a.date) < String(b.date) ? -1 : 1,
    );
  }, [result]);

  const worst = result.metrics.risk.maxDrawdown;
  const tickFormatter = makeDateTickFormatter(
    daysBetween(result.effectiveStart, result.effectiveEnd),
  );
  const dateTicks = React.useMemo(
    () => makeDateTicks(rows.map((r) => String(r.date))),
    [rows],
  );

  return (
    <ChartFrame
      title="Drawdown"
      description="Loss from the previous high, at every point in the backtest."
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
      <div className="h-56 w-full sm:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="dd-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--negative))" stopOpacity={0.05} />
                <stop offset="100%" stopColor="hsl(var(--negative))" stopOpacity={0.3} />
              </linearGradient>
            </defs>
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
              width={52}
              domain={[Math.min(worst * 1.1, -0.05), 0]}
              tickFormatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <ReferenceLine
              y={worst}
              stroke="hsl(var(--negative))"
              strokeDasharray="4 4"
              strokeOpacity={0.6}
              label={{
                value: `Max ${formatPercent(worst, 1)}`,
                position: 'insideBottomLeft',
                fill: 'hsl(var(--negative))',
                fontSize: 10,
              }}
            />

            {series.map((s) =>
              hidden.has(s.key) ? null : (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={s.key === 'portfolio' ? 1.5 : 1}
                  fill={s.key === 'portfolio' ? 'url(#dd-fill)' : s.color}
                  fillOpacity={s.key === 'portfolio' ? 1 : 0.06}
                  isAnimationActive={false}
                  dot={false}
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
                    rows={series
                      .filter((s) => !hidden.has(s.key) && typeof row[s.key] === 'number')
                      .map((s) => ({
                        label: s.label,
                        color: s.color,
                        value: formatPercent(row[s.key]),
                      }))}
                  />
                );
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
