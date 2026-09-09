'use client';

import * as React from 'react';
import { ChartFrame } from '@/components/charts/chart-chrome';
import { formatNumber, formatPercent, formatSignedPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DrawdownTopology } from '@/lib/desk/drawdown-topology';
import type { SessionSplit } from '@/lib/desk/session-split';
import type { VolatilityPersistence } from '@/lib/desk/vol-persistence';

/**
 * Three quantitative panels, drawn plainly.
 * =============================================================================
 * The arithmetic lives in `lib/desk/` and is tested there; this file is only
 * how it is read. Deliberately unstyled beyond the house table conventions —
 * these are correct before they are pretty, and the visual pass belongs to
 * whoever owns the design of this page.
 *
 * Two rules are load-bearing rather than cosmetic. A null is drawn as an em
 * dash and never as zero, because a percentage of zero and an unmeasured
 * quantity look identical once they are both "0.0%" in a column. And every
 * panel whose figures read the future says so in its own footer, next to the
 * numbers, rather than in a note at the bottom of the page that a reader
 * screenshotting one panel will not carry with them.
 */

const dash = '—';
const pct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? dash : formatPercent(v, digits);
const signed = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? dash : formatSignedPercent(v, digits);
const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? dash : formatNumber(v, digits);
const tone = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'text-positive' : 'text-negative';

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">{children}</p>
  );
}

const TH = 'px-2 py-1.5 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground';
const TD = 'numeric px-2 py-1.5 text-right tabular-nums';

/* ------------------------------------------------------------------ */
/* Drawdown recovery topology                                          */
/* ------------------------------------------------------------------ */

