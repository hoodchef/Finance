'use client';

import * as React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Play, RefreshCw, Waves } from 'lucide-react';
import type { MonteCarloResult, SimMethod } from '@/lib/analysis/montecarlo';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AXIS_PROPS, ChartFrame, GRID_PROPS } from '@/components/charts/chart-chrome';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '@/lib/format';
import { useWorkspace } from '@/store/workspace';
import { cn } from '@/lib/utils';

interface Response {
  simulation: MonteCarloResult;
  historical: {
    start: string;
    end: string;
    cagr: number;
    volatility: number;
    maxDrawdown: number;
    observations: number;
  };
}

const METHOD_LABEL: Record<SimMethod, string> = {
  block: 'Block bootstrap',
  iid: 'Independent days',
  normal: 'Lognormal',
  'student-t': 'Student-t',
};

const METHOD_NOTE: Record<SimMethod, string> = {
  block:
    'Resamples contiguous stretches of this portfolio’s own history, so turbulent days stay together. Assumes no distribution and cannot produce a day the record does not contain.',
  iid: 'Resamples individual real days independently. Breaks up volatility clustering, which understates drawdowns in a way that looks reassuring.',
  normal:
    'Draws from a fitted lognormal. Tractable and standard, and it understates the frequency of extreme days — markets have fatter tails than this.',
  'student-t':
    'Draws from a Student-t standardised to the same volatility, so fat tails redistribute risk rather than adding it. Most visible over short horizons.',
};

/** A labelled number field that tolerates being mid-typed. */
function NumField({
  label,
  value,
  onChange,
  suffix,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="relative">
        <Input
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw !== '' && !/^-?\d*\.?\d*$/.test(raw)) return;
            onChange(raw);
          }}
          className={cn('h-8 text-xs', suffix && 'pr-6')}
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
 * The simulation workspace.
 *
 * Built around one discipline: every number on screen is labelled with where it
 * came from. A fan chart drawn from assumed parameters looks exactly like one
 * drawn from measured history, and the difference is the whole question.
 */
