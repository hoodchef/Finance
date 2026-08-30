'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
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
import { optimise, type Candidate, type Objective, type ShapeId } from '@/lib/options/optimise';
import type { OptionLeg } from '@/lib/options/strategy';

/**
 * The optimiser, and the comparison that falls out of it.
 *
 * The result table is the side-by-side comparison: every row is a complete
 * structure with its cost, bounds, probability and Greeks, over identical
 * assumptions. Comparing structures that were priced on different assumptions
 * would rank the assumptions rather than the structures.
 *
 * The drift control is the important one and it is deliberately prominent.
 * With it left at the risk-free rate the optimiser is searching a world where
 * nothing has an edge, and it says so rather than presenting a winner.
 */

const OBJECTIVES: Array<{ id: Objective; label: string }> = [
  { id: 'max-probability-of-profit', label: 'Maximise probability of profit' },
  { id: 'max-expected-value', label: 'Maximise expected value' },
  { id: 'max-theta', label: 'Maximise theta' },
  { id: 'min-max-loss', label: 'Minimise maximum loss' },
  { id: 'max-risk-adjusted', label: 'Maximise risk-adjusted return' },
  { id: 'min-capital', label: 'Minimise capital required' },
  { id: 'target-delta', label: 'Target a delta' },
  { id: 'target-probability', label: 'Target a probability of profit' },
];

const SHAPES: Array<{ id: ShapeId; label: string }> = [
  { id: 'bull-call-spread', label: 'Bull call' },
  { id: 'bear-call-spread', label: 'Bear call' },
  { id: 'bull-put-spread', label: 'Bull put' },
  { id: 'bear-put-spread', label: 'Bear put' },
  { id: 'iron-condor', label: 'Iron condor' },
  { id: 'butterfly', label: 'Butterfly' },
  { id: 'straddle', label: 'Straddle' },
  { id: 'strangle', label: 'Strangle' },
  { id: 'long-call', label: 'Long call' },
  { id: 'long-put', label: 'Long put' },
  { id: 'short-put', label: 'Short put' },
];

