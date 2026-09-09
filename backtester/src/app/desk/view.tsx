'use client';

import * as React from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { TickerSearch } from '@/components/builder/ticker-search';
import { AXIS_PROPS, ChartFrame, ChartLegend, GRID_PROPS } from '@/components/charts/chart-chrome';
import { Skeleton } from '@/components/ui/skeleton';
import { TailRidgePanel, type TailRidgeData } from '@/components/desk/tail-ridge';
import { RegimeLatticePanel } from '@/components/desk/regime-lattice';
import { MarketContextPanels, type MarketContextData } from '@/components/desk/market-context';
import {
  PersistencePanel,
  RecoveryPanel,
  SessionSplitPanel,
} from '@/components/desk/quant-panels';
import { useActiveTicker, useTickerStore } from '@/store/ticker';
import { useHydrated } from '@/hooks/use-hydrated';
import {
  formatCurrency,
  formatCurrencyCompact,
  formatNumber,
  formatPercent,
  formatSignedPercent,
} from '@/lib/format';
import { cn, seriesColor } from '@/lib/utils';
import type {
  FlowResult,
  MomentumAgreement,
  MomentumRung,
  ParticipationResult,
  RangeState,
  VolRung,
} from '@/lib/desk/models';
import type { RegimeLattice } from '@/lib/desk/regime-lattice';
import type { DrawdownTopology } from '@/lib/desk/drawdown-topology';
import type { SessionSplit } from '@/lib/desk/session-split';
import type { VolatilityPersistence } from '@/lib/desk/vol-persistence';

/**
 * The desk: one security, read four ways at once.
 * =============================================================================
 * Every panel here replaces a single-number indicator with the shape behind it,
 * because the shape is what distinguishes situations the scalar cannot. The
 * arithmetic lives in `lib/desk/models.ts` and is tested there; this file is
 * only how it is drawn.
 *
 * Nothing on this page is modelled or simulated. Every figure is computed from
 * bars a provider actually returned, and a panel whose data did not arrive says
 * so rather than rendering an empty frame that reads as a finding.
 */

interface DeskResponse {
  symbol: string;
  asOf: string;
  last: {
    close: number;
    open: number;
    high: number;
    low: number;
    volume: number;
    change: number | null;
    changePct: number | null;
  };
  momentum: { rungs: MomentumRung[]; agreement: MomentumAgreement };
  flow: FlowResult;
  volatility: VolRung[];
  tails: TailRidgeData | null;
  lattice: RegimeLattice | null;
  range: RangeState;
  participation: ParticipationResult | null;
  liquidity: MarketContextData['liquidity'];
  benchmark: MarketContextData['benchmark'];
  peers: MarketContextData['peers'];
  intradayAvailable: boolean;
  drawdownTopology: DrawdownTopology | null;
  sessionSplit: SessionSplit | null;
  volPersistence: VolatilityPersistence | null;
  coverage: {
    dailyBars: number;
    from: string;
    to: string;
    intradayBars: number;
    exDividendDates: number;
  };
}

const tone = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'text-positive' : 'text-negative';

