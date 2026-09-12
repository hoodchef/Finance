'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { Unit } from '@/lib/valuation/asts/inputs';
import { fromDisplay, toDisplay, unitValue } from './format';

/**
 * One editable model input, shown in its display unit (percent rows as 4.84,
 * not 0.0484) and committed on Enter or blur — never on every keystroke, so a
 * half-typed "0." is not fed to the engine as zero. Escape reverts.
 *
 * A value that differs from the delivered model is marked, and says what the
 * delivered value was: an edited model must never pass for the reviewed one.
 */
export function ParamInput({
  value,
  delivered,
  unit,
  onCommit,
  integer = false,
  min,
  max,
  label,
  className,
}: {
  value: number;
  delivered: number;
  unit: Unit;
  onCommit: (v: number) => void;
  integer?: boolean;
  min?: number;
  max?: number;
  label: string;
  className?: string;
}) {
  const shown = React.useCallback((v: number) => {
    const d = toDisplay(v, unit);
    return String(Number(d.toPrecision(10)));
  }, [unit]);
  const [text, setText] = React.useState(() => shown(value));
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(shown(value));
  }, [value, focused, shown]);

  const parsed = Number(text);
  const model = fromDisplay(parsed, unit);
  const invalid =
    text.trim() === '' ||
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    (min != null && model < min) ||
    (max != null && model > max);
  const changed = value !== delivered;

  const commit = () => {
    if (!invalid && model !== value) onCommit(model);
    else if (invalid) setText(shown(value));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={changed ? `Delivered model: ${unitValue(delivered, unit)}` : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(shown(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={cn(
        'numeric h-7 w-20 rounded border border-border bg-background px-1.5 text-right text-xs outline-none',
        'focus:border-ring focus:ring-1 focus:ring-ring',
        changed && 'border-[hsl(var(--warning))] bg-[hsl(var(--warning))]/10',
        invalid && focused && 'border-negative',
        className,
      )}
    />
  );
}

/** Bounds per input: wide enough for any defensible view, tight enough that the engine stays defined. */
export function boundsFor(key: string, unit: Unit): { integer: boolean; min?: number; max?: number } {
  const integer = unit === 'yr' || unit === '#' || key === 'sat_life' || key === 'bonus_dep';
  switch (key) {
    case 'sat_life': return { integer, min: 3, max: 15 };
    case 'bonus_dep': return { integer, min: 0, max: 1 };
    case 'loss_rate': return { integer, min: 0, max: 0.9 };
    case 'prob': case 't1_share': case 'cip_credit': case 'nol_limit': case 'blume_w':
      return { integer, min: 0, max: 1 };
    case 'ramp': return { integer, min: 0.5, max: 30 };
    case 'cl_unwind_yrs': return { integer, min: 1, max: 30 };
    case 'wacc_shift': return { integer, min: -0.05, max: 0.1 };
  }
  if (unit === 'yr') return { integer, min: 2020, max: 2060 };
  if (unit === '#') return { integer, min: 0 };
  if (unit === '%') return { integer, min: -0.99, max: 5 };
  if (unit === '$/mo' || unit === 'mm' || unit === '$mm/yr') return { integer, min: 0 };
  return { integer };
}
