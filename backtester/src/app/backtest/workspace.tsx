'use client';

import * as React from 'react';
import { AlertCircle, Check, LineChart, Link2, Play, RefreshCw, Save } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { PortfolioBuilder } from '@/components/builder/portfolio-builder';
import { ConfigPanel } from '@/components/config/config-panel';
import { ResultsDashboard } from '@/components/results/results-dashboard';
import { ResultsSkeleton } from '@/components/results/loading-state';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { useBacktest } from '@/hooks/use-backtest';
import { buildShareUrl, decodeShareLink } from '@/lib/share';
import { parseConfig, parsePositions } from '@/lib/validate';
import { useHydrated } from '@/hooks/use-hydrated';
import { totalWeight, useWorkspace } from '@/store/workspace';
import { uid } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

type MobileView = 'portfolio' | 'settings' | 'results';

const MOBILE_TABS: Array<{ id: MobileView; label: string }> = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'settings', label: 'Settings' },
  { id: 'results', label: 'Results' },
];

/**
 * Identifies the inputs a result was produced from. Comparing it against the
 * live inputs tells us when the displayed result no longer matches what the
 * panels show — otherwise editing a weight silently leaves stale numbers on
 * screen, which is the worst possible failure mode for this kind of tool.
 */
function inputSignature(
  draft: { positions: Array<{ symbol: string; weight: number; expenseRatio?: number }> },
  config: unknown,
): string {
  const holdings = draft.positions
    .map((p) => `${p.symbol.trim().toUpperCase()}:${p.weight}:${p.expenseRatio ?? ''}`)
    .join('|');
  return `${holdings}::${JSON.stringify(config)}`;
}

