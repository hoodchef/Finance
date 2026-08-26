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
import { CorrelationGrid } from '@/components/results/correlation-grid';
import { useJob } from '@/hooks/use-job';
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

interface CorrelatedResponse {
  simulation: {
    symbols: string[];
    paths: number;
    years: number;
    rebalanceEvery: number;
    ridge: number;
    terminal: { p5: number; p25: number; median: number; p75: number; p95: number };
    annualised: { p5: number; median: number; p95: number };
    worstDrawdown: { median: number; p95: number };
    realisedCorrelation: number[][];
    inputCorrelation: number[][];
    endingWeights: number[];
    regimeUsed: {
      stressFrequency: number;
      calmCorrelation: number;
      stressedCorrelation: number;
      realisedStressShare: number;
    } | null;
    bands: Array<{ year: number; p5: number; median: number; p95: number }>;
  };
  estimate: {
    symbols: string[];
    correlation: number[][];
    annualVolatility: number[];
    observations: number;
    shrinkage: number;
    averageCorrelation: number;
    from: string;
    to: string;
  };
  targetWeights: number[];
  regimeNote: string | null;
  glidepath: { to: number[] } | null;
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
  vector = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
  hint?: string;
  /** Accepts a separated list ("20/70/10") rather than a single number. */
  vector?: boolean;
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
            // Separators are admitted only for a vector field; letting every
            // numeric input take "20/70" would make Horizon accept nonsense.
            const ok = vector ? /^[\d./,\s]*$/ : /^-?\d*\.?\d*$/;
            if (raw !== '' && !ok.test(raw)) return;
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

  const [mode, setMode] = React.useState<'portfolio' | 'assets'>('portfolio');
  const [rebalance, setRebalance] = React.useState('annual');
  const [shrink, setShrink] = React.useState(true);
  const [regimeAware, setRegimeAware] = React.useState(true);
  const [glideTo, setGlideTo] = React.useState('');
  const correlated = useJob<CorrelatedResponse>();

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

  async function runCorrelated() {
    await correlated.start('/api/correlated', {
      portfolio: { id: draft.id, name: draft.name, positions: draft.positions },
      config,
      years: Number(years) || 30,
      paths: Number(paths) || 2000,
      initialInvestment: Number(initial) || 0,
      contributionAmount: Number(contribution) || 0,
      contributionFrequency,
      rebalance,
      shrink,
      regimeAware,
      // "60/40" or "60,40" — a weight per holding, in the order they are listed.
      glidepathTo: glideTo.trim()
        ? glideTo.split(/[\/,\s]+/).map(Number).filter((v) => Number.isFinite(v))
        : undefined,
    });
  }

