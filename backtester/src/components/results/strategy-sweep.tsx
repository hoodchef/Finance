'use client';

import * as React from 'react';
import { Play, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrencyCompact, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { describeStrategy } from '@/lib/engine/build-strategy';
import { useWorkspace } from '@/store/workspace';
import type { BacktestResult } from '@/lib/backtest';
import type { StrategySpec } from '@/lib/types';

/**
 * The same portfolio under several strategies, side by side.
 *
 * Building a strategy is worth much less without this. On its own a rule
 * produces one number, and one number cannot answer the only question that
 * matters about it — whether it beat leaving the weights alone. Running the
 * alternatives against the identical portfolio, period and costs makes the
 * comparison a controlled one: every column differs from every other in the
 * rule and in nothing else.
 *
 * WHY THE WARNING IS NOT DECORATION
 *
 * Comparing six rules over one history and keeping the winner is the most
 * reliable way there is to fool yourself. The best of six is expected to look
 * good on the sample it was chosen on even when none of the six has any edge,
 * and the more variants added the worse that gets. The panel says so, in
 * proportion to how many were run, because a table of ranked strategies
 * invites exactly the reading it cannot support.
 */

interface Variant {
  id: string;
  label: string;
  spec: StrategySpec | undefined;
}

/**
 * The comparison set: doing nothing, whatever is configured, and the canonical
 * alternatives. Six is the server's cap, and enough — a longer list makes the
 * selection problem worse, not the answer better.
 */
function variantsFor(current: StrategySpec | undefined): Variant[] {
  const out: Variant[] = [
    { id: 'declared', label: 'Declared weights', spec: undefined },
  ];

  const currentIsFixed = !current || (current.kind === 'fixed' && !('overlays' in current));
  if (!currentIsFixed) {
    out.push({ id: 'current', label: 'Your strategy', spec: current });
  }

  const canonical: Variant[] = [
    { id: 'equal', label: 'Equal weight', spec: { kind: 'equal' } },
    {
      id: 'trend',
      label: 'Trend filter (200d)',
      spec: { kind: 'composed', base: { kind: 'fixed' }, overlays: [{ kind: 'trend', windowDays: 200 }] },
    },
    {
      id: 'minvar',
      label: 'Minimum variance',
      spec: { kind: 'minimumVariance', lookbackDays: 252, shrink: true, maxWeightPct: 60 },
    },
    {
      id: 'riskparity',
      label: 'Risk parity',
      spec: { kind: 'riskParity', lookbackDays: 252, shrink: true, maxWeightPct: 60 },
    },
    {
      id: 'voltarget',
      label: '10% volatility target',
      spec: {
        kind: 'composed',
        base: { kind: 'fixed' },
        overlays: [{ kind: 'volatilityTarget', targetVolPct: 10, lookbackDays: 63 }],
      },
    },
  ];

  for (const v of canonical) {
    if (out.length >= 6) break;
    out.push(v);
  }
  return out;
}

interface Row {
  label: string;
  description: string;
  finalValue: number;
  cagr: number;
  volatility: number;
  maxDrawdown: number;
  sharpe: number;
  isBaseline: boolean;
  isCurrent: boolean;
}

export function StrategySweep() {
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);

  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  const variants = React.useMemo(() => variantsFor(config.strategy), [config.strategy]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: variants.map((v) => ({
            portfolio: draft,
            // Identical in every respect but the rule, so the comparison is
            // controlled: same period, same costs, same contributions.
            config: { ...config, strategy: v.spec },
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'The comparison could not be run.');
        return;
      }
      const results: BacktestResult[] = body.results ?? [];
      setRows(
        results.map((r, i) => ({
          label: variants[i].label,
          description: describeStrategy(variants[i].spec),
          finalValue: r.totals.finalValue,
          cagr: r.metrics.returns.cagr,
          volatility: r.metrics.risk.volatility,
          maxDrawdown: r.metrics.risk.maxDrawdown,
          sharpe: r.metrics.ratios.sharpe,
          isBaseline: variants[i].id === 'declared',
          isCurrent: variants[i].id === 'current',
        })),
      );
    } catch {
      setError('The comparison could not be run.');
    } finally {
      setRunning(false);
    }
  }

  const baseline = rows?.find((r) => r.isBaseline) ?? null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <CardTitle className="text-sm">Compare strategies</CardTitle>
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            The same portfolio, period and costs under each rule, so the only difference between
            these rows is the rule itself.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={running} className="shrink-0">
          <Play className="h-3 w-3" />
          {running ? 'Running…' : rows ? 'Run again' : `Run ${variants.length}`}
        </Button>
      </CardHeader>

      <CardContent>
        {error && <p className="text-xs text-[hsl(var(--negative))]">{error}</p>}

        {running && !rows && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}

        {!running && !rows && !error && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Runs {variants.length} strategies against this portfolio, including doing nothing.
            Each is a full backtest; the price data is already loaded, so it costs about as long
            as the slowest one.
          </p>
        )}

        {rows && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Strategy</th>
                    <th className="py-2 pr-3 text-right font-medium">Final</th>
                    <th className="py-2 pr-3 text-right font-medium">CAGR</th>
                    <th className="py-2 pr-3 text-right font-medium">Volatility</th>
                    <th className="py-2 pr-3 text-right font-medium">Max drawdown</th>
                    <th className="py-2 text-right font-medium">Sharpe</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const better = baseline && !r.isBaseline && r.sharpe > baseline.sharpe;
                    return (
                      <tr
                        key={r.label}
                        className={cn(
                          'border-b border-border/50 last:border-0',
                          r.isCurrent && 'bg-muted/40',
                        )}
                      >
                        <td className="py-1.5 pr-3">
                          <span className={cn('block', (r.isBaseline || r.isCurrent) && 'font-medium')}>
                            {r.label}
                          </span>
                          <span className="block text-2xs text-muted-foreground">
                            {r.description}
                          </span>
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatCurrencyCompact(r.finalValue)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatPercent(r.cagr, 2)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatPercent(r.volatility, 2)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right text-[hsl(var(--negative))]">
                          {formatPercent(r.maxDrawdown, 1)}
                        </td>
                        <td
                          className={cn(
                            'numeric py-1.5 text-right',
                            better && 'font-medium text-[hsl(var(--positive))]',
                          )}
                        >
                          {r.sharpe.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="text-2xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">
                  Picking the best of these is not a result.
                </span>{' '}
                Ranking {rows.length} rules on one history and keeping the winner is how a
                strategy that has no edge comes to look like one — the best of {rows.length} flatters
                itself on the sample it was chosen on, and the more you compare the worse that
                gets. A rule is worth something if it holds up on periods you did not pick it on,
                and if you can say why it should work before you see the number.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
