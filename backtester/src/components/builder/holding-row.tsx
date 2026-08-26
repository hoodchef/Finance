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

/**
 * Percentage fields are `type="text"`, not `type="number"`.
 *
 * A number input reports `value` as an empty string for anything it cannot
 * parse, and a half-typed decimal is one of those: typing "0." reads back as
 * "", so a controlled field wipes what was just typed and the next keystroke
 * turns "0.2" into "2". Text plus `inputMode="decimal"` keeps the mobile
 * numeric keypad while letting the raw string through intact; the guard below
 * does the job `type="number"` was there for.
 *
 * Losing the spinner arrows is deliberate — nudging an allocation by 0.1 was
 * never how these get filled in.
 */
const PARTIAL_DECIMAL = /^\d*\.?\d*$/;

/** True for anything that is, or could still become, a non-negative decimal. */
export function isPartialDecimal(raw: string): boolean {
  return raw === '' || PARTIAL_DECIMAL.test(raw);
}

/** The number a partial entry represents, or null while it is still just "." */
export function parsePartialDecimal(raw: string): number | null {
  if (raw === '' || raw === '.') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Holds what the user is typing, or null when the field is not being edited.
 *
 * A new row starts at weight 0, which rendered as a literal "0" rather than a
 * placeholder — so typing 10 into it produced "010". Showing '' for zero fixes
 * that, but on its own it fights the user mid-decimal, hence the buffer: while
 * focused the raw string wins, and on blur the committed number formats itself.
 */
function useDecimalDraft() {
  return React.useState<string | null>(null);
}

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

  const [weightDraft, setWeightDraft] = useDecimalDraft();
  const [expenseDraft, setExpenseDraft] = useDecimalDraft();

  const weightShown =
    weightDraft ??
    (Number.isFinite(position.weight) && position.weight !== 0 ? String(position.weight) : '');
  const expenseShown = expenseDraft ?? (position.expenseRatio ?? '').toString();

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
          type="text"
          inputMode="decimal"
          aria-label={`Weight for ${position.symbol || `holding ${index + 1}`} in percent`}
          placeholder="0"
          value={weightShown}
          onChange={(e) => {
            const raw = e.target.value;
            if (!isPartialDecimal(raw)) return;
            setWeightDraft(raw);
            onChange({ weight: parsePartialDecimal(raw) ?? 0 });
          }}
          onBlur={() => setWeightDraft(null)}
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
          type="text"
          inputMode="decimal"
          disabled={isCash}
          aria-label={`Expense ratio for ${position.symbol || `holding ${index + 1}`} in percent per year`}
          placeholder="—"
          value={expenseShown}
          onChange={(e) => {
            const raw = e.target.value;
            if (!isPartialDecimal(raw)) return;
            setExpenseDraft(raw);
            // Blank clears the override rather than asserting a 0% fee.
            onChange({ expenseRatio: raw === '' ? undefined : (parsePartialDecimal(raw) ?? undefined) });
          }}
          onBlur={() => setExpenseDraft(null)}
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
