'use client';

import * as React from 'react';
import { ChartFrame } from '@/components/charts/chart-chrome';
import { formatCurrencyCompact, formatNumber, formatPercent, formatSignedPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Market context: how it trades, what it moves with, who it trades against.
 * =============================================================================
 * Three readings that only make sense relative to something else, which is why
 * they sit together rather than beside the single-security models above.
 *
 * Liquidity is reported as a MEDIAN rather than a mean. One index-rebalance
 * session can carry ten times a normal day's volume, and an average that
 * includes it describes a day nobody will get filled on.
 *
 * The benchmark and peer figures are measured only on the dates both series
 * actually traded. A holiday one venue observes and the other does not is a
 * missing observation, not a zero return, and pairing them by position rather
 * than by date silently shifts one series against the other.
 */

interface LiquidityWindow {
  label: string;
  medianDollarVolume: number | null;
  p10DollarVolume: number | null;
  medianShareVolume: number | null;
  amihud: number | null;
  turnover: number | null;
  zeroVolumeSessions: number;
  bars: number;
}

interface RelationWindow {
  label: string;
  beta: number | null;
  correlation: number | null;
  r2: number | null;
  idiosyncraticVol: number | null;
  observations: number;
}

interface PeerHorizon {
  label: string;
  peerMedian: number | null;
  medianExcess: number | null;
  rank: number | null;
  measured: number;
}

export interface MarketContextData {
  liquidity: {
    windows: LiquidityWindow[];
    trend?: number | null;
    participationRate?: number | null;
  } | null;
  benchmark: {
    symbol: string | null;
    relation: { benchmark?: string; overlap?: number; windows: RelationWindow[] } | null;
    unavailable: string | null;
  } | null;
  peers: {
    cohort: { source?: string; peers: string[]; horizons: PeerHorizon[] } | null;
    unavailable: string | null;
  } | null;
}

const tone = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'text-positive' : 'text-negative';

export function MarketContextPanels({ data }: { data: MarketContextData }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <LiquidityPanel liquidity={data.liquidity} />
      <BenchmarkPanel benchmark={data.benchmark} />
      <PeerPanel peers={data.peers} className="xl:col-span-2" />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LiquidityPanel({ liquidity }: { liquidity: MarketContextData['liquidity'] }) {
  const rows = liquidity?.windows?.filter((w) => w.medianDollarVolume != null) ?? [];
  return (
    <ChartFrame
      title="Liquidity"
      description="Median dollar volume, not mean — one index-rebalance session can carry ten times a normal day, and an average that includes it describes a day nobody gets filled on. The tenth percentile is the quiet day to size against."
    >
      {rows.length === 0 ? (
        <Empty>No volume history came back for this security, so there is nothing to measure.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pl-4 pr-3 font-medium sm:pl-5">Window</th>
                <th className="py-2 pr-3 text-right font-medium">Median $vol</th>
                <th className="py-2 pr-3 text-right font-medium">Quiet day</th>
                <th className="py-2 pr-3 text-right font-medium">Turnover</th>
                <th className="py-2 pr-4 text-right font-medium sm:pr-5">Untraded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.label} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pl-4 pr-3 sm:pl-5">{w.label}</td>
                  <td className="numeric py-1.5 pr-3 text-right">
                    {formatCurrencyCompact(w.medianDollarVolume ?? 0)}
                  </td>
                  <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                    {w.p10DollarVolume != null ? formatCurrencyCompact(w.p10DollarVolume) : '—'}
                  </td>
                  <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                    {w.turnover != null ? formatPercent(w.turnover, 3) : '—'}
                  </td>
                  {/* Sessions that printed no volume at all. On a thin name this
                      is the number that decides whether a stop can be worked. */}
                  <td
                    className={cn(
                      'numeric py-1.5 pr-4 text-right sm:pr-5',
                      w.zeroVolumeSessions > 0 ? 'text-negative' : 'text-muted-foreground',
                    )}
                  >
                    {w.zeroVolumeSessions} / {w.bars}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */

function BenchmarkPanel({ benchmark }: { benchmark: MarketContextData['benchmark'] }) {
  const rel = benchmark?.relation;
  const rows = rel?.windows?.filter((w) => w.beta != null) ?? [];
  return (
    <ChartFrame
      title={`Against ${rel?.benchmark ?? benchmark?.symbol ?? 'the benchmark'}`}
      description="Beta and correlation at each window, on the trading dates both series share. A low R² makes the beta beside it unreliable, because the regression has little to fit — which is why it is shown rather than left out."
    >
      {benchmark?.unavailable ? (
        <Empty>{benchmark.unavailable}</Empty>
      ) : rows.length === 0 ? (
        <Empty>No overlapping history with the benchmark, so nothing can be measured against it.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pl-4 pr-3 font-medium sm:pl-5">Window</th>
                <th className="py-2 pr-3 text-right font-medium">Beta</th>
                <th className="py-2 pr-3 text-right font-medium">Corr</th>
                <th className="py-2 pr-3 text-right font-medium">R²</th>
                <th className="py-2 pr-4 text-right font-medium sm:pr-5">Own vol</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.label} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pl-4 pr-3 sm:pl-5">{w.label}</td>
                  <td className="numeric py-1.5 pr-3 text-right font-semibold">
                    {formatNumber(w.beta, 2)}
                  </td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatNumber(w.correlation, 2)}</td>
                  <td
                    className={cn(
                      'numeric py-1.5 pr-3 text-right',
                      (w.r2 ?? 0) < 0.1 ? 'text-muted-foreground' : '',
                    )}
                  >
                    {w.r2 != null ? formatPercent(w.r2, 0) : '—'}
                  </td>
                  <td className="numeric py-1.5 pr-4 text-right text-muted-foreground sm:pr-5">
                    {w.idiosyncraticVol != null ? formatPercent(w.idiosyncraticVol) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rel?.overlap != null && (
            <p className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground sm:px-5">
              Measured on {rel.overlap} sessions both series traded. Own vol is what is left after
              the benchmark is accounted for — the part a hedge against it would not remove.
            </p>
          )}
        </div>
      )}
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */

function PeerPanel({
  peers,
  className,
}: {
  peers: MarketContextData['peers'];
  className?: string;
}) {
  const cohort = peers?.cohort;
  const rows = cohort?.horizons?.filter((h) => h.medianExcess != null) ?? [];
  return (
    <ChartFrame
      title="Against its peers"
      description="Return relative to the median of a comparable cohort, at each horizon. Leading the market and leading your own sector are different claims, and only the second says the business did something."
      className={className}
    >
      {peers?.unavailable ? (
        <Empty>{peers.unavailable}</Empty>
      ) : rows.length === 0 ? (
        <Empty>No peer cohort could be resolved for this security.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 sm:px-5">
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">Cohort</span>
            {(cohort?.peers ?? []).map((p) => (
              <span
                key={p}
                className="numeric rounded border border-border bg-muted/40 px-1.5 py-0.5 text-2xs"
              >
                {p}
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pl-4 pr-3 font-medium sm:pl-5">Horizon</th>
                  <th className="py-2 pr-3 text-right font-medium">Peer median</th>
                  <th className="py-2 pr-3 text-right font-medium">Excess</th>
                  <th className="py-2 pr-3 text-right font-medium">Rank</th>
                  <th className="py-2 pr-4 text-right font-medium sm:pr-5">Measured</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.label} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pl-4 pr-3 sm:pl-5">{h.label}</td>
                    <td className={cn('numeric py-1.5 pr-3 text-right', tone(h.peerMedian))}>
                      {formatSignedPercent(h.peerMedian, 1)}
                    </td>
                    <td
                      className={cn('numeric py-1.5 pr-3 text-right font-semibold', tone(h.medianExcess))}
                    >
                      {formatSignedPercent(h.medianExcess, 1)}
                    </td>
                    <td className="numeric py-1.5 pr-3 text-right">
                      {h.rank != null ? formatPercent(h.rank, 0) : '—'}
                    </td>
                    <td className="numeric py-1.5 pr-4 text-right text-muted-foreground sm:pr-5">
                      {h.measured}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cohort?.source && (
            <p className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground sm:px-5">
              Cohort from {cohort.source}. Rank is where this security sits inside it, so 100% is
              the strongest of the group and 0% the weakest.
            </p>
          )}
        </>
      )}
    </ChartFrame>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">{children}</p>
  );
}
