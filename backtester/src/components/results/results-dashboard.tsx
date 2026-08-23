'use client';

import * as React from 'react';
import type { BacktestResult } from '@/lib/backtest';
import { fromBacktest } from '@/lib/analytics/adapters';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GrowthChart } from '@/components/charts/growth-chart';
import { DrawdownChart } from '@/components/charts/drawdown-chart';
import { AnnualReturnsChart, AnnualSummary } from '@/components/charts/annual-returns';
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';
import { RollingChart, RollingTable } from '@/components/charts/rolling-chart';
import {
  AllocationDonut,
  AllocationDrift,
  ContributionChart,
} from '@/components/charts/allocation-charts';
import { CapitalBreakdown, KpiGrid } from './kpi-grid';
import {
  BenchmarkTable,
  DrawdownTable,
  HoldingsTable,
  RiskTable,
} from './tables';
import {
  DataFreshness,
  ExportMenu,
  InsightsPanel,
  MethodologyPanel,
  SyntheticDataBanner,
  WarningsPanel,
} from './panels';
import { AssetDetailDialog } from './asset-detail';
import { TaxLotsPanel } from './tax-lots';
import { RealSummaryStrip, RealTermsPanel } from './real-terms';
import { CorrelationPanel } from './correlation-matrix';
import { PeriodReturnsTable } from './period-returns';

/**
 * The results page. Everything visible here is computed by the engine from the
 * portfolio and settings the user supplied — no figure on this page is a
 * placeholder or a sample value.
 */
export function ResultsDashboard({ result }: { result: BacktestResult }) {
  const [selectedAsset, setSelectedAsset] = React.useState<string | null>(null);
  // One conversion at the boundary; every chart below is origin-agnostic.
  const subjects = React.useMemo(() => fromBacktest(result), [result]);

  return (
    <div className="space-y-5">
      <SyntheticDataBanner result={result} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{result.portfolio.name}</h2>
            <Badge variant="outline">
              {formatDate(result.effectiveStart)} → {formatDate(result.effectiveEnd)}
            </Badge>
            {result.dataSource.synthetic && <Badge variant="warning">Synthetic data</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {result.portfolio.positions.length} holding
            {result.portfolio.positions.length === 1 ? '' : 's'} ·{' '}
            {result.totals.tradeCount} trades · {result.totals.rebalanceCount} rebalances ·
            computed in {result.computeMs} ms
          </p>
          <div className="mt-1">
            <DataFreshness dataSource={result.dataSource} />
          </div>
        </div>
        <ExportMenu result={result} />
      </div>

      <WarningsPanel warnings={result.warnings} />
      <KpiGrid result={result} />
      <RealSummaryStrip result={result} />
      <CapitalBreakdown result={result} />

      <Tabs defaultValue="performance">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="risk">Risk</TabsTrigger>
          <TabsTrigger value="returns">Returns</TabsTrigger>
          <TabsTrigger value="allocation">Allocation</TabsTrigger>
          <TabsTrigger value="holdings">Holdings</TabsTrigger>
          <TabsTrigger value="gains">Gains</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>

        <TabsContent value="performance" className="space-y-5">
          <GrowthChart subjects={subjects} />
          <RealTermsPanel result={result} />
          <BenchmarkTable result={result} />
        </TabsContent>

        <TabsContent value="risk" className="space-y-5">
          <DrawdownChart subjects={subjects} />
          <DrawdownTable result={result} />
          <CorrelationPanel result={result} />
          <RiskTable result={result} />
        </TabsContent>

        <TabsContent value="returns" className="space-y-5">
          <AnnualReturnsChart result={result} />
          <AnnualSummary result={result} />
          <MonthlyHeatmap monthly={result.metrics.monthly} annual={result.metrics.annual} />
          <RollingChart result={result} />
          <RollingTable result={result} />
          <PeriodReturnsTable result={result} />
        </TabsContent>

        <TabsContent value="allocation" className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <AllocationDonut result={result} />
            <ContributionChart result={result} />
          </div>
          <AllocationDrift result={result} />
        </TabsContent>

        <TabsContent value="holdings" className="space-y-5">
          <HoldingsTable result={result} onSelect={setSelectedAsset} />
        </TabsContent>

        <TabsContent value="gains" className="space-y-5">
          <TaxLotsPanel result={result} />
        </TabsContent>

        <TabsContent value="insights" className="space-y-5">
          <InsightsPanel result={result} />
        </TabsContent>
      </Tabs>

      <MethodologyPanel result={result} />

      <AssetDetailDialog
        result={result}
        symbol={selectedAsset}
        onOpenChange={(open) => !open && setSelectedAsset(null)}
      />
    </div>
  );
}
