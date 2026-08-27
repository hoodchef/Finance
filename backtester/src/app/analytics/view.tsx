'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, FlaskConical, LineChart, Play, RefreshCw } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { ContextBar } from '@/components/layout/context-bar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  NumCell,
  NumHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InfoTip } from '@/components/ui/tooltip';
import { postRebalanceAnalysis, type ApiError } from '@/hooks/use-backtest';
import { DataFreshness } from '@/components/results/panels';
import { ScenarioPanel } from '@/components/results/scenario-panel';
import { MonteCarloPanel } from '@/components/results/montecarlo-panel';
import { FactorPanel } from '@/components/results/factor-panel';
import { useHydrated } from '@/hooks/use-hydrated';
import { useWorkspace } from '@/store/workspace';
import { formatCurrency, formatDate, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

type RebalanceResponse = Awaited<ReturnType<typeof postRebalanceAnalysis>>;
type Scenario = RebalanceResponse['scenarios'][number];

export function AnalyticsView() {
  const hydrated = useHydrated();
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);

  return (
    <>
      <PageHeader
        title="Studies"
        description="Deeper studies on the portfolio currently loaded in the backtester."
      />
      <ContextBar />
      <PageBody>
        {!hydrated ? (
          <Skeleton className="h-64 w-full" />
        ) : draft.positions.filter((p) => p.symbol.trim() && p.weight > 0).length === 0 ? (
          <EmptyState
            icon={LineChart}
            title="No portfolio loaded"
            description="Build an allocation in the backtester first. These studies run against whatever is currently open there."
            action={
              <Button asChild>
                <Link href="/backtest">Open the backtester</Link>
              </Button>
            }
            className="py-20"
          />
        ) : (
          <Tabs defaultValue="rebalancing">
            <TabsList>
              <TabsTrigger value="rebalancing">Rebalancing</TabsTrigger>
              <TabsTrigger value="montecarlo">Monte Carlo</TabsTrigger>
              <TabsTrigger value="factors">Factors</TabsTrigger>
              <TabsTrigger value="scenario">Scenarios</TabsTrigger>
            </TabsList>

            <TabsContent value="rebalancing">
              <RebalancingAnalysis draft={draft} config={config} />
            </TabsContent>

            <TabsContent value="montecarlo">
              <MonteCarloPanel
                portfolio={{ id: draft.id, name: draft.name, positions: draft.positions }}
                config={config}
              />
            </TabsContent>

            <TabsContent value="factors">
              <FactorPanel
                portfolio={{ id: draft.id, name: draft.name, positions: draft.positions }}
                config={config}
              />
            </TabsContent>

            <TabsContent value="scenario">
              <ScenarioPanel
                portfolio={{ id: draft.id, name: draft.name, positions: draft.positions }}
                config={config}
              />
            </TabsContent>
          </Tabs>
        )}
      </PageBody>
    </>
  );
}

/* ------------------------------------------------------------------ */

