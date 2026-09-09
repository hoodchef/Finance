'use client';

import * as React from 'react';
import { ChartFrame, useMeasuredWidth } from '@/components/charts/chart-chrome';
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

const PAD = { top: 16, right: 12, bottom: 22, left: 12 };
const MIN_W = 300;

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
 *
 * READING IT. The picture could only be looked at: five curves, three price
 * labels, and no way to ask what any point on it meant. The crosshair answers
 * the question the shape exists to raise — the same price is an unremarkable
 * finish at six months and an extraordinary one at a week — by reporting the
 * distance from spot in EACH horizon's own standard deviations.
 *
 * That figure is not a new model. `oneSigma` is `spot · σ · √t`, supplied per
 * band, so the log-space σ is `oneSigma / spot` and the readout is
 * `ln(price / spot)` over it — the same definition of "two standard deviations"
 * the threshold lines and the table below already use, so the crosshair reads
 * ±2σ exactly where those lines are drawn. Reporting a probability instead was
 * tempting and would have been wrong: the grid stops at 2.5σ of the longest
 * horizon, so summing the drawn density understates precisely the tail this
 * panel is about.
 */
export function TailRidgePanel({ data }: { data: TailRidgeData | null }) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>();

  /*
   * The crosshair is an INDEX into the price grid, not a price. The bands are
   * sampled on that grid, so an index puts the marker exactly on each curve,
   * and it gives the keyboard a natural step — one sample — without inventing
   * a second notion of how far an arrow key should move.
   */
  const [cross, setCross] = React.useState<number | null>(null);
  /** The horizon under the pointer, in the drawing, the readout or the table. */
  const [active, setActive] = React.useState<string | null>(null);

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

  /*
   * A pixel-for-pixel viewBox, so the ridge REFLOWS with the panel rather than
   * scaling inside it. The height follows the width at a little under half,
   * clamped both ways: below ~210px five stacked bands stop being separable,
   * and above ~360 one panel starts to dominate a page of six.
   */
  const W = Math.max(MIN_W, width);
  const H = Math.round(Math.min(360, Math.max(210, W * 0.42)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const lo = grid[0];
  const hi = grid[grid.length - 1];
  const xOf = (price: number) => PAD.left + ((price - lo) / (hi - lo)) * plotW;
  const clampIndex = (i: number) => Math.min(grid.length - 1, Math.max(0, i));
  const indexAtX = (x: number) => clampIndex(Math.round(((x - PAD.left) / plotW) * (grid.length - 1)));
  const indexAtPrice = (price: number) =>
    clampIndex(Math.round(((price - lo) / (hi - lo)) * (grid.length - 1)));

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
  const baseOf = (row: number) => PAD.top + rowH * (row + 1);
  const yOf = (band: RidgeBand, row: number, i: number) =>
    baseOf(row) - (band.density[i] / peak) * amp;

  const bandPath = (band: RidgeBand, row: number, clip?: [number, number]) => {
    const base = baseOf(row);
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
    const first = clip ? Math.max(lo, clip[0]) : lo;
    const last = clip ? Math.min(hi, clip[1]) : hi;
    return `${pts.join('')}L${xOf(last).toFixed(2)},${base.toFixed(2)}L${xOf(first).toFixed(2)},${base.toFixed(2)}Z`;
  };

  const crossPrice = cross != null ? grid[cross] : null;
  const crossX = cross != null ? xOf(grid[cross]) : 0;
  /** Distance from spot in this horizon's own standard deviations. */
  const sigmaAt = (band: RidgeBand, price: number) =>
    Math.log(price / data.spot) / (band.oneSigma / data.spot);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const spotIndex = indexAtPrice(data.spot);
    const at = cross ?? spotIndex;
    const step = (n: number) => {
      event.preventDefault();
      setCross(clampIndex(at + n));
    };
    if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'PageUp') step(8);
    else if (event.key === 'PageDown') step(-8);
    else if (event.key === 'Home') {
      event.preventDefault();
      setCross(spotIndex);
    } else if (event.key === 'Escape') setCross(null);
  };

  return (
    <ChartFrame
      title="Tail probability ridge"
      description="Where the price could finish at each horizon under a lognormal drawn from this security's own realised volatility — and, beside it, how often the security has actually travelled that far. The model is the curve; the table is the record."
    >
      <div
        ref={box}
        className="rounded px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
        tabIndex={0}
        role="group"
        aria-label="Tail ridge. Arrow keys move a price crosshair, Home returns it to spot, Escape clears it."
        onKeyDown={onKeyDown}
      >
        {/* Nothing is drawn until the container has been measured: a guessed
            width would lay the ridge out once and then move every curve. */}
        {width > 0 && (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            role="img"
            aria-label={`Terminal price distributions at ${bands.length} horizons, with the tails beyond ${sigmas} standard deviations filled`}
            onPointerMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              setCross(indexAtX(((event.clientX - rect.left) / rect.width) * W));
            }}
            onPointerLeave={() => setCross(null)}
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
              const dim = active != null && active !== band.label;
              return (
                <g
                  key={band.label}
                  onPointerEnter={() => setActive(band.label)}
                  onPointerLeave={() => setActive(null)}
                >
                  <path
                    d={bandPath(band, row)}
                    fill="hsl(var(--card))"
                    /*
                     * Only the STROKE responds to the highlight. The fill is
                     * what hides the further horizons behind the nearer ones,
                     * so fading it turns the ridge into five overlapping
                     * outlines and loses the front-to-back reading entirely.
                     */
                    fillOpacity={0.82}
                    stroke={seriesColor(band.label, row)}
                    strokeWidth={active === band.label ? 2.2 : 1.1}
                    strokeOpacity={dim ? 0.32 : 1}
                  />
                  {/* The tails, filled on both sides of the threshold. */}
                  <path d={bandPath(band, row, [lo, lower])} fill="hsl(var(--negative))" fillOpacity={0.5} />
                  <path
                    d={bandPath(band, row, [upper, hi])}
                    fill="hsl(var(--positive))" fillOpacity={0.42}
                  />
                  <text
                    x={PAD.left + 2}
                    y={baseOf(row) - 3}
                    fontSize={10}
                    fontWeight={active === band.label ? 700 : 500}
                    fill={seriesColor(band.label, row)}
                    fillOpacity={dim ? 0.45 : 1}
                  >
                    {band.label}
                  </text>
                </g>
              );
            })}

            {/* In front of the bands, but transparent to the pointer so it
                never steals the hover it exists to follow. */}
            {cross != null && (
              <g pointerEvents="none">
                <line
                  x1={crossX} x2={crossX} y1={PAD.top} y2={H - PAD.bottom}
                  stroke="hsl(var(--primary))" strokeWidth={1}
                />
                {bands.map((band, row) => (
                  <circle
                    key={band.label}
                    cx={crossX}
                    cy={yOf(band, row, cross)}
                    r={2.6}
                    fill={seriesColor(band.label, row)}
                    stroke="hsl(var(--card))"
                    strokeWidth={1}
                  />
                ))}
                <text
                  x={crossX}
                  y={PAD.top - 5}
                  fontSize={10}
                  textAnchor={crossX > W * 0.8 ? 'end' : crossX < W * 0.2 ? 'start' : 'middle'}
                  fill="hsl(var(--foreground))"
                >
                  {formatCurrency(grid[cross])}
                </text>
              </g>
            )}

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
        )}
      </div>

      {/*
       * The readout holds its height whether or not a crosshair is set, so
       * moving the pointer onto the drawing does not shove the table down the
       * page underneath the reader's eye.
       */}
      <div className="mt-1 min-h-[4.25rem] border-t border-border px-4 pt-2.5 sm:px-5">
        {crossPrice == null ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Point at a price — or focus the drawing and use the arrow keys — to read how far it is
            from spot in each horizon&rsquo;s own standard deviations. The same finish is ordinary
            at six months and extreme at one week, which is what the widening says.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6" aria-live="polite">
            <div className="flex flex-col gap-0.5">
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Finish at
              </span>
              <span className="numeric text-sm font-semibold">{formatCurrency(crossPrice)}</span>
              <span
                className={cn(
                  'numeric text-2xs',
                  crossPrice > data.spot
                    ? 'text-positive'
                    : crossPrice < data.spot
                      ? 'text-negative'
                      : 'text-muted-foreground',
                )}
              >
                {formatPercent(crossPrice / data.spot - 1, 1)} from spot
              </span>
            </div>
            {bands.map((band, row) => {
              const z = sigmaAt(band, crossPrice);
              return (
                <div
                  key={band.label}
                  className="flex flex-col gap-0.5"
                  onPointerEnter={() => setActive(band.label)}
                  onPointerLeave={() => setActive(null)}
                >
                  <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span
                      aria-hidden
                      className="h-2 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: seriesColor(band.label, row) }}
                    />
                    {band.label}
                  </span>
                  <span
                    className={cn(
                      'numeric text-sm font-semibold',
                      // Past the threshold this panel is measured at, the
                      // reading IS the tail — so it is coloured like one.
                      Math.abs(z) >= sigmas ? (z > 0 ? 'text-positive' : 'text-negative') : '',
                    )}
                  >
                    {z > 0 ? '+' : ''}
                    {formatNumber(z, 2)}σ
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    1σ is ±{formatPercent(band.oneSigma / data.spot, 1)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-2.5 overflow-x-auto border-t border-border">
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
            {data.comparisons.map((c, row) => {
              const model = c.modelUp + c.modelDown;
              const observed = (c.observedUp ?? 0) + (c.observedDown ?? 0);
              return (
                <tr
                  key={c.label}
                  className={cn(
                    'border-b border-border/50 last:border-0',
                    // A row and a curve are the same horizon, and nothing on
                    // the panel used to say which curve a row meant.
                    active === c.label && 'bg-muted/40',
                  )}
                  onPointerEnter={() => setActive(c.label)}
                  onPointerLeave={() => setActive(null)}
                >
                  <td className="py-1.5 pl-4 pr-3 sm:pl-5">
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-2 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: seriesColor(c.label, row) }}
                      />
                      {c.label}
                    </span>
                  </td>
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
