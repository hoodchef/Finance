'use client';

import * as React from 'react';
import { Pause, Play, RotateCcw, Search } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatCurrency, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  binPrice,
  buildRidge,
  latticeOutcomes,
  layoutRelationshipGraph,
  percentile,
  riskNeutralUpProbability,
  runLattice,
} from '@/lib/lattice/distribution';
import { useWorkspace } from '@/store/workspace';
import { useActiveTicker, useTickerStore } from '@/store/ticker';
import {
  alignSeries,
  correlationMatrix,
  InsufficientHistoryError,
  periodsPerYear,
  realizedVolatility,
  type DatedClose,
} from '@/lib/lattice/realized';

/**
 * The distribution lab.
 * =============================================================================
 * Three pictures of one fact, and the point of putting them on one page is
 * that they are the SAME arithmetic rather than three topics.
 *
 *  - The lattice is the binomial option model, drawn. A ball choosing left or
 *    right at each peg is a price stepping up or down at each node, and it
 *    runs on the tree's own risk-neutral probability — so the pile leans by
 *    exactly the drift the model charges for.
 *  - The ridge is that same terminal distribution at successive horizons,
 *    which is where the square-root-of-time law stops being a formula.
 *  - The graph is the correlation between holdings, which decides whether
 *    those distributions add up or cancel out.
 *
 * Every number is computed here from the parameters on screen. Nothing is a
 * market quote, nothing is a trading record, and the page says so rather than
 * letting a large figure imply otherwise.
 */

const LEVELS = 24;
const TRIALS = 6000;

