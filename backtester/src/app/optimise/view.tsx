'use client';

import * as React from 'react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { Sparkles, TriangleAlert } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AXIS_PROPS, GRID_PROPS } from '@/components/charts/chart-chrome';
import { formatPercent } from '@/lib/format';
import { cn, uid } from '@/lib/utils';
import { useWorkspace } from '@/store/workspace';
import {
  alignSeries,
  InsufficientHistoryError,
  periodsPerYear,
  type DatedClose,
} from '@/lib/lattice/realized';
import { generatePortfolio, runSharpeLab, type LabResult } from '@/lib/analysis/sharpe-lab';

/**
 * The Sharpe lab.
 * =============================================================================
 * Two questions with one engine: re-weight what you hold, or build something
 * from a list of candidates.
 *
 * The page is arranged around the number most optimisers bury. A maximum
 * Sharpe solver is handed estimated returns and an estimated covariance, and
 * it seeks out exactly the holdings whose estimates luck flattered — so its
 * in-sample Sharpe measures how well it fitted noise, not what it will earn.
 * Weights are therefore solved on the earlier part of the history and scored
 * on the part the solver never saw, and the out-of-sample column is the one
 * given prominence. Equal weight sits in the same table as the benchmark,
 * because it estimates nothing and is hard to beat for that reason.
 */

type Mode = 'reweight' | 'build';

const PRESETS: Array<{ label: string; symbols: string }> = [
  { label: 'Core ETFs', symbols: 'SPY, QQQ, IWM, TLT, GLD' },
  { label: 'Sectors', symbols: 'XLK, XLF, XLE, XLV, XLP' },
  { label: 'Mega caps', symbols: 'AAPL, MSFT, NVDA, AMZN, GOOGL' },
];

