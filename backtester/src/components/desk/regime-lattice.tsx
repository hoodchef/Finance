'use client';

import * as React from 'react';
import { ChartFrame } from '@/components/charts/chart-chrome';
import { formatNumber, formatPercent, formatSignedPercent } from '@/lib/format';
import { cn, seriesColor } from '@/lib/utils';
import type { RegimeLattice, LatticeVertex } from '@/lib/desk/regime-lattice';

const W = 460;
const H = 380;
const R = 168; // Half the drawing area, leaving room for the largest node.

/**
 * The 5D strategy lattice.
 * =============================================================================
 * A five-cube — 32 vertices, 80 edges — where every axis is a real condition
 * and every vertex is a state this security has been in. An edge is one
 * condition flipping, which is why the same axis is always the same direction
 * on screen: the eye can follow what changed without reading a label.
 *
 * The geometry is not decoration. Node size is how long the security spent
 * there, node colour is what tended to happen next, and a hollow node is a
 * state it has never occupied — most names live on a handful of the 32 and
 * never visit the rest, and the empty corners are as informative as the full
 * ones.
 */
export function RegimeLatticePanel({ lattice }: { lattice: RegimeLattice | null }) {
  const [hover, setHover] = React.useState<number | null>(null);

  if (!lattice || !lattice.vertices.length) {
    return (
      <ChartFrame
        title="5D strategy lattice"
        description="Every state this security has been in, and what followed."
      >
        <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
          The lattice needs about four years of history before it can classify a day at all —
          two hundred of them establish the trend average alone. There is not enough here.
        </p>
      </ChartFrame>
    );
  }

  const byCode = new Map(lattice.vertices.map((v) => [v.code, v]));
  const maxVisits = Math.max(1, ...lattice.vertices.map((v) => v.visits));
  const maxForward = Math.max(
    0.001,
    ...lattice.vertices.map((v) => Math.abs(v.forward ?? 0)),
  );

  const cx = (v: LatticeVertex) => W / 2 + v.x * R;
  const cy = (v: LatticeVertex) => H / 2 + v.y * R;
  const radius = (v: LatticeVertex) =>
    v.visits === 0 ? 2.5 : 3 + Math.sqrt(v.visits / maxVisits) * 9;

  const current = byCode.get(lattice.currentCode ?? -1) ?? null;
  const shown = hover != null ? byCode.get(hover) : current;

  return (
    <ChartFrame
      title="5D strategy lattice"
      description="Five conditions, so thirty-two possible states. Each day lands on one vertex; each edge is a single condition flipping. Size is time spent, colour is the forward return that followed."
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="overflow-x-auto px-2 sm:px-3">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-[380px] w-full min-w-[380px]"
            role="img"
            aria-label="Five-dimensional regime lattice: 32 vertices, 80 edges"
            onMouseLeave={() => setHover(null)}
          >
            {lattice.edges.map((e) => {
              const a = byCode.get(e.from)!;
              const b = byCode.get(e.to)!;
              const walked = e.traversals > 0;
              const touching = hover != null && (e.from === hover || e.to === hover);
              return (
                <line
                  key={`${e.from}-${e.to}`}
                  x1={cx(a)} y1={cy(a)} x2={cx(b)} y2={cy(b)}
                  stroke={touching ? 'hsl(var(--primary))' : 'hsl(var(--border))'}
                  strokeWidth={touching ? 1.4 : walked ? 1 : 0.5}
                  strokeOpacity={touching ? 0.9 : walked ? 0.75 : 0.28}
                />
              );
            })}

            {lattice.vertices.map((v) => {
              const visited = v.visits > 0;
              const f = v.forward;
              const fill = !visited
                ? 'transparent'
                : f == null
                  ? 'hsl(var(--muted-foreground))'
                  : f >= 0
                    ? 'hsl(var(--positive))'
                    : 'hsl(var(--negative))';
              return (
                <g key={v.code}>
                  {v.current && (
                    <circle
                      cx={cx(v)} cy={cy(v)} r={radius(v) + 4.5}
                      fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5}
                    />
                  )}
                  <circle
                    cx={cx(v)} cy={cy(v)} r={radius(v)}
                    fill={fill}
                    fillOpacity={f == null ? 0.45 : 0.3 + (Math.abs(f) / maxForward) * 0.6}
                    stroke={visited ? fill : 'hsl(var(--border))'}
                    strokeWidth={1}
                    onMouseEnter={() => setHover(v.code)}
                    style={{ cursor: 'pointer' }}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        <div className="space-y-2 px-4 pb-4 sm:px-5 lg:px-0 lg:pr-5">
          <Row label="Vertices" value={`${lattice.occupied} / ${lattice.vertices.length}`} sub="states ever occupied" />
          <Row label="Edges" value={String(lattice.edges.length)} sub="one condition apart" />
          <Row label="Days classified" value={String(lattice.classified)} sub={`forward return over ${lattice.horizon}d`} />

          {shown && (
            <div className="rounded-md border border-border bg-muted/40 p-2.5">
              <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {shown.current && hover == null ? 'Today' : `Vertex ${shown.code}`}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {lattice.axes.map((axis, i) => (
                  <span
                    key={axis}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-2xs',
                      shown.bits[i]
                        ? 'bg-primary/20 text-foreground'
                        : 'bg-transparent text-muted-foreground line-through',
                    )}
                  >
                    {axis}
                  </span>
                ))}
              </div>
              <dl className="mt-2 space-y-1">
                <Pair label="Days here" value={String(shown.visits)} />
                <Pair
                  label={`Forward ${lattice.horizon}d`}
                  value={shown.forward != null ? formatSignedPercent(shown.forward) : '—'}
                  tone={
                    shown.forward == null ? '' : shown.forward > 0 ? 'text-positive' : 'text-negative'
                  }
                />
                <Pair
                  label="Spread"
                  value={shown.forwardSd != null ? `±${formatPercent(shown.forwardSd)}` : '—'}
                />
                <Pair label="Observations" value={String(shown.samples)} />
              </dl>
              {shown.forward == null && shown.visits > 0 && (
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Too few observations to report a forward return.
                </p>
              )}
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Hover a vertex. Hollow ones are states this security has never been in.
          </p>
        </div>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
        A description of a record, not a signal. The forward returns use data after the day they
        are attached to, which is fine for a study of what happened and would be look-ahead if it
        were traded; the windows overlap, so twenty-eight observations are nothing like
        twenty-eight independent ones. Thresholds are this security&rsquo;s own medians, because
        &ldquo;high volatility&rdquo; is a different number for a utility and a biotech.
      </p>
    </ChartFrame>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/50 pb-1.5">
      <span className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-right">
        <span className="numeric text-sm font-semibold">{value}</span>
        <span className="block text-2xs text-muted-foreground">{sub}</span>
      </span>
    </div>
  );
}

function Pair({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className={cn('numeric text-2xs font-semibold', tone)}>{value}</dd>
    </div>
  );
}
