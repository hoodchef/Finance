'use client';

import { Plus, Trash2 } from 'lucide-react';
import type { CashflowLeg } from '@/lib/types';
import { describeLeg } from '@/lib/engine/cashflows';
import { useWorkspace } from '@/store/workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InfoTip } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Additional cashflow legs.
 *
 * The simple contribution above covers "save the same amount every month". This
 * covers everything else: a lump sum at a point in time, a withdrawal that
 * starts once saving stops, a percentage drawdown rule. Each leg states itself
 * in a sentence underneath, because the combination of offset, duration and
 * growth is easy to set up wrongly and hard to spot from the fields alone.
 */
/**
 * A stable reference for the empty case. Returning a fresh `[]` from a zustand
 * selector makes every reference check fail, which re-renders, which selects
 * again — an infinite loop that blanks the page rather than erroring visibly.
 */
const NO_LEGS: CashflowLeg[] = [];

export function CashflowLegs() {
  // The fallback is applied outside the selector, so the selector itself
  // returns a stable value.
  const legs = useWorkspace((s) => s.config.cashflows) ?? NO_LEGS;
  const inflationOn = useWorkspace((s) => s.config.inflation.mode !== 'off');
  const addCashflow = useWorkspace((s) => s.addCashflow);
  const updateCashflow = useWorkspace((s) => s.updateCashflow);
  const removeCashflow = useWorkspace((s) => s.removeCashflow);

  return (
    <div className="space-y-2.5">
      {legs.map((leg, i) => (
        <LegEditor
          key={leg.id}
          leg={leg}
          index={i}
          inflationOn={inflationOn}
          onChange={(patch) => updateCashflow(leg.id, patch)}
          onRemove={() => removeCashflow(leg.id)}
        />
      ))}

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={addCashflow}
        disabled={legs.length >= 8}
      >
        <Plus />
        {legs.length ? 'Add another cashflow' : 'Add a cashflow'}
      </Button>

      {legs.length === 0 && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          For a lump sum at a future date, a withdrawal that begins after saving stops, or a
          percentage drawdown rule.
        </p>
      )}
    </div>
  );
}

function LegEditor({
  leg,
  index,
  inflationOn,
  onChange,
  onRemove,
}: {
  leg: CashflowLeg;
  index: number;
  inflationOn: boolean;
  onChange: (patch: Partial<CashflowLeg>) => void;
  onRemove: () => void;
}) {
  const isPercent = leg.kind === 'percentOfPortfolio';
  const id = (field: string) => `leg-${leg.id}-${field}`;

  return (
    <div className="space-y-2 rounded-md border border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cashflow {index + 1}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove cashflow ${index + 1}`}
          onClick={onRemove}
          className="text-muted-foreground hover:text-negative"
        >
          <Trash2 />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={id('amount')}>{isPercent ? 'Percent' : 'Amount'}</Label>
          <div className="relative">
            {!isPercent && (
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
                $
              </span>
            )}
            <Input
              id={id('amount')}
              type="number"
              step={isPercent ? '0.1' : '100'}
              value={leg.amount}
              onChange={(e) => onChange({ amount: Number(e.target.value) })}
              className={isPercent ? 'text-xs' : 'pl-5 text-xs'}
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label htmlFor={id('kind')}>Type</Label>
            <InfoTip label="About cashflow type">
              A fixed amount can be grown by a rate or by inflation. A percentage is taken from the
              balance on the day it fires, so it shrinks as the portfolio does — which is how a
              percentage drawdown rule actually behaves.
            </InfoTip>
          </div>
          <Select
            value={leg.kind}
            onValueChange={(v) => onChange({ kind: v as CashflowLeg['kind'] })}
          >
            <SelectTrigger id={id('kind')} className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">Fixed amount</SelectItem>
              <SelectItem value="percentOfPortfolio">% of balance</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor={id('freq')}>Frequency</Label>
          <Select
            value={leg.frequency}
            onValueChange={(v) => onChange({ frequency: v as CashflowLeg['frequency'] })}
          >
            <SelectTrigger id={id('freq')} className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">One time</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="semiannual">Semi-annually</SelectItem>
              <SelectItem value="annual">Annually</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label htmlFor={id('offset')}>Starts after</Label>
            <InfoTip label="About the offset">
              Months from the start of the backtest before the first occurrence. Use it to begin a
              withdrawal at retirement.
            </InfoTip>
          </div>
          <div className="relative">
            <Input
              id={id('offset')}
              type="number"
              min="0"
              step="1"
              value={leg.offsetMonths}
              onChange={(e) => onChange({ offsetMonths: Number(e.target.value) })}
              className="pr-8 text-xs"
            />
            <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
              mo
            </span>
          </div>
        </div>

        {leg.frequency !== 'once' && (
          <>
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <Label htmlFor={id('duration')}>Runs for</Label>
                <InfoTip label="About duration">
                  Leave blank to run to the end of the backtest.
                </InfoTip>
              </div>
              <div className="relative">
                <Input
                  id={id('duration')}
                  type="number"
                  min="1"
                  step="1"
                  placeholder="to the end"
                  value={leg.durationMonths ?? ''}
                  onChange={(e) =>
                    onChange({
                      durationMonths: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="pr-8 text-xs"
                />
                <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
                  mo
                </span>
              </div>
            </div>

            {!isPercent && (
              <div className="space-y-1">
                <Label htmlFor={id('growth')}>Grows by</Label>
                <div className="relative">
                  <Input
                    id={id('growth')}
                    type="number"
                    step="0.5"
                    value={leg.annualGrowthPct}
                    onChange={(e) => onChange({ annualGrowthPct: Number(e.target.value) })}
                    className="pr-10 text-xs"
                  />
                  <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
                    %/yr
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {inflationOn && !isPercent && (
        <label className="flex cursor-pointer items-center gap-2 text-2xs">
          <input
            type="checkbox"
            checked={leg.adjustForInflation}
            onChange={(e) => onChange({ adjustForInflation: e.target.checked })}
            className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
          />
          Also grow with inflation
        </label>
      )}

      <p className="border-t border-border pt-2 text-2xs leading-relaxed text-muted-foreground">
        {describeLeg(leg)}
      </p>
    </div>
  );
}