export function OptimiseView() {
  const positions = useWorkspace((s) => s.draft.positions);
  const setDraft = useWorkspace((s) => s.setDraft);
  const draft = useWorkspace((s) => s.draft);

  const [mode, setMode] = React.useState<Mode>('reweight');
  const [candidates, setCandidates] = React.useState('SPY, QQQ, TLT, GLD');
  const [maxWeight, setMaxWeight] = React.useState(40);
  const [trainPct, setTrainPct] = React.useState(70);
  const [riskFree, setRiskFree] = React.useState(4);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<LabResult | null>(null);
  const [kept, setKept] = React.useState<Array<{ symbol: string; weight: number }> | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const held = React.useMemo(
    () => positions.filter((p) => p.symbol.trim()).map((p) => ({
      symbol: p.symbol.trim().toUpperCase(),
      weight: p.weight,
    })),
    [positions],
  );

  const symbols = React.useMemo(() => {
    if (mode === 'reweight') return [...new Set(held.map((h) => h.symbol))];
    return [...new Set(
      candidates.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
    )];
  }, [mode, held, candidates]);

  async function closesFor(symbol: string): Promise<DatedClose[]> {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch('/api/chart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker: symbol, timespan: 'day', from, to }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Could not load ${symbol}.`);
    return (body.bars ?? []).map((b: { date: string; close: number }) => ({
      date: b.date, close: b.close,
    }));
  }

  async function run() {
    if (symbols.length < 2) {
      setNote('At least two holdings are needed — there is nothing to weight otherwise.');
      return;
    }
    setBusy(true);
    setNote(null);
    setResult(null);
    setKept(null);
    try {
      // Capped at five: the data plan allows about five requests a minute.
      const wanted = symbols.slice(0, 5);
      const series: Record<string, DatedClose[]> = {};
      for (const s of wanted) series[s] = await closesFor(s);

      const aligned = alignSeries(series);
      const perYear = periodsPerYear(series[wanted[0]]);
      const current =
        mode === 'reweight'
          ? aligned.symbols.map((s) => held.find((h) => h.symbol === s)?.weight ?? 0)
          : undefined;

      const options = {
        symbols: aligned.symbols,
        returns: aligned.returns,
        periodsPerYear: perYear,
        riskFree: riskFree / 100,
        maxWeight: maxWeight / 100,
        trainFraction: trainPct / 100,
        current,
      };

      if (mode === 'build') {
        const { result: r, kept: k } = generatePortfolio(options);
        setResult(r);
        setKept(k);
      } else {
        setResult(runSharpeLab(options));
      }

      if (symbols.length > wanted.length) {
        setNote(
          `Used the first ${wanted.length} of ${symbols.length} symbols — the data plan allows ` +
            'about five requests a minute.',
        );
      }
    } catch (e) {
      setNote(
        e instanceof InsufficientHistoryError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'The optimisation could not be run.',
      );
    } finally {
      setBusy(false);
    }
  }

  /** Writes a suggested weighting into the working portfolio. */
  function apply(weights: number[]) {
    if (!result) return;
    setDraft({
      ...draft,
      positions: result.symbols.map((symbol, i) => {
        const existing = positions.find((p) => p.symbol.trim().toUpperCase() === symbol);
        return {
          id: existing?.id ?? uid('pos'),
          symbol,
          name: existing?.name,
          weight: Number((weights[i] * 100).toFixed(2)),
        };
      }),
    });
  }

  const frontierData = React.useMemo(
    () =>
      (result?.frontier ?? []).map((p) => ({
        risk: p.volatility * 100,
        ret: p.expectedReturn * 100,
        sharpe: p.sharpe,
      })),
    [result],
  );

  const marks = React.useMemo(
    () =>
      (result?.candidates ?? []).map((c) => ({
        risk: c.inSample.volatility * 100,
        ret: c.inSample.expectedReturn * 100,
        label: c.label,
      })),
    [result],
  );

  return (
    <>
      <PageHeader
        title="Sharpe lab"
        description="Re-weight what you hold, or build a portfolio from candidates — and see how much of the improvement survives on history the solver never saw."
      />

      <PageBody className="space-y-4">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex gap-0.5">
              {(['reweight', 'build'] as const).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={mode === m ? 'secondary' : 'ghost'}
                  className="h-7 px-3 text-2xs"
                  onClick={() => { setMode(m); setResult(null); setKept(null); setNote(null); }}
                >
                  {m === 'reweight' ? 'Re-weight my holdings' : 'Build a new portfolio'}
                </Button>
              ))}
            </div>

            {mode === 'build' ? (
              <div className="space-y-2">
                <label className="text-2xs uppercase tracking-wide text-muted-foreground">
                  Candidates
                </label>
                <Input
                  value={candidates}
                  onChange={(e) => setCandidates(e.target.value)}
                  placeholder="SPY, QQQ, TLT, GLD"
                  className="max-w-xl text-xs"
                />
                <div className="flex flex-wrap gap-1">
                  {PRESETS.map((p) => (
                    <Button key={p.label} size="sm" variant="ghost" className="h-6 px-2 text-2xs"
                      onClick={() => setCandidates(p.symbols)}>
                      {p.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {held.length
                  ? `Weighting ${symbols.join(', ')} from the working portfolio.`
                  : 'The working portfolio is empty. Add holdings on the Backtest page, or switch to building one.'}
              </p>
            )}

            <div className="flex flex-wrap items-end gap-4">
              <Num label="Max per holding %" value={maxWeight} onChange={setMaxWeight} />
              <Num label="Solve on first %" value={trainPct} onChange={setTrainPct} />
              <Num label="Risk-free %" value={riskFree} step={0.25} onChange={setRiskFree} />
              <Button size="sm" onClick={() => void run()} disabled={busy || symbols.length < 2}>
                <Sparkles className="h-3 w-3" />
                {busy ? 'Measuring…' : mode === 'build' ? 'Build it' : 'Optimise'}
              </Button>
            </div>

            {note && <p className="text-xs leading-relaxed text-negative">{note}</p>}
          </CardContent>
        </Card>

        {result && (
          <>
            {/* The warning comes before the numbers, not after them. */}
            <Card>
              <CardContent className="flex items-start gap-2.5 p-4">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
                <p className="text-xs leading-relaxed">
                  <span className="font-medium">Read the out-of-sample column.</span>{' '}
                  {result.caveat}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="overflow-x-auto p-4">
                <table className="w-full min-w-[44rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Method</th>
                      <th className="py-2 pr-3 text-right font-medium">In-sample Sharpe</th>
                      <th className="py-2 pr-3 text-right font-medium">Out-of-sample Sharpe</th>
                      <th className="py-2 pr-3 text-right font-medium">Kept</th>
                      <th className="py-2 pr-3 text-right font-medium">Return</th>
                      <th className="py-2 pr-3 text-right font-medium">Volatility</th>
                      <th className="py-2 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.candidates.map((c) => {
                      const keptFrac =
                        c.inSample.sharpe > 0 && c.outOfSample
                          ? c.outOfSample.sharpe / c.inSample.sharpe
                          : null;
                      return (
                        <tr key={c.id} className={cn(
                          'border-b border-border/50 last:border-0',
                          c.id === 'current' && 'bg-muted/40',
                        )}>
                          <td className="py-2 pr-3">
                            <span className="block font-medium">{c.label}</span>
                            <span className="block max-w-md text-2xs text-muted-foreground">
                              {c.description}
                            </span>
                          </td>
                          <td className="numeric py-2 pr-3 text-right text-muted-foreground">
                            {c.inSample.sharpe.toFixed(2)}
                          </td>
                          <td className={cn(
                            'numeric py-2 pr-3 text-right font-medium',
                            (c.outOfSample?.sharpe ?? 0) >= 0 ? 'text-positive' : 'text-negative',
                          )}>
                            {c.outOfSample ? c.outOfSample.sharpe.toFixed(2) : '—'}
                          </td>
                          <td className="numeric py-2 pr-3 text-right text-muted-foreground">
                            {keptFrac == null ? '—' : formatPercent(keptFrac, 0)}
                          </td>
                          <td className="numeric py-2 pr-3 text-right">
                            {c.outOfSample ? formatPercent(c.outOfSample.expectedReturn, 1) : '—'}
                          </td>
                          <td className="numeric py-2 pr-3 text-right">
                            {c.outOfSample ? formatPercent(c.outOfSample.volatility, 1) : '—'}
                          </td>
                          <td className="py-2">
                            {c.id !== 'current' && (
                              <Button size="sm" variant="ghost" className="h-6 text-2xs"
                                onClick={() => apply(c.weights)}>
                                Apply
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  &ldquo;Kept&rdquo; is the share of the in-sample Sharpe that survived on unseen
                  history. A method keeping well below 100% was fitting the sample, and the
                  in-sample figure was never available to earn.
                </p>
              </CardContent>
            </Card>

            {/* Weights */}
            <Card>
              <CardContent className="overflow-x-auto p-4">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Holding</th>
                      {result.candidates.map((c) => (
                        <th key={c.id} className="py-2 pr-3 text-right font-medium">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.symbols.map((sym, i) => (
                      <tr key={sym} className="border-b border-border/50 last:border-0">
                        <td className="numeric py-1.5 pr-3 font-medium">{sym}</td>
                        {result.candidates.map((c) => (
                          <td key={c.id} className="numeric py-1.5 pr-3 text-right">
                            {(c.weights[i] * 100).toFixed(1)}%
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {kept && (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Built from {result.symbols.length} candidates; {kept.length} earned a place.
                    The solvers are long-only, so selection is not a separate step — anything that
                    does not earn funding simply gets zero.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Frontier */}
            <Card>
              <CardContent className="p-4">
                <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Efficient frontier · solved on the training window
                </div>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 8, right: 12, bottom: 24, left: 8 }}>
                      <CartesianGrid {...GRID_PROPS} />
                      {/* Recharts prints the raw float otherwise: 8.4445977143%. */}
                      <XAxis {...AXIS_PROPS} type="number" dataKey="risk" name="Volatility"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                      <YAxis {...AXIS_PROPS} type="number" dataKey="ret" name="Return"
                        tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                      <ZAxis range={[40, 40]} />
                      <Tooltip contentStyle={{ fontSize: 11 }}
                        formatter={(v: number) => `${v.toFixed(2)}%`} />
                      <Scatter data={frontierData} fill="var(--series-0)" line />
                      <Scatter data={marks} fill="var(--series-4)" />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  The frontier and the marked allocations are drawn on the training window, which
                  is where they look best. It is a picture of the estimate, not of the future.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}

function Num({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</label>
      <Input type="number" step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="w-28 text-xs" />
    </div>
  );
}
