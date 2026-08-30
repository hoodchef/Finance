'use client';

import type { BacktestResult } from '@/lib/backtest';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTip, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Pairwise correlation heatmap.
 *
 * The colour scale runs from −1 to +1 through a neutral midpoint, so a
 * genuinely diversifying pair reads as visually different from a redundant one
 * at a glance rather than requiring the number to be read.
 */
export function CorrelationPanel({ result }: { result: BacktestResult }) {
  const m = result.correlation;
  if (!m || m.symbols.length < 2) return null;

  const totalDays = Math.max(...m.overlap.map((row) => Math.max(...row)));
  const thin = m.overlap.some((row, i) =>
    row.some((v, j) => i !== j && v > 0 && v < totalDays * 0.5),
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Correlation
          <InfoTip label="About correlation">
            How closely two holdings moved together day to day. +1.00 means they moved in lockstep
            and provide no diversification against each other; 0.00 means their moves were
            unrelated; negative means one tended to rise when the other fell. Computed on daily
            returns over the days both actually traded.
          </InfoTip>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Daily returns, {m.start && formatDate(m.start)} → {m.end && formatDate(m.end)}. Average
          pairwise correlation{' '}
          <span className="numeric font-medium text-foreground">
            {formatNumber(m.averageCorrelation)}
          </span>
          .
        </p>
      </CardHeader>

      <CardContent className="space-y-3 overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-2xs">
          <caption className="sr-only">
            Correlation of daily returns between each pair of holdings.
          </caption>
          <thead>
            <tr>
              <th className="px-1" />
              {m.symbols.map((s) => (
                <th
                  key={s}
                  scope="col"
                  className="numeric px-1 pb-1 text-center font-semibold text-muted-foreground"
                >
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.symbols.map((rowSymbol, i) => (
              <tr key={rowSymbol}>
                <th
                  scope="row"
                  className="numeric whitespace-nowrap px-1 text-right font-semibold text-muted-foreground"
                >
                  {rowSymbol}
                </th>
                {m.symbols.map((colSymbol, j) => {
                  const v = m.values[i][j];
                  const isDiagonal = i === j;
                  return (
                    <td key={colSymbol} className="p-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(
                              'numeric flex h-8 w-14 cursor-default items-center justify-center rounded-sm text-[10px] font-medium',
                              isDiagonal && 'opacity-45',
                            )}
                            style={cellStyle(v)}
                          >
                            {Number.isFinite(v) ? v.toFixed(2) : '—'}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="font-medium">
                            {rowSymbol} vs {colSymbol}
                          </div>
                          {isDiagonal ? (
                            <div className="mt-0.5 text-muted-foreground">
                              Annualised volatility {formatPercent(m.volatility[i])}
                            </div>
                          ) : (
                            <>
                              <div className="numeric">{formatNumber(v)}</div>
                              <div className="mt-0.5 text-muted-foreground">
                                {m.overlap[i][j].toLocaleString()} overlapping days
                              </div>
                            </>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-6 rounded-sm" style={cellStyle(-1)} />
            −1.00 moves oppositely
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-6 rounded-sm" style={cellStyle(0)} />
            0.00 unrelated
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-6 rounded-sm" style={cellStyle(1)} />
            +1.00 moves together
          </span>
        </div>

        {thin && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Some pairs overlap for far fewer days than others, because a holding listed later or
            stopped trading. Hover a cell for its observation count — a coefficient from a short
            overlap is not comparable with one from the full period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function cellStyle(v: number): React.CSSProperties {
  if (!Number.isFinite(v)) {
    return { backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' };
  }
  const magnitude = Math.min(1, Math.abs(v));
  const alpha = 0.08 + magnitude * 0.72;
  // Positive correlation is the thing to worry about in a portfolio, so it
  // takes the warning-coloured end of the scale.
  const hue = v >= 0 ? 'var(--negative)' : 'var(--positive)';
  return {
    backgroundColor: `hsl(${hue} / ${alpha})`,
    color: magnitude > 0.55 ? 'hsl(var(--background))' : 'hsl(var(--foreground))',
  };
}