function RebalancingAnalysis({
  draft,
  config,
}: {
  draft: ReturnType<typeof useWorkspace.getState>['draft'];
  config: ReturnType<typeof useWorkspace.getState>['config'];
}) {
  const [analysis, setAnalysis] = React.useState<RebalanceResponse | null>(null);
  const scenarios = analysis?.scenarios ?? null;
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  async function run() {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const data = await postRebalanceAnalysis(
        { id: draft.id, name: draft.name, positions: draft.positions },
        config,
        ac.signal,
      );
      if (!ac.signal.aborted) setAnalysis(data);
    } catch (err) {
      if (!ac.signal.aborted) {
        setError(
          (err as ApiError)?.error
            ? (err as ApiError)
            : { error: 'Could not reach the analysis service.' },
        );
      }
    } finally {
      if (!ac.signal.aborted) setPending(false);
    }
  }

  React.useEffect(() => () => controller.current?.abort(), []);

  const columns: Array<{
    label: string;
    get: (s: Scenario) => number;
    format: (v: number) => string;
    better: 'high' | 'low' | null;
    hint?: string;
  }> = [
    { label: 'CAGR', get: (s) => s.cagr, format: (v) => formatPercent(v), better: 'high' },
    { label: 'Volatility', get: (s) => s.volatility, format: (v) => formatPercent(v), better: 'low' },
    { label: 'Max drawdown', get: (s) => s.maxDrawdown, format: (v) => formatPercent(v, 1), better: 'high' },
    { label: 'Sharpe', get: (s) => s.sharpe, format: (v) => formatNumber(v), better: 'high' },
    { label: 'Sortino', get: (s) => s.sortino, format: (v) => formatNumber(v), better: 'high' },
    { label: 'Final value', get: (s) => s.finalValue, format: (v) => formatCurrency(v), better: 'high' },
    { label: 'Trades', get: (s) => s.trades, format: (v) => String(Math.round(v)), better: 'low' },
    {
      label: 'Turnover /yr',
      get: (s) => s.turnoverPerYear,
      format: (v) => formatPercent(v, 0),
      better: 'low',
      hint: 'Traded notional per year as a share of average portfolio value. Higher turnover means more trading costs and, in a taxable account, more realised gains.',
    },
    { label: 'Trading costs', get: (s) => s.tradingCosts, format: (v) => formatCurrency(v), better: 'low' },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Rebalancing analysis</CardTitle>
              <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
                The same portfolio, the same window and the same costs under every rebalancing
                rule. Only the rule changes between rows, so the differences are attributable to it
                alone.
              </p>
            </div>
            <Button onClick={run} disabled={pending}>
              {pending ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Running six backtests…
                </>
              ) : (
                <>
                  {scenarios ? <RefreshCw /> : <Play />}
                  {scenarios ? 'Rerun' : 'Run analysis'}
                </>
              )}
            </Button>
          </div>
          <p className="text-2xs text-muted-foreground">
            {draft.name} · {formatDate(config.start)} → {formatDate(config.end)} ·{' '}
            {formatCurrency(config.initialInvestment)} initial ·{' '}
            {config.fees.tradingCostBps} bps per trade
            {config.fees.tradingCostBps === 0 &&
              ' — with zero trading costs the higher-turnover rules are flattered'}
          </p>
          {analysis && (
            <div className="mt-1">
              <DataFreshness dataSource={analysis.dataSource} />
            </div>
          )}
        </CardHeader>

        {error && (
          <CardContent>
            <div
              role="alert"
              className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/8 p-3"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
              <p className="text-xs">{error.error}</p>
            </div>
          </CardContent>
        )}

        {pending && !scenarios && (
          <CardContent>
            <Skeleton className="h-56 w-full" />
          </CardContent>
        )}

        {analysis?.dataSource.synthetic && (
          <CardContent>
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border-2 border-[hsl(var(--warning))] bg-[hsl(var(--warning))]/10 p-3"
            >
              <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" />
              <p className="text-xs leading-relaxed">
                <span className="font-semibold">These scenarios use synthetic data.</span> The
                rebalancing rules below are compared against a seeded random walk, not against any
                market. The comparison is internally consistent and tells you nothing about which
                rule would have served you.
              </p>
            </div>
          </CardContent>
        )}

        {scenarios && (
          <CardContent className={cn('px-0 pb-0', pending && 'opacity-60')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-card">Rule</TableHead>
                  {columns.map((c) => (
                    <NumHead key={c.label}>
                      <span className="inline-flex items-center gap-1">
                        {c.label}
                        {c.hint && <InfoTip label={`About ${c.label}`}>{c.hint}</InfoTip>}
                      </span>
                    </NumHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {scenarios.map((s) => {
                  const isCurrent = s.frequency === config.rebalance;
                  return (
                    <TableRow key={s.frequency} className={cn(isCurrent && 'bg-primary/5')}>
                      <TableCell className="sticky left-0 whitespace-nowrap bg-card">
                        <span className="flex items-center gap-2 text-xs font-medium">
                          {s.label}
                          {isCurrent && <Badge variant="primary">Current</Badge>}
                        </span>
                      </TableCell>
                      {columns.map((c) => {
                        const values = scenarios.map(c.get).filter(Number.isFinite);
                        const best =
                          c.better && values.length > 1
                            ? c.better === 'high'
                              ? Math.max(...values)
                              : Math.min(...values)
                            : null;
                        const v = c.get(s);
                        return (
                          <NumCell
                            key={c.label}
                            className={cn(
                              'text-xs',
                              best != null && Math.abs(v - best) < 1e-12 && 'font-semibold',
                            )}
                          >
                            {Number.isFinite(v) ? c.format(v) : '—'}
                          </NumCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="px-4 py-3 text-2xs leading-relaxed text-muted-foreground">
              Rebalancing is a risk-control decision before it is a return decision: it holds the
              portfolio near the weights you chose. Whether it also helped or hurt return in this
              particular window is a fact about this window, not a general property.
            </p>
          </CardContent>
        )}

        {!scenarios && !pending && !error && (
          <CardContent>
            <EmptyState
              icon={RefreshCw}
              title="Not run yet"
              description="This runs six full backtests against one shared dataset. It usually takes a second or two."
              className="border-0 py-10"
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
