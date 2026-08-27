'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Check, Play, RefreshCw, Scale } from 'lucide-react';
import type { BacktestConfig, Portfolio } from '@/lib/types';
import type { OptimisedPortfolio } from '@/lib/analysis/optimise';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AXIS_PROPS, ChartFrame, GRID_PROPS } from '@/components/charts/chart-chrome';
import { formatPercent } from '@/lib/format';
import { useWorkspace } from '@/store/workspace';
import { cn } from '@/lib/utils';

interface Response {
  symbols: string[];
  current: number[] | null;
  portfolios: {
    minimumVariance: OptimisedPortfolio;
    riskParity: OptimisedPortfolio;
    maximumSharpe: OptimisedPortfolio;
  };
  frontier: OptimisedPortfolio[];
  estimate: {
    observations: number;
    shrinkage: number;
    from: string;
    to: string;
    annualVolatility: number[];
  };
}

const METHOD = {
  minimumVariance: {
    label: 'Minimum variance',
    note: 'The lowest-risk mix available from these holdings. Uses no expected returns at all, which is why it tends to hold up out of sample.',
  },
  riskParity: {
    label: 'Risk parity',
    note: 'Every holding contributes the same share of risk. Equal weights are not equal risk — a 60/40 takes most of its risk from the equity leg.',
  },
  maximumSharpe: {
    label: 'Maximum Sharpe',
    note: 'The best historical return per unit of risk. Depends on expected returns, which are the input estimated least reliably — treat it as the least trustworthy of the three.',
  },
} as const;

type MethodKey = keyof typeof METHOD;

/**
 * Portfolio construction from the holdings' joint history.
 *
 * Shows three answers rather than one. Optimisation amplifies estimation
 * error: the assets it likes most are the ones whose statistics were most
 * flattered by luck, and expected returns are the worst offenders. Presenting
 * a single allocation would imply a precision the estimate cannot support, so
 * the two methods that ignore expected returns sit beside the one that does
 * not, with concentration reported for all of them.
 */
