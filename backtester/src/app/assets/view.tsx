'use client';

import * as React from 'react';
import { AlertCircle, BarChart3, Plus, Search } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { TickerSearch } from '@/components/builder/ticker-search';
import { GrowthChart } from '@/components/charts/growth-chart';
import { DrawdownChart } from '@/components/charts/drawdown-chart';
import { AnnualReturnsChart } from '@/components/charts/annual-returns';
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';
import { RiskTable, DrawdownTable } from '@/components/results/tables';
import { MethodologyPanel, SyntheticDataBanner, WarningsPanel } from '@/components/results/panels';
import { KpiGrid } from '@/components/results/kpi-grid';
import { useBacktest } from '@/hooks/use-backtest';
import { useWorkspace } from '@/store/workspace';
import { useHydrated } from '@/hooks/use-hydrated';
import { RANGE_PRESETS, MAX_HISTORY_START } from '@/lib/defaults';
import { addYears, todayIso } from '@/lib/market-data/dates';
import { uid } from '@/lib/utils';
import { CATALOG } from '@/lib/market-data/catalog';

/**
 * Single-asset explorer. It runs the same engine on a one-holding portfolio, so
 * the statistics here are computed identically to the portfolio dashboard —
 * there is no second, subtly different code path for asset-level numbers.
 */
export function AssetsView() {
  const hydrated = useHydrated();
  const config = useWorkspace((s) => s.config);
  const addPosition = useWorkspace((s) => s.addPosition);
  const { result, error, pending, run } = useBacktest();

  const [symbol, setSymbol] = React.useState<string | null>(null);
  const [name, setName] = React.useState<string>('');
  const [years, setYears] = React.useState<number | 'max'>(10);
  const [added, setAdded] = React.useState(false);

  const load = React.useCallback(
    async (sym: string, label: string, span: number | 'max') => {
      setSymbol(sym);
      setName(label);
      const end = todayIso();
      await run(
        { id: `asset-${sym}`, name: label || sym, positions: [{ id: uid('pos'), symbol: sym, weight: 100 }] },
        {
          ...config,
          start: span === 'max' ? MAX_HISTORY_START : addYears(end, -span),
          end,
          contributionAmount: 0,
          contributionFrequency: 'none',
          rebalance: 'never',
          fees: {
            managementFeePct: 0,
            tradingCostBps: 0,
            commissionPerTrade: 0,
            defaultExpenseRatioPct: 0,
          },
        },
      );
    },
    [config, run],
  );

  const popular = React.useMemo(
    () => CATALOG.filter((c) => ['SPY', 'QQQ', 'VTI', 'BND', 'GLD', 'VXUS', 'TLT', 'SCHD'].includes(c.symbol)),
    [],
  );

  return (
    <>
      <PageHeader
        title="Assets"
        description="Examine one ticker on its own — buy and hold, dividends reinvested, no fees."
        actions={
          symbol && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                addPosition({ id: uid('pos'), symbol, name, weight: 0 });
                setAdded(true);
                setTimeout(() => setAdded(false), 2200);
              }}
            >
              <Plus />
              {added ? 'Added to builder' : 'Add to portfolio'}
            </Button>
          )
        }
      />

      <PageBody className="space-y-5">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Look up a security</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <TickerSearch
              placeholder="Search a ticker or fund name…"
              onSelect={(meta) => void load(meta.symbol, meta.name, years)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xs uppercase tracking-wide text-muted-foreground">Period</span>
              {RANGE_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={years === p.years ? 'default' : 'outline'}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => {
                    setYears(p.years);
                    if (symbol) void load(symbol, name, p.years);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            {!symbol && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                  Common
                </span>
                {popular.map((c) => (
                  <Button
                    key={c.symbol}
                    variant="outline"
                    size="sm"
                    className="numeric h-7 px-2 text-xs"
                    onClick={() => void load(c.symbol, c.name, years)}
                  >
                    {c.symbol}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/8 p-4"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-negative">Could not load {symbol}</p>
              <p className="text-xs leading-relaxed">{error.error}</p>
            </div>
          </div>
        )}

        {pending && !result && (
          <div className="space-y-5">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
        )}

        {!symbol && !pending && (
          <EmptyState
            icon={Search}
            title="No security selected"
            description="Search above, or pick one of the common tickers, to see its full return and risk history."
            className="py-20"
          />
        )}

        {hydrated && result && (
          <div className="space-y-5">
            <SyntheticDataBanner result={result} />
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="numeric text-lg font-semibold">{symbol}</h2>
              <span className="text-sm text-muted-foreground">{name}</span>
              <Badge variant="outline">
                {result.effectiveStart} → {result.effectiveEnd}
              </Badge>
            </div>
            <WarningsPanel warnings={result.warnings} />
            <KpiGrid result={result} />
            <GrowthChart result={result} />
            <DrawdownChart result={result} />
            <DrawdownTable result={result} />
            <AnnualReturnsChart result={result} />
            <MonthlyHeatmap monthly={result.metrics.monthly} annual={result.metrics.annual} />
            <RiskTable result={result} />
            <MethodologyPanel result={result} />
          </div>
        )}

        {!hydrated && symbol && (
          <EmptyState icon={BarChart3} title="Loading" className="py-20" />
        )}
      </PageBody>
    </>
  );
}
