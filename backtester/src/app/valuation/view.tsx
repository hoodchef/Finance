'use client';

import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHydrated } from '@/hooks/use-hydrated';
import { useActiveTicker } from '@/store/ticker';
import { MODEL_META } from '@/lib/valuation/asts/inputs';
import { intrinsicModelFor } from '@/lib/valuation/registry';
import { useAstsValuation, type Valuation } from '@/components/valuation/use-asts-valuation';
import { SummaryTab } from '@/components/valuation/summary-tab';
import { AssumptionsTab } from '@/components/valuation/assumptions-tab';
import { StatementsTab } from '@/components/valuation/statements-tab';
import { SensitivityTab } from '@/components/valuation/sensitivity-tab';
import { SimulationTab } from '@/components/valuation/simulation-tab';
import { FundingTab } from '@/components/valuation/funding-tab';
import { ChecksTab } from '@/components/valuation/checks-tab';
import { ProvenanceTab } from '@/components/valuation/provenance-tab';

const TABS = [
  ['summary', 'Summary'],
  ['assumptions', 'Assumptions'],
  ['model', 'Model'],
  ['sensitivity', 'Sensitivity'],
  ['simulation', 'Simulation'],
  ['funding', 'Funding & risk'],
  ['checks', 'Checks'],
  ['provenance', 'Provenance'],
] as const;
type Tab = (typeof TABS)[number][0];
const TAB_KEY = 'valuation.tab';

function StatusBadges({ v }: { v: Valuation }) {
  const f = v.live?.filings;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={v.checks.failed === 0 ? 'positive' : 'negative'} title="The workbook's 44 live checks">
        Checks: {v.checks.status}
      </Badge>
      {f ? (
        <Badge variant={f.freshness === 'current' ? 'outline' : 'warning'} title={f.headline}>
          Filings: {f.freshness}
        </Badge>
      ) : (
        <Badge variant="outline">Filings: {v.live ? 'unavailable' : 'checking…'}</Badge>
      )}
      <Badge variant={v.diffs.length ? 'warning' : 'outline'} title={v.diffs.length ? 'Inputs differ from the delivered model' : undefined}>
        {v.diffs.length ? `Edited · ${v.diffs.length}` : 'As delivered'}
      </Badge>
    </div>
  );
}

export function ValuationView() {
  const hydrated = useHydrated();
  const v = useAstsValuation();
  const focus = useActiveTicker();
  const [tab, setTab] = React.useState<Tab>('summary');
  React.useEffect(() => {
    try {
      const t = localStorage.getItem(TAB_KEY) as Tab | null;
      if (t && TABS.some(([k]) => k === t)) setTab(t);
    } catch {
      /* no stored tab */
    }
  }, []);
  const choose = (t: string) => {
    setTab(t as Tab);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* not remembered */
    }
  };

  const other = focus && !intrinsicModelFor(focus.symbol) ? focus.symbol : null;
  const f = v.live?.filings;

  return (
    <>
      <PageHeader
        title="Valuation"
        description={`${MODEL_META.company} (${MODEL_META.exchange}: ${MODEL_META.ticker}) — four-scenario FCFF DCF, valued at ${MODEL_META.valuationDate}, run live. A port of the analyst’s workbook held to it at every cell; everything it stamped is recomputed here.`}
        actions={hydrated && v.restored ? <StatusBadges v={v} /> : null}
      />
      <PageBody className="space-y-4">
        {other && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            There is no intrinsic model for {other}. A valuation is company-specific — ASTS’s revenue is a satellite constellation and a
            share of partner subscribers — so this page shows the one model that has been built rather than a template filled with defaults.
          </p>
        )}
        {f && f.freshness !== 'current' && (
          <p className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 p-3 text-xs leading-relaxed">{f.headline}</p>
        )}
        {v.diffs.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 px-3 py-2 text-xs">
            <span>
              You are looking at an <strong>edited</strong> model: {v.diffs.length} input{v.diffs.length === 1 ? ' differs' : 's differ'} from
              the delivered one. Every figure on every tab reflects the edits.
            </span>
            <Button size="sm" variant="outline" onClick={v.reset}><RotateCcw className="size-3.5" /> Reset</Button>
          </div>
        )}

        {!hydrated || !v.restored ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={choose}>
            <div className="-mx-1 overflow-x-auto px-1">
              <TabsList>
                {TABS.map(([k, label]) => (
                  <TabsTrigger key={k} value={k}>
                    {label}
                    {k === 'checks' && v.checks.failed > 0 && (
                      <span className="ml-1.5 rounded bg-[hsl(var(--negative))]/15 px-1 text-2xs text-negative">{v.checks.failed}</span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="summary"><SummaryTab v={v} /></TabsContent>
            <TabsContent value="assumptions"><AssumptionsTab v={v} /></TabsContent>
            <TabsContent value="model"><StatementsTab v={v} /></TabsContent>
            <TabsContent value="sensitivity"><SensitivityTab v={v} /></TabsContent>
            <TabsContent value="simulation"><SimulationTab v={v} /></TabsContent>
            <TabsContent value="funding"><FundingTab v={v} /></TabsContent>
            <TabsContent value="checks"><ChecksTab v={v} /></TabsContent>
            <TabsContent value="provenance"><ProvenanceTab v={v} /></TabsContent>
          </Tabs>
        )}
      </PageBody>
    </>
  );
}
