'use client';

import * as React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react';
import type { Position } from '@/lib/types';
import { CASH_SYMBOL } from '@/lib/types';
import { lookupCatalog } from '@/lib/market-data/catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn, seriesColor } from '@/lib/utils';

export function HoldingRow({
  position,
  index,
  onChange,
  onRemove,
}: {
  position: Position;
  index: number;
  onChange: (patch: Partial<Position>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: position.id,
  });

  const catalogName = position.name ?? lookupCatalog(position.symbol)?.name;
  const isCash = position.symbol.toUpperCase() === CASH_SYMBOL;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-transparent px-1 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)_4.75rem_4.75rem_auto]',
        'hover:border-border hover:bg-muted/40',
        isDragging && 'z-10 border-border bg-card opacity-90 shadow-lg',
      )}
    >
      <button
        type="button"
        aria-label={`Reorder ${position.symbol || 'holding'}`}
        className="flex h-7 w-5 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="h-5 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: seriesColor(position.symbol || position.id, index) }}
        />
        <div className="min-w-0">
          <input
            aria-label={`Ticker for holding ${index + 1}`}
            value={position.symbol}
            onChange={(e) => onChange({ symbol: e.target.value.toUpperCase(), name: undefined })}
            placeholder="TICKER"
            spellCheck={false}
            className="numeric w-full bg-transparent text-sm font-medium uppercase outline-none placeholder:font-normal placeholder:normal-case placeholder:text-muted-foreground/60 focus-visible:underline focus-visible:decoration-primary focus-visible:underline-offset-4"
          />
          <div className="truncate text-2xs text-muted-foreground">
            {catalogName ?? (position.symbol ? 'Resolved when the backtest runs' : 'No ticker set')}
          </div>
        </div>
      </div>

      <div className="relative col-start-2 sm:col-start-3">
        {/* The column headers are desktop-only, so each field names itself
            below `sm` — otherwise two identical "%" boxes stack unlabelled. */}
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground sm:hidden">
          Weight
        </span>
        <Input
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          aria-label={`Weight for ${position.symbol || `holding ${index + 1}`} in percent`}
          value={Number.isFinite(position.weight) ? position.weight : ''}
          onChange={(e) => onChange({ weight: e.target.value === '' ? 0 : Number(e.target.value) })}
          className="h-8 w-full min-w-0 pl-16 pr-5 text-right text-xs sm:pl-2"
        />
        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
          %
        </span>
      </div>

      <div className="relative col-start-2 sm:col-start-4">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground sm:hidden">
          Expense ratio
        </span>
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          disabled={isCash}
          aria-label={`Expense ratio for ${position.symbol || `holding ${index + 1}`} in percent per year`}
          placeholder="—"
          value={position.expenseRatio ?? ''}
          onChange={(e) =>
            onChange({ expenseRatio: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          className="h-8 w-full min-w-0 pl-24 pr-5 text-right text-xs sm:pl-2"
        />
        <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
          %
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${position.symbol || `holding ${index + 1}`}`}
        onClick={onRemove}
        className="text-muted-foreground transition-opacity hover:text-negative focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <Trash2 />
      </Button>
    </div>
  );
}