export function OptimiserPanel({
  portfolio,
  config,
}: {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
}) {
  const [data, setData] = React.useState<Response | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const priced = portfolio.positions.filter((p) => p.symbol.trim()).length;
  const draft = useWorkspace((s) => s.draft);
  const setDraft = useWorkspace((s) => s.setDraft);
  const [applied, setApplied] = React.useState<string | null>(null);

  /**
   * Adopts a suggested allocation into the working portfolio.
   *
   * Without this the panel is a dead end: it tells you a better mix existed
   * and leaves you to retype it. Weights are matched by SYMBOL rather than by
   * position, because the optimiser only ever sees priced holdings — a cash
   * sleeve or an unpriced row is not in its output and must keep whatever it
   * had rather than being silently dropped.
   */
  function apply(key: MethodKey, symbols: string[], weights: number[]) {
    const bySymbol = new Map(symbols.map((sym, i) => [sym.toUpperCase(), weights[i] * 100]));
    setDraft({
      ...draft,
      positions: draft.positions.map((p) => {
        const w = bySymbol.get(p.symbol.trim().toUpperCase());
        return w === undefined ? p : { ...p, weight: Math.round(w * 10) / 10 };
      }),
    });
    setApplied(key);
    window.setTimeout(() => setApplied(null), 2500);
  }

  async function run() {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/optimise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        // A flat 60% cap is meaningless on two holdings — it forces 40/60
        // whatever the assets are. The cap exists to stop a ten-holding
        // solution collapsing into one bet, so it has to scale with the count.
        body: JSON.stringify({
          portfolio,
          config,
          riskFree: 0.03,
          maxWeight: Math.min(1, Math.max(0.4, 2.5 / Math.max(1, priced))),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Optimisation failed.');
      if (!ac.signal.aborted) setData(json as Response);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Optimisation failed.');
    } finally {
      if (!ac.signal.aborted) setPending(false);
    }
  }

  React.useEffect(() => () => controller.current?.abort(), []);

  const frontier = React.useMemo(
    () =>
      data?.frontier.map((p) => ({
        risk: Number((p.volatility * 100).toFixed(3)),
        ret: Number((p.expectedReturn * 100).toFixed(3)),
      })) ?? [],
    [data],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-4 w-4" />
              Allocation
              <Badge variant="outline">Suggested</Badge>
            </CardTitle>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              What these same holdings could have been weighted, judged on how they actually moved
              together. Three answers, because one would imply a precision the estimate cannot
              support.
            </p>
          </div>
          <Button onClick={run} disabled={pending}>
            {pending ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Solving…
              </>
            ) : (
              <>
                {data ? <RefreshCw /> : <Play />}
                {data ? 'Rerun' : 'Optimise'}
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      {error && (
        <CardContent>
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="leading-relaxed">{error}</p>
          </div>
        </CardContent>
      )}

      {pending && !data && (
        <CardContent>
          <Skeleton className="h-72 w-full" />
        </CardContent>
      )}

      {!data && !pending && !error && (
        <CardContent>
          <EmptyState
            icon={Scale}
            title="Not solved yet"
            description="Fits a covariance to the holdings' joint history and solves for minimum variance, risk parity and maximum Sharpe."
            className="border-0 py-10"
          />
        </CardContent>
      )}

      {data && (
        <CardContent className={cn('space-y-4', pending && 'opacity-60')}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Allocation</th>
                  {data.symbols.map((s) => (
                    <th key={s} className="py-2 pr-3 text-right font-medium">
                      {s}
                    </th>
                  ))}
                  <th className="py-2 pr-3 text-right font-medium">Return</th>
                  <th className="py-2 pr-3 text-right font-medium">Risk</th>
                  <th className="py-2 pr-3 text-right font-medium">Sharpe</th>
                  <th className="py-2 pr-3 text-right font-medium">Spread</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.current && (
                  <tr className="border-b border-border/50 bg-muted/30">
                    <td className="py-2 pr-3 font-medium">Yours</td>
                    {data.current.map((w, i) => (
                      <td key={i} className="numeric py-2 pr-3 text-right">
                        {formatPercent(w, 0)}
                      </td>
                    ))}
                    <td className="numeric py-2 pr-3 text-right text-muted-foreground" colSpan={5}>
                      as it stands
                    </td>
                  </tr>
                )}
                {(Object.keys(METHOD) as MethodKey[]).map((key) => {
                  const p = data.portfolios[key];
                  // Herfindahl inverted: how many holdings this is "really" in.
                  const spread = p.concentration > 0 ? 1 / p.concentration : 0;
                  return (
                    <tr key={key} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 font-medium">{METHOD[key].label}</td>
                      {p.weights.map((w, i) => (
                        <td
                          key={i}
                          className={cn(
                            'numeric py-2 pr-3 text-right',
                            w < 0.005 && 'text-muted-foreground',
                          )}
                        >
                          {formatPercent(w, 0)}
                        </td>
                      ))}
                      <td className="numeric py-2 pr-3 text-right">
                        {formatPercent(p.expectedReturn, 1)}
                      </td>
                      <td className="numeric py-2 pr-3 text-right">
                        {formatPercent(p.volatility, 1)}
                      </td>
                      <td className="numeric py-2 pr-3 text-right font-medium">
                        {p.sharpe.toFixed(2)}
                      </td>
                      <td
                        className={cn(
                          'numeric py-2 pr-3 text-right',
                          spread < 2.5 && 'text-[hsl(var(--warning))]',
                        )}
                        title="Effective number of holdings. Well below the real count means the solution is a concentrated bet."
                      >
                        {spread.toFixed(1)} of {data.symbols.length}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => apply(key, data.symbols, p.weights)}
                        >
                          {applied === key ? (
                            <>
                              <Check className="h-3 w-3" />
                              Applied
                            </>
                          ) : (
                            'Apply'
                          )}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ChartFrame
            title="Risk against return"
            description="Each point is the least-risk mix that reaches that return. The curve flattening is the useful part: past the bend, more risk buys very little."
          >
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={frontier} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  {...AXIS_PROPS}
                  dataKey="risk"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                />
                <YAxis {...AXIS_PROPS} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
                <Line
                  dataKey="ret"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>

          <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
            <p className="font-medium">Why three answers and not one</p>
            <p className="mt-1 text-muted-foreground">
              An optimiser is drawn to whatever the sample says had high return and low
              correlation, and those are the assets whose statistics were most flattered by luck.
              Expected returns need decades to estimate usefully; covariance needs years. So
              minimum variance and risk parity, which use no expected returns at all, are usually
              the more trustworthy answers &mdash; and maximum Sharpe, which reads best on paper,
              is the one to doubt.
            </p>
            <p className="mt-1.5 text-muted-foreground">
              Applying one of these rewrites the weights in your working portfolio &mdash;
              symbols the optimiser never saw, such as a cash sleeve, keep what they had. Nothing
              is saved until you save it, and the Backtest page will re-run against the new mix.
            </p>
            <p className="mt-1.5 text-muted-foreground">
              Fitted to{' '}
              <span className="numeric text-foreground">
                {data.estimate.observations.toLocaleString()}
              </span>{' '}
              days from {data.estimate.from} to {data.estimate.to}, with Ledoit&ndash;Wolf
              shrinkage at{' '}
              <span className="numeric text-foreground">
                {formatPercent(data.estimate.shrinkage, 0)}
              </span>
              . Long-only, with a per-holding cap that scales to the number of holdings. These are the weights that would have been
              best over that window &mdash; not a claim about the next one.
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
