'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Clock } from 'lucide-react';
import { useWorkspace } from '@/store/workspace';
import { useTickerStore } from '@/store/ticker';
import { useHydrated } from '@/hooks/use-hydrated';
import {
  formatPercent,
  formatSignedPercent,
  formatNumber,
  formatDateShort,
  formatCurrencyCompact,
} from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The desk: what this workspace currently knows.
 * =============================================================================
 * The page this replaces explained the product. Three cards headed PLAN, BUILD
 * and ANALYSE described what each section was for, permanently — useful once,
 * and then furniture for every visit after that. A terminal opens on state,
 * not on an introduction.
 *
 * Everything here comes from the persisted workspace: saved runs, the draft
 * being edited, the securities recently in focus. That is deliberate rather
 * than a shortcut. It renders instantly, it works while the price providers
 * are rate-limited, and nothing on the landing page can burn a request budget
 * that a real question needs later.
 *
 * The figures are measurements of backtests already run, not live quotes, and
 * the strip says so rather than leaving a reader to assume otherwise.
 */

/** Tone for a figure where the SIGN carries the meaning. */
function signTone(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'text-positive' : 'text-negative';
}

export function Desk() {
  const hydrated = useHydrated();
  const runs = useWorkspace((s) => s.runs);
  const portfolios = useWorkspace((s) => s.portfolios);
  const recent = useTickerStore((s) => s.recent);

  // Nothing to show before hydration, and nothing to show on a first visit.
  // Both are handled by rendering nothing at all: an empty dashboard frame is
  // worse than no dashboard, and the sections below still introduce the product.
  if (!hydrated) return null;
  if (!runs.length && !recent.length && !portfolios.length) return null;

  const latest = runs[0];
  /*
   * Distinct results only.
   *
   * Re-running the same portfolio saves another run, and a workspace picks up
   * dozens of them — this one held 35, of which one was a distinct answer. Five
   * identical rows is not a comparison, it is a rendering of how many times
   * somebody pressed the button, and it crowds out the runs that do differ.
   *
   * Collapsed on the figures rather than on the label, so two portfolios that
   * happen to share a name still both appear.
   */
  const seen = new Set<string>();
  const comparable = runs.filter((r) => {
    const k = [
      r.label,
      r.summary.start,
      r.summary.end,
      r.summary.cagr,
      r.summary.sharpe,
      r.summary.maxDrawdown,
    ].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);

  return (
    <section aria-label="Where things stand" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Where things stand
        </h2>
        {runs.length > 0 && (
          <Link
            href="/compare"
            className="flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
          >
            All {runs.length} run{runs.length === 1 ? '' : 's'}
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>

      {latest && <LatestRun run={latest} />}
      {comparable.length > 1 && <RunTable runs={comparable} />}
      {recent.length > 0 && <WatchStrip />}
    </section>
  );
}

/**
 * The most recent run, as a hairline-separated tile strip.
 *
 * The house grouping from UI-CONVENTIONS: one block, legible from two columns
 * up to five, rather than a column of full-width stat rows.
 */
function LatestRun({ run }: { run: ReturnType<typeof useWorkspace.getState>['runs'][number] }) {
  const s = run.summary;
  /*
   * Six, not five. The strip is a `gap-px` grid over a border-coloured ground,
   * so a ragged last row does not leave a gap — it leaves a lit rectangle that
   * reads as a sixth tile someone forgot to fill in. Six divides evenly at
   * every column count the strip uses: two, three and six.
   */
  const cells: Array<{ label: string; value: string; tone?: string; sub?: string }> = [
    { label: 'CAGR', value: formatPercent(s.cagr), tone: signTone(s.cagr), sub: 'annualised' },
    { label: 'Total return', value: formatSignedPercent(s.totalReturn), tone: signTone(s.totalReturn), sub: 'time-weighted' },
    { label: 'Sharpe', value: formatNumber(s.sharpe), sub: 'excess / risk' },
    { label: 'Volatility', value: formatPercent(s.volatility), sub: 'annualised' },
    { label: 'Max drawdown', value: formatPercent(s.maxDrawdown), tone: signTone(s.maxDrawdown), sub: 'peak to trough' },
    { label: 'Final value', value: formatCurrencyCompact(s.finalValue), sub: 'end of period' },
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">{run.label}</span>
          <span className="numeric shrink-0 text-2xs text-muted-foreground">
            {formatDateShort(s.start)} → {formatDateShort(s.end)}
          </span>
        </div>
        <span className="text-2xs text-muted-foreground">
          {s.synthetic ? 'Synthetic prices — not a result' : 'Last backtest'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="flex flex-col gap-0.5 bg-card px-3 py-2.5">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {c.label}
            </span>
            <span className={cn('numeric text-lg font-semibold leading-tight', c.tone)}>
              {c.value}
            </span>
            <span className="text-2xs text-muted-foreground">{c.sub}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Recent runs side by side.
 *
 * Comparison is the whole point of keeping runs, and it used to need a trip to
 * another page. Five rows of six figures is small enough to read at a glance
 * and dense enough to be worth the space.
 */
function RunTable({ runs }: { runs: ReturnType<typeof useWorkspace.getState>['runs'] }) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2 pl-3 pr-3 font-medium">Run</th>
            <th className="py-2 pr-3 text-right font-medium">CAGR</th>
            <th className="py-2 pr-3 text-right font-medium">Sharpe</th>
            <th className="py-2 pr-3 text-right font-medium">Vol</th>
            <th className="py-2 pr-3 text-right font-medium">Max DD</th>
            <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Saved</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.runId}
              tabIndex={0}
              role="link"
              onClick={() => router.push('/compare')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') router.push('/compare');
              }}
              className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
            >
              <td className="max-w-[14rem] truncate py-1.5 pl-3 pr-3">{r.label}</td>
              <td className={cn('numeric py-1.5 pr-3 text-right', signTone(r.summary.cagr))}>
                {formatPercent(r.summary.cagr)}
              </td>
              <td className="numeric py-1.5 pr-3 text-right">{formatNumber(r.summary.sharpe)}</td>
              <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                {formatPercent(r.summary.volatility)}
              </td>
              <td className={cn('numeric py-1.5 pr-3 text-right', signTone(r.summary.maxDrawdown))}>
                {formatPercent(r.summary.maxDrawdown)}
              </td>
              <td className="numeric hidden py-1.5 pr-3 text-right text-muted-foreground sm:table-cell">
                {formatDateShort(r.savedAt.slice(0, 10))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Securities recently in focus.
 *
 * The ticker bar carries one security across the pages that are about a
 * security; this is the way back to the others without opening a search box.
 */
function WatchStrip() {
  const recent = useTickerStore((s) => s.recent);
  const setTicker = useTickerStore((s) => s.setTicker);
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="flex items-center gap-1 pr-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden />
        Recent
      </span>
      {recent.slice(0, 8).map((t) => (
        <button
          key={t.symbol}
          type="button"
          onClick={() => {
            setTicker(t.symbol, t.name);
            router.push('/chart');
          }}
          title={t.name ?? t.symbol}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 transition-colors hover:border-input hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="numeric text-2xs font-semibold">{t.symbol}</span>
          {t.name && (
            <span className="hidden max-w-[8rem] truncate text-2xs text-muted-foreground sm:inline">
              {t.name}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
