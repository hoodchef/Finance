'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

const ACCOUNT_LABELS: Record<string, string> = {
  employer_match: 'Employer match',
  fhsa: 'FHSA',
  resp: 'RESP',
  rrsp: 'RRSP',
  tfsa: 'TFSA',
  non_registered: 'Non-registered',
};

const ACCOUNT_WHY: Record<string, string> = {
  employer_match: 'Free money, and it uses the same RRSP room your own contributions do.',
  fhsa: 'Deductible going in and tax-free coming out — the only account that is both.',
  resp: 'Attracts the 20% education grant.',
  rrsp: 'Deductible now, taxed on withdrawal.',
  tfsa: 'No deduction, but nothing is taxed again — including in benefit calculations.',
  non_registered: 'No shelter. Only reached once registered room runs out.',
};

interface PlannerResponse {
  provinces?: string[];
  marginal: { statutory_rate: number; clawback_rate: number; effective_rate: number };
  allocation: {
    allocation: Record<string, number>;
    sequence: string[];
    tax_refund: number;
    benefit_restored: number;
    employer_match_earned: number;
    resp_grant_earned: number;
    warnings: string[];
  } | null;
}

/**
 * Where this year's savings should go, on the front page.
 *
 * The original CanPath opened straight into this: a few inputs, and
 * immediately an answer about which account the next dollar belongs in. That
 * flow was the product, and splitting the app into a launchpad plus a separate
 * planner buried the one thing it was for behind a click.
 *
 * Deliberately three inputs. The full Planner has a dozen — partner income,
 * children, employer match, retirement rate — and every one matters, but
 * asking for them before showing anything is what turns a useful answer into a
 * form. Province, income and monthly savings give an answer worth reading, and
 * the link goes to the rest.
 */
export function SavingsFlow({ compact = false }: { compact?: boolean }) {
  const [province, setProvince] = React.useState('BC');
  const [income, setIncome] = React.useState('95000');
  const [monthly, setMonthly] = React.useState('1500');
  const [children, setChildren] = React.useState('0');
  const [data, setData] = React.useState<PlannerResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const annualSavings = Math.max(0, (Number(monthly) || 0) * 12);

  React.useEffect(() => {
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/planner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            province,
            income: Number(income) || 0,
            partnerIncome: 0,
            // Ages drive the child benefit, and under-6 pays more. Assuming
            // school age is the conservative reading of a bare count, and it
            // is stated below rather than being a silent choice.
            childAges: Array.from({ length: Math.min(6, Number(children) || 0) }, () => 8),
            savingsCapacity: annualSavings,
            fhsaEligible: true,
            employerMatchRate: 0,
            employerMatchCap: 0,
            expectedRetirementRate: 0.25,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not compute.');
        setData(json as PlannerResponse);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not compute.');
      }
    }, 350);
    return () => window.clearTimeout(id);
  }, [province, income, annualSavings, children]);

  const alloc = data?.allocation;
  const rows = React.useMemo(() => {
    if (!alloc) return [];
    return alloc.sequence
      .map((account) => ({ account, amount: alloc.allocation[account] ?? 0 }))
      .filter((r) => r.amount > 0);
  }, [alloc]);

  const firstYearBack =
    alloc != null
      ? alloc.tax_refund +
        alloc.benefit_restored +
        alloc.employer_match_earned +
        alloc.resp_grant_earned
      : 0;

  return (
    <Card>
      <CardContent className={cn('space-y-4', compact ? 'pt-4' : 'pt-5')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Province</Label>
            <Select value={province} onValueChange={setProvince}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(data?.provinces ?? ['BC']).map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Your income</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
                $
              </span>
              <Input
                type="text"
                inputMode="numeric"
                value={income}
                onChange={(e) => /^\d*$/.test(e.target.value) && setIncome(e.target.value)}
                className="h-9 pl-5 text-xs"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Saving each month</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
                $
              </span>
              <Input
                type="text"
                inputMode="numeric"
                value={monthly}
                onChange={(e) => /^\d*$/.test(e.target.value) && setMonthly(e.target.value)}
                className="h-9 pl-5 text-xs"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Children under 18</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={children}
              onChange={(e) => /^\d*$/.test(e.target.value) && setChildren(e.target.value)}
              className="h-9 text-xs"
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {!data && !error && <Skeleton className="h-40 w-full" />}

        {data && (
          <>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {data.marginal.clawback_rate > 0.0005 ? (
                <>
                  Your bracket says{' '}
                  <span className="numeric text-foreground">
                    {formatPercent(data.marginal.statutory_rate, 1)}
                  </span>
                  , but the next dollar actually costs{' '}
                  <span className="numeric font-medium text-foreground">
                    {formatPercent(data.marginal.effective_rate, 1)}
                  </span>{' '}
                  &mdash; benefit clawback takes the other{' '}
                  <span className="numeric text-[hsl(var(--warning))]">
                    {formatPercent(data.marginal.clawback_rate, 1)}
                  </span>
                  , and it appears nowhere on a tax return.
                </>
              ) : (
                /* Saying "says X but costs X" reads as a contradiction. With no
                   income-tested benefits in play the bracket IS the answer, and
                   that is worth stating plainly rather than dressing up. */
                <>
                  The next dollar costs{' '}
                  <span className="numeric font-medium text-foreground">
                    {formatPercent(data.marginal.effective_rate, 1)}
                  </span>
                  , which here is just the bracket &mdash; no income-tested benefit is being
                  clawed back at this income.
                </>
              )}
            </div>

            {rows.length > 0 ? (
              <div>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">Where your money should go</h3>
                  <span className="text-2xs text-muted-foreground">
                    {formatCurrency(annualSavings)} a year, in the order the solver funded it
                  </span>
                </div>

                {/* The shape of the answer before the detail of it. */}
                <div className="mb-2 flex h-2 overflow-hidden rounded-full">
                  {rows.map((r, i) => (
                    <div
                      key={r.account}
                      style={{
                        width: `${(r.amount / annualSavings) * 100}%`,
                        background: `var(--series-${i % 15})`,
                      }}
                      title={`${ACCOUNT_LABELS[r.account] ?? r.account}: ${formatCurrency(r.amount)}`}
                    />
                  ))}
                </div>

                <table className="w-full text-xs">
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.account} className="border-b border-border/50 last:border-0">
                        <td className="w-6 py-1.5">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: `var(--series-${i % 15})` }}
                          />
                        </td>
                        <td className="py-1.5 pr-3 font-medium">
                          {ACCOUNT_LABELS[r.account] ?? r.account}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatCurrency(r.amount)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                          {formatPercent(r.amount / annualSavings, 0)}
                        </td>
                        <td className="hidden py-1.5 text-muted-foreground sm:table-cell">
                          {ACCOUNT_WHY[r.account] ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {firstYearBack > 0 && (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Funding it this way returns{' '}
                    <span className="numeric font-medium text-[hsl(var(--positive))]">
                      {formatCurrency(firstYearBack)}
                    </span>{' '}
                    in the first year &mdash; refund, restored benefits and grants combined.
                  </p>
                )}

                {alloc?.warnings?.slice(0, 1).map((w) => (
                  <p key={w} className="mt-1.5 text-xs leading-relaxed text-[hsl(var(--warning))]">
                    {w}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Enter an amount you can save and this will show which account each dollar belongs in.
              </p>
            )}

            {Number(children) > 0 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Children are assumed to be school age. Under-6 attracts a higher Canada Child
                Benefit, so exact ages change the clawback &mdash; set them in the Planner.
              </p>
            )}

            <Link
              href="/planner"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Partner income, children, employer match and the rest
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