export function RecoveryPanel({ topology }: { topology: DrawdownTopology | null }) {
  const bands = topology?.bands.filter((b) => b.episodes > 0) ?? [];

  return (
    <ChartFrame
      title="Recovery topology"
      description="What has followed each depth of drawdown, measured from the day the depth became visible rather than from the low. Read down the table: the further fall is what the remaining decline cost someone who waited for the hole to be obvious."
      footer={
        topology?.current
          ? `Time under water ${pct(topology.underwaterShare, 0)} of ${topology.bars} bars · ulcer index ${pct(topology.ulcer)} · ${topology.totalEpisodes} episodes`
          : undefined
      }
    >
      {!topology || !bands.length ? (
        <Empty>
          This security has no drawdown deep enough to describe over the history that loaded.
        </Empty>
      ) : (
        <div className="overflow-x-auto px-3 sm:px-4">
          <table className="w-full min-w-[44rem] text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Depth</th>
                <th className={cn(TH, 'text-right')}>Times</th>
                <th className={cn(TH, 'text-right')}>Median further fall</th>
                <th className={cn(TH, 'text-right')}>Worst further fall</th>
                <th className={cn(TH, 'text-right')}>Bars to trough</th>
                <th className={cn(TH, 'text-right')}>Bars to recover</th>
                <th className={cn(TH, 'text-right')}>Recovered</th>
                <th className={cn(TH, 'text-right')}>Worst depth</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.threshold} className="border-b border-border/50 last:border-0">
                  <td className="numeric px-2 py-1.5 font-semibold">{b.label}</td>
                  <td className={TD}>{b.episodes}</td>
                  <td className={cn(TD, tone(b.medianFurtherFall))}>
                    {signed(b.medianFurtherFall)}
                  </td>
                  <td className={cn(TD, tone(b.worstFurtherFall))}>{signed(b.worstFurtherFall)}</td>
                  <td className={TD}>{num(b.medianBarsToTrough, 0)}</td>
                  <td className={TD}>
                    {num(b.medianBarsToRecover, 0)}
                    {b.unrecovered > 0 && (
                      <span
                        className="ml-1 text-2xs font-normal text-muted-foreground"
                        title={`${b.unrecovered} of these have not recovered, and cannot contribute a duration`}
                      >
                        +{b.unrecovered}?
                      </span>
                    )}
                  </td>
                  <td className={TD}>{pct(b.recoveryRate, 0)}</td>
                  <td className={cn(TD, 'text-negative')}>{signed(b.worstDepth)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="px-2 pb-1 pt-3 text-xs leading-relaxed text-muted-foreground">
            {topology.current
              ? `Currently ${pct(Math.abs(topology.current.drawdown))} below the high set ${topology.current.peakDate}, ${topology.current.barsUnderwater} bars ago; ${pct(topology.current.gainToRecover)} would regain it. `
              : ''}
            A “+n?” beside a recovery time counts episodes still under water, which cannot
            contribute a duration — so every median here is biased short by exactly the cases a
            reader most wants to know about. These are descriptions of a record, measured with data
            from after the day they are attached to, and would be look-ahead if traded.
          </p>
        </div>
      )}
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Session split                                                       */
/* ------------------------------------------------------------------ */

export function SessionSplitPanel({ split }: { split: SessionSplit | null }) {
  return (
    <ChartFrame
      title="Overnight against the session"
      description="A close-to-close return is two different markets glued together: the gap, which is only accessible at the open and carries the news, and the continuous session, where an order can actually be worked. The two legs compound to the total — they do not add — and the share of the move is quoted in logs, which is the only decomposition that reconciles."
      footer={
        split
          ? `${split.sessions} sessions · ${split.exDividendSessionsExcluded} ex-dividend excluded · volatility annualised at one observation per session, so it is per-event risk, not per-hour`
          : undefined
      }
    >
      {!split ? (
        <Empty>
          Not enough sessions with a usable open and close to split this security&rsquo;s return.
        </Empty>
      ) : (
        <div className="space-y-3 px-3 sm:px-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Leg</th>
                  <th className={cn(TH, 'text-right')}>Compounded</th>
                  <th className={cn(TH, 'text-right')}>Share of move</th>
                  <th className={cn(TH, 'text-right')}>Mean</th>
                  <th className={cn(TH, 'text-right')}>Median</th>
                  <th className={cn(TH, 'text-right')}>Vol (ann.)</th>
                  <th className={cn(TH, 'text-right')}>Positive</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Overnight', split.overnight],
                    ['Session', split.intraday],
                  ] as const
                ).map(([label, leg]) => (
                  <tr key={label} className="border-b border-border/50">
                    <td className="px-2 py-1.5 font-semibold">{label}</td>
                    <td className={cn(TD, tone(leg.growth))}>{signed(leg.growth)}</td>
                    <td className={TD}>{pct(leg.share, 0)}</td>
                    <td className={cn(TD, tone(leg.meanReturn))}>{signed(leg.meanReturn, 3)}</td>
                    <td className={cn(TD, tone(leg.medianReturn))}>{signed(leg.medianReturn, 3)}</td>
                    <td className={TD}>{pct(leg.volatility)}</td>
                    <td className={TD}>{pct(leg.positiveShare, 0)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="px-2 py-1.5 text-muted-foreground">Both, compounded</td>
                  <td className={cn(TD, tone(split.totalGrowth))}>{signed(split.totalGrowth)}</td>
                  <td className={cn(TD, 'text-muted-foreground')}>100%</td>
                  <td className={TD} colSpan={4} />
                </tr>
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Gap quintile</th>
                  <th className={cn(TH, 'text-right')}>Sessions</th>
                  <th className={cn(TH, 'text-right')}>Mean gap</th>
                  <th className={cn(TH, 'text-right')}>Session that followed</th>
                  <th className={cn(TH, 'text-right')}>Median</th>
                  <th className={cn(TH, 'text-right')}>Kept going</th>
                </tr>
              </thead>
              <tbody>
                {split.buckets.map((b) => (
                  <tr key={b.rank} className="border-b border-border/50 last:border-0">
                    <td className="px-2 py-1.5">{b.label}</td>
                    <td className={TD}>{b.sessions}</td>
                    <td className={cn(TD, tone(b.meanOvernight))}>{signed(b.meanOvernight, 2)}</td>
                    <td className={cn(TD, tone(b.meanIntraday))}>{signed(b.meanIntraday, 3)}</td>
                    <td className={cn(TD, tone(b.medianIntraday))}>{signed(b.medianIntraday, 3)}</td>
                    <td className={TD}>{pct(b.continuationShare, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="px-2 pb-1 text-xs leading-relaxed text-muted-foreground">
            Gap and session correlation {num(split.gapFollowThrough)} — negative is the gap fading,
            positive is it being extended. Overall {pct(split.continuationShare, 0)} of sessions went
            the same way as the gap that opened them. The quintiles are this security&rsquo;s own and
            are drawn from the whole sample, which a reader standing in the past would not have had.
            Ex-dividend sessions are dropped because the price series is not dividend-adjusted, and
            leaving them in charges the whole distribution to the overnight leg.
            {split.identicalOpenSessions > split.sessions / 2
              ? ' Most opens in this feed are exactly the prior close, which means it is not carrying real opens and this split is an artefact of the data rather than a fact about the security.'
              : ''}
          </p>
        </div>
      )}
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Volatility persistence                                              */
/* ------------------------------------------------------------------ */

export function PersistencePanel({
  persistence,
}: {
  persistence: VolatilityPersistence | null;
}) {
  const p = persistence;
  const maxAcf = Math.max(
    0.05,
    ...(p?.acf.flatMap((a) => [Math.abs(a.absolute ?? 0), Math.abs(a.signed ?? 0)]) ?? []),
  );

  return (
    <ChartFrame
      title="Volatility persistence"
      description="The cone says how volatile this security is now. This says how long that tends to last. Magnitude is measured as the absolute log return, not the squared one — both are standard, and under fat tails they disagree."
      footer={
        p
          ? `${p.observations} log returns · half-life ${num(p.halfLife, 1)} trading days · quartile cuts ${p.cuts.map((c) => pct(c, 2)).join(' / ')}`
          : undefined
      }
    >
      {!p ? (
        <Empty>Not enough history to measure how long this security&rsquo;s volatility lasts.</Empty>
      ) : (
        <div className="space-y-3 px-3 sm:px-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
            <Fact label="Lag-1 persistence" value={num(p.rho1)} sub="of |log return|" />
            <Fact
              label="Quiet after quiet"
              value={pct(p.quietAfterQuiet, 0)}
              sub="0.25 if independent"
            />
            <Fact
              label="Storm after storm"
              value={pct(p.stormAfterStorm, 0)}
              sub="0.25 if independent"
            />
            <Fact
              label="Today"
              value={p.currentQuartile != null ? `Q${p.currentQuartile}` : dash}
              sub="quartile of own moves"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Today</th>
                  <th className={cn(TH, 'text-right')}>→ Q1 quietest</th>
                  <th className={cn(TH, 'text-right')}>→ Q2</th>
                  <th className={cn(TH, 'text-right')}>→ Q3</th>
                  <th className={cn(TH, 'text-right')}>→ Q4 wildest</th>
                  <th className={cn(TH, 'text-right')}>Days</th>
                </tr>
              </thead>
              <tbody>
                {p.matrix.map((row) => (
                  <tr key={row.from} className="border-b border-border/50 last:border-0">
                    <td className="px-2 py-1.5 font-semibold">Q{row.from}</td>
                    {row.to.map((cell, i) => (
                      <td
                        key={i}
                        className={cn(
                          TD,
                          i === row.from - 1 && cell != null && cell > 0.25 && 'font-semibold',
                        )}
                      >
                        {pct(cell, 0)}
                      </td>
                    ))}
                    <td className={cn(TD, 'text-muted-foreground')}>{row.observations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1 pb-1">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Autocorrelation by lag — magnitude against direction
            </p>
            {p.acf.map((a) => (
              <div key={a.lag} className="flex items-center gap-2 text-2xs">
                <span className="numeric w-8 shrink-0 text-muted-foreground">{a.lag}d</span>
                <div className="flex h-3 flex-1 items-center">
                  <div className="flex w-1/2 justify-end">
                    <div
                      className="h-2 rounded-l bg-negative/60"
                      style={{
                        width: `${Math.max(0, -(a.absolute ?? 0) / maxAcf) * 100}%`,
                      }}
                    />
                  </div>
                  <div className="flex w-1/2 justify-start">
                    <div
                      className="h-2 rounded-r bg-positive/60"
                      style={{ width: `${Math.max(0, (a.absolute ?? 0) / maxAcf) * 100}%` }}
                    />
                  </div>
                </div>
                <span className="numeric w-12 shrink-0 text-right">{num(a.absolute)}</span>
                <span
                  className="numeric w-12 shrink-0 text-right text-muted-foreground"
                  title="Autocorrelation of the signed return at the same lag"
                >
                  {num(a.signed)}
                </span>
              </div>
            ))}
            <p className="px-2 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground">
              The bars and the first column are the magnitude; the greyed column is the signed
              return at the same lag. The pair is the reading — the same series is close to
              unpredictable in direction and strongly persistent in size, and one line alone cannot
              show that. The half-life reads the lag-1 figure as an AR(1); absolute returns decay
              far more slowly than any AR(1), so read the curve for the tail. The quartile cuts come
              from the whole sample, which makes the matrix a description of a record and would be
              look-ahead if traded.
            </p>
          </div>
        </div>
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