export function LatticeView() {
  const positions = useWorkspace((s) => s.draft.positions);

  const [ticker, setTicker] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<Array<{ ticker: string; name: string }>>([]);
  const [openHits, setOpenHits] = React.useState(false);
  const [measured, setMeasured] = React.useState<{
    symbol: string;
    name: string | null;
    spot: number;
    volatility: number;
    observations: number;
    from: string;
    to: string;
    perYear: number;
  } | null>(null);
  const [measureNote, setMeasureNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [corr, setCorr] = React.useState<{
    symbols: string[];
    matrix: number[][];
    dates: number;
    from: string;
    to: string;
  } | null>(null);
  const [corrNote, setCorrNote] = React.useState<string | null>(null);

  const [spot, setSpot] = React.useState(100);
  const [vol, setVol] = React.useState(0.25);
  const [rate, setRate] = React.useState(0.04);
  const [years, setYears] = React.useState(1);
  const [seed, setSeed] = React.useState(42);
  const [running, setRunning] = React.useState(true);
  const [dropped, setDropped] = React.useState(0);

  /* ---------------- Measurement ---------------- */

  const activeFocus = useActiveTicker();
  const publishTicker = useTickerStore((s) => s.setTicker);
  const adopted = React.useRef(false);

  /** Fetches daily closes for one symbol over roughly two years. */
  const closesFor = React.useCallback(async (symbol: string): Promise<DatedClose[]> => {
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
      date: b.date,
      close: b.close,
    }));
  }, []);

  /**
   * Measures the spot and volatility a security actually had.
   *
   * The volatility is the standard deviation of log returns annualised by the
   * observed frequency, not a number typed into a box. It is what makes the
   * lattice a statement about this security rather than an illustration.
   */
  const measure = React.useCallback(
    async (symbol: string) => {
      const up = symbol.trim().toUpperCase();
      if (!up) return;
      setBusy(true);
      setMeasureNote(null);
      try {
        const closes = await closesFor(up);
        const v = realizedVolatility(closes);
        const last = closes[closes.length - 1];
        setMeasured({
          symbol: up,
          name: null,
          spot: last.close,
          volatility: v,
          observations: closes.length,
          from: closes[0].date,
          to: last.date,
          perYear: periodsPerYear(closes),
        });
        setSpot(Number(last.close.toFixed(2)));
        setVol(v);
        setTicker(up);
        publishTicker(up);
      } catch (e) {
        setMeasured(null);
        setMeasureNote(
          e instanceof InsufficientHistoryError
            ? e.message
            : e instanceof Error
              ? e.message
              : `Could not measure ${up}.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [closesFor, publishTicker],
  );

  React.useEffect(() => {
    if (adopted.current || !activeFocus?.symbol) return;
    adopted.current = true;
    void measure(activeFocus.symbol);
  }, [activeFocus, measure]);

  /* Autocomplete, debounced so a fast typist does not spend the rate limit. */
  React.useEffect(() => {
    if (query.trim().length < 1) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/chart/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: query.trim() }),
        });
        const body = await res.json();
        setHits(Array.isArray(body.results) ? body.results.slice(0, 8) : []);
      } catch {
        setHits([]);
      }
    }, 220);
    return () => window.clearTimeout(t);
  }, [query]);

  /* ---------------- Computation, all pure ---------------- */

  const pUp = React.useMemo(
    () =>
      riskNeutralUpProbability({
        riskFreeRate: rate,
        dividendYield: 0,
        volatility: vol,
        years,
        steps: LEVELS,
      }),
    [rate, vol, years],
  );

  const lattice = React.useMemo(
    () => runLattice({ levels: LEVELS, trials: TRIALS, pUp, seed }),
    [pUp, seed],
  );

  const outcomes = React.useMemo(
    () => latticeOutcomes(lattice, { spot, volatility: vol, years }),
    [lattice, spot, vol, years],
  );

  const ridge = React.useMemo(
    () =>
      buildRidge({
        spot,
        volatility: vol,
        riskFreeRate: rate,
        dividendYield: 0,
        reference: spot,
        horizons: [
          { years: years * 0.25, label: `${Math.round(years * 3)}M` },
          { years: years * 0.5, label: `${Math.round(years * 6)}M` },
          { years, label: `${years}Y` },
          { years: years * 2, label: `${years * 2}Y` },
          { years: years * 3, label: `${years * 3}Y` },
        ],
      }),
    [spot, vol, rate, years],
  );

  /*
   * The graph runs on the holdings in the workspace. With fewer than two there
   * is nothing to relate, so it says so rather than drawing a lone dot.
   *
   * Correlations here are ILLUSTRATIVE: computing real ones needs overlapping
   * price history for every pair, which is the backtest engine's job, not this
   * page's. The panel labels them as such — a plausible-looking correlation
   * nobody measured is exactly the kind of number this codebase refuses to
   * present as fact.
   */
  const symbols = React.useMemo(
    () => [...new Set(positions.map((p) => p.symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 10),
    [positions],
  );

  /**
   * Measures the correlations, on the dates every holding actually traded.
   *
   * Capped at five symbols because the data plan allows about five requests a
   * minute; asking for more turns a page load into a rate limit. The cap is
   * stated on screen rather than silently truncating the portfolio.
   */
  const measureCorrelations = React.useCallback(async () => {
    if (symbols.length < 2) return;
    setBusy(true);
    setCorrNote(null);
    try {
      const wanted = symbols.slice(0, 5);
      const series: Record<string, DatedClose[]> = {};
      for (const sym of wanted) {
        series[sym] = await closesFor(sym);
      }
      const aligned = alignSeries(series);
      setCorr({
        symbols: aligned.symbols,
        matrix: correlationMatrix(aligned),
        dates: aligned.dates.length,
        from: aligned.dates[0],
        to: aligned.dates[aligned.dates.length - 1],
      });
      if (symbols.length > wanted.length) {
        setCorrNote(
          `Measured the first ${wanted.length} of ${symbols.length} holdings — the data plan ` +
            'allows about five requests a minute.',
        );
      }
    } catch (e) {
      setCorr(null);
      setCorrNote(
        e instanceof InsufficientHistoryError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Correlations could not be measured.',
      );
    } finally {
      setBusy(false);
    }
  }, [symbols, closesFor]);

  const graph = React.useMemo(() => {
    if (!corr || corr.symbols.length < 2) return null;
    return layoutRelationshipGraph({
      symbols: corr.symbols,
      correlation: corr.matrix,
      threshold: 0.3,
      seed: 9,
    });
  }, [corr]);

  /* Animate the pile filling, so the convergence is watched rather than shown. */
  React.useEffect(() => {
    setDropped(0);
  }, [lattice]);

  React.useEffect(() => {
    if (!running || dropped >= TRIALS) return;
    const id = window.setTimeout(() => setDropped((d) => Math.min(TRIALS, d + 90)), 16);
    return () => window.clearTimeout(id);
  }, [running, dropped]);

  const shown = React.useMemo(() => {
    if (dropped >= TRIALS) return lattice.bins;
    // Fill bins in proportion, so the shape emerges rather than filling left
    // to right — the emergence is the thing worth watching.
    const scale = dropped / TRIALS;
    return lattice.bins.map((b) => Math.round(b * scale));
  }, [lattice, dropped]);

  const median = percentile(outcomes, 0.5);
  const p05 = percentile(outcomes, 0.05);
  const p95 = percentile(outcomes, 0.95);
  const forward = spot * Math.exp(rate * years);

  return (
    <>
      <PageHeader
        title="Distribution lab"
        description="One piece of mathematics, three ways: the lattice that prices an option, the shape it leaves at each horizon, and how holdings move together."
      />

      <PageBody className="space-y-4">
        {/* Session strip */}
        <Card>
          <CardContent className="p-0">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-2.5">
              <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Binomial lattice · risk-neutral · {LEVELS} steps
              </span>
              <span className="numeric ml-auto text-2xs text-muted-foreground">
                {dropped.toLocaleString()} / {TRIALS.toLocaleString()} paths
              </span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs"
                  onClick={() => setRunning((r) => !r)}>
                  {running ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  {running ? 'Pause' : 'Run'}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs"
                  onClick={() => { setSeed((s) => s + 1); setRunning(true); }}>
                  <RotateCcw className="h-3 w-3" />
                  Reseed
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
              <Figure label="Spot" value={formatCurrency(spot)} />
              <Figure label="Forward" value={formatCurrency(forward)} sub={`${formatPercent(rate, 1)} · ${years}y`} />
              <Figure label="Median outcome" value={formatCurrency(median)} />
              <Figure label="5th percentile" value={formatCurrency(p05)} tone="negative" />
              <Figure label="95th percentile" value={formatCurrency(p95)} tone="positive" />
              <Figure label="Up-step p" value={pUp.toFixed(4)} sub="risk-neutral" />
            </div>
          </CardContent>
        </Card>

        {/* Search */}
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="relative max-w-xl">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setOpenHits(true); }}
                onFocus={() => setOpenHits(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && query.trim()) {
                    void measure(query.trim());
                    setQuery('');
                    setOpenHits(false);
                  }
                  if (e.key === 'Escape') setOpenHits(false);
                }}
                placeholder="Measure a security — AAPL, MSFT, KO…"
                className="pl-8 text-xs"
                aria-label="Search a security to measure"
              />
              {openHits && hits.length > 0 && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                  {hits.map((h) => (
                    <button
                      key={h.ticker}
                      type="button"
                      onClick={() => { void measure(h.ticker); setQuery(''); setOpenHits(false); }}
                      className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
                    >
                      <span className="numeric text-xs font-medium">{h.ticker}</span>
                      <span className="truncate text-2xs text-muted-foreground">{h.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {measured ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">{measured.symbol}</span> measured
                from <span className="numeric">{measured.observations}</span> closes,{' '}
                <span className="numeric">{measured.from}</span> to{' '}
                <span className="numeric">{measured.to}</span>. Realised volatility{' '}
                <span className="numeric font-medium text-foreground">
                  {formatPercent(measured.volatility, 1)}
                </span>{' '}
                — the standard deviation of daily log returns, annualised by the observed
                frequency, not a number typed into a box.
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {measureNote ??
                  'Search a security to drive the lattice from its own measured volatility, or set the inputs by hand below.'}
              </p>
            )}
            {measured && measureNote && (
              <p className="text-xs leading-relaxed text-negative">{measureNote}</p>
            )}
          </CardContent>
        </Card>

        {/* Controls */}
        <Card>
          <CardContent className="flex flex-wrap items-end gap-4 p-4">
            <Num label="Spot" value={spot} step={5} onChange={setSpot} />
            <Num label="Volatility %" value={Math.round(vol * 100)} step={1}
              onChange={(v) => setVol(Math.max(0.01, v / 100))} />
            <Num label="Rate %" value={Math.round(rate * 1000) / 10} step={0.5}
              onChange={(v) => setRate(v / 100)} />
            <Num label="Horizon (years)" value={years} step={1} onChange={(v) => setYears(Math.max(1, v))} />
            <p className="ml-auto max-w-md text-xs leading-relaxed text-muted-foreground">
              These drive every figure below. Searching a security replaces the spot and
              volatility with its measured ones; edit them here to ask a what-if instead. The
              distributions are model output, never a quote or a record of trades.
            </p>
          </CardContent>
        </Card>

        {/* The lattice */}
        <Card>
          <CardContent className="p-4">
            <Header
              title="Probability lattice"
              detail={`${TRIALS.toLocaleString()} paths · one board · ${LEVELS} steps`}
            />
            <LatticeBoard bins={shown} expected={lattice.expected} levels={LEVELS}
              spot={spot} vol={vol} years={years} complete={dropped >= TRIALS} />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Each ball takes {LEVELS} independent steps, up with probability{' '}
              <span className="numeric">{pUp.toFixed(4)}</span> — the same risk-neutral
              probability a Cox–Ross–Rubinstein tree uses to price an option. The outline is the
              exact binomial. Nobody draws that curve; it is what {TRIALS.toLocaleString()}
              {' '}independent coin flips leave behind.
            </p>
          </CardContent>
        </Card>

        {/* The ridge */}
        <Card>
          <CardContent className="p-4">
            <Header title="Tail probability ridge" detail="terminal distribution by horizon" />
            <RidgePlot ridge={ridge} spot={spot} />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              The same distribution at each horizon, drawn on one shared price axis so the
              widening is visible. Uncertainty grows with the square root of time, not with
              time — four years is twice as uncertain as one, not four times.
            </p>
          </CardContent>
        </Card>

        {/* The graph */}
        <Card>
          <CardContent className="p-4">
            <Header title="Relationship graph" detail={`${symbols.length} holdings`} />
            {graph ? (
              <>
                <RelationshipGraphView graph={graph} />
                <p className="mt-2 rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Measured.</span> Pearson
                  correlation of daily log returns over the{' '}
                  <span className="numeric">{corr?.dates ?? 0}</span> days every holding actually
                  traded, {corr?.from} to {corr?.to}. Only shared dates are used: filling a gap
                  where one symbol did not trade inserts a zero return that drags correlations
                  toward zero, and makes a portfolio look better diversified than it is.
                </p>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {symbols.length < 2
                    ? 'Add at least two holdings to a portfolio to see how they relate. With one there is nothing to relate.'
                    : `Measures the correlation between ${symbols.length} holdings from their own price history.`}
                </p>
                {symbols.length >= 2 && (
                  <Button size="sm" variant="outline" onClick={() => void measureCorrelations()}
                    disabled={busy}>
                    {busy ? 'Measuring…' : 'Measure correlations'}
                  </Button>
                )}
                {corrNote && (
                  <p className="text-xs leading-relaxed text-muted-foreground">{corrNote}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Header({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 border-b border-border pb-2">
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-2xs uppercase tracking-[0.18em] text-muted-foreground">{detail}</span>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="bg-card p-3">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'numeric text-lg font-semibold leading-tight',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Num({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 text-xs"
      />
    </div>
  );
}

/** The board: pegs, the pile, and the exact binomial drawn over it. */
function LatticeBoard({
  bins,
  expected,
  levels,
  spot,
  vol,
  years,
  complete,
}: {
  bins: number[];
  expected: number[];
  levels: number;
  spot: number;
  vol: number;
  years: number;
  complete: boolean;
}) {
  const W = 1000;
  const H = 340;
  const pegTop = 16;
  const pegBottom = H * 0.56;
  const binTop = pegBottom + 12;
  const binH = H - binTop - 22;

  const colW = W / (levels + 1);
  const maxBin = Math.max(1, ...expected);

  const pegs: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < levels; row++) {
    const y = pegTop + ((pegBottom - pegTop) * row) / Math.max(1, levels - 1);
    for (let i = 0; i <= row; i++) {
      pegs.push({ x: W / 2 + (i - row / 2) * colW, y });
    }
  }

  // The exact binomial as a path over the bins.
  const curve = expected
    .map((e, k) => `${k === 0 ? 'M' : 'L'}${(k + 0.5) * colW},${binTop + binH - (e / maxBin) * binH}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
      aria-label="Probability lattice">
      {pegs.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="hsl(var(--muted-foreground))"
          fillOpacity={0.32} />
      ))}

      {bins.map((count, k) => {
        const h = (count / maxBin) * binH;
        const price = binPrice({ spot, volatility: vol, years, steps: levels, upMoves: k });
        const up = price >= spot;
        return (
          <rect
            key={k}
            x={k * colW + colW * 0.12}
            y={binTop + binH - h}
            width={colW * 0.76}
            height={Math.max(0, h)}
            fill={up ? 'hsl(var(--positive))' : 'hsl(var(--negative))'}
            fillOpacity={0.55}
          />
        );
      })}

      <path d={curve} fill="none" stroke="hsl(var(--foreground))" strokeOpacity={complete ? 0.75 : 0.3}
        strokeWidth={1.25} strokeDasharray={complete ? undefined : '3 3'} />

      <line x1={0} x2={W} y1={binTop + binH} y2={binTop + binH} stroke="hsl(var(--border))" />

      {[0, Math.floor(levels / 2), levels].map((k) => (
        <text key={k} x={(k + 0.5) * colW} y={H - 6} textAnchor="middle" fontSize={10}
          className="numeric" fill="hsl(var(--muted-foreground))">
          {binPrice({ spot, volatility: vol, years, steps: levels, upMoves: k }).toFixed(0)}
        </text>
      ))}
    </svg>
  );
}