export function SimulatorView() {
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);

  const [method, setMethod] = React.useState<SimMethod>('block');
  const [years, setYears] = React.useState('30');
  const [paths, setPaths] = React.useState('2000');
  const [expectedReturn, setExpectedReturn] = React.useState('');
  const [volatility, setVolatility] = React.useState('');
  const [degreesOfFreedom, setDegreesOfFreedom] = React.useState('5');
  const [inflation, setInflation] = React.useState('2.5');
  const [initial, setInitial] = React.useState(String(config.initialInvestment ?? 10000));
  const [contribution, setContribution] = React.useState('0');
  const [contributionFrequency, setContributionFrequency] = React.useState('annual');
  const [withdrawal, setWithdrawal] = React.useState('0');
  const [withdrawalFrequency, setWithdrawalFrequency] = React.useState('annual');

  const [data, setData] = React.useState<Response | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const pct = (v: string): number | null => (v.trim() === '' ? null : Number(v) / 100);

  async function run() {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          portfolio: { id: draft.id, name: draft.name, positions: draft.positions },
          config,
          method,
          years: Number(years) || 30,
          paths: Number(paths) || 2000,
          initialInvestment: Number(initial) || 0,
          contributionAmount: Number(contribution) || 0,
          contributionFrequency,
          withdrawalAmount: Number(withdrawal) || 0,
          withdrawalFrequency,
          expectedReturn: pct(expectedReturn),
          volatility: pct(volatility),
          degreesOfFreedom: Number(degreesOfFreedom) || 5,
          inflation: (Number(inflation) || 0) / 100,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Simulation failed.');
      if (!ac.signal.aborted) setData(json as Response);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Simulation failed.');
    } finally {
      if (!ac.signal.aborted) setPending(false);
    }
  }

  React.useEffect(() => () => controller.current?.abort(), []);

  const sim = data?.simulation;
  const parametric = method === 'normal' || method === 'student-t';
  const withdrawing = (Number(withdrawal) || 0) > 0;

  const chartData = React.useMemo(
    () =>
      sim?.bands.map((b) => ({
        year: b.year,
        lower: b.p5,
        mid: [b.p25, b.p75] as [number, number],
        band: [b.p5, b.p95] as [number, number],
        median: b.median,
        contributed: b.contributed,
      })) ?? [],
    [sim],
  );

  return (
    <>
      <PageHeader
        title="Simulator"
        description="Take this portfolio's measured behaviour forward, or replace any part of it with an assumption and see what that costs."
        actions={
          <Button onClick={run} disabled={pending}>
            {pending ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Running…
              </>
            ) : (
              <>
                {data ? <RefreshCw /> : <Play />}
                {data ? 'Rerun' : 'Simulate'}
              </>
            )}
          </Button>
        }
      />

      <PageBody className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        {/* ---- controls ---- */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Method</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={method} onValueChange={(v) => setMethod(v as SimMethod)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(METHOD_LABEL) as SimMethod[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-2xs leading-relaxed text-muted-foreground">{METHOD_NOTE[method]}</p>
              <div className="grid grid-cols-2 gap-2">
                <NumField label="Horizon" value={years} onChange={setYears} suffix="yr" />
                <NumField label="Paths" value={paths} onChange={setPaths} />
              </div>
              {method === 'student-t' && (
                <NumField
                  label="Degrees of freedom"
                  value={degreesOfFreedom}
                  onChange={setDegreesOfFreedom}
                  hint="Lower is fatter-tailed. Below 3 the variance is undefined."
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Assumptions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <NumField
                label="Expected return"
                value={expectedReturn}
                onChange={setExpectedReturn}
                suffix="%"
                placeholder="from history"
                hint={
                  parametric
                    ? 'Annual, arithmetic. Blank measures it from the backtest.'
                    : 'Bootstraps take their mean from the sample; this is ignored.'
                }
              />
              <NumField
                label="Volatility"
                value={volatility}
                onChange={setVolatility}
                suffix="%"
                placeholder="from history"
                hint={parametric ? 'Annual standard deviation.' : 'Ignored by bootstraps.'}
              />
              <NumField label="Inflation" value={inflation} onChange={setInflation} suffix="%" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Cash flows</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <NumField label="Starting balance" value={initial} onChange={setInitial} suffix="$" />
              <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <NumField label="Contribution" value={contribution} onChange={setContribution} suffix="$" />
                <Select value={contributionFrequency} onValueChange={setContributionFrequency}>
                  <SelectTrigger className="h-8 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="annual">Annual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <NumField
                  label="Withdrawal"
                  value={withdrawal}
                  onChange={setWithdrawal}
                  suffix="$"
                  hint="In today's dollars. Grows with inflation."
                />
                <Select value={withdrawalFrequency} onValueChange={setWithdrawalFrequency}>
                  <SelectTrigger className="h-8 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="annual">Annual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ---- results ---- */}
        <div className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="leading-relaxed">{error}</p>
            </div>
          )}

          {pending && !sim && <Skeleton className="h-96 w-full" />}

          {!sim && !pending && !error && (
            <Card>
              <CardContent>
                <EmptyState
                  icon={Waves}
                  title="Nothing simulated yet"
                  description="This runs a real backtest of the loaded portfolio first, then takes its behaviour forward. Nothing is shown until it has — a fan chart drawn from assumed parameters is indistinguishable from a real one."
                  className="border-0 py-16"
                />
              </CardContent>
            </Card>
          )}

          {sim && data && (
            <>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
                <Stat
                  className="bg-card"
                  label="Median outcome"
                  value={formatCurrencyCompact(sim.terminal.median)}
                  sub={`${formatCurrencyCompact(sim.terminalReal.median)} in today's dollars`}
                />
                <Stat
                  className="bg-card"
                  label="Poor outcome (5th)"
                  tone="negative"
                  value={formatCurrencyCompact(sim.terminal.p5)}
                  sub={`${formatPercent(sim.annualised.p5)} a year`}
                />
                <Stat
                  className="bg-card"
                  label="Good outcome (95th)"
                  tone="positive"
                  value={formatCurrencyCompact(sim.terminal.p95)}
                  sub={`${formatPercent(sim.annualised.p95)} a year`}
                />
                {withdrawing ? (
                  <Stat
                    className="bg-card"
                    label="Money lasts"
                    tone={sim.successRate > 0.9 ? 'positive' : 'negative'}
                    value={formatPercent(sim.successRate, 1)}
                    sub={
                      sim.medianRuinYear
                        ? `failures run dry around year ${sim.medianRuinYear.toFixed(0)}`
                        : 'no path ran dry'
                    }
                  />
                ) : (
                  <Stat
                    className="bg-card"
                    label="Deepest fall"
                    tone="negative"
                    value={formatPercent(sim.worstDrawdown.median, 1)}
                    sub={`tail ${formatPercent(sim.worstDrawdown.p95, 1)}`}
                  />
                )}
              </div>

              {/* Where every parameter came from. */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    What this ran on
                    <Badge variant={parametric ? 'warning' : 'outline'}>
                      {parametric ? 'Modelled' : 'Resampled'}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[30rem] text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">Parameter</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Used</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Measured</th>
                          <th className="py-1.5 font-medium">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-border/50">
                          <td className="py-1.5 pr-3">
                            Return
                            <span className="ml-1 text-2xs text-muted-foreground">arithmetic</span>
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right">
                            {formatPercent(sim.parameters.expectedReturn)}
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                            {sim.parameters.expectedReturnSource === 'history'
                              ? formatPercent(sim.parameters.expectedReturn)
                              : '—'}
                          </td>
                          <td className="py-1.5">
                            <Badge
                              variant={
                                sim.parameters.expectedReturnSource === 'assumed'
                                  ? 'warning'
                                  : 'outline'
                              }
                            >
                              {sim.parameters.expectedReturnSource}
                            </Badge>
                          </td>
                        </tr>
                        <tr className="border-b border-border/50">
                          <td className="py-1.5 pr-3">Volatility</td>
                          <td className="numeric py-1.5 pr-3 text-right">
                            {formatPercent(sim.parameters.volatility)}
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                            {formatPercent(data.historical.volatility)}
                          </td>
                          <td className="py-1.5">
                            <Badge
                              variant={
                                sim.parameters.volatilitySource === 'assumed' ? 'warning' : 'outline'
                              }
                            >
                              {sim.parameters.volatilitySource}
                            </Badge>
                          </td>
                        </tr>
                        <tr className="border-b border-border/50">
                          <td className="py-1.5 pr-3">
                            Compound growth
                            <span className="ml-1 text-2xs text-muted-foreground">geometric</span>
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">—</td>
                          <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                            {formatPercent(data.historical.cagr)}
                          </td>
                          <td className="py-1.5">
                            <Badge variant="outline">history</Badge>
                          </td>
                        </tr>
                        <tr>
                          <td className="py-1.5 pr-3">Inflation</td>
                          <td className="numeric py-1.5 pr-3 text-right">
                            {formatPercent(sim.parameters.inflation)}
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">—</td>
                          <td className="py-1.5">
                            <Badge variant="warning">assumed</Badge>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    The arithmetic mean sits above the compound growth rate by roughly half the
                    variance &mdash; about{' '}
                    <span className="numeric text-foreground">
                      {formatPercent((sim.parameters.volatility * sim.parameters.volatility) / 2)}
                    </span>{' '}
                    at this volatility. That gap is volatility drag, not an error and not an
                    optimistic thumb on the scale: a simulation compounds period by period, so it
                    is the arithmetic mean it must be given.
                  </p>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    Grounded in a real backtest over{' '}
                    <span className="numeric text-foreground">
                      {data.historical.start} – {data.historical.end}
                    </span>{' '}
                    ({data.historical.observations.toLocaleString()} observations).{' '}
                    {parametric
                      ? 'A fitted distribution can produce days the record does not contain — which is the point, and the risk.'
                      : 'A resampling inherits that period entirely: its inflation, its rates, its valuations. It cannot produce a decade the sample does not contain.'}
                  </p>
                </CardContent>
              </Card>

              <ChartFrame
                title="Range of outcomes"
                description="Shaded bands span the 5th to 95th percentile; the inner band is the 25th to 75th."
                footer="Dashed, and deliberately unlike the historical charts: these are modelled outcomes, not observations."
              >
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                    <defs>
                      <linearGradient id="simBand" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--chart-4))" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="hsl(var(--chart-4))" stopOpacity={0.06} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis
                      {...AXIS_PROPS}
                      dataKey="year"
                      tickFormatter={(v) => `${v}y`}
                      type="number"
                      domain={[0, 'dataMax']}
                    />
                    <YAxis {...AXIS_PROPS} tickFormatter={(v) => formatCurrencyCompact(Number(v))} />
                    <Area
                      dataKey="band"
                      stroke="none"
                      fill="url(#simBand)"
                      isAnimationActive={false}
                    />
                    <Area
                      dataKey="mid"
                      stroke="none"
                      fill="hsl(var(--chart-4))"
                      fillOpacity={0.18}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="median"
                      stroke="hsl(var(--chart-4))"
                      strokeWidth={2}
                      strokeDasharray="5 3"
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="contributed"
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      dot={false}
                      isAnimationActive={false}
                    />
                    {withdrawing && <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeDasharray="3 3" />}
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartFrame>

              <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
                <p className="font-medium">Reading this honestly</p>
                <p className="mt-1 text-muted-foreground">
                  {sim.paths.toLocaleString()} paths over {sim.years} years.{' '}
                  {sim.parameters.expectedReturnSource === 'assumed' ||
                  sim.parameters.volatilitySource === 'assumed'
                    ? 'At least one parameter here is an assertion, not a measurement — compare the columns above. '
                    : 'Every parameter was measured from this portfolio’s own record. '}
                  A median is the middle of what was simulated, not a forecast, and nothing here is
                  a floor: a worse ordering than any sampled remains possible.
                </p>
                {parametric && (
                  <p className="mt-1.5 text-muted-foreground">
                    Parametric draws are independent, so volatility clustering is absent. Over long
                    horizons the central limit theorem pulls the outcome distribution toward normal
                    whatever the per-day shape — which is why fat tails move short horizons far more
                    than long ones, and why block resampling remains the better default for a
                    decades-long question.
                  </p>
                )}
                {withdrawing && (
                  <p className="mt-1.5 text-muted-foreground">
                    Withdrawals are stated in today&rsquo;s dollars and grown at{' '}
                    {formatPercent(sim.parameters.inflation)} a year. Success means the balance
                    never reached zero — it says nothing about how close it came, and a plan that
                    survives on a knife edge is not the same as one that survives comfortably.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </PageBody>
    </>
  );
}
