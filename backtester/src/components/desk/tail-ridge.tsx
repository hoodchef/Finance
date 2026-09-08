'use client';

import * as React from 'react';
import { ChartFrame } from '@/components/charts/chart-chrome';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { cn, seriesColor } from '@/lib/utils';
import type { TailComparison } from '@/lib/desk/tails';

interface RidgeBand {
  years: number;
  label: string;
  density: number[];
  probabilityAbove: number;
  oneSigma: number;
}

export interface TailRidgeData {
  ridge: { grid: number[]; bands: RidgeBand[]; reference: number };
  comparisons: TailComparison[];
  volatility: number;
  spot: number;
}

const W = 720;
const H = 330;
const PAD = { top: 14, right: 12, bottom: 22, left: 12 };

/**
 * The tail ridge.
 * =============================================================================
 * Terminal price distributions at five horizons, stacked back to front, with
 * the region beyond the threshold filled on both sides.
 *
 * Every band is drawn on ONE vertical scale rather than each normalised to its
 * own peak. That is deliberate and it is the opposite of the choice the
 * distribution lab makes: there the bands are separate scenarios and per-band
 * scaling keeps them all legible, whereas here the SPREADING IS THE SUBJECT.
 * A near horizon is a tall narrow spike and a far one a low wide hump because
 * that is what a widening distribution looks like; normalising each to the same
 * height would draw five identical humps and delete the message.
 */