  async function run() {
    if (mode === 'assets') return runCorrelated();
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
  const corr = correlated.result;
  const busy = mode === 'assets' ? correlated.status === 'queued' || correlated.status === 'running' : pending;
  const busyElapsed = mode === 'assets' ? correlated.elapsedSeconds : 0;
  const hasResult = mode === 'assets' ? Boolean(corr) : Boolean(data);
  const activeError = mode === 'assets' ? correlated.error : error;
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
          <Button onClick={run} disabled={busy}>
            {busy ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {correlated.status === 'queued' && correlated.queuePosition
                  ? `Queued #${correlated.queuePosition}`
                  : busyElapsed
                    ? `Running ${busyElapsed}s`
                    : 'Running…'}
              </>
            ) : (
              <>
                {hasResult ? <RefreshCw /> : <Play />}
                {hasResult ? 'Rerun' : 'Simulate'}
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
              <CardTitle className="text-sm">What to simulate</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={mode} onValueChange={(v) => setMode(v as 'portfolio' | 'assets')}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portfolio">The portfolio as one series</SelectItem>
                  <SelectItem value="assets">Each holding, correlated</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {mode === 'portfolio'
                  ? 'Resamples the portfolio’s own realised return. Cheap and assumption-free, but it bakes in the weights the backtest held — it cannot see the holdings, so it cannot tell you what rebalancing is worth.'
                  : 'Fits a covariance to the holdings’ joint history and simulates them together, so weights drift and rebalancing does something. Needs at least two priced holdings.'}
              </p>
              {mode === 'assets' && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Rebalance</Label>
                    <Select value={rebalance} onValueChange={setRebalance}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never — let it drift</SelectItem>
                        <SelectItem value="annual">Annually</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={shrink}
                      onChange={(e) => setShrink(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Shrink the covariance (Ledoit&ndash;Wolf). Sample correlations are biased
                      outward &mdash; the extreme ones are extreme partly by luck. Leave this on
                      unless you have decades of history for every holding.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={regimeAware}
                      onChange={(e) => setRegimeAware(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Model calm and stressed regimes separately. Correlations rise in falls, so
                      one blended covariance reports a downside that is too narrow for the reason
                      that matters most. Both regimes are measured from your own history, not
                      assumed.
                    </span>
                  </label>
                  <NumField
                    label="Glide to"
                    vector
                    value={glideTo}
                    onChange={setGlideTo}
                    placeholder="e.g. 20/70/10"
                    hint="Optional. Ending weights to drift toward across the horizon, one per holding in the order listed. Blank holds the target mix."
                  />
                </>
              )}
            </CardContent>
          </Card>

          <Card className={cn(mode === 'assets' && 'opacity-50')}>
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
          {activeError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="leading-relaxed">{activeError}</p>
            </div>
          )}

          {busy && !hasResult && <Skeleton className="h-96 w-full" />}

          {!hasResult && !busy && !activeError && (
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

          {mode === 'portfolio' && sim && data && (
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
          {mode === 'assets' && corr && (
            <>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
                <Stat
                  className="bg-card"
                  label="Median outcome"
                  value={formatCurrencyCompact(corr.simulation.terminal.median)}
                  sub={`${formatPercent(corr.simulation.annualised.median)} a year`}
                />
                <Stat
                  className="bg-card"
                  label="Poor outcome (5th)"
                  tone="negative"
                  value={formatCurrencyCompact(corr.simulation.terminal.p5)}
                  sub={`${formatPercent(corr.simulation.annualised.p5)} a year`}
                />
                <Stat
                  className="bg-card"
                  label="Good outcome (95th)"
                  tone="positive"
                  value={formatCurrencyCompact(corr.simulation.terminal.p95)}
                  sub={`${formatPercent(corr.simulation.annualised.p95)} a year`}
                />
                <Stat
                  className="bg-card"
                  label="Deepest fall"
                  tone="negative"
                  value={formatPercent(corr.simulation.worstDrawdown.median, 1)}
                  sub={`tail ${formatPercent(corr.simulation.worstDrawdown.p95, 1)}`}
                />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    How the holdings move together
                    <Badge variant="outline">
                      {corr.estimate.observations.toLocaleString()} days
                    </Badge>
                    {corr.estimate.shrinkage > 0.01 && (
                      <Badge variant="warning">
                        shrunk {formatPercent(corr.estimate.shrinkage, 0)}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <CorrelationGrid
                    symbols={corr.estimate.symbols}
                    matrix={corr.estimate.correlation}
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[26rem] text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">Holding</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Annual vol</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Target</th>
                          <th className="py-1.5 text-right font-medium">Ends at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {corr.estimate.symbols.map((sym, i) => (
                          <tr key={sym} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-3 font-medium">{sym}</td>
                            <td className="numeric py-1.5 pr-3 text-right">
                              {formatPercent(corr.estimate.annualVolatility[i], 1)}
                            </td>
                            <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                              {formatPercent(corr.targetWeights[i], 1)}
                            </td>
                            <td className="numeric py-1.5 text-right">
                              {formatPercent(corr.simulation.endingWeights[i], 1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    Estimated over{' '}
                    <span className="numeric text-foreground">
                      {corr.estimate.from} – {corr.estimate.to}
                    </span>
                    .{' '}
                    {corr.simulation.rebalanceEvery > 0
                      ? 'The gap between target and ending weight is the drift that accumulates between rebalances.'
                      : 'Nothing was rebalanced, so the ending weights are wherever compounding carried them — which is the point of running it this way.'}
                    {corr.estimate.shrinkage > 0.01 && (
                      <>
                        {' '}
                        Correlations were pulled{' '}
                        {formatPercent(corr.estimate.shrinkage, 0)} toward their average of{' '}
                        <span className="numeric text-foreground">
                          {corr.estimate.averageCorrelation.toFixed(2)}
                        </span>
                        , because {corr.estimate.symbols.length} holdings need{' '}
                        {(corr.estimate.symbols.length * (corr.estimate.symbols.length - 1)) / 2}{' '}
                        correlations estimated and the extreme ones are extreme partly by luck.
                      </>
                    )}
                    {corr.simulation.ridge > 0 && (
                      <> A small ridge was added to make the matrix factorisable; two holdings are
                      close to collinear.</>
                    )}
                  </p>

                  {corr.simulation.regimeUsed && (
                    <div className="rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed">
                      <p className="font-medium text-foreground">
                        Correlation in calm and stressed markets
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        On the calmest {formatPercent(1 - corr.simulation.regimeUsed.stressFrequency, 0)}{' '}
                        of days these holdings correlated{' '}
                        <span className="numeric text-foreground">
                          {corr.simulation.regimeUsed.calmCorrelation.toFixed(2)}
                        </span>{' '}
                        on average. On the worst{' '}
                        {formatPercent(corr.simulation.regimeUsed.stressFrequency, 0)} they
                        correlated{' '}
                        <span className="numeric text-foreground">
                          {corr.simulation.regimeUsed.stressedCorrelation.toFixed(2)}
                        </span>
                        {corr.simulation.regimeUsed.stressedCorrelation >
                        corr.simulation.regimeUsed.calmCorrelation
                          ? ' — diversification was weakest exactly when it was needed, and the simulation reproduces that rather than averaging it away.'
                          : ' — unusually, these held their independence through the falls in this window.'}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        Both regimes are measured from your own history and drawn at the frequency
                        they occurred, so the mixture still averages back to the same long-run
                        return. What changes is the shape of the downside.
                      </p>
                    </div>
                  )}

                  {corr.regimeNote && (
                    <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-2.5 text-2xs leading-relaxed">
                      <span className="font-medium">Regimes not modelled.</span>{' '}
                      <span className="text-muted-foreground">{corr.regimeNote}</span>
                    </div>
                  )}

                  {corr.glidepath && (
                    <p className="text-2xs leading-relaxed text-muted-foreground">
                      Gliding from{' '}
                      {corr.targetWeights.map((w) => formatPercent(w, 0)).join(' / ')} to{' '}
                      {corr.glidepath.to.map((w) => formatPercent(w, 0)).join(' / ')} across{' '}
                      {corr.simulation.years} years, applied at each rebalance.
                    </p>
                  )}
                </CardContent>
              </Card>

              <ChartFrame
                title="Range of outcomes"
                description="Shaded band spans the 5th to 95th percentile of simulated paths."
                footer="Dashed, and deliberately unlike the historical charts: these are modelled outcomes, not observations."
              >
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart
                    data={corr.simulation.bands.map((b) => ({
                      year: b.year,
                      band: [b.p5, b.p95] as [number, number],
                      median: b.median,
                    }))}
                    margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
                  >
                    <defs>
                      <linearGradient id="corrBand" x1="0" y1="0" x2="0" y2="1">
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
                    <Area dataKey="band" stroke="none" fill="url(#corrBand)" isAnimationActive={false} />
                    <Line
                      dataKey="median"
                      stroke="hsl(var(--chart-4))"
                      strokeWidth={2}
                      strokeDasharray="5 3"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartFrame>

              <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
                <p className="font-medium">Reading this honestly</p>
                <p className="mt-1 text-muted-foreground">
                  {corr.simulation.paths.toLocaleString()} paths over {corr.simulation.years} years,
                  drawn from a multivariate normal fitted to the joint history.{' '}
                  {corr.simulation.regimeUsed
                    ? 'Two regimes are modelled, so correlation breakdown in falls is reproduced rather than averaged away. What is still assumed is that regimes arrive independently — real stress clusters, and a run of bad months is more likely than this makes it look.'
                    : 'Correlations are held fixed for the whole horizon — real ones move, and they rise toward one in exactly the falls where diversification was supposed to help. Turn on regimes above, or treat the downside band as optimistic.'}
                </p>
              </div>
            </>
          )}
        </div>
      </PageBody>
    </>
  );
}
