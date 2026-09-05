'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import type { BacktestResult } from '@/lib/backtest';
import { fromBacktest } from '@/lib/analytics/adapters';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GrowthChart } from '@/components/charts/growth-chart';
import { CapitalBreakdown, KpiGrid } from './kpi-grid';
import { BenchmarkTable } from './tables';
import {
  DataFreshness,
  ExportMenu,
  MethodologyPanel,
  SyntheticDataBanner,
  WarningsPanel,
} from './panels';
import { AssetDetailDialog } from './asset-detail';
import { RealSummaryStrip, RealTermsPanel } from './real-terms';

/**
 * Six of the seven tabs are loaded on demand.
 * =============================================================================
 * Radix already declines to RENDER an inactive tab, but the code for all seven
 * still shipped in the page bundle, which made `/backtest` 240 kB against
 * 21 kB for the next largest route in the app — eleven times the size, to show
 * one tab. Everything behind a tab nobody clicked was paid for on first load.
 *
 * Only the Performance tab is bundled eagerly, because it is the one that is
 * open when results arrive. The rest are separate chunks fetched on first
 * click, which is a request the reader has just made and is expecting.
 *
 * `ssr: false` because the dashboard only ever exists after a backtest has run
 * in the browser; there is no server render of it to hydrate against.
 */
const tabLoader = () => <TabSkeleton />;

const RiskTab = dynamic(() => import('./tabs/risk-tab').then((m) => m.RiskTab), {
  ssr: false,
  loading: tabLoader,
});
const ReturnsTab = dynamic(() => import('./tabs/returns-tab').then((m) => m.ReturnsTab), {
  ssr: false,
  loading: tabLoader,
});
const AllocationTab = dynamic(
  () => import('./tabs/allocation-tab').then((m) => m.AllocationTab),
  { ssr: false, loading: tabLoader },
);
const HoldingsTab = dynamic(() => import('./tabs/holdings-tab').then((m) => m.HoldingsTab), {
  ssr: false,
  loading: tabLoader,
});
const GainsTab = dynamic(() => import('./tabs/gains-tab').then((m) => m.GainsTab), {
  ssr: false,
  loading: tabLoader,
});
const InsightsTab = dynamic(() => import('./tabs/insights-tab').then((m) => m.InsightsTab), {
  ssr: false,
  loading: tabLoader,
});

/**
 * Holds the tab's height while its chunk arrives, so the page does not jump.
 * Deliberately says nothing: a spinner captioned "Loading" on a 150ms fetch
 * reads as an error state more often than as progress.
 */
function TabSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/40" />
      <div className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
    </div>
  );
}

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
          <RiskTab result={result} subjects={subjects} />
        </TabsContent>

        <TabsContent value="returns" className="space-y-5">
          <ReturnsTab result={result} />
        </TabsContent>

        <TabsContent value="allocation" className="space-y-5">
          <AllocationTab result={result} />
        </TabsContent>

        <TabsContent value="holdings" className="space-y-5">
          <HoldingsTab result={result} onSelect={setSelectedAsset} />
        </TabsContent>

        <TabsContent value="gains" className="space-y-5">
          <GainsTab result={result} />
        </TabsContent>

        <TabsContent value="insights" className="space-y-5">
          <InsightsTab result={result} />
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
