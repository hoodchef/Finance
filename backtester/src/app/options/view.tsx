'use client';

import * as React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Copy, Plus, Trash2 } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AXIS_PROPS, GRID_PROPS } from '@/components/charts/chart-chrome';
import { formatCurrency, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  netDebit,
  payoffCurve,
  summarise,
  valuePosition,
  type OptionLeg,
  type OptionPosition,
} from '@/lib/options/strategy';
import {
  analysePositionProbability,
  defaultScenarios,
  monteCarlo,
  runScenarios,
} from '@/lib/options/analytics';
import { applyPreset, emptyPosition, newLeg, PRESETS, type PresetId } from '@/lib/options/presets';
import { perDay, perPoint } from '@/lib/options/pricing';

/**
 * The options strategy builder.
 *
 * Everything below the chain fetch is computed in the browser from pure
 * functions, which is what lets the payoff, the Greeks and the probabilities
 * move the instant a strike or a premium changes. Only the chain needs a
 * server, because only the chain needs credentials.
 *
 * The layering matters as much as the numbers: a theoretical value is model
 * output and a quote is not, and the page never lets the two share a column
 * without saying which is which.
 */

interface ChainQuote {
  symbol: string;
  type: 'call' | 'put';
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  impliedVolatility: number | null;
}

interface ChainResponse {
  ticker: string;
  spot: number | null;
  spotAsOf: string | null;
  spotSource: string | null;
  spotNote: string | null;
  chain: { quotes: ChainQuote[]; expiries: string[]; source: string; latency: string; fetchedAt: string } | null;
  chainNote: string | null;
  chainConfigured: boolean;
  needsConfiguration: boolean;
  provenance: { underlying: string; chain: string | null; pricing: string };
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const addMonths = (months: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'warn';
  hint?: string;
}) {
  return (
    <div className="border-b border-border/50 px-3 py-2 last:border-0">
      <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          'numeric text-sm font-medium',
          tone === 'positive' && 'text-[hsl(var(--positive))]',
          tone === 'negative' && 'text-[hsl(var(--negative))]',
          tone === 'warn' && 'text-[hsl(var(--negative))]',
        )}
      >
        {value}
      </div>
      {hint && <div className="text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function OptionsView() {
  const [ticker, setTicker] = React.useState('AAPL');
  const [input, setInput] = React.useState('AAPL');
  const [data, setData] = React.useState<ChainResponse | null>(null);
  const [loading, setLoading] = React.useState(false);

  const [position, setPosition] = React.useState<OptionPosition>(() => emptyPosition('AAPL'));
  const [spot, setSpot] = React.useState(200);
  const [spotOverride, setSpotOverride] = React.useState<number | null>(null);
  const [assumedVol, setAssumedVol] = React.useState(0.28);
  const [asOf] = React.useState(todayIso());
  const [mcPaths, setMcPaths] = React.useState(20000);
  const [mcDrift, setMcDrift] = React.useState(0.04);

  const nearExpiry = React.useMemo(() => data?.chain?.expiries[0] ?? addMonths(2), [data]);
  const farExpiry = React.useMemo(
    () => data?.chain?.expiries[Math.min(3, (data?.chain?.expiries.length ?? 1) - 1)] ?? addMonths(9),
    [data],
  );

  const presetCtx = React.useMemo(
    () => ({
      spot,
      nearExpiry,
      farExpiry,
      volatility: assumedVol,
      contracts: 1,
      multiplier: 100,
    }),
    [spot, nearExpiry, farExpiry, assumedVol],
  );

  async function load(symbol: string) {
    setLoading(true);
    try {
      const res = await fetch('/api/options/chain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker: symbol }),
      });
      const body: ChainResponse = await res.json();
      setData(body);
      setTicker(body.ticker ?? symbol);
      if (body.spot) {
        setSpot(body.spot);
        setSpotOverride(null);
      }
      setPosition((p) => ({ ...p, underlying: body.ticker ?? symbol }));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    void load('AAPL');
    // Once, for a starting point. Changing tickers goes through the form.
  }, []);

  const liveSpot = spotOverride ?? spot;

  /* ---------------- Derived analytics, all pure ---------------- */

  const summary = React.useMemo(() => summarise(position), [position]);
  const valuation = React.useMemo(
    () => valuePosition(position, { spot: liveSpot, asOf }),
    [position, liveSpot, asOf],
  );

  const range = React.useMemo(() => {
    const strikes = position.legs.map((l) => l.strike);
    const lo = Math.min(liveSpot * 0.7, ...(strikes.length ? strikes : [liveSpot]));
    const hi = Math.max(liveSpot * 1.3, ...(strikes.length ? strikes : [liveSpot]));
    return { min: Math.max(0.01, lo * 0.9), max: hi * 1.1 };
  }, [position, liveSpot]);

  const curve = React.useMemo(
    () =>
      position.legs.length || position.stock
        ? payoffCurve(position, { ...range, points: 141, asOf })
        : [],
    [position, range, asOf],
  );

  const probability = React.useMemo(
    () =>
      position.legs.length
        ? analysePositionProbability(position, { spot: liveSpot, volatility: assumedVol, asOf })
        : null,
    [position, liveSpot, assumedVol, asOf],
  );

  const scenarios = React.useMemo(
    () =>
      position.legs.length
        ? runScenarios(position, { spot: liveSpot, asOf, scenarios: defaultScenarios() })
        : [],
    [position, liveSpot, asOf],
  );

  const simulation = React.useMemo(
    () =>
      position.legs.length
        ? monteCarlo(position, {
            spot: liveSpot,
            volatility: assumedVol,
            drift: mcDrift,
            asOf,
            paths: mcPaths,
            seed: 42,
          })
        : null,
    [position, liveSpot, assumedVol, mcDrift, mcPaths, asOf],
  );

  /** Greeks across underlying prices, for the curve charts. */
  const greekCurve = React.useMemo(() => {
    if (!position.legs.length) return [];
    const out: Array<{ spot: number; delta: number; gamma: number; theta: number; vega: number }> = [];
    for (let i = 0; i <= 40; i++) {
      const s = range.min + ((range.max - range.min) * i) / 40;
      const v = valuePosition(position, { spot: s, asOf });
      out.push({
        spot: s,
        delta: v.greeks.delta,
        gamma: v.greeks.gamma,
        theta: perDay(v.greeks.theta),
        vega: perPoint(v.greeks.vega),
      });
    }
    return out;
  }, [position, range, asOf]);

  /* ---------------- Leg editing ---------------- */

  const setLeg = (id: string, patch: Partial<OptionLeg>) =>
    setPosition((p) => ({ ...p, legs: p.legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const removeLeg = (id: string) =>
    setPosition((p) => ({ ...p, legs: p.legs.filter((l) => l.id !== id) }));
  const duplicateLeg = (id: string) =>
    setPosition((p) => {
      const found = p.legs.find((l) => l.id === id);
      if (!found) return p;
      return { ...p, legs: [...p.legs, { ...found, id: `${found.id}-copy-${Date.now()}` }] };
    });

  function loadPreset(id: PresetId) {
    const built = applyPreset(id, presetCtx);
    setPosition((p) => ({ ...p, legs: built.legs, stock: built.stock }));
  }

  const missingPremium = position.legs.some((l) => l.entryPremium === 0);

  return (
    <>
      <PageHeader
        title="Options"
        description="Build a multi-leg position and see its payoff, Greeks, probabilities and risk."
        actions={
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void load(input.trim().toUpperCase());
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ticker"
              className="w-28 text-xs"
              aria-label="Ticker"
            />
            <Button size="sm" type="submit" disabled={loading}>
              {loading ? 'Loading…' : 'Load'}
            </Button>
          </form>
        }
      />

      <PageBody className="space-y-4">
        {/* Underlying and data provenance */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
            <div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">
                Underlying
              </div>
              <div className="numeric text-lg font-semibold">
                {ticker} {data?.spot != null ? formatCurrency(data.spot) : '—'}
              </div>
              <div className="text-2xs text-muted-foreground">{data?.provenance.underlying}</div>
            </div>

            <div className="min-w-[12rem]">
              <label htmlFor="opt-spot" className="text-2xs uppercase tracking-wide text-muted-foreground">
                Price to analyse at
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="opt-spot"
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={(range.max - range.min) / 200}
                  value={liveSpot}
                  onChange={(e) => setSpotOverride(Number(e.target.value))}
                  className="w-40"
                />
                <span className="numeric text-sm">{formatCurrency(liveSpot)}</span>
                {spotOverride != null && (
                  <Button size="sm" variant="ghost" onClick={() => setSpotOverride(null)}>
                    Reset
                  </Button>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="opt-vol" className="text-2xs uppercase tracking-wide text-muted-foreground">
                Volatility assumption
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="opt-vol"
                  type="number"
                  min={1}
                  max={300}
                  step={1}
                  value={Math.round(assumedVol * 100)}
                  onChange={(e) => setAssumedVol(Math.max(0.01, Number(e.target.value) / 100))}
                  className="w-20 text-xs"
                />
                <span className="text-2xs text-muted-foreground">% /yr</span>
              </div>
            </div>

            {data?.chain ? (
              <Badge variant="outline" className="gap-1">
                {data.chain.source} · {data.chain.latency}
              </Badge>
            ) : (
              <div className="flex max-w-xl items-start gap-2 rounded-md border border-border bg-muted/40 p-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">No live option chain.</span>{' '}
                  {data?.chainNote ??
                    'No chain provider is configured.'}{' '}
                  Everything below still works — enter legs by hand and the pricing, Greeks and
                  probabilities are computed from them. Nothing here is filled in with invented
                  quotes.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,0.8fr)]">
          {/* LEFT: builder */}
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Legs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select onValueChange={(v) => loadPreset(v as PresetId)}>
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="Load a strategy template…" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {position.legs.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Load a template or add a leg. Every template becomes ordinary legs you can edit.
                </p>
              )}

              <div className="space-y-2">
                {position.legs.map((l) => (
                  <div key={l.id} className="rounded-md border border-border p-2">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Select value={l.side} onValueChange={(v) => setLeg(l.id, { side: v as 'buy' | 'sell' })}>
                        <SelectTrigger className="h-7 w-[4.5rem] text-2xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="buy">Buy</SelectItem>
                          <SelectItem value="sell">Sell</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={l.type} onValueChange={(v) => setLeg(l.id, { type: v as 'call' | 'put' })}>
                        <SelectTrigger className="h-7 w-[4.5rem] text-2xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="call">Call</SelectItem>
                          <SelectItem value="put">Put</SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="ml-auto flex gap-0.5">
                        <button
                          type="button"
                          aria-label="Duplicate leg"
                          onClick={() => duplicateLeg(l.id)}
                          className="rounded p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          aria-label="Remove leg"
                          onClick={() => removeLeg(l.id)}
                          className="rounded p-1 text-muted-foreground hover:text-[hsl(var(--negative))]"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <LegField label="Strike" value={l.strike} step={0.5}
                        onChange={(v) => setLeg(l.id, { strike: v })} />
                      <LegField label="Contracts" value={l.contracts} step={1}
                        onChange={(v) => setLeg(l.id, { contracts: v })} />
                      <LegField label="Premium" value={l.entryPremium} step={0.05}
                        onChange={(v) => setLeg(l.id, { entryPremium: v })} />
                      <LegField label="IV %" value={Math.round(l.impliedVolatility * 1000) / 10} step={1}
                        onChange={(v) => setLeg(l.id, { impliedVolatility: Math.max(0.001, v / 100) })} />
                      <LegField label="Multiplier" value={l.multiplier} step={1}
                        onChange={(v) => setLeg(l.id, { multiplier: Math.max(1, v) })} />
                      <div>
                        <label className="text-2xs text-muted-foreground">Expiry</label>
                        <Input
                          type="date"
                          value={l.expiry}
                          onChange={(e) => setLeg(l.id, { expiry: e.target.value })}
                          className="h-7 text-2xs"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-2xs text-muted-foreground">Exercise</label>
                        <Select value={l.style} onValueChange={(v) => setLeg(l.id, { style: v as 'american' | 'european' })}>
                          <SelectTrigger className="h-7 text-2xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="american">American (binomial)</SelectItem>
                            <SelectItem value="european">European (Black–Scholes)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => setPosition((p) => ({ ...p, legs: [...p.legs, newLeg(presetCtx)] }))}
              >
                <Plus className="h-3 w-3" />
                Add leg
              </Button>

              {position.stock && (
                <div className="rounded-md border border-border p-2 text-2xs">
                  <div className="mb-1 font-medium">Stock</div>
                  <div className="text-muted-foreground">
                    {position.stock.side === 'buy' ? 'Long' : 'Short'} {position.stock.shares} shares
                    at {formatCurrency(position.stock.entryPrice)}
                  </div>
                  <Button size="sm" variant="ghost" className="mt-1 h-6 text-2xs"
                    onClick={() => setPosition((p) => ({ ...p, stock: null }))}>
                    Remove stock
                  </Button>
                </div>
              )}

              {missingPremium && (
                <p className="rounded-md border border-[hsl(var(--negative))]/40 bg-[hsl(var(--negative))]/10 p-2 text-2xs leading-relaxed">
                  One or more legs has no premium. Templates deliberately leave it at zero rather
                  than inventing a price — enter what you paid or received, or the P/L below is
                  measured against nothing.
                </p>
              )}
            </CardContent>
          </Card>

          {/* CENTRE: payoff */}
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Payoff</CardTitle>
            </CardHeader>
            <CardContent>
              {curve.length === 0 ? (
                <p className="text-xs text-muted-foreground">Add a leg to see the payoff.</p>
              ) : (
                <div style={{ height: 340 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={curve} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis
                        {...AXIS_PROPS}
                        dataKey="spot"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={(v: number) => v.toFixed(0)}
                      />
                      <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`} />
                      <Tooltip
                        contentStyle={{ fontSize: 11 }}
                        formatter={(v: number, name: string) => [formatCurrency(v), name]}
                        labelFormatter={(v: number) => `Underlying ${formatCurrency(v)}`}
                      />
                      <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.4} />
                      <ReferenceLine
                        x={liveSpot}
                        stroke="hsl(var(--foreground))"
                        strokeDasharray="3 3"
                        strokeOpacity={0.5}
                      />
                      {position.legs.map((l) => (
                        <ReferenceLine
                          key={l.id}
                          x={l.strike}
                          stroke="hsl(var(--muted-foreground))"
                          strokeOpacity={0.35}
                        />
                      ))}
                      <Area
                        type="monotone"
                        dataKey="atExpiry"
                        name="At expiry"
                        stroke="hsl(var(--series-0))"
                        fill="hsl(var(--series-0))"
                        fillOpacity={0.12}
                      />
                      <Line
                        type="monotone"
                        dataKey="theoretical"
                        name="Today (theoretical)"
                        stroke="hsl(var(--series-2))"
                        dot={false}
                        strokeWidth={1.5}
                      />
                      {summary.breakevens.map((b) => (
                        <ReferenceDot key={b} x={b} y={0} r={3}
                          fill="hsl(var(--positive))" stroke="none" />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
                The filled line is profit at the final expiry; the thin line is the theoretical
                value today, from the model. Dots mark breakevens, the dashed line the current
                underlying, and the faint verticals the strikes.
              </p>
            </CardContent>
          </Card>

          {/* RIGHT: risk dashboard */}
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Position</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Stat
                label={netDebit(position) >= 0 ? 'Net debit' : 'Net credit'}
                value={formatCurrency(Math.abs(netDebit(position)))}
              />
              <Stat
                label="Max profit"
                value={summary.maxProfit == null ? 'Unlimited' : formatCurrency(summary.maxProfit)}
                tone={summary.maxProfit == null ? 'positive' : undefined}
              />
              <Stat
                label="Max loss"
                value={summary.maxLoss == null ? 'UNLIMITED' : formatCurrency(summary.maxLoss)}
                tone={summary.maxLoss == null ? 'warn' : 'negative'}
                hint={summary.maxLoss == null ? 'This position can lose without bound.' : undefined}
              />
              <Stat
                label="Breakevens"
                value={summary.breakevens.length ? summary.breakevens.map((b) => b.toFixed(2)).join(', ') : '—'}
              />
              <Stat label="Capital (estimate)" value={formatCurrency(summary.capital)}
                hint="Not your broker's margin number." />
              <Stat
                label="Current P/L"
                value={formatCurrency(valuation.profit)}
                tone={valuation.profit >= 0 ? 'positive' : 'negative'}
              />
              <Stat label="Delta" value={valuation.greeks.delta.toFixed(2)} hint="Share-equivalent" />
              <Stat label="Gamma" value={valuation.greeks.gamma.toFixed(4)} />
              <Stat label="Theta / day" value={formatCurrency(perDay(valuation.greeks.theta))} />
              <Stat label="Vega / point" value={formatCurrency(perPoint(valuation.greeks.vega))} />
              <Stat label="Rho / point" value={formatCurrency(perPoint(valuation.greeks.rho))} />
              {probability && (
                <>
                  <Stat label="Probability of profit" value={formatPercent(probability.probabilityOfProfit, 1)} />
                  <Stat
                    label="Expected value"
                    value={formatCurrency(probability.expectedValue)}
                    tone={probability.expectedValue >= 0 ? 'positive' : 'negative'}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* BOTTOM: analytics */}
        <Tabs defaultValue="greeks">
          <TabsList>
            <TabsTrigger value="greeks">Greeks</TabsTrigger>
            <TabsTrigger value="probability">Probability</TabsTrigger>
            <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
            <TabsTrigger value="montecarlo">Monte Carlo</TabsTrigger>
            <TabsTrigger value="chain">Chain</TabsTrigger>
          </TabsList>

          <TabsContent value="greeks" className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-2">
              {(['delta', 'gamma', 'theta', 'vega'] as const).map((g, i) => (
                <Card key={g}>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-xs capitalize">{g} vs underlying</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div style={{ height: 160 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={greekCurve} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                          <CartesianGrid {...GRID_PROPS} />
                          <XAxis {...AXIS_PROPS} dataKey="spot" type="number"
                            domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => v.toFixed(0)} />
                          <YAxis {...AXIS_PROPS} width={48} />
                          <Tooltip contentStyle={{ fontSize: 11 }} />
                          <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.3} />
                          <ReferenceLine x={liveSpot} stroke="hsl(var(--foreground))" strokeDasharray="3 3" strokeOpacity={0.4} />
                          <Line type="monotone" dataKey={g} stroke={`hsl(var(--series-${i}))`} dot={false} strokeWidth={1.5} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">By leg</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Leg</th>
                      <th className="py-2 pr-3 text-right font-medium">Value</th>
                      <th className="py-2 pr-3 text-right font-medium">P/L</th>
                      <th className="py-2 pr-3 text-right font-medium">Delta</th>
                      <th className="py-2 pr-3 text-right font-medium">Gamma</th>
                      <th className="py-2 pr-3 text-right font-medium">Theta/day</th>
                      <th className="py-2 text-right font-medium">Vega/pt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuation.legs.map((lv) => {
                      const leg = position.legs.find((l) => l.id === lv.legId)!;
                      return (
                        <tr key={lv.legId} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 pr-3">
                            {leg.side === 'buy' ? '+' : '−'}{leg.contracts} {leg.strike}{' '}
                            {leg.type === 'call' ? 'C' : 'P'}{' '}
                            <span className="text-2xs text-muted-foreground">{leg.expiry}</span>
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right">{formatCurrency(lv.value)}</td>
                          <td className={cn('numeric py-1.5 pr-3 text-right',
                            lv.profit >= 0 ? 'text-[hsl(var(--positive))]' : 'text-[hsl(var(--negative))]')}>
                            {formatCurrency(lv.profit)}
                          </td>
                          <td className="numeric py-1.5 pr-3 text-right">{lv.delta.toFixed(2)}</td>
                          <td className="numeric py-1.5 pr-3 text-right">{lv.gamma.toFixed(4)}</td>
                          <td className="numeric py-1.5 pr-3 text-right">{formatCurrency(perDay(lv.theta))}</td>
                          <td className="numeric py-1.5 text-right">{formatCurrency(perPoint(lv.vega))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="probability">
            <Card>
              <CardContent className="space-y-3 p-4">
                {probability ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Stat label="Probability of profit" value={formatPercent(probability.probabilityOfProfit, 1)} />
                      <Stat label="Probability of loss" value={formatPercent(probability.probabilityOfLoss, 1)} />
                      <Stat label="Expected value" value={formatCurrency(probability.expectedValue)} />
                      <Stat
                        label="Expected move (1σ)"
                        value={`± ${formatCurrency(probability.expectedMove.oneSigma)}`}
                        hint={`${formatCurrency(probability.expectedMove.low)} – ${formatCurrency(probability.expectedMove.high)}`}
                      />
                    </div>

                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">Leg</th>
                          <th className="py-2 text-right font-medium">Chance of finishing in the money</th>
                        </tr>
                      </thead>
                      <tbody>
                        {probability.legs.map((l) => (
                          <tr key={l.legId} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-3">{l.strike} {l.type === 'call' ? 'C' : 'P'}</td>
                            <td className="numeric py-1.5 text-right">{formatPercent(l.probabilityITM, 1)}</td>
                          </tr>
                        ))}
                        {probability.touchBreakeven.map((t) => (
                          <tr key={`t-${t.level}`} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-3 text-muted-foreground">
                              Touching breakeven {t.level.toFixed(2)} before expiry
                            </td>
                            <td className="numeric py-1.5 text-right">{formatPercent(t.probability, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <p className="rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-muted-foreground">
                      {probability.assumptions}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Add a leg to see probabilities.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="scenarios">
            <Card>
              <CardContent className="overflow-x-auto p-4">
                <table className="w-full min-w-[44rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Scenario</th>
                      <th className="py-2 pr-3 text-right font-medium">Underlying</th>
                      <th className="py-2 pr-3 text-right font-medium">Days</th>
                      <th className="py-2 pr-3 text-right font-medium">P/L</th>
                      <th className="py-2 pr-3 text-right font-medium">Delta</th>
                      <th className="py-2 pr-3 text-right font-medium">Theta/day</th>
                      <th className="py-2 text-right font-medium">Vega/pt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenarios.map((s) => (
                      <tr key={s.label} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-3">{s.label}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{formatCurrency(s.spot)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{s.daysPassed}</td>
                        <td className={cn('numeric py-1.5 pr-3 text-right',
                          s.profit >= 0 ? 'text-[hsl(var(--positive))]' : 'text-[hsl(var(--negative))]')}>
                          {formatCurrency(s.profit)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">{s.delta.toFixed(1)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{formatCurrency(perDay(s.theta))}</td>
                        <td className="numeric py-1.5 text-right">{formatCurrency(perPoint(s.vega))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="montecarlo">
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label htmlFor="mc-paths" className="text-2xs text-muted-foreground">Paths</label>
                    <Input id="mc-paths" type="number" min={100} max={200000} step={1000}
                      value={mcPaths} onChange={(e) => setMcPaths(Number(e.target.value))}
                      className="w-28 text-xs" />
                  </div>
                  <div>
                    <label htmlFor="mc-drift" className="text-2xs text-muted-foreground">Drift %/yr</label>
                    <Input id="mc-drift" type="number" step={0.5}
                      value={Math.round(mcDrift * 1000) / 10}
                      onChange={(e) => setMcDrift(Number(e.target.value) / 100)}
                      className="w-24 text-xs" />
                  </div>
                </div>

                {simulation ? (
                  <>
                    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      <Stat label="Mean P/L" value={formatCurrency(simulation.mean)} />
                      <Stat label="Median" value={formatCurrency(simulation.median)} />
                      <Stat label="5th pct" value={formatCurrency(simulation.p5)} />
                      <Stat label="95th pct" value={formatCurrency(simulation.p95)} />
                      <Stat label="Worst path" value={formatCurrency(simulation.min)} />
                      <Stat label="P(loss)" value={formatPercent(simulation.probabilityOfLoss, 1)} />
                    </div>

                    <div style={{ height: 200 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={simulation.histogram} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                          <CartesianGrid {...GRID_PROPS} />
                          <XAxis {...AXIS_PROPS} dataKey="from" type="number"
                            domain={['dataMin', 'dataMax']}
                            tickFormatter={(v: number) => (v / 1000).toFixed(1) + 'k'} />
                          <YAxis {...AXIS_PROPS} width={48} />
                          <Tooltip contentStyle={{ fontSize: 11 }}
                            labelFormatter={(v: number) => `P/L from ${formatCurrency(v)}`} />
                          <Area type="step" dataKey="count" stroke="hsl(var(--series-4))"
                            fill="hsl(var(--series-4))" fillOpacity={0.25} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    <p className="rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-muted-foreground">
                      {simulation.assumptions}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Add a leg to simulate.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="chain">
            <Card>
              <CardContent className="p-4">
                {data?.chain ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[40rem] text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">Expiry</th>
                          <th className="py-2 pr-3 text-right font-medium">Strike</th>
                          <th className="py-2 pr-3 font-medium">Type</th>
                          <th className="py-2 pr-3 text-right font-medium">Bid</th>
                          <th className="py-2 pr-3 text-right font-medium">Ask</th>
                          <th className="py-2 pr-3 text-right font-medium">IV</th>
                          <th className="py-2 font-medium"> </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.chain.quotes.slice(0, 200).map((q) => (
                          <tr key={q.symbol} className="border-b border-border/50 last:border-0">
                            <td className="numeric py-1.5 pr-3">{q.expiry}</td>
                            <td className="numeric py-1.5 pr-3 text-right">{q.strike}</td>
                            <td className="py-1.5 pr-3">{q.type}</td>
                            <td className="numeric py-1.5 pr-3 text-right">{q.bid ?? '—'}</td>
                            <td className="numeric py-1.5 pr-3 text-right">{q.ask ?? '—'}</td>
                            <td className="numeric py-1.5 pr-3 text-right">
                              {q.impliedVolatility != null ? formatPercent(q.impliedVolatility, 1) : '—'}
                            </td>
                            <td className="py-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-2xs"
                                onClick={() =>
                                  setPosition((p) => ({
                                    ...p,
                                    legs: [
                                      ...p.legs,
                                      {
                                        ...newLeg(presetCtx),
                                        type: q.type,
                                        strike: q.strike,
                                        expiry: q.expiry,
                                        // Mid where both sides are quoted; a
                                        // one-sided market is left at zero
                                        // rather than filled from one side.
                                        entryPremium:
                                          q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : 0,
                                        impliedVolatility: q.impliedVolatility ?? assumedVol,
                                      },
                                    ],
                                  }))
                                }
                              >
                                Add
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {data?.chainNote ?? 'No chain loaded.'}
                    </p>
                    {data?.needsConfiguration && (
                      <p className="text-2xs leading-relaxed text-muted-foreground">
                        Alpaca serves OPRA option chains with implied volatility and Greeks. Add
                        <code className="mx-1 rounded bg-muted px-1">ALPACA_API_KEY_ID</code> and
                        <code className="mx-1 rounded bg-muted px-1">ALPACA_API_SECRET_KEY</code>
                        to <code className="rounded bg-muted px-1">.env.local</code> and reload.
                        Until then the builder works from legs you enter yourself.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="rounded-md border border-border bg-muted/40 p-3 text-2xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">What is measured and what is modelled.</span>{' '}
            {data?.provenance.pricing} The underlying price and any chain quotes are market data;
            every theoretical value, Greek, probability and simulated outcome on this page is
            computed from a model and is only as good as the volatility assumption behind it.
          </p>
        </div>
      </PageBody>
    </>
  );
}

function LegField({
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
      <label className="text-2xs text-muted-foreground">{label}</label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 text-2xs"
      />
    </div>
  );
}
