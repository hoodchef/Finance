'use client';

import * as React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacktestResult } from '@/lib/backtest';
import type { RollingSeries } from '@/lib/metrics';
import { formatDate, formatPercent, formatSignedPercent } from '@/lib/format';
import { Button } from '@/components/ui/button';
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
import { InfoTip } from '@/components/ui/tooltip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AXIS_PROPS,
  ChartFrame,
  ChartTooltip,
  GRID_PROPS,
  makeDateTickFormatter,
  makeDateTicks,
  tooltipDate,
} from './chart-chrome';
import { cn } from '@/lib/utils';

/**
 * Every overlapping holding period of a given length, plotted by its start
 * date. It answers "how much did the outcome depend on when I happened to
 * start?", which a single CAGR cannot.
 */
export function RollingChart({ result }: { result: BacktestResult }) {
  const available = result.rolling;
  const [selected, setSelected] = React.useState<number | null>(null);

  const active = React.useMemo(() => {
    if (!available.length) return null;
    const preferred = selected ?? (available.find((r) => r.years === 5) ?? available[0]).years;
    return available.find((r) => r.years === preferred) ?? available[0];
  }, [available, selected]);

  if (!active) return null;

  const rows = active.points.map((p) => ({
    date: p.startDate,
    annualised: p.annualised,
    endDate: p.endDate,
    volatility: p.volatility,
    maxDrawdown: p.maxDrawdown,
  }));

  const dateTicks = makeDateTicks(rows.map((r) => r.date));
  const spanDays =
    (Date.parse(`${rows[rows.length - 1].date}T00:00:00Z`) -
      Date.parse(`${rows[0].date}T00:00:00Z`)) /
    86_400_000;
  const tickFormatter = makeDateTickFormatter(spanDays);
  const s = active.summary;

  return (
    <ChartFrame
      title={`Rolling ${active.years}-year returns`}
      description={`Every ${active.years}-year holding period in this backtest, plotted by its start date. ${s.count.toLocaleString()} overlapping windows.`}
      actions={
        <div className="flex flex-wrap gap-1">
          {available.map((r) => (
            <Button
              key={r.years}
              size="sm"
              variant={r.years === active.years ? 'default' : 'outline'}
              onClick={() => setSelected(r.years)}
              className="h-7 px-2.5 text-xs"
            >
              {r.years}Y
            </Button>
          ))}
        </div>
      }
      footer={
        <span>
          Windows overlap, so these observations are not independent. The spread describes what
          history did; it is not a confidence interval for what comes next.
        </span>
      }
    >
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="rolling-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.22} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
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
              tickFormatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--negative))" strokeOpacity={0.5} />
            <ReferenceLine
              y={s.median}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              label={{
                value: `median ${formatPercent(s.median, 1)}`,
                position: 'insideTopRight',
                fill: 'hsl(var(--muted-foreground))',
                fontSize: 10,
              }}
            />
            <Area
              type="monotone"
              dataKey="annualised"
              stroke="none"
              fill="url(#rolling-fill)"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="annualised"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }}
              content={({ active: on, payload, label }) => {
                if (!on || !payload?.length) return null;
                const row = payload[0].payload as (typeof rows)[number];
                return (
                  <ChartTooltip
                    title={`${tooltipDate(label)} → ${formatDate(row.endDate)}`}
                    rows={[
                      {
                        label: 'Annualised',
                        value: formatSignedPercent(row.annualised),
                        color: 'hsl(var(--primary))',
                      },
                      { label: 'Volatility', value: formatPercent(row.volatility), muted: true },
                      ...(row.maxDrawdown != null && row.maxDrawdown < 0
                        ? [
                            {
                              label: 'Worst drawdown',
                              value: formatPercent(row.maxDrawdown),
                              muted: true,
                            },
                          ]
                        : []),
                    ]}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

/** Distribution of outcomes across every window length. */
export function RollingTable({ result }: { result: BacktestResult }) {
  if (!result.rolling.length) return null;

  const cols: Array<{ key: keyof RollingSeries['summary']; label: string }> = [
    { key: 'min', label: 'Worst' },
    { key: 'p5', label: '5th' },
    { key: 'p25', label: '25th' },
    { key: 'median', label: 'Median' },
    { key: 'p75', label: '75th' },
    { key: 'p95', label: '95th' },
    { key: 'max', label: 'Best' },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Holding-period outcomes
          <InfoTip label="About holding-period outcomes">
            Each row takes every possible start date for a holding period of that length and reports
            the distribution of annualised results. The gap between the 5th and 95th percentile is
            how much the outcome depended on timing.
          </InfoTip>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Annualised return by holding-period length, across every overlapping window.
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <NumHead>Windows</NumHead>
              {cols.map((c) => (
                <NumHead key={c.key}>{c.label}</NumHead>
              ))}
              <NumHead>
                <span className="inline-flex items-center gap-1">
                  Loss rate
                  <InfoTip label="About loss rate">
                    Share of start dates that ended below where they began. It is the plainest
                    statement of how often holding for this long lost money.
                  </InfoTip>
                </span>
              </NumHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rolling.map((r) => (
              <TableRow key={r.years}>
                <TableCell className="whitespace-nowrap text-xs font-medium">
                  {r.years} year{r.years === 1 ? '' : 's'}
                </TableCell>
                <NumCell className="text-xs text-muted-foreground">
                  {r.summary.count.toLocaleString()}
                </NumCell>
                {cols.map((c) => {
                  const v = r.summary[c.key] as number;
                  return (
                    <NumCell
                      key={c.key}
                      className={cn(
                        'text-xs',
                        c.key === 'median' && 'font-semibold',
                        v < 0 ? 'text-negative' : 'text-positive',
                      )}
                    >
                      {formatSignedPercent(v, 1)}
                    </NumCell>
                  );
                })}
                <NumCell
                  className={cn(
                    'text-xs',
                    r.summary.negativeRate > 0 ? 'text-negative' : 'text-muted-foreground',
                  )}
                >
                  {formatPercent(r.summary.negativeRate, 0)}
                </NumCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {(() => {
            const longest = result.rolling[result.rolling.length - 1];
            const w = longest.summary.worstWindow;
            const b = longest.summary.bestWindow;
            if (!w || !b) return null;
            return `Over ${longest.years} years, the weakest start date (${formatDate(
              w.startDate,
            )}) annualised ${formatSignedPercent(w.annualised, 1)} and the strongest (${formatDate(
              b.startDate,
            )}) annualised ${formatSignedPercent(b.annualised, 1)}.`;
          })()}
        </p>
      </CardContent>
    </Card>
  );
}
