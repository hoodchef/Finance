'use client';

import * as React from 'react';
import { AlertCircle, CheckCircle2, FlaskConical, Play, XCircle } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatPercent } from '@/lib/format';
import { useWorkspace } from '@/store/workspace';
import { cn } from '@/lib/utils';

interface LabResponse {
  summary: {
    start: string;
    end: string;
    tradingDays: number;
    transactions: number;
    elapsedMs: number;
    engineVersion: string;
  };
  identity: Record<string, number | boolean>;
  perSymbol: Array<{
    symbol: string;
    openShares: number;
    openCostBasis: number;
    realised: number;
    unrealised: number;
    dividends: number;
  }>;
  metrics: { returns: Record<string, number>; risk: Record<string, number> };
  warnings: Array<{ severity: string; code: string; message: string }>;
  dataSource: {
    providerLabel: string;
    synthetic: boolean;
    symbols: Array<{ symbol: string; source: string; synthetic: boolean }>;
  };
  universe: { count: number; source: string } | null;
  queue: { active: number; queued: number; retained: number; maxConcurrent: number };
}

/** One assertion the Lab checks and reports rather than hiding in a test file. */
interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function buildChecks(d: LabResponse): Check[] {
  const id = d.identity as Record<string, number> & { closes: boolean };
  const anySynthetic = d.dataSource.synthetic || d.dataSource.symbols.some((s) => s.synthetic);
  const blocking = d.warnings.filter((w) => w.severity === 'error');

  return [
    {
      name: 'Ledger closes',
      passed: Boolean(id.closes),
      detail: `Reported gain ${formatCurrency(id.reportedGain)} against ${formatCurrency(
        id.rebuiltGain,
      )} rebuilt from realised, unrealised, dividends and costs. Residual ${formatCurrency(
        id.residual,
      )}.`,
    },
    {
      name: 'Data is real',
      passed: !anySynthetic,
      detail: anySynthetic
        ? 'At least one series is synthetic. Results here are not a backtest.'
        : `Every series came from ${d.dataSource.providerLabel}.`,
    },
    {
      name: 'No blocking warnings',
      passed: blocking.length === 0,
      detail: blocking.length
        ? blocking.map((w) => w.code).join(', ')
        : `${d.warnings.length} advisory warning(s), none blocking.`,
    },
    {
      name: 'Calendar is populated',
      passed: d.summary.tradingDays > 20,
      detail: `${d.summary.tradingDays.toLocaleString()} points over ${d.summary.start} – ${d.summary.end}.`,
    },
    {
      name: 'Metrics are finite',
      passed: [
        ...Object.values(d.metrics.returns),
        ...Object.values(d.metrics.risk),
      ].every((v) => typeof v !== 'number' || Number.isFinite(v)),
      detail: 'Every reported return and risk statistic is a finite number.',
    },
  ];
}

/**
 * The Lab.
 *
 * A place to interrogate the engine rather than admire it. It runs the loaded
 * portfolio and reports the quantities the product surfaces nowhere else: the
 * two independent statements of the same gain and the residual between them,
 * the per-symbol ledger, the provenance of every series, and a set of checks
 * that either pass or say why not.
 *
 * The ledger check is the one that matters. Every metric in the app is derived
 * from these totals, and a derived number looks equally plausible whether or
 * not its inputs agree with each other.
 */
