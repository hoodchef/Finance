'use client';

import * as React from 'react';
import { AlertCircle, Hourglass } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { formatCurrency, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Response {
  readiness: {
    years_to_retirement: number;
    cpp_annual: number;
    cpp_start_age: number;
    oas_annual: number;
    oas_gross: number;
    oas_recovery_tax: number;
    government_annual: number;
    income_gap: number;
    nest_egg_needed: number;
    projected_real: number;
    required_monthly: number;
    monthly_shortfall: number;
    on_track: boolean;
    coverage: number;
  };
  cppByAge: Array<{ age: number; annual: number; breakevenAgainst65: number | null }>;
  oas: { gross: number; clawbackStarts: number; fullyRecoveredAt: number; recoveryAtTarget: number };
  waiting: Array<{
    delay_years: number;
    cost: number;
    contributions_skipped: number;
    lost_per_dollar_skipped: number;
  }>;
}

function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return;
            onChange(raw);
          }}
          className={cn('h-8 text-xs', prefix && 'pl-5', suffix && 'pr-7')}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      {hint && <p className="text-2xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Retirement, with the government benefits included.
 *
 * The CanPath engine has modelled CPP and OAS since it was ported and nothing
 * called it. Two of the decisions here are among the largest a Canadian
 * retiree makes and neither is obvious from a tax return:
 *
 * When to start CPP has no right answer, only a breakeven age — taking it
 * early is not a mistake if you do not reach it. So the table lays out every
 * start age with the age at which waiting overtakes, rather than recommending
 * one.
 *
 * The OAS recovery tax takes fifteen cents of every dollar above a threshold
 * and appears nowhere until it happens. It is shown as the income range it
 * operates over, so a retiree can see where they sit relative to the edge.
 */
export function RetirementView() {
  const [currentAge, setCurrentAge] = React.useState('40');
  const [retirementAge, setRetirementAge] = React.useState('65');
  const [currentSavings, setCurrentSavings] = React.useState('150000');
  const [monthlyContribution, setMonthlyContribution] = React.useState('1500');
  const [targetIncome, setTargetIncome] = React.useState('70000');
  const [annualRate, setAnnualRate] = React.useState('6');
  const [cppStartAge, setCppStartAge] = React.useState('65');

  const [data, setData] = React.useState<Response | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    const id = window.setTimeout(async () => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch('/api/retirement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentAge: Number(currentAge),
            retirementAge: Number(retirementAge),
            currentSavings: Number(currentSavings),
            monthlyContribution: Number(monthlyContribution),
            targetIncome: Number(targetIncome),
            annualRate: (Number(annualRate) || 0) / 100,
            cppStartAge: Number(cppStartAge),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not project that.');
        setData(json as Response);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not project that.');
      } finally {
        setPending(false);
      }
    }, 350);
    return () => window.clearTimeout(id);
  }, [currentAge, retirementAge, currentSavings, monthlyContribution, targetIncome, annualRate, cppStartAge]);

  const r = data?.readiness;

  return (
    <>
      <PageHeader
        title="Retirement"
        description="What CPP and OAS will actually pay, what the portfolio has to cover, and what waiting costs."
      />

      <PageBody className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Your situation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Age now" value={currentAge} onChange={setCurrentAge} />
              <Field label="Retire at" value={retirementAge} onChange={setRetirementAge} />
            </div>
            <Field label="Saved so far" value={currentSavings} onChange={setCurrentSavings} prefix="$" />
            <Field
              label="Saving each month"
              value={monthlyContribution}
              onChange={setMonthlyContribution}
              prefix="$"
            />
            <Field
              label="Income you want"
              value={targetIncome}
              onChange={setTargetIncome}
              prefix="$"
              hint="In today's dollars, before tax."
            />
            <Field label="Expected return" value={annualRate} onChange={setAnnualRate} suffix="%" />
            <Field
              label="Start CPP at"
              value={cppStartAge}
              onChange={setCppStartAge}
              hint="Between 60 and 70. The table opposite shows what each choice pays."
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="leading-relaxed">{error}</p>
            </div>
          )}

          {!r && !error && <Skeleton className="h-64 w-full" />}

          {r && (
            <>
              <div
                className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4',
                  pending && 'opacity-60',
                  r.on_track ? 'border-border' : 'border-[hsl(var(--warning))]/40')}
              >
                <Stat
                  className="bg-card"
                  label="Government pays"
                  value={formatCurrency(r.government_annual)}
                  sub={`CPP ${formatCurrency(r.cpp_annual)} + OAS ${formatCurrency(r.oas_annual)}`}
                  hint="Before tax, in today's dollars. This is the part you do not have to save for."
                />
                <Stat
                  className="bg-card"
                  label="Portfolio must cover"
                  value={formatCurrency(r.income_gap)}
                  sub={`needs ${formatCurrency(r.nest_egg_needed)} saved`}
                />
                <Stat
                  className="bg-card"
                  label="On track for"
                  tone={r.on_track ? 'positive' : 'negative'}
                  value={formatCurrency(r.projected_real)}
                  sub={`${formatPercent(r.coverage, 0)} of what is needed`}
                />
                <Stat
                  className="bg-card"
                  label={r.on_track ? 'Room to spare' : 'Short by'}
                  tone={r.on_track ? 'positive' : 'negative'}
                  value={`${formatCurrency(Math.abs(r.monthly_shortfall))}/mo`}
                  sub={`${formatCurrency(r.required_monthly)}/mo would do it`}
                />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    When to start CPP
                    <Badge variant="outline">no right answer</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[26rem] text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">Start at</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Pays each year</th>
                          <th className="py-1.5 pr-3 text-right font-medium">vs starting at 65</th>
                          <th className="py-1.5 font-medium">Overtakes 65 at age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.cppByAge.map((c) => {
                          const base = data.cppByAge.find((x) => x.age === 65)!.annual;
                          const diff = c.annual - base;
                          return (
                            <tr
                              key={c.age}
                              className={cn(
                                'border-b border-border/50 last:border-0',
                                String(c.age) === cppStartAge && 'bg-primary/8 font-medium',
                              )}
                            >
                              <td className="py-1.5 pr-3">{c.age}</td>
                              <td className="numeric py-1.5 pr-3 text-right">
                                {formatCurrency(c.annual)}
                              </td>
                              <td
                                className={cn(
                                  'numeric py-1.5 pr-3 text-right',
                                  diff > 0 && 'text-[hsl(var(--positive))]',
                                  diff < 0 && 'text-[hsl(var(--negative))]',
                                )}
                              >
                                {c.age === 65 ? '—' : `${diff > 0 ? '+' : ''}${formatCurrency(diff)}`}
                              </td>
                              <td className="numeric py-1.5 text-muted-foreground">
                                {c.breakevenAgainst65 ? c.breakevenAgainst65.toFixed(1) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    Waiting pays more per year and fewer years. The overtake column is the age at
                    which the larger cheque catches up on total dollars received &mdash; before
                    that, starting earlier is ahead. Taking CPP early is not a mistake if you do
                    not reach the breakeven, and no table can tell you whether you will.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">The OAS clawback</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <p className="leading-relaxed text-muted-foreground">
                    Above{' '}
                    <span className="numeric text-foreground">
                      {formatCurrency(data.oas.clawbackStarts)}
                    </span>{' '}
                    of net income, the recovery tax takes 15 cents of every additional dollar of
                    OAS back. By{' '}
                    <span className="numeric text-foreground">
                      {formatCurrency(data.oas.fullyRecoveredAt)}
                    </span>{' '}
                    it has taken all {formatCurrency(data.oas.gross)} of it.
                  </p>
                  <p className="leading-relaxed text-muted-foreground">
                    At the {formatCurrency(Number(targetIncome) || 0)} you asked for, it would take{' '}
                    <span className="numeric text-foreground">
                      {formatCurrency(data.oas.recoveryAtTarget)}
                    </span>
                    . It is a marginal rate on top of your marginal rate, and it appears nowhere on
                    a return.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">What waiting costs</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[26rem] text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">Start later by</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Contributions skipped</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Final value lost</th>
                          <th className="py-1.5 text-right font-medium">Per $1 skipped</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.waiting.map((w) => (
                          <tr key={w.delay_years} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-3">
                              {w.delay_years} year{w.delay_years === 1 ? '' : 's'}
                            </td>
                            <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                              {formatCurrency(w.contributions_skipped)}
                            </td>
                            <td className="numeric py-1.5 pr-3 text-right text-[hsl(var(--negative))]">
                              {formatCurrency(w.cost)}
                            </td>
                            <td className="numeric py-1.5 text-right font-medium">
                              ${w.lost_per_dollar_skipped.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    The last column is the point: a dollar not saved early costs several dollars at
                    retirement, and the multiple shrinks the longer you leave it &mdash; which is
                    the argument for starting, not for having started.
                  </p>
                </CardContent>
              </Card>

              <div className="rounded-md border border-border bg-muted/40 p-3 text-2xs leading-relaxed text-muted-foreground">
                CPP and OAS figures are 2026 parameters from Canada.ca, carried from CanPath&rsquo;s
                Python reference and replayed against its fixtures on every build. CPP uses the
                average payment rather than the maximum, since most people do not reach the
                maximum. This is a calculation, not advice.
              </div>
            </>
          )}
        </div>
      </PageBody>
    </>
  );
}