export function OptimiserPanel({
  underlying,
  spot,
  asOf,
  expiries,
  pricingVolatility,
  riskFreeRate,
  dividendYield,
  onApply,
}: {
  underlying: string;
  spot: number;
  asOf: string;
  expiries: string[];
  pricingVolatility: number;
  riskFreeRate: number;
  dividendYield: number;
  onApply: (legs: OptionLeg[]) => void;
}) {
  const [objective, setObjective] = React.useState<Objective>('max-probability-of-profit');
  const [shapes, setShapes] = React.useState<ShapeId[]>([
    'bull-put-spread',
    'bear-call-spread',
    'iron-condor',
  ]);
  const [driftPct, setDriftPct] = React.useState(Math.round(riskFreeRate * 1000) / 10);
  const [evalVolPct, setEvalVolPct] = React.useState(Math.round(pricingVolatility * 1000) / 10);
  const [maxLoss, setMaxLoss] = React.useState<number | ''>('');
  const [minPop, setMinPop] = React.useState<number | ''>('');
  const [result, setResult] = React.useState<ReturnType<typeof optimise> | null>(null);
  const [busy, setBusy] = React.useState(false);

  function run() {
    setBusy(true);
    // Synchronous but heavy; yields once so the button can show its state.
    window.setTimeout(() => {
      try {
        setResult(
          optimise({
            underlying,
            spot,
            asOf,
            riskFreeRate,
            dividendYield,
            pricingVolatility,
            evaluation: { drift: driftPct / 100, volatility: Math.max(0.01, evalVolPct / 100) },
            expiries: expiries.slice(0, 3),
            shapes,
            objective,
            constraints: {
              maxLoss: maxLoss === '' ? undefined : Number(maxLoss),
              minProbabilityOfProfit: minPop === '' ? undefined : Number(minPop) / 100,
              targetDelta: 0,
              targetProbability: 0.7,
            },
            contracts: 1,
            multiplier: 100,
            maxCandidates: 4000,
          }),
        );
      } finally {
        setBusy(false);
      }
    }, 0);
  }

  const toggleShape = (id: ShapeId) =>
    setShapes((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="text-2xs text-muted-foreground">Objective</label>
            <Select value={objective} onValueChange={(v) => setObjective(v as Objective)}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {OBJECTIVES.map((o) => (
                  <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="opt-drift" className="text-2xs text-muted-foreground">
              Your expected drift
            </label>
            <div className="flex items-center gap-1">
              <Input id="opt-drift" type="number" step={1} value={driftPct}
                onChange={(e) => setDriftPct(Number(e.target.value))} className="w-20 text-xs" />
              <span className="text-2xs text-muted-foreground">%/yr</span>
            </div>
          </div>
          <div>
            <label htmlFor="opt-evol" className="text-2xs text-muted-foreground">
              Your expected volatility
            </label>
            <div className="flex items-center gap-1">
              <Input id="opt-evol" type="number" step={1} value={evalVolPct}
                onChange={(e) => setEvalVolPct(Number(e.target.value))} className="w-20 text-xs" />
              <span className="text-2xs text-muted-foreground">%</span>
            </div>
          </div>
          <div>
            <label htmlFor="opt-maxloss" className="text-2xs text-muted-foreground">Max loss ≤</label>
            <Input id="opt-maxloss" type="number" step={100} value={maxLoss}
              placeholder="any"
              onChange={(e) => setMaxLoss(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-24 text-xs" />
          </div>
          <div>
            <label htmlFor="opt-minpop" className="text-2xs text-muted-foreground">Min PoP %</label>
            <Input id="opt-minpop" type="number" step={5} value={minPop}
              placeholder="any"
              onChange={(e) => setMinPop(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-24 text-xs" />
          </div>
          <Button size="sm" onClick={run} disabled={busy || !shapes.length}>
            <Search className="h-3 w-3" />
            {busy ? 'Searching…' : 'Search'}
          </Button>
        </div>

        <div>
          <p className="mb-1 text-2xs text-muted-foreground">Structures to search</p>
          <div className="flex flex-wrap gap-1.5">
            {SHAPES.map((s) => {
              const on = shapes.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleShape(s.id)}
                  className={
                    on
                      ? 'rounded border border-primary bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-foreground'
                      : 'rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {result && (
          <>
            <p className="text-2xs text-muted-foreground">
              {result.evaluated.toLocaleString()} structures evaluated, {result.feasible.toLocaleString()}{' '}
              met the constraints.
            </p>

            {result.candidates.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Structure</th>
                      <th className="py-2 pr-3 text-right font-medium">Cost</th>
                      <th className="py-2 pr-3 text-right font-medium">Max profit</th>
                      <th className="py-2 pr-3 text-right font-medium">Max loss</th>
                      <th className="py-2 pr-3 text-right font-medium">PoP</th>
                      <th className="py-2 pr-3 text-right font-medium">Exp. value</th>
                      <th className="py-2 pr-3 text-right font-medium">Capital</th>
                      <th className="py-2 pr-3 text-right font-medium">Delta</th>
                      <th className="py-2 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.candidates.map((c: Candidate, i) => (
                      <tr key={`${c.label}-${i}`} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-3">{c.label}</td>
                        <td className={cn('numeric py-1.5 pr-3 text-right',
                          c.netDebit < 0 && 'text-[hsl(var(--positive))]')}>
                          {c.netDebit < 0 ? `+${formatCurrency(-c.netDebit)}` : formatCurrency(c.netDebit)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {c.maxProfit == null ? '∞' : formatCurrency(c.maxProfit)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right text-[hsl(var(--negative))]">
                          {c.maxLoss == null ? 'UNLIMITED' : formatCurrency(c.maxLoss)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatPercent(c.probabilityOfProfit, 1)}
                        </td>
                        <td className={cn('numeric py-1.5 pr-3 text-right',
                          c.expectedValue >= 0 ? 'text-[hsl(var(--positive))]' : 'text-[hsl(var(--negative))]')}>
                          {formatCurrency(c.expectedValue)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">{formatCurrency(c.capital)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{c.delta.toFixed(1)}</td>
                        <td className="py-1.5">
                          <Button size="sm" variant="ghost" className="h-6 text-2xs"
                            onClick={() => onApply(c.legs)}>
                            Load
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="space-y-1.5">
              {result.notes.map((n) => (
                <p key={n} className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                  {n}
                </p>
              ))}
            </div>
          </>
        )}

        {!result && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Searches strike and expiry combinations for the structures you tick, scores each one,
            and returns a shortlist. Candidates are priced from the model; the drift and
            volatility above are <em>your</em> view, and they are what decides whether a structure
            is worth more than it costs. Leave them at the pricing assumptions and every expected
            value will be zero — correctly, because under the pricing model nothing has an edge.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
