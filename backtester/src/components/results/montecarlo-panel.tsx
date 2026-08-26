'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Dices, Play, RefreshCw } from 'lucide-react';
import type { BacktestConfig, Portfolio } from '@/lib/types';
import type { MonteCarloResult } from '@/lib/analysis/montecarlo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { InfoTip } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AXIS_PROPS, ChartFrame, ChartTooltip, GRID_PROPS } from '@/components/charts/chart-chrome';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Response {
  simulation: MonteCarloResult;
  historical: { start: string; end: string; cagr: number; volatility: number; maxDrawdown: number };
}

/**
 * Simulated results are rendered deliberately unlike historical ones — dashed
 * bounds, a distinct palette, and a standing caveat. A fan chart that looked
 * like a backtest would invite it to be read as one, and the two are entirely
 * different kinds of evidence.
 */
export function MonteCarloPanel({
  portfolio,
  config,
}: {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
}) {
  const [years, setYears] = React.useState(20);
  const [method, setMethod] = React.useState<'block' | 'iid'>('block');
  const [data, setData] = React.useState<Response | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  async function run() {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/montecarlo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolio, config, years, method, paths: 1000 }),
        signal: ac.signal,
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

  // A resampling's median IS its sample's realised return, reshuffled. Reading
  // it as a forecast is the single most likely misuse of this panel, and the
  // two conditions below are when that misreading does the most damage.
  const sampleCagr = data?.historical.cagr ?? null;
  // Reusing the same days many times over is not the same as observing that
  // many independent years, however tight the resulting bands look.
  const reuse = sim && sim.sampleYears > 0 ? sim.years / sim.sampleYears : 0;
  const horizonStrained = reuse > 1.5;
  // Past ~25%/yr, compounding over decades leaves the plausible entirely.
  const extremeSample = sampleCagr != null && Math.abs(sampleCagr) > 0.25;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Dices className="h-4 w-4" />
              Monte Carlo
              <Badge variant="warning">Simulated</Badge>
            </CardTitle>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Replays this portfolio&rsquo;s own historical days in thousands of different orders.
              It answers how much the <em>sequence</em> of returns mattered — not what the market
              will do next.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={String(years)} onValueChange={(v) => setYears(Number(v))}>
              <SelectTrigger className="h-9 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[5, 10, 20, 30, 40].map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y} years
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={method} onValueChange={(v) => setMethod(v as 'block' | 'iid')}>
              <SelectTrigger className="h-9 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block">Block resampling</SelectItem>
                <SelectItem value="iid">Independent days</SelectItem>
              </SelectContent>
            </Select>
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
          </div>
        </div>
      </CardHeader>

      {error && (
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/8 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
            <p className="text-xs">{error}</p>
          </div>
        </CardContent>
      )}

      {pending && !sim && (
        <CardContent>
          <Skeleton className="h-72 w-full" />
        </CardContent>
      )}

      {!sim && !pending && !error && (
        <CardContent>
          <EmptyState
            icon={Dices}
            title="Not run yet"
            description="This resamples the portfolio's realised daily returns. Nothing is shown until it has, because a fan chart drawn from assumed parameters is indistinguishable from a real one."
            className="border-0 py-10"
          />
        </CardContent>
      )}

      {sim && data && (
        <CardContent className={cn('space-y-4', pending && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
            <Stat
              className="bg-card"
              label="Median outcome"
              value={formatCurrencyCompact(sim.terminal.median)}
              sub={`${formatPercent(sim.annualised.median)} a year`}
              hint="The middle of the simulated range. Half the resampled orderings ended above this and half below."
            />
            <Stat
              className="bg-card"
              label="Poor outcome (5th)"
              tone="negative"
              value={formatCurrencyCompact(sim.terminal.p5)}
              sub={`${formatPercent(sim.annualised.p5)} a year`}
              hint="One ordering in twenty ended worse than this. Nothing here is a floor — a worse ordering than any sampled remains possible."
            />
            <Stat
              className="bg-card"
              label="Good outcome (95th)"
              tone="positive"
              value={formatCurrencyCompact(sim.terminal.p95)}
              sub={`${formatPercent(sim.annualised.p95)} a year`}
            />
            <Stat
              className="bg-card"
              label="Deepest fall"
              tone="negative"
              value={formatPercent(sim.worstDrawdown.median, 1)}
              sub={`tail ${formatPercent(sim.worstDrawdown.p95, 1)}`}
              hint="Median worst drawdown across the simulated paths, and the tail case. Block resampling keeps turbulent days together, which is most of what makes a drawdown deep."
            />
          </div>

          {sampleCagr != null && (
            <div
              className={cn(
                'rounded-md border p-3 text-xs leading-relaxed',
                horizonStrained || extremeSample
                  ? 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8'
                  : 'border-border bg-muted/40',
              )}
            >
              <p className="text-muted-foreground">
                The sample returned{' '}
                <span className="numeric text-foreground">{formatPercent(sampleCagr)}</span> a
                year. The simulated median of{' '}
                <span className="numeric text-foreground">
                  {formatPercent(sim.annualised.median)}
                </span>{' '}
                is that same figure reshuffled &mdash; a resampling cannot produce a long-run
                return its own history does not contain, so read the median as the input, not a
                prediction.
              </p>
              {horizonStrained && (
                <p className="mt-1.5 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Projecting {sim.years} years from {sim.sampleYears} years of history.
                  </span>{' '}
                  Every path reuses the same{' '}
                  <span className="numeric">{sim.sampleDays.toLocaleString()}</span> days about{' '}
                  <span className="numeric">{reuse.toFixed(1)}&times;</span> over, so these bands
                  describe one regime resampled &mdash; not {sim.years} independent years. Shorten{' '}
                  {sim.years > 5 ? 'the horizon or widen the sample' : 'the sample window'} to
                  close that gap.
                </p>
              )}
              {extremeSample && (
                <p className="mt-1.5 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {formatPercent(sampleCagr)} a year compounds to implausible levels over{' '}
                    {sim.years} years.
                  </span>{' '}
                  It comes from a short, unusually {sampleCagr > 0 ? 'strong' : 'weak'} stretch for
                  this portfolio. No asset has sustained such a rate for decades, and nothing in
                  this model stops it being extrapolated as though one could.
                </p>
              )}
            </div>
          )}

          <FanChart sim={sim} />

          <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
            <p className="font-medium">What this is, and is not</p>
            <p className="mt-1 text-muted-foreground">
              Every simulated day is a real day drawn from{' '}
              <span className="numeric text-foreground">
                {data.historical.start} – {data.historical.end}
              </span>
              , so the simulation inherits that period entirely: its inflation, its rate
              environment, its valuations. It cannot produce a decade the sample does not contain.
              A resampling of the 2010s will not generate 1970s stagflation, because no such day is
              in the hat. Widen the window and the range widens with it.
            </p>
            <p className="mt-1.5 text-muted-foreground">
              {sim.method === 'block' ? (
                <>
                  Sampling <span className="text-foreground">contiguous {sim.blockDays}-day blocks</span>,
                  which keeps turbulent days together. Independent sampling breaks up those
                  stretches and understates drawdowns in a way that looks reassuring.
                </>
              ) : (
                <>
                  Sampling <span className="text-foreground">individual days independently</span>,
                  which destroys volatility clustering and therefore{' '}
                  <span className="text-foreground">understates drawdown risk</span>. Block
                  resampling is the more honest default.
                </>
              )}{' '}
              {sim.paths.toLocaleString()} paths from {sim.sampleYears} years of history.
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function FanChart({ sim }: { sim: MonteCarloResult }) {
  // Recharts stacks by value, so the bands are expressed as widths.
  const rows = sim.bands.map((b) => ({
    year: b.year,
    lower: b.p5,
    lowerMid: b.p25 - b.p5,
    upperMid: b.p75 - b.p25,
    upper: b.p95 - b.p75,
    median: b.median,
    contributed: b.contributed,
    raw: b,
  }));

  return (
    <ChartFrame
      title="Range of outcomes"
      description="Shaded bands span the 5th to 95th percentile of simulated orderings."
      footer="Dashed, and deliberately unlike the historical charts: these are modelled outcomes, not observations."
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis
              dataKey="year"
              {...AXIS_PROPS}
              tickFormatter={(v) => `${v}y`}
              minTickGap={20}
            />
            <YAxis
              {...AXIS_PROPS}
              width={62}
              tickFormatter={(v) => formatCurrencyCompact(Number(v))}
            />
            <Area dataKey="lower" stackId="fan" stroke="none" fill="transparent" isAnimationActive={false} />
            <Area
              dataKey="lowerMid"
              stackId="fan"
              stroke="none"
              fill="hsl(var(--primary))"
              fillOpacity={0.12}
              isAnimationActive={false}
            />
            <Area
              dataKey="upperMid"
              stackId="fan"
              stroke="none"
              fill="hsl(var(--primary))"
              fillOpacity={0.22}
              isAnimationActive={false}
            />
            <Area
              dataKey="upper"
              stackId="fan"
              stroke="none"
              fill="hsl(var(--primary))"
              fillOpacity={0.12}
              isAnimationActive={false}
            />
            <Line
              dataKey="median"
              stroke="hsl(var(--primary))"
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
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Tooltip
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const b = (payload[0].payload as (typeof rows)[number]).raw;
                return (
                  <ChartTooltip
                    title={`Year ${label}`}
                    rows={[
                      { label: '95th', value: formatCurrency(b.p95), muted: true },
                      { label: '75th', value: formatCurrency(b.p75), muted: true },
                      { label: 'Median', value: formatCurrency(b.median), color: 'hsl(var(--primary))' },
                      { label: '25th', value: formatCurrency(b.p25), muted: true },
                      { label: '5th', value: formatCurrency(b.p5), muted: true },
                      { label: 'Contributed', value: formatCurrency(b.contributed), muted: true },
                    ]}
                    footer="Simulated, not observed."
                  />
                );
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
