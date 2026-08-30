'use client';

import * as React from 'react';
import { Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  driftDistance,
  findHedges,
  probabilityHedgeBreaks,
  type HedgeObjective,
} from '@/lib/options/hedge';
import type { OptionLeg, OptionPosition, StockLeg } from '@/lib/options/strategy';
import { valuePosition } from '@/lib/options/strategy';

/**
 * The hedge optimiser.
 *
 * You hold something; you want it to behave differently. The table answers
 * "what do I buy" with the cost, what delta it actually leaves, and — the
 * column that stops this being misleading — how far the underlying can move
 * before the hedge stops working.
 *
 * A hedge with no gamma never drifts and says so. One with gamma gets a
 * distance and a probability of breaking, because "you are delta neutral" is
 * true for an instant and reads as though it were true for a month.
 */

const OBJECTIVES: Array<{ id: HedgeObjective; label: string }> = [
  { id: 'delta-neutral', label: 'Delta neutral' },
  { id: 'target-delta', label: 'Target a specific delta' },
  { id: 'protect-floor', label: 'Protect a floor price' },
];

export function HedgePanel({
  position,
  spot,
  asOf,
  volatility,
  expiries,
  onApply,
}: {
  position: OptionPosition;
  spot: number;
  asOf: string;
  volatility: number;
  expiries: string[];
  onApply: (legs: OptionLeg[], stock: StockLeg | null) => void;
}) {
  const [objective, setObjective] = React.useState<HedgeObjective>('delta-neutral');
  const [targetDelta, setTargetDelta] = React.useState(0);
  const [floorPrice, setFloorPrice] = React.useState(Math.round(spot * 0.9));
  const [maxContracts, setMaxContracts] = React.useState(6);
  const [maxDebit, setMaxDebit] = React.useState<number | ''>('');
  const [useStock, setUseStock] = React.useState(true);
  const [result, setResult] = React.useState<ReturnType<typeof findHedges> | null>(null);
  const [busy, setBusy] = React.useState(false);

  const currentDelta = React.useMemo(
    () => valuePosition(position, { spot, asOf }).greeks.delta,
    [position, spot, asOf],
  );

  const hasPosition = position.legs.length > 0 || position.stock != null;

  function run() {
    setBusy(true);
    window.setTimeout(() => {
      try {
        setResult(
          findHedges({
            position,
            spot,
            asOf,
            volatility,
            objective,
            targetDelta,
            floorPrice,
            instruments: useStock ? ['put', 'call', 'stock'] : ['put', 'call'],
            expiries: expiries.slice(0, 2),
            maxContracts,
            maxDebit: maxDebit === '' ? undefined : Number(maxDebit),
            multiplier: 100,
          }),
        );
      } finally {
        setBusy(false);
      }
    }, 0);
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">
              Current delta
            </div>
            <div className="numeric text-lg font-semibold">{currentDelta.toFixed(1)}</div>
            <div className="text-2xs text-muted-foreground">share-equivalent</div>
          </div>

          <div className="min-w-[13rem]">
            <label className="text-2xs text-muted-foreground">Goal</label>
            <Select value={objective} onValueChange={(v) => setObjective(v as HedgeObjective)}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {OBJECTIVES.map((o) => (
                  <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {objective === 'target-delta' && (
            <div>
              <label htmlFor="hedge-target" className="text-2xs text-muted-foreground">Target delta</label>
              <Input id="hedge-target" type="number" step={10} value={targetDelta}
                onChange={(e) => setTargetDelta(Number(e.target.value))} className="w-24 text-xs" />
            </div>
          )}

          {objective === 'protect-floor' && (
            <div>
              <label htmlFor="hedge-floor" className="text-2xs text-muted-foreground">Floor price</label>
              <Input id="hedge-floor" type="number" step={1} value={floorPrice}
                onChange={(e) => setFloorPrice(Number(e.target.value))} className="w-24 text-xs" />
            </div>
          )}

          <div>
            <label htmlFor="hedge-max" className="text-2xs text-muted-foreground">Max contracts</label>
            <Input id="hedge-max" type="number" min={1} max={30} value={maxContracts}
              onChange={(e) => setMaxContracts(Number(e.target.value))} className="w-24 text-xs" />
          </div>

          <div>
            <label htmlFor="hedge-cost" className="text-2xs text-muted-foreground">Spend at most</label>
            <Input id="hedge-cost" type="number" step={100} value={maxDebit} placeholder="any"
              onChange={(e) => setMaxDebit(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-24 text-xs" />
          </div>

          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <input type="checkbox" checked={useStock} onChange={(e) => setUseStock(e.target.checked)} />
            Allow shorting stock
          </label>

          <Button size="sm" onClick={run} disabled={busy || !hasPosition}>
            <Shield className="h-3 w-3" />
            {busy ? 'Searching…' : 'Find hedges'}
          </Button>
        </div>

        {!hasPosition && (
          <p className="text-xs text-muted-foreground">
            Add legs or stock above first — a hedge needs something to hedge.
          </p>
        )}

        {result && (
          <>
            <p className="text-2xs text-muted-foreground">
              {result.evaluated.toLocaleString()} hedges evaluated against a starting delta of{' '}
              <span className="numeric">{result.currentDelta.toFixed(1)}</span>.
            </p>

            {result.candidates.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Hedge</th>
                      <th className="py-2 pr-3 text-right font-medium">Cost</th>
                      <th className="py-2 pr-3 text-right font-medium">Delta after</th>
                      <th className="py-2 pr-3 text-right font-medium">Gamma</th>
                      <th className="py-2 pr-3 font-medium">Holds until</th>
                      <th className="py-2 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.candidates.map((c, i) => {
                      const drift = driftDistance(c.gamma, 25);
                      const breaks =
                        drift == null
                          ? null
                          : probabilityHedgeBreaks(spot, drift, volatility, 30);
                      return (
                        <tr key={`${c.label}-${i}`} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 pr-3">
                            {c.label}
                            {c.linear && (
                              <span className="ml-1.5 text-2xs text-[hsl(var(--positive))]">exact</span>
                            )}
                          </td>
                          <td className={cn('numeric py-1.5 pr-3 text-right',
                            c.cost < 0 && 'text-[hsl(var(--positive))]')}>
                            {c.cost < 0 ? `+${formatCurrency(-c.cost)}` : formatCurrency(c.cost)}
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right">{c.residualDelta.toFixed(1)}</td>
                          <td className="numeric py-1.5 pr-3 text-right">{c.gamma.toFixed(2)}</td>
                          <td className="py-1.5 pr-3 text-2xs text-muted-foreground">
                            {drift == null ? (
                              'never drifts'
                            ) : (
                              <>
                                <span className="numeric">±{formatCurrency(drift)}</span> move
                                {breaks != null && (
                                  <span> · {formatPercent(breaks, 0)} chance in 30d</span>
                                )}
                              </>
                            )}
                          </td>
                          <td className="py-1.5">
                            <Button size="sm" variant="ghost" className="h-6 text-2xs"
                              onClick={() =>
                                onApply(
                                  [...position.legs, ...c.legs],
                                  c.shares === 0
                                    ? position.stock ?? null
                                    : {
                                        side: 'buy',
                                        shares:
                                          ((position.stock?.side === 'sell' ? -1 : 1) *
                                            (position.stock?.shares ?? 0)) + c.shares,
                                        entryPrice: spot,
                                      },
                                )
                              }
                            >
                              Apply
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="space-y-1.5">
              {result.notes.map((n) => (
                <p key={n} className="rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-muted-foreground">
                  {n}
                </p>
              ))}
            </div>
          </>
        )}

        {!result && hasPosition && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Searches stock, single options and collars for the cheapest way to reach your goal,
            using whole contracts only — so the delta it actually leaves you with is shown rather
            than the delta a fractional position would have. The last column is the one to read:
            a hedge with gamma is neutral now and less so tomorrow.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
