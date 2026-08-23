'use client';

import type { Position } from '@/lib/types';
import { cn, seriesColor } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Stacked weight bar. Anything short of 100% shows as an explicit gap. */
export function AllocationBar({
  positions,
  className,
}: {
  positions: Position[];
  className?: string;
}) {
  const total = positions.reduce((a, p) => a + (Number(p.weight) || 0), 0);
  const scale = Math.max(total, 100);
  const filled = positions.filter((p) => (Number(p.weight) || 0) > 0);

  return (
    <div
      className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      role="img"
      aria-label={`Allocation: ${filled
        .map((p) => `${p.symbol || 'unset'} ${p.weight}%`)
        .join(', ')}. Total ${total}%.`}
    >
      {filled.map((p, i) => (
        <Tooltip key={p.id}>
          <TooltipTrigger asChild>
            <div
              className="h-full transition-[width] duration-200"
              style={{
                width: `${((Number(p.weight) || 0) / scale) * 100}%`,
                backgroundColor: seriesColor(p.symbol || String(i), i),
              }}
            />
          </TooltipTrigger>
          <TooltipContent>
            <span className="numeric font-medium">{p.symbol || 'Unset'}</span> · {p.weight}%
          </TooltipContent>
        </Tooltip>
      ))}
      {total < 100 && (
        <div
          className="h-full bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,hsl(var(--muted-foreground)/0.25)_3px,hsl(var(--muted-foreground)/0.25)_6px)]"
          style={{ width: `${((100 - total) / scale) * 100}%` }}
        />
      )}
    </div>
  );
}
