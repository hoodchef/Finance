'use client';

import * as React from 'react';
import type { PeriodReturn } from '@/lib/metrics';
import { MONTH_LABELS, formatPercent, formatSignedPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ChartFrame } from './chart-chrome';

/**
 * Month-by-year heatmap. Cell intensity is scaled to the largest absolute
 * monthly move in the sample rather than a fixed range, so the contrast is
 * meaningful for both a bond fund and a leveraged ETF.
 */
export function MonthlyHeatmap({
  monthly,
  annual,
  title = 'Monthly returns',
}: {
  monthly: PeriodReturn[];
  annual: PeriodReturn[];
  title?: string;
}) {
  const { years, grid, scale } = React.useMemo(() => {
    const byYear = new Map<number, Array<PeriodReturn | undefined>>();
    let peak = 0;
    for (const m of monthly) {
      if (m.month == null) continue;
      if (!byYear.has(m.year)) byYear.set(m.year, new Array(12).fill(undefined));
      byYear.get(m.year)![m.month] = m;
      peak = Math.max(peak, Math.abs(m.return));
    }
    return {
      years: [...byYear.keys()].sort((a, b) => b - a),
      grid: byYear,
      scale: peak || 0.01,
    };
  }, [monthly]);

  const annualByYear = React.useMemo(
    () => new Map(annual.map((a) => [a.year, a])),
    [annual],
  );

  const summary = React.useMemo(() => {
    const rs = monthly.map((m) => m.return);
    if (!rs.length) return null;
    const sorted = [...rs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return {
      average: rs.reduce((a, b) => a + b, 0) / rs.length,
      median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
      positive: rs.filter((r) => r > 0).length / rs.length,
      best: Math.max(...rs),
      worst: Math.min(...rs),
      count: rs.length,
    };
  }, [monthly]);

  if (!years.length) return null;

  return (
    <ChartFrame
      title={title}
      description="Each cell is that month's time-weighted return. Shading is relative to the largest move in this backtest."
      footer={
        summary && (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              Average <span className="numeric text-foreground">{formatSignedPercent(summary.average)}</span>
            </span>
            <span>
              Median <span className="numeric text-foreground">{formatSignedPercent(summary.median)}</span>
            </span>
            <span>
              Positive{' '}
              <span className="numeric text-foreground">
                {formatPercent(summary.positive, 0)} of {summary.count}
              </span>
            </span>
            <span>
              Best <span className="numeric text-positive">{formatSignedPercent(summary.best)}</span>
            </span>
            <span>
              Worst <span className="numeric text-negative">{formatSignedPercent(summary.worst)}</span>
            </span>
          </div>
        )
      }
    >
      <div className="overflow-x-auto px-3 pb-1">
        <table className="w-full min-w-[46rem] border-separate border-spacing-0.5 text-2xs">
          <caption className="sr-only">
            Monthly returns by year, with the calendar-year total in the final column.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-12 px-1 text-left font-semibold text-muted-foreground">
                Year
              </th>
              {MONTH_LABELS.map((m) => (
                <th key={m} scope="col" className="px-1 text-center font-semibold text-muted-foreground">
                  {m}
                </th>
              ))}
              <th scope="col" className="w-16 px-1 text-right font-semibold text-muted-foreground">
                Year
              </th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const months = grid.get(year)!;
              const total = annualByYear.get(year);
              return (
                <tr key={year}>
                  <th scope="row" className="numeric px-1 text-left font-medium">
                    {year}
                  </th>
                  {months.map((m, i) => (
                    <td key={i} className="p-0">
                      {m ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className="numeric flex h-7 cursor-default items-center justify-center rounded-sm text-[10px] font-medium tabular-nums"
                              style={cellStyle(m.return, scale)}
                            >
                              {(m.return * 100).toFixed(1)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="font-medium">
                              {MONTH_LABELS[i]} {year}
                            </div>
                            <div className="numeric">{formatSignedPercent(m.return)}</div>
                            <div className="mt-1 text-muted-foreground">
                              {m.startDate} → {m.endDate}
                              {m.partial && ' · partial month'}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <div className="h-7 rounded-sm bg-muted/40" />
                      )}
                    </td>
                  ))}
                  <td className="p-0">
                    <div
                      className={cn(
                        'numeric flex h-7 items-center justify-end rounded-sm px-1.5 text-[10px] font-semibold',
                        total && total.return >= 0 ? 'text-positive' : 'text-negative',
                      )}
                    >
                      {total ? `${(total.return * 100).toFixed(1)}%` : '—'}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}

function cellStyle(value: number, scale: number): React.CSSProperties {
  const intensity = Math.min(1, Math.abs(value) / scale);
  // Keep a floor so a near-zero month is still a visible tile, not a hole.
  const alpha = 0.1 + intensity * 0.75;
  const hue = value >= 0 ? 'var(--positive)' : 'var(--negative)';
  return {
    backgroundColor: `hsl(${hue} / ${alpha})`,
    color: intensity > 0.55 ? 'hsl(var(--background))' : 'hsl(var(--foreground))',
  };
}
