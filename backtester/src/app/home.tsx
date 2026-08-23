'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Briefcase, GitCompare, LineChart, Play, Sparkles } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { AllocationBar } from '@/components/builder/allocation-bar';
import { useHydrated } from '@/hooks/use-hydrated';
import { useWorkspace } from '@/store/workspace';
import { PRESETS } from '@/lib/presets';
import { formatDate } from '@/lib/format';
import { seriesColor } from '@/lib/utils';

export function DashboardHome() {
  const router = useRouter();
  const hydrated = useHydrated();
  const portfolios = useWorkspace((s) => s.portfolios);
  const draft = useWorkspace((s) => s.draft);
  const loadPreset = useWorkspace((s) => s.loadPreset);
  const loadPortfolio = useWorkspace((s) => s.loadPortfolio);

  function openPreset(id: string) {
    loadPreset(id);
    router.push('/backtest');
  }

  function openPortfolio(id: string) {
    loadPortfolio(id);
    router.push('/backtest');
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Construct a portfolio, test it against real market history, and see what actually drove the result."
        actions={
          <Button asChild size="lg">
            <Link href="/backtest">
              <Play />
              Open the backtester
            </Link>
          </Button>
        }
      />

      <PageBody className="space-y-6">
        {/* Current draft ------------------------------------------------ */}
        {hydrated && draft.positions.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle>Continue where you left off</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {draft.name} · {draft.positions.length} holding
                    {draft.positions.length === 1 ? '' : 's'} · edited{' '}
                    {formatDate(draft.updatedAt.slice(0, 10))}
                  </p>
                </div>
                <Button asChild size="sm">
                  <Link href="/backtest">
                    Open
                    <ArrowRight />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <AllocationBar positions={draft.positions} />
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {draft.positions.map((p, i) => (
                  <span key={p.id} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: seriesColor(p.symbol || p.id, i) }}
                    />
                    <span className="numeric text-foreground">{p.symbol || '—'}</span>
                    <span className="numeric">{p.weight}%</span>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Presets ------------------------------------------------------- */}
        <section>
          <h2 className="mb-3 text-sm font-semibold">Start from a known allocation</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => openPreset(preset.id)}
                className="group rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium">{preset.name}</h3>
                  <Badge variant="outline" className="capitalize">
                    {preset.category}
                  </Badge>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {preset.description}
                </p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {preset.holdings.map((h, i) => (
                    <span
                      key={h.symbol}
                      className="numeric inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-2xs"
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-sm"
                        style={{ backgroundColor: seriesColor(h.symbol, i) }}
                      />
                      {h.symbol} {h.weight}%
                    </span>
                  ))}
                </div>
                <span className="mt-3 inline-flex items-center gap-1 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  Load and test
                  <ArrowRight className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Saved --------------------------------------------------------- */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Your saved portfolios</h2>
            {hydrated && portfolios.length > 0 && (
              <Button asChild variant="ghost" size="sm">
                <Link href="/portfolios">
                  Manage
                  <ArrowRight />
                </Link>
              </Button>
            )}
          </div>

          {!hydrated ? (
            <div className="h-28 animate-pulse rounded-lg border border-border bg-card" aria-hidden />
          ) : portfolios.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="Nothing saved yet"
              description="Portfolios you save in the backtester show up here, ready to rerun or compare."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/backtest">Build one</Link>
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {portfolios.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openPortfolio(p.id)}
                  className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <h3 className="truncate text-sm font-medium">{p.name}</h3>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    {p.positions.length} holding{p.positions.length === 1 ? '' : 's'} · updated{' '}
                    {formatDate(p.updatedAt.slice(0, 10))}
                  </p>
                  <div className="mt-3">
                    <AllocationBar positions={p.positions} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Where to go next ---------------------------------------------- */}
        <section className="grid gap-3 sm:grid-cols-3">
          <NextStep
            href="/compare"
            icon={GitCompare}
            title="Compare portfolios"
            body="Run several allocations over one window and put their statistics side by side."
          />
          <NextStep
            href="/analytics"
            icon={Sparkles}
            title="Rebalancing analysis"
            body="See what every rebalancing rule would have done to return, risk and trading costs."
          />
          <NextStep
            href="/assets"
            icon={LineChart}
            title="Inspect an asset"
            body="Look at a single ticker's history, drawdowns and monthly returns before adding it."
          />
        </section>
      </PageBody>
    </>
  );
}

function NextStep({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4 text-primary" />
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
    </Link>
  );
}