export function DeskView() {
  const hydrated = useHydrated();
  const focus = useActiveTicker();
  const setTicker = useTickerStore((s) => s.setTicker);

  const [data, setData] = React.useState<DeskResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const symbol = focus?.symbol ?? null;

  React.useEffect(() => {
    if (!symbol) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/desk?symbol=${encodeURIComponent(symbol)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!live) return;
        if (!r.ok) {
          setError(body.error ?? 'The desk could not load this security.');
          setData(null);
          return;
        }
        setData(body as DeskResponse);
      })
      .catch(() => live && setError('The desk could not load this security.'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [symbol]);

  return (
    <>
      <PageHeader
        title="Desk"
        description="Momentum, flow, volatility and participation for one security, each read as a shape rather than a score."
        actions={
          <div className="w-full sm:w-72">
            <TickerSearch onSelect={(s) => setTicker(s.symbol, s.name)} />
          </div>
        }
      />

      <PageBody className="space-y-4">
        {!hydrated || (loading && !data) ? (
          <div className="space-y-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !symbol ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            Search a security above, or press ⌘K, to put one in focus. The desk reads whatever the
            ticker bar is holding, so it follows you from the chart and the research pages.
          </p>
        ) : error ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            {error}
          </p>
        ) : data ? (
          <>
            <Tape data={data} />

            <div className="grid gap-4 xl:grid-cols-2">
              <MomentumPanel rungs={data.momentum.rungs} agreement={data.momentum.agreement} />
              <VolatilityPanel cone={data.volatility} range={data.range} />
            </div>

            <TailRidgePanel data={data.tails} />

            <FlowPanel flow={data.flow} />

            <RegimeLatticePanel lattice={data.lattice} />

            {/* How it trades, what it moves with, who it trades against —
                the three readings that only mean anything relative to
                something else. */}
            <MarketContextPanels
              data={{ liquidity: data.liquidity, benchmark: data.benchmark, peers: data.peers }}
            />

            <RecoveryPanel topology={data.drawdownTopology} />

            <SessionSplitPanel split={data.sessionSplit} />

            <PersistencePanel persistence={data.volPersistence} />

            <ParticipationPanel
              participation={data.participation}
              available={data.intradayAvailable}
            />

            <p className="text-xs leading-relaxed text-muted-foreground">
              {data.coverage.dailyBars} daily bars from {data.coverage.from} to {data.coverage.to}
              {data.coverage.intradayBars > 0
                ? `, and ${data.coverage.intradayBars} five-minute bars for the session profile`
                : ''}
              . Every figure is measured from those bars. Nothing here is modelled, forecast or
              simulated.
            </p>
          </>
        ) : null}
      </PageBody>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The tape                                                            */
/* ------------------------------------------------------------------ */

function Tape({ data }: { data: DeskResponse }) {
  const { last } = data;
  const cells: Array<{ label: string; value: React.ReactNode; sub?: string; cls?: string }> = [
    {
      label: 'Last',
      value: formatCurrency(last.close),
      sub: `as of ${data.asOf}`,
    },
    {
      label: 'Change',
      value: formatSignedPercent(last.changePct),
      sub: last.change != null ? formatCurrency(last.change) : undefined,
      cls: tone(last.changePct),
    },
    {
      label: 'Day range',
      value: `${formatCurrency(last.low)} – ${formatCurrency(last.high)}`,
      sub: 'low to high',
    },
    {
      label: 'Volume',
      value: formatCurrencyCompact(last.volume).replace('$', ''),
      sub: 'shares',
    },
    {
      label: 'Momentum',
      value: data.momentum.agreement.direction.toUpperCase(),
      sub: `${data.momentum.agreement.measured} horizons agree ${Math.round(Math.abs(data.momentum.agreement.score) * 100)}%`,
      cls:
        data.momentum.agreement.direction === 'up'
          ? 'text-positive'
          : data.momentum.agreement.direction === 'down'
            ? 'text-negative'
            : '',
    },
    {
      label: 'Flow',
      value: data.flow.pressure != null ? formatSignedPercent(data.flow.pressure, 1) : '—',
      sub: 'net / gross, 63d',
      cls: tone(data.flow.pressure),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <div key={c.label} className="flex flex-col gap-0.5 bg-card px-3 py-2.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {c.label}
          </span>
          <span className={cn('numeric text-lg font-semibold leading-tight', c.cls)}>{c.value}</span>
          {c.sub && <span className="text-2xs text-muted-foreground">{c.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Momentum term structure                                             */
/* ------------------------------------------------------------------ */

function MomentumPanel({
  rungs,
  agreement,
}: {
  rungs: MomentumRung[];
  agreement: MomentumAgreement;
}) {
  const measured = rungs.filter((r) => r.ret != null);
  const scale = Math.max(0.02, ...measured.map((r) => Math.abs(r.ret!)));

  return (
    <ChartFrame
      title="Momentum term structure"
      description="Return at each horizon, and how unusual that return is for that horizon. Read the shape: every rung one way is a trend; short rungs against long ones is a pullback inside one."
    >
      <div className="space-y-1.5 p-4 pt-1 sm:p-5 sm:pt-1">
        {rungs.map((r) => {
          const width = r.ret != null ? (Math.abs(r.ret) / scale) * 50 : 0;
          const up = (r.ret ?? 0) > 0;
          return (
            <div key={r.label} className="flex items-center gap-2">
              <span className="numeric w-8 shrink-0 text-2xs text-muted-foreground">{r.label}</span>

              {/* A shared zero line down the middle, so the rungs are read
                  against one another rather than each in its own box. */}
              <div className="relative h-5 flex-1 rounded bg-muted/40">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" aria-hidden />
                {r.ret != null && (
                  <div
                    className="absolute inset-y-1 rounded-sm"
                    style={{
                      left: up ? '50%' : `${50 - width}%`,
                      width: `${width}%`,
                      backgroundColor: up
                        ? 'hsl(var(--positive))'
                        : 'hsl(var(--negative))',
                      opacity: 0.85,
                    }}
                    aria-hidden
                  />
                )}
              </div>

              <span className={cn('numeric w-16 shrink-0 text-right text-xs', tone(r.ret))}>
                {r.ret != null ? formatSignedPercent(r.ret, 1) : '—'}
              </span>
              {/* The z-score is the part that says whether the move was
                  ordinary. A 2% day and a 2% year are not comparable as
                  returns; against their own histories they are. */}
              <span
                className="numeric w-12 shrink-0 text-right text-2xs text-muted-foreground"
                title="Standard deviations from this horizon's own average"
              >
                {r.z != null ? `${r.z > 0 ? '+' : ''}${formatNumber(r.z, 1)}σ` : '—'}
              </span>
            </div>
          );
        })}

        <div className="flex items-center justify-between border-t border-border pt-2 text-2xs text-muted-foreground">
          <span>
            {agreement.measured} of {rungs.length} horizons measured
          </span>
          <span>
            Agreement{' '}
            <span
              className={cn(
                'numeric font-semibold',
                agreement.direction === 'up'
                  ? 'text-positive'
                  : agreement.direction === 'down'
                    ? 'text-negative'
                    : '',
              )}
            >
              {formatNumber(agreement.score, 2)}
            </span>
          </span>
        </div>
      </div>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Volatility cone                                                     */
/* ------------------------------------------------------------------ */

function VolatilityPanel({ cone, range }: { cone: VolRung[]; range: RangeState }) {
  const rows = cone.filter((r) => r.current != null);
  const chart = rows.map((r) => ({
    label: r.label,
    band: [r.p10! * 100, r.p90! * 100] as [number, number],
    median: r.p50! * 100,
    current: r.current! * 100,
  }));

  return (
    <ChartFrame
      title="Volatility cone"
      description="Realised volatility at each window against that window's own history. The band is the 10th to 90th percentile; the dot is now. The two ends usually disagree, and that disagreement is the reading."
    >
      <ChartLegend
        className="px-4 pb-1 sm:px-5"
        series={[
          { label: '10th–90th percentile', color: seriesColor('band', 0) },
          { label: 'Median', color: seriesColor('median', 1), dashed: true },
          { label: 'Now', color: seriesColor('now', 4) },
        ]}
      />
      {chart.length === 0 ? (
        <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
          Not enough history to measure a volatility cone for this security.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis {...AXIS_PROPS} dataKey="label" />
              <YAxis {...AXIS_PROPS} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
              <Area
                dataKey="band"
                stroke="none"
                fill={seriesColor('band', 0)}
                fillOpacity={0.18}
                isAnimationActive={false}
              />
              <Line
                dataKey="median"
                stroke={seriesColor('median', 1)}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="current"
                stroke={seriesColor('now', 4)}
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border px-4 py-3 sm:grid-cols-4 sm:px-5">
            <Fact label="ATR" value={range.atrPct != null ? formatPercent(range.atrPct) : '—'} sub="of price, 21d" />
            <Fact
              label="ATR rank"
              value={range.atrRank != null ? formatPercent(range.atrRank, 0) : '—'}
              sub="vs own history"
            />
            <Fact
              label="In range"
              value={range.positionInRange != null ? formatPercent(range.positionInRange, 0) : '—'}
              sub="close within 21d high–low"
            />
            <Fact
              label="Inside bars"
              value={String(range.insideRun)}
              sub={range.insideRun > 1 ? 'compressing' : 'consecutive'}
            />
          </div>
        </>
      )}
    </ChartFrame>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="numeric text-sm font-semibold">{value}</span>
      <span className="text-2xs text-muted-foreground">{sub}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Flow                                                                */
/* ------------------------------------------------------------------ */

function FlowPanel({ flow }: { flow: FlowResult }) {
  /*
   * The per-session series is the close LOCATION, not the signed dollars.
   *
   * Drawn as raw signed dollar volume it was unreadable: one heavy session set
   * the scale and every other bar collapsed to nothing, which is the same
   * outlier problem the research charts had. Close location is bounded to
   * [-1, +1] by construction, so every session is visible at the same weight,
   * and it answers the more useful question anyway — how strongly did each day
   * close, rather than how large was it. The dollars are already in the
   * accumulated line above it and in the net figure below.
   */
  const data = flow.points.map((p) => ({
    date: p.date,
    cumulative: p.cumulative,
    clv: p.clv,
  }));

  return (
    <ChartFrame
      title="Flow pressure"
      description="Dollar volume signed by where each bar closed inside its own range. A session that gaps up and then sells off closes near its low — this counts that as distribution, which a close-to-close reading calls buying."
    >
      <ChartLegend
        className="px-4 pb-1 sm:px-5"
        series={[
          { label: 'Accumulated flow (dollars)', color: seriesColor('cum', 0), dashed: true },
          { label: 'Close strength (−1 to +1)', color: seriesColor('sig', 2) },
        ]}
      />
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...AXIS_PROPS} dataKey="date" minTickGap={40} />
          <YAxis
            {...AXIS_PROPS}
            yAxisId="l"
            tickFormatter={(v) => formatCurrencyCompact(Number(v))}
          />
          <YAxis
            {...AXIS_PROPS}
            yAxisId="r"
            orientation="right"
            domain={[-1, 1]}
            ticks={[-1, 0, 1]}
            tickFormatter={(v) => (Number(v) > 0 ? 'high' : Number(v) < 0 ? 'low' : '')}
          />
          <Bar
            yAxisId="r"
            dataKey="clv"
            fill={seriesColor('sig', 2)}
            fillOpacity={0.6}
            isAnimationActive={false}
          />
          <Line
            yAxisId="l"
            dataKey="cumulative"
            stroke={seriesColor('cum', 0)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border px-4 py-3 sm:grid-cols-3 sm:px-5">
        <Fact
          label="Net flow"
          value={formatCurrencyCompact(flow.net)}
          sub="signed dollar volume, 63d"
        />
        <Fact
          label="Pressure"
          value={flow.pressure != null ? formatSignedPercent(flow.pressure, 1) : '—'}
          sub="net as a share of gross"
        />
        <Fact
          label="Closed strong"
          value={flow.upBarShare != null ? formatPercent(flow.upBarShare, 0) : '—'}
          sub="bars closing in the upper half"
        />
      </div>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Participation                                                       */
/* ------------------------------------------------------------------ */

function ParticipationPanel({
  participation,
  available,
}: {
  participation: ParticipationResult | null;
  available: boolean;
}) {
  if (!available || !participation || participation.buckets.length === 0) {
    return (
      <ChartFrame
        title="Session participation"
        description="When during the session the volume actually arrives."
      >
        <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
          No intraday bars came back for this security, so there is no session shape to profile.
          The panel is left empty rather than drawn from daily bars, which carry no time of day.
        </p>
      </ChartFrame>
    );
  }

  const data = participation.buckets.map((b) => ({
    label: b.label,
    typical: b.typical * 100,
    today: (b.today ?? 0) * 100,
  }));

  return (
    <ChartFrame
      title="Session participation"
      description="Share of the day's volume by half hour. Volume is reliably heavy at the open and the close and thin in the middle, which is what makes a departure from that shape worth seeing."
    >
      <ChartLegend
        className="px-4 pb-1 sm:px-5"
        series={[
          { label: `Typical (${participation.sessions} sessions)`, color: seriesColor('typ', 1) },
          { label: 'Latest session', color: seriesColor('today', 0) },
        ]}
      />
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...AXIS_PROPS} dataKey="label" minTickGap={24} />
          <YAxis {...AXIS_PROPS} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
          <Bar dataKey="typical" fill={seriesColor('typ', 1)} fillOpacity={0.45} isAnimationActive={false} />
          <Bar dataKey="today" fill={seriesColor('today', 0)} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border px-4 py-3 sm:px-5">
        <Fact
          label="Divergence"
          value={
            participation.divergence != null ? formatPercent(participation.divergence, 1) : '—'
          }
          sub="how far today departs from the usual shape"
        />
        <Fact
          label="Sessions"
          value={String(participation.sessions)}
          sub="averaged for the typical profile"
        />
      </div>
    </ChartFrame>
  );
}
