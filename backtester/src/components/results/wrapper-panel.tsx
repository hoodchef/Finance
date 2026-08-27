'use client';

import * as React from 'react';
import { Landmark } from 'lucide-react';
import { compareAccounts } from '@/lib/canpath/accounts-growth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Which account wrapper this money belongs in.
 *
 * The point where the two halves of the product meet: the effective marginal
 * rate comes from the Planner, the growth factor from a real backtest, and the
 * answer is what you actually keep.
 *
 * The honest finding is that the growth factor CANCELS. Which wrapper wins
 * depends only on whether your rate later is below your rate now, and this
 * panel says so rather than letting a backtest imply it changed the answer.
 * A tool that made this look portfolio-dependent would be telling people
 * something false about their own decision.
 */
export function WrapperPanel({
  contribution,
  growthFactor,
  rateNow,
  rateLater,
  growthLabel,
}: {
  contribution: number;
  growthFactor: number;
  rateNow: number;
  rateLater: number;
  /** Where the growth factor came from, so it is never mistaken for a forecast. */
  growthLabel: string;
}) {
  const result = React.useMemo(() => {
    try {
      return compareAccounts({ contribution, growthFactor, rateNow, rateLater });
    } catch {
      return null;
    }
  }, [contribution, growthFactor, rateNow, rateLater]);

  if (!result) return null;

  const best = result.outcomes.reduce((a, b) => (b.netValue > a.netValue ? b : a));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Landmark className="h-4 w-4" />
          Which account keeps more
          <Badge variant="outline">2026 rates</Badge>
        </CardTitle>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          The same {formatCurrency(contribution)} out of pocket, grown at the rate this portfolio
          actually achieved, under each wrapper.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Account</th>
                <th className="py-2 pr-3 text-right font-medium">Goes in</th>
                <th className="py-2 pr-3 text-right font-medium">Grows to</th>
                <th className="py-2 pr-3 text-right font-medium">Tax out</th>
                <th className="py-2 text-right font-medium">You keep</th>
              </tr>
            </thead>
            <tbody>
              {result.outcomes.map((o) => (
                <tr key={o.account} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 font-medium">
                    {o.account}
                    {o.account === best.account && (
                      <span className="ml-1.5 text-2xs font-normal text-[hsl(var(--positive))]">
                        best
                      </span>
                    )}
                  </td>
                  <td className="numeric py-2 pr-3 text-right">{formatCurrency(o.contributed)}</td>
                  <td className="numeric py-2 pr-3 text-right">{formatCurrency(o.grossValue)}</td>
                  <td className="numeric py-2 pr-3 text-right text-muted-foreground">
                    {o.taxOnWithdrawal > 0 ? `−${formatCurrency(o.taxOnWithdrawal)}` : '—'}
                  </td>
                  <td
                    className={cn(
                      'numeric py-2 text-right font-medium',
                      o.account === best.account && 'text-[hsl(var(--positive))]',
                    )}
                  >
                    {formatCurrency(o.netValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <p className="text-muted-foreground">
            {result.effectivelyEqual ? (
              <>
                <span className="font-medium text-foreground">
                  At the same rate now and later, the RRSP and the TFSA tie exactly.
                </span>{' '}
                Not approximately — the deduction going in and the tax coming out cancel.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">
                  The RRSP keeps {formatPercent(Math.abs(result.rrspAdvantage - 1), 1)}{' '}
                  {result.rrspAdvantage > 1 ? 'more' : 'less'} than the TFSA here
                </span>{' '}
                — because your rate later ({formatPercent(rateLater, 1)}) is{' '}
                {rateLater < rateNow ? 'below' : 'above'} your rate now (
                {formatPercent(rateNow, 1)}).
              </>
            )}
          </p>
          <p className="mt-1.5 text-muted-foreground">
            <span className="font-medium text-foreground">The growth rate cancels.</span> Every
            wrapper compounds the same money at the same rate, so which one wins turns entirely on
            those two rates — a better portfolio does not change the answer, it only changes how
            much is at stake. The figures above use {growthLabel}.
          </p>
        </div>

        <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
          <p className="font-medium">A taxable account is missing, deliberately</p>
          <p className="mt-1 text-muted-foreground">{result.taxableAccountBlocked}</p>
        </div>
      </CardContent>
    </Card>
  );
}