/** Overlapping densities, back to front, on one shared axis. */
function RidgePlot({
  ridge,
  spot,
}: {
  ridge: ReturnType<typeof buildRidge>;
  spot: number;
}) {
  const W = 1000;
  const H = 340;
  const rowH = H / (ridge.bands.length + 1.4);
  /*
   * Each band is scaled to its OWN peak, not to a shared one.
   *
   * Sharing a vertical scale looks principled and renders as five flat lines:
   * the grid has to span the widest horizon, so the near ones are a tall
   * narrow spike and everything else is a smear along the axis. The
   * comparison that matters here is WIDTH, which the shared x-axis already
   * carries — scaling each to its own height is what makes the width legible.
   */
  const peakOf = (d: number[]) => Math.max(...d) || 1;
  const xOf = (i: number) => (i / (ridge.grid.length - 1)) * W;
  const spotX =
    ((spot - ridge.grid[0]) / (ridge.grid[ridge.grid.length - 1] - ridge.grid[0])) * W;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
      aria-label="Terminal distribution by horizon">
      <line x1={spotX} x2={spotX} y1={0} y2={H - 18} stroke="hsl(var(--foreground))"
        strokeOpacity={0.35} strokeDasharray="3 3" />

      {/* Furthest horizon first, so nearer ones sit in front. */}
      {[...ridge.bands].reverse().map((band, revIndex) => {
        const index = ridge.bands.length - 1 - revIndex;
        const baseline = rowH * (index + 1.25);
        // Taller than the row so bands overlap, which is what makes a ridge a
        // ridge rather than five separate charts stacked.
        const amp = rowH * 2.1;
        const bandPeak = peakOf(band.density);
        const d = band.density
          .map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${baseline - (v / bandPeak) * amp}`)
          .join(' ');
        return (
          <g key={band.label}>
            <path d={`${d} L${W},${baseline} L0,${baseline} Z`}
              fill={`hsl(var(--series-${index % 15}))`} fillOpacity={0.32} />
            <path d={d} fill="none" stroke={`hsl(var(--series-${index % 15}))`} strokeWidth={1.9} />
            <text x={6} y={baseline - 4} fontSize={10} className="numeric"
              fill="hsl(var(--muted-foreground))">
              {band.label} · ±{band.oneSigma.toFixed(1)}
            </text>
          </g>
        );
      })}

      {[0, 0.5, 1].map((f) => {
        const i = Math.round(f * (ridge.grid.length - 1));
        return (
          <text key={f} x={Math.min(W - 20, Math.max(20, xOf(i)))} y={H - 4} fontSize={10}
            textAnchor="middle" className="numeric" fill="hsl(var(--muted-foreground))">
            {ridge.grid[i].toFixed(0)}
          </text>
        );
      })}
    </svg>
  );
}

/** Nodes on the unit disc, edges weighted and coloured by sign. */
function RelationshipGraphView({
  graph,
}: {
  graph: NonNullable<ReturnType<typeof layoutRelationshipGraph>>;
}) {
  const S = 360;
  const pad = 34;
  const at = (v: number) => pad + ((v + 1) / 2) * (S - pad * 2);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <svg viewBox={`0 0 ${S} ${S}`} width="100%" height={320} role="img"
      aria-label="How holdings relate">
      {graph.edges.map((e) => {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.a}-${e.b}`}
            x1={at(a.x)} y1={at(a.y)} x2={at(b.x)} y2={at(b.y)}
            stroke={e.correlation >= 0 ? 'hsl(var(--positive))' : 'hsl(var(--negative))'}
            strokeOpacity={0.18 + Math.abs(e.correlation) * 0.5}
            strokeWidth={0.5 + Math.abs(e.correlation) * 2.5}
          />
        );
      })}
      {graph.nodes.map((n) => (
        <g key={n.id}>
          <circle cx={at(n.x)} cy={at(n.y)} r={4 + n.centrality * 7}
            fill="hsl(var(--card))" stroke="hsl(var(--foreground))" strokeOpacity={0.6} />
          <text x={at(n.x)} y={at(n.y) - 10} textAnchor="middle" fontSize={10}
            className="numeric" fill="hsl(var(--foreground))">
            {n.id}
          </text>
        </g>
      ))}
    </svg>
  );
}