export function BacktestWorkspace() {
  const hydrated = useHydrated();
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);
  const saveDraft = useWorkspace((s) => s.saveDraft);
  const saveRun = useWorkspace((s) => s.saveRun);
  const planAssumptions = useWorkspace((s) => s.planAssumptions);
  const clearPlan = useWorkspace((s) => s.clearPlan);
  const { result, error, pending, run } = useBacktest();

  // Only affects layouts below `lg`; the desktop grid shows everything at once.
  const [mobileView, setMobileView] = React.useState<MobileView>('portfolio');
  const [saved, setSaved] = React.useState(false);
  const [ranSignature, setRanSignature] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [shareError, setShareError] = React.useState<string | null>(null);
  const setDraft = useWorkspace((s) => s.setDraft);
  const setConfig = useWorkspace((s) => s.setConfig);

  const signature = inputSignature(draft, config);
  const stale = result != null && ranSignature != null && ranSignature !== signature;

  const validHoldings = draft.positions.filter((p) => p.symbol.trim() && p.weight > 0);
  const canRun = validHoldings.length > 0 && !pending;
  const total = totalWeight(draft.positions);

  const onRun = React.useCallback(async () => {
    if (validHoldings.length === 0 || pending) return;
    setMobileView('results');
    const outcome = await run(draft, config);
    if (outcome) {
      setRanSignature(inputSignature(draft, config));
      // Every completed run is recorded with an immutable snapshot of the
      // portfolio and config behind it, so a later edit cannot rewrite what
      // this result measured.
      saveRun(outcome);
    }
  }, [validHoldings.length, pending, run, draft, config, saveRun]);

  // A shared link is untrusted input, so it goes through the same validation a
  // typed request does before any of it reaches the store.
  React.useEffect(() => {
    if (!hydrated) return;
    const encoded = new URLSearchParams(window.location.search).get('s');
    if (!encoded) return;

    const decoded = decodeShareLink(encoded);
    if (!decoded) {
      setShareError('That shared link could not be read. It may be truncated or from an older version.');
      return;
    }

    try {
      const positions = parsePositions(decoded.portfolio.positions);
      const config = parseConfig(decoded.config);
      const now = new Date().toISOString();
      setDraft({
        id: uid('pf'),
        name: decoded.portfolio.name,
        positions,
        createdAt: now,
        updatedAt: now,
      });
      setConfig(config);
      // Drop the parameter so a later edit is not silently overwritten by a
      // reload, and so the address bar reflects the live state.
      window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
      setShareError(
        err instanceof Error
          ? `That shared link is not valid: ${err.message}`
          : 'That shared link could not be loaded.',
      );
    }
    // Runs once after hydration; the link is consumed and cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void onRun();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRun]);

  async function onShare() {
    const url = buildShareUrl(window.location.origin, draft, config);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard access can be denied; putting the link in the address bar
      // still lets the user copy it manually.
      window.history.replaceState({}, '', `${window.location.pathname}?s=${url.split('?s=')[1]}`);
      setShareError('Clipboard access was blocked. The link is now in the address bar — copy it from there.');
    }
  }

  function onSave() {
    saveDraft();
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }

  return (
    <>
      <PageHeader
        title="Backtest"
        description="Build a portfolio, set the rules, and see what it would have done."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onShare}
              disabled={!validHoldings.length}
            >
              {copied ? <Check /> : <Link2 />}
              {copied ? 'Link copied' : 'Share'}
            </Button>
            <Button variant="outline" size="sm" onClick={onSave} disabled={!validHoldings.length}>
              <Save />
              {saved ? 'Saved' : 'Save portfolio'}
            </Button>
            <Button size="lg" onClick={onRun} disabled={!canRun} className="min-w-[9.5rem]">
              {pending ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Running…
                </>
              ) : (
                <>
                  <Play />
                  Run backtest
                </>
              )}
            </Button>
          </>
        }
      />

      {/* Section switcher, small screens only. */}
      <div className="sticky top-12 z-20 border-b border-border bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
        <div
          role="tablist"
          aria-label="Backtester sections"
          className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1"
        >
          {MOBILE_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={mobileView === t.id}
              onClick={() => setMobileView(t.id)}
              className={cn(
                'rounded px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mobileView === t.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground',
              )}
            >
              {t.label}
              {t.id === 'results' && result && (
                <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle" />
              )}
            </button>
          ))}
        </div>
      </div>

      <PageBody className="grid items-start gap-5 lg:grid-cols-[23rem_minmax(0,1fr)] xl:grid-cols-[25rem_minmax(0,1fr)]">
        <div className="space-y-5 lg:sticky lg:top-6">
          <div className={cn(mobileView !== 'portfolio' && 'max-lg:hidden')}>
            {hydrated ? <PortfolioBuilder /> : <PanelPlaceholder className="h-[28rem]" />}
          </div>
          <div className={cn(mobileView !== 'settings' && 'max-lg:hidden')}>
            {hydrated ? <ConfigPanel /> : <PanelPlaceholder className="h-[36rem]" />}
          </div>
        </div>

        <div className={cn('min-w-0 space-y-5', mobileView !== 'results' && 'max-lg:hidden')}>
          {shareError && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" />
              <p className="text-xs leading-relaxed">{shareError}</p>
            </div>
          )}

          {/* Settings carried over from the Planner rest on assumptions the
              Planner made. Applying them silently would let a projection
              inherit a premise the user never saw. */}
          {planAssumptions && planAssumptions.length > 0 && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium">Settings came from your plan</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearPlan}
                  className="text-xs text-muted-foreground"
                >
                  Dismiss
                </Button>
              </div>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
                {planAssumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/8 p-4"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-negative">Backtest failed</p>
                <p className="text-xs leading-relaxed">{error.error}</p>
                {/* Only add a hint when it is actually true. The message above
                    is already specific — a bad ticker, a currency mismatch — and
                    appending "the service is rate-limiting" to it would send
                    someone off diagnosing the wrong problem. */}
                {error.kind === 'market-data' && /rate-limit|refused|unreachable/i.test(error.error) && (
                  <p className="text-xs text-muted-foreground">
                    This is a connectivity or quota problem rather than a mistake in your portfolio.
                    A free Tiingo key raises the ceiling considerably — see Settings.
                  </p>
                )}
              </div>
            </div>
          )}

          {pending && !result && <ResultsSkeleton />}

          {!pending && !result && !error && (
            <EmptyState
              icon={LineChart}
              title="No backtest yet"
              description={
                validHoldings.length === 0
                  ? 'Add at least one holding with a weight above zero, then run the backtest.'
                  : `Ready to test ${validHoldings.length} holding${
                      validHoldings.length === 1 ? '' : 's'
                    } with ${formatCurrency(config.initialInvestment)} from ${config.start}. Press Run backtest, or ⌘↵.`
              }
              action={
                <div className="flex flex-col items-center gap-2">
                  <Button onClick={onRun} disabled={!canRun}>
                    <Play />
                    Run backtest
                  </Button>
                  {Math.abs(total - 100) > 0.005 && validHoldings.length > 0 && (
                    <Badge variant="warning">
                      Weights total {total}% — they will be scaled to 100%
                    </Badge>
                  )}
                </div>
              }
              className="py-20"
            />
          )}

          {stale && !pending && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3">
              <p className="text-xs leading-relaxed">
                These results were produced from earlier settings. The portfolio or configuration
                has changed since.
              </p>
              <Button size="sm" onClick={onRun}>
                <RefreshCw />
                Rerun
              </Button>
            </div>
          )}

          {result && (
            <div className={cn(pending && 'pointer-events-none opacity-60 transition-opacity')}>
              <ResultsDashboard result={result} />
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}

function PanelPlaceholder({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg border border-border bg-card', className)} aria-hidden />;
}
