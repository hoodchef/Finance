'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Correlation heat map for an arbitrary symbol/matrix pair.
 *
 * Distinct from `CorrelationPanel`, which renders the correlation computed
 * inside a BacktestResult. This one takes a bare matrix, because the simulator
 * shows the ESTIMATE it is about to simulate from — which is not the same
 * object and, once shrinkage is applied, not the same numbers either.
 *
 * Diverging rather than sequential: the sign is the first thing a reader needs,
 * and a single-hue ramp makes -0.1 and +0.1 look like neighbours on a scale
 * rather than opposites.
 */
function cellStyle(v: number): React.CSSProperties {
  const magnitude = Math.min(1, Math.abs(v));
  const hue = v >= 0 ? 'var(--chart-1)' : 'var(--chart-3)';
  return { backgroundColor: `hsl(${hue} / ${0.08 + magnitude * 0.55})` };
}

export function CorrelationGrid({
  symbols,
  matrix,
  className,
}: {
  symbols: string[];
  matrix: number[][];
  className?: string;
}) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="min-w-max border-separate border-spacing-0.5 text-2xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-1.5 py-1 text-left font-medium text-muted-foreground">
              &nbsp;
            </th>
            {symbols.map((s) => (
              <th key={s} className="px-1.5 py-1 font-medium text-muted-foreground">
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {symbols.map((rowSym, i) => (
            <tr key={rowSym}>
              <th className="sticky left-0 z-10 bg-card px-1.5 py-1 text-left font-medium">
                {rowSym}
              </th>
              {symbols.map((colSym, j) => {
                const v = matrix[i]?.[j] ?? 0;
                return (
                  <td
                    key={colSym}
                    style={i === j ? undefined : cellStyle(v)}
                    className={cn(
                      'numeric rounded px-1.5 py-1 text-center tabular-nums',
                      i === j && 'bg-muted text-muted-foreground',
                    )}
                    title={`${rowSym} / ${colSym}: ${v.toFixed(3)}`}
                  >
                    {i === j ? '—' : v.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