export function LabView() {
  const draft = useWorkspace((s) => s.draft);
  const config = useWorkspace((s) => s.config);

  const [data, setData] = React.useState<LabResponse | null>(null);
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
      const res = await fetch('/api/lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          portfolio: { id: draft.id, name: draft.name, positions: draft.positions },
          config,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Inspection failed.');
      if (!ac.signal.aborted) setData(json as LabResponse);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Inspection failed.');
    } finally {
      if (!ac.signal.aborted) setPending(false);
    }
  }

  React.useEffect(() => () => controller.current?.abort(), []);

  const checks = data ? buildChecks(data) : [];
  const failing = checks.filter((c) => !c.passed);

  return (
    <>
      <PageHeader
        title="Lab"
        description="Run the loaded portfolio and inspect what the engine actually computed — the ledger, the reconciliation, the provenance, and every warning."
        actions={
          <Button onClick={run} disabled={pending}>
            {pending ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Inspecting…
              </>
            ) : (
              <>
                <Play />
                {data ? 'Re-inspect' : 'Inspect'}
              </>
            )}
          </Button>
        }
      />

      <PageBody className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="leading-relaxed">{error}</p>
          </div>
        )}

        {pending && !data && <Skeleton className="h-80 w-full" />}

        {!data && !pending && !error && (
          <Card>
            <CardContent>
              <EmptyState
                icon={FlaskConical}
                title="Nothing inspected yet"
                description="Runs the portfolio currently loaded in the Backtest page and opens up its internals. Change the portfolio or the settings there, then re-inspect to see what moved."
                className="border-0 py-16"
              />
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <Card
              className={cn(
                failing.length > 0 && 'border-destructive/40',
                failing.length === 0 && 'border-[hsl(var(--success))]/40',
              )}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  Checks
                  <Badge variant={failing.length ? 'negative' : 'positive'}>
                    {failing.length ? `${failing.length} failing` : 'all passing'}
                  </Badge>
                  <span className="ml-auto text-2xs font-normal text-muted-foreground">
                    engine {data.summary.engineVersion} · {data.summary.elapsedMs} ms
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {checks.map((c) => (
                  <div key={c.name} className="flex items-start gap-2 text-xs">
                    {c.passed ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
                    ) : (
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-muted-foreground">{c.detail}</div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Ledger</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[26rem] text-xs">
                  <tbody>
                    {(
                      [
                        ['Ending value', 'endingValue'],
                        ['Net invested', 'netInvested'],
                        ['Contributions', 'contributions'],
                        ['Withdrawals', 'withdrawals'],
                        ['Dividends', 'dividends'],
                        ['Cash interest', 'cashInterest'],
                        ['Management fees', 'managementFees'],
                        ['Expense ratio cost', 'expenseRatioCost'],
                        ['Trading costs', 'tradingCosts'],
                        ['Realised gain', 'realised'],
                        ['Unrealised gain', 'unrealised'],
                      ] as const
                    ).map(([label, key]) => (
                      <tr key={key} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 text-muted-foreground">{label}</td>
                        <td className="numeric py-1.5 text-right">
                          {formatCurrency(Number(data.identity[key]))}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-border/50 font-medium">
                      <td className="py-1.5 pr-3">Reported gain</td>
                      <td className="numeric py-1.5 text-right">
                        {formatCurrency(Number(data.identity.reportedGain))}
                      </td>
                    </tr>
                    <tr className="font-medium">
                      <td className="py-1.5 pr-3">Rebuilt from components</td>
                      <td className="numeric py-1.5 text-right">
                        {formatCurrency(Number(data.identity.rebuiltGain))}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-3 text-muted-foreground">Residual</td>
                      <td
                        className={cn(
                          'numeric py-1.5 text-right',
                          data.identity.closes
                            ? 'text-[hsl(var(--success))]'
                            : 'text-destructive font-medium',
                        )}
                      >
                        {formatCurrency(Number(data.identity.residual))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Per holding</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">Symbol</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Shares</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Cost basis</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Realised</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Unrealised</th>
                      <th className="py-1.5 text-right font-medium">Dividends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perSymbol.map((r) => (
                      <tr key={r.symbol} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-3 font-medium">{r.symbol}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{r.openShares.toFixed(4)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatCurrency(r.openCostBasis)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">{formatCurrency(r.realised)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {formatCurrency(r.unrealised)}
                        </td>
                        <td className="numeric py-1.5 text-right">{formatCurrency(r.dividends)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Job queue</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
                  {(
                    [
                      ['Running', data.queue.active, `of ${data.queue.maxConcurrent} slots`],
                      ['Waiting', data.queue.queued, 'ahead in line'],
                      ['Retained', data.queue.retained, 'results still readable'],
                      ['Concurrency', data.queue.maxConcurrent, 'hard cap'],
                    ] as const
                  ).map(([label, value, sub]) => (
                    <div key={label} className="bg-card px-3 py-2">
                      <div className="text-2xs uppercase tracking-wide text-muted-foreground">
                        {label}
                      </div>
                      <div className="numeric mt-0.5 text-base font-semibold">{value}</div>
                      <div className="text-2xs text-muted-foreground">{sub}</div>
                    </div>
                  ))}
                </div>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Simulations and correlated runs are queued rather than held open on the request.
                  Jobs live in this process, so a restart loses them and a second server instance
                  would not see them &mdash; that is the current limit, not a bug.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Provenance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Provider chain</span>
                  <Badge variant={data.dataSource.synthetic ? 'negative' : 'outline'}>
                    {data.dataSource.providerLabel}
                  </Badge>
                  {data.universe && (
                    <span className="text-muted-foreground">
                      · universe {data.universe.count.toLocaleString()} from {data.universe.source}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.dataSource.symbols.map((s) => (
                    <Badge key={s.symbol} variant={s.synthetic ? 'negative' : 'outline'}>
                      {s.symbol} · {s.source}
                    </Badge>
                  ))}
                </div>
                {data.warnings.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {data.warnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-muted-foreground">
                        <Badge variant={w.severity === 'error' ? 'negative' : 'warning'}>
                          {w.code}
                        </Badge>
                        <span className="leading-relaxed">{w.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}