export function TailRidgePanel({ data }: { data: TailRidgeData | null }) {
  if (!data || !data.ridge.bands.length) {
    return (
      <ChartFrame
        title="Tail probability ridge"
        description="Where the price could finish, and how often it has actually gone that far."
      >
        <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
          Not enough history to measure a volatility for this security, so there is no
          distribution to draw. Nothing is shown rather than a curve drawn from an assumed
          number.
        </p>
      </ChartFrame>
    );
  }

  const { grid, bands } = data.ridge;
  /*
   * The threshold now grows with the horizon, so there is no single pair of
   * lines to draw. The chart marks the FURTHEST horizon's band — the widest,
   * and therefore the one whose tail is visible on this scale — and the table
   * below carries each horizon's own.
   */
  const widest = data.comparisons[data.comparisons.length - 1];
  const threshold = widest?.threshold ?? 0.1;
  const sigmas = widest?.sigmas ?? 2;
  const upper = data.spot * (1 + threshold);
  const lower = data.spot * (1 - threshold);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const xOf = (price: number) =>
    PAD.left + ((price - grid[0]) / (grid[grid.length - 1] - grid[0])) * plotW;

  // One scale across every band, so a far horizon really is flatter.
  const peak = Math.max(...bands.flatMap((b) => b.density));
  /*
   * The tallest band has to FIT.
   *
   * Each band is drawn from its own baseline, and row 0 — the nearest horizon,
   * and always the tallest, because a one-week density is the most
   * concentrated — sits one row down from the top. So an amplitude above one
   * row height sends its peak off the top of the viewBox, which is exactly
   * what happened at 2.4: the spike was cut flat and the picture lost the very
   * band it is scaled by.
   */
  const rowH = plotH / bands.length;
  const amp = rowH * 0.95;

  const bandPath = (band: RidgeBand, row: number, clip?: [number, number]) => {
    const base = PAD.top + rowH * (row + 1);
    const pts: string[] = [];
    let started = false;
    for (let i = 0; i < grid.length; i++) {
      const price = grid[i];
      if (clip && (price < clip[0] || price > clip[1])) continue;
      const x = xOf(price);
      const y = base - (band.density[i] / peak) * amp;
      pts.push(`${started ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`);
      started = true;
    }
    if (!pts.length) return '';
    const first = clip ? Math.max(grid[0], clip[0]) : grid[0];
    const last = clip ? Math.min(grid[grid.length - 1], clip[1]) : grid[grid.length - 1];
    return `${pts.join('')}L${xOf(last).toFixed(2)},${base.toFixed(2)}L${xOf(first).toFixed(2)},${base.toFixed(2)}Z`;
  };

  return (
    <ChartFrame
      title="Tail probability ridge"
      description="Where the price could finish at each horizon under a lognormal drawn from this security's own realised volatility — and, beside it, how often the security has actually travelled that far. The model is the curve; the table is the record."
    >
      <div className="overflow-x-auto px-2 sm:px-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-[330px] w-full min-w-[520px]"
          role="img"
          aria-label="Terminal price distributions at five horizons, with the tails beyond two standard deviations filled"
        >
          {/* The spot line and the two thresholds, behind the bands. */}
          <line
            x1={xOf(data.spot)} x2={xOf(data.spot)} y1={PAD.top} y2={H - PAD.bottom}
            stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="2 3"
          />
          {[lower, upper].map((level) => (
            <line
              key={level}
              x1={xOf(level)} x2={xOf(level)} y1={PAD.top} y2={H - PAD.bottom}
              stroke="hsl(var(--negative))" strokeWidth={1} strokeOpacity={0.45}
            />
          ))}

          {/* Back to front, so nearer horizons sit in front of further ones. */}
          {[...bands].reverse().map((band, i) => {
            const row = bands.length - 1 - i;
            return (
              <g key={band.label}>
                <path
                  d={bandPath(band, row)}
                  fill="hsl(var(--card))"
                  fillOpacity={0.82}
                  stroke={seriesColor(band.label, row)}
                  strokeWidth={1.1}
                />
                {/* The tails, filled on both sides of the threshold. */}
                <path d={bandPath(band, row, [grid[0], lower])} fill="hsl(var(--negative))" fillOpacity={0.5} />
                <path
                  d={bandPath(band, row, [upper, grid[grid.length - 1]])}
                  fill="hsl(var(--positive))" fillOpacity={0.42}
                />
                <text
                  x={PAD.left + 2}
                  y={PAD.top + rowH * (row + 1) - 2}
                  fontSize={9}
                  fill="hsl(var(--muted-foreground))"
                >
                  {band.label}
                </text>
              </g>
            );
          })}

          {[lower, data.spot, upper].map((level, i) => (
            <text
              key={level}
              x={xOf(level)}
              y={H - 8}
              fontSize={9}
              textAnchor="middle"
              fill="hsl(var(--muted-foreground))"
            >
              {i === 1 ? `spot ${formatCurrency(level)}` : formatCurrency(level)}
            </text>
          ))}
        </svg>
      </div>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 pl-4 pr-3 font-medium sm:pl-5">Horizon</th>
              <th className="py-2 pr-3 text-right font-medium">Beyond</th>
              <th className="py-2 pr-3 text-right font-medium">Model</th>
              <th className="py-2 pr-3 text-right font-medium">Observed</th>
              <th className="py-2 pr-3 text-right font-medium">Windows</th>
              <th className="py-2 pr-4 text-right font-medium sm:pr-5">Fat tail</th>
            </tr>
          </thead>
          <tbody>
            {data.comparisons.map((c) => {
              const model = c.modelUp + c.modelDown;
              const observed = (c.observedUp ?? 0) + (c.observedDown ?? 0);
              return (
                <tr key={c.label} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pl-4 pr-3 sm:pl-5">{c.label}</td>
                  <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                    ±{formatPercent(c.threshold, 1)}
                  </td>
                  <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                    {formatPercent(model)}
                  </td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatPercent(observed)}</td>
                  <td className="numeric py-1.5 pr-3 text-right text-muted-foreground">
                    {c.samples}
                  </td>
                  <td
                    className={cn(
                      'numeric py-1.5 pr-4 text-right font-semibold sm:pr-5',
                      c.fatTailMultiple != null && c.fatTailMultiple > 1.15 && 'text-negative',
                    )}
                  >
                    {c.fatTailMultiple != null ? `×${formatNumber(c.fatTailMultiple, 2)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
        The curve is a model and the table is what happened. Each row measures beyond {sigmas}{' '}
        standard deviations of its OWN horizon, which is why the model column barely moves — that
        is the point, because it leaves the observed column as the only thing that varies. A
        lognormal is thin-tailed by construction, so the multiple is usually above one. Windows
        overlap, which makes the observed column a description of this security&rsquo;s record
        rather than a significance test.
      </p>
    </ChartFrame>
  );
}
