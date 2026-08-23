'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { BacktestResult } from '@/lib/backtest';
import { daysBetween } from '@/lib/market-data/dates';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { seriesColor } from '@/lib/utils';
import {
  AXIS_PROPS,
  ChartFrame,
  ChartTooltip,
  GRID_PROPS,
  makeDateTickFormatter,
  makeDateTicks,
  tooltipDate,
} from './chart-chrome';

function colorFor(result: BacktestResult, symbol: string): string {
  const i = result.ledgers.findIndex((l) => l.symbol === symbol);
  return seriesColor(symbol, i >= 0 ? i : undefined);
}

/** Where the money ended up, against where it was meant to be. */
export function AllocationDonut({ result }: { result: BacktestResult }) {
  const data = result.ledgers
    .filter((l) => l.endingValue > 0.005)
    .map((l) => ({
      name: l.symbol,
      value: l.endingValue,
      weight: l.endWeight,
      target: l.targetWeight,
      color: colorFor(result, l.symbol),
    }));

  if (!data.length) return null;

  return (
    <ChartFrame
      title="Final allocation"
      description="Market value on the last day of the backtest."
    >
      <div className="flex flex-col items-center gap-4 p-3 sm:flex-row">
        <div className="h-48 w-48 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius="58%"
                outerRadius="88%"
                paddingAngle={1.5}
                stroke="hsl(var(--card))"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {data.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof data)[number];
                  return (
                    <ChartTooltip
                      title={d.name}
                      rows={[
                        { label: 'Value', value: formatCurrency(d.value), color: d.color },
                        { label: 'Weight', value: formatPercent(d.weight), muted: true },
                        { label: 'Target', value: formatPercent(d.target), muted: true },
                      ]}
                    />
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <ul className="w-full min-w-0 flex-1 space-y-1">
          {data
            .slice()
            .sort((a, b) => b.value - a.value)
            .map((d) => {
              const drift = d.weight - d.target;
              return (
                <li key={d.name} className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: d.color }}
                  />
                  <span className="numeric w-16 shrink-0 font-medium">{d.name}</span>
                  <span className="numeric w-14 shrink-0 text-right">{formatPercent(d.weight, 1)}</span>
                  <span className="w-14 shrink-0 text-right text-2xs text-muted-foreground">
                    tgt {formatPercent(d.target, 1)}
                  </span>
                  <span
                    className={`numeric flex-1 text-right text-2xs ${
                      Math.abs(drift) < 0.005
                        ? 'text-muted-foreground'
                        : drift > 0
                          ? 'text-positive'
                          : 'text-negative'
                    }`}
                  >
                    {formatSignedPercent(drift, 1)}
                  </span>
                </li>
              );
            })}
        </ul>
      </div>
    </ChartFrame>
  );
}

/** How weights drifted between rebalances. */
export function AllocationDrift({ result }: { result: BacktestResult }) {
  const symbols = React.useMemo(
    () => result.ledgers.filter((l) => l.endingValue > 0 || l.targetWeight > 0).map((l) => l.symbol),
    [result],
  );

  const rows = React.useMemo(
    () =>
      result.allocation.map((point) => {
        const row: Record<string, number | string> = { date: point.date };
        for (const s of symbols) row[s] = point.weights[s] ?? 0;
        return row;
      }),
    [result, symbols],
  );

  if (rows.length < 2 || symbols.length < 2) return null;

  const tickFormatter = makeDateTickFormatter(
    daysBetween(result.effectiveStart, result.effectiveEnd),
  );
  const dateTicks = makeDateTicks(rows.map((r) => String(r.date)));

  return (
    <ChartFrame
      title="Allocation drift"
      description={
        result.totals.rebalanceCount > 0
          ? `Weights between the ${result.totals.rebalanceCount} rebalances in this run.`
          : 'Weights over time. Rebalancing is off, so winners compound into a larger share.'
      }
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} stackOffset="expand">
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
              width={44}
              tickFormatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
            />
            {symbols.map((s) => (
              <Area
                key={s}
                type="monotone"
                dataKey={s}
                stackId="alloc"
                stroke={colorFor(result, s)}
                fill={colorFor(result, s)}
                fillOpacity={0.65}
                strokeWidth={0.5}
                isAnimationActive={false}
              />
            ))}
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number>;
                const total = symbols.reduce((a, s) => a + (row[s] ?? 0), 0) || 1;
                return (
                  <ChartTooltip
                    title={tooltipDate(label)}
                    rows={symbols
                      .filter((s) => (row[s] ?? 0) > 0.0005)
                      .sort((a, b) => (row[b] ?? 0) - (row[a] ?? 0))
                      .map((s) => ({
                        label: s,
                        color: colorFor(result, s),
                        value: formatPercent((row[s] ?? 0) / total, 1),
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

/** Dollar profit and loss per holding — the attribution view. */
export function ContributionChart({ result }: { result: BacktestResult }) {
  const data = React.useMemo(
    () =>
      result.ledgers
        .map((l) => ({
          name: l.symbol,
          pnl: l.profitAndLoss,
          share: l.shareOfGain,
          color: colorFor(result, l.symbol),
        }))
        .sort((a, b) => b.pnl - a.pnl),
    [result],
  );

  if (data.length < 2) return null;

  return (
    <ChartFrame
      title="Contribution to gain"
      description="Profit and loss in dollars for each holding, after its own trading costs and fund fees."
      footer={`These sum to the total investment gain of ${formatCurrency(
        result.totals.investmentGain,
      )}, together with cash interest less the portfolio management fee.`}
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
          >
            <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
            <XAxis
              type="number"
              {...AXIS_PROPS}
              tickFormatter={(v) => formatCurrency(Number(v))}
            />
            <YAxis type="category" dataKey="name" {...AXIS_PROPS} width={64} />
            <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} />
            <Bar dataKey="pnl" isAnimationActive={false} radius={[0, 2, 2, 0]}>
              {data.map((d) => (
                <Cell
                  key={d.name}
                  fill={d.pnl >= 0 ? 'hsl(var(--positive))' : 'hsl(var(--negative))'}
                />
              ))}
            </Bar>
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.4 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as (typeof data)[number];
                return (
                  <ChartTooltip
                    title={d.name}
                    rows={[
                      {
                        label: 'Profit and loss',
                        value: formatCurrency(d.pnl),
                        color: d.pnl >= 0 ? 'hsl(var(--positive))' : 'hsl(var(--negative))',
                      },
                      { label: 'Share of total gain', value: formatPercent(d.share), muted: true },
                    ]}
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
