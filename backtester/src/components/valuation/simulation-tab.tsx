'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { AXIS_PROPS, ChartFrame, ChartLegend, ChartTooltip, GRID_PROPS } from '@/components/charts/chart-chrome';
import { BASE } from '@/lib/valuation/asts/inputs';
import { CORR_PAIRS, DISTS } from '@/lib/valuation/asts/analytics';
import { ANALYST_MC as ANALYST, ANALYST_PW } from '@/lib/valuation/asts/stamped';
import { SCENARIO_COLOR, type Valuation } from './use-asts-valuation';
import { pct, usd } from './format';


export function SimulationTab({ v }: { v: Valuation }) {
  const { mc, price, diffs, model, inputs } = v;
  const r = mc.result;
  const hist = r
    ? r.hist.map((n, i) => ({ bin: i === 29 ? '290+' : `${i * 10}`, lo: i * 10, n, share: n / r.n }))
    : [];
  const priceBin = Math.min(29, Math.floor(price / 10));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        {mc.status === 'running' ? (
          <span>
            Simulating {r ? 'the updated model' : '20,000 paths'}… {Math.round(mc.progress * 100)}%
            {r ? ' — the figures below are from the previous run until it finishes.' : ''}
          </span>
        ) : mc.status === 'error' ? (
          <span className="text-negative">The simulation failed: {mc.message}</span>
        ) : (
          <span>
            {r?.n.toLocaleString()} paths on the current inputs, seed {r?.seed}. Deterministic: the same inputs give the same result.
          </span>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <ChartFrame
          title="Distribution of value per share"
          description={`Share of paths per $10 bin. A ${pct(inputs.scenario.prob[0], 0)} Distress jump sits at ${usd(model.runs[0].vps)}; every other path draws the fourteen drivers below and runs the Base model.`}
          footer={<ChartLegend series={[
            { label: 'Paths at or above the price', color: SCENARIO_COLOR[BASE] },
            { label: 'Paths below the price', color: 'hsl(var(--muted-foreground) / 0.5)' },
            { label: `Price ${usd(price)}`, color: 'hsl(var(--foreground))', dashed: true },
          ]} />}
        >
          <div className="h-64">
            {r ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hist} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap={1}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="bin" {...AXIS_PROPS} interval={4} tickFormatter={(x) => (x === '290+' ? x : `$${x}`)} />
                  <YAxis {...AXIS_PROPS} width={40} tickFormatter={(x) => pct(x, 0)} />
                  <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} content={({ active, payload }) =>
                    active && payload?.length ? (
                      <ChartTooltip
                        title={payload[0].payload.bin === '290+' ? '$290 and above' : `$${payload[0].payload.lo}–${payload[0].payload.lo + 10}`}
                        rows={[
                          { label: 'Paths', value: payload[0].payload.n.toLocaleString() },
                          { label: 'Share', value: pct(payload[0].payload.share, 1) },
                        ]}
                      />
                    ) : null} />
                  <ReferenceLine x={hist[priceBin]?.bin} stroke="hsl(var(--foreground))" strokeDasharray="4 3" />
                  <Bar dataKey="share" radius={[4, 4, 0, 0]}>
                    {hist.map((h) => (
                      <Cell key={h.bin} fill={h.lo + 10 > price ? SCENARIO_COLOR[BASE] : 'hsl(var(--muted-foreground) / 0.5)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Running…</div>
            )}
          </div>
        </ChartFrame>

        <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Simulation results">
          <header className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">Results</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {diffs.length === 0
                ? 'Beside the analyst’s own run at the same inputs. The two use different random streams, so they agree to sampling error, not to the cent.'
                : 'The analyst’s column is the delivered model; yours has been edited, so the two are not expected to agree.'}
            </p>
          </header>
          <Table className="text-xs">
            <TableHeader>
              <TableRow><TableHead /><NumHead>This run</NumHead><NumHead>Analyst</NumHead></TableRow>
            </TableHeader>
            <TableBody>
              {([
                ['Mean', r && usd(r.mean), usd(ANALYST.mean)],
                ['Std. error of the mean', r && usd(r.se), usd(ANALYST.se)],
                ['P5', r && usd(r.pct[5]), usd(ANALYST.p5)],
                ['P10', r && usd(r.pct[10]), usd(ANALYST.p10)],
                ['P25', r && usd(r.pct[25]), '—'],
                ['Median', r && usd(r.pct[50]), usd(ANALYST.p50)],
                ['P75', r && usd(r.pct[75]), '—'],
                ['P90', r && usd(r.pct[90]), usd(ANALYST.p90)],
                ['P95', r && usd(r.pct[95]), '—'],
                [`P(value > ${usd(price)})`, r && pct(r.pAbove, 1), `${pct(ANALYST.pAbove, 1)} at ${usd(ANALYST.price)}`],
                ['P(equity worth ~0)', r && pct(r.pZero, 1), pct(ANALYST.pZero, 1)],
                ['Mean excluding Distress paths', r && usd(r.meanNonDistress), usd(ANALYST.meanNonDistress)],
                ['Scenario prob-weighted value', usd(model.pw), usd(ANALYST_PW)],
                ['Implied return p.a., 3-yr: P10 / P50 / P90', r && `${pct(r.er3.p10, 0)} / ${pct(r.er3.p50, 0)} / ${pct(r.er3.p90, 0)}`, '—'],
              ] as Array<[string, string | null, string]>).map(([label, mine, theirs]) => (
                <TableRow key={label}>
                  <TableCell className="text-muted-foreground">{label}</TableCell>
                  <NumCell className="font-medium">{mine ?? '…'}</NumCell>
                  <NumCell className="text-muted-foreground">{theirs}</NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {r && (
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              Convergence — running mean after {r.conv.map((c) => `${c.k.toLocaleString()}: ${usd(c.mean)}`).join(' · ')}. Copula
              positive-definite (minimum eigenvalue {r.eigMin.toFixed(3)}).
            </p>
          )}
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Distributions">
          <header className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">What is drawn</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">The analyst’s design (analytics.py), unchanged. The WACC shift is drawn from N(0, 1pp) and replaces the what-if lever rather than adding to it, as in the original.</p>
          </header>
          <Table className="text-xs">
            <TableBody>
              {DISTS.map((d) => (
                <TableRow key={d.key}>
                  <TableCell className="numeric text-2xs text-muted-foreground">{d.key}</TableCell>
                  <TableCell>{d.desc}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
        <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Dependence">
          <header className="border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">Dependence — Gaussian copula</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Correlations between the drivers’ ranks. All other pairs are independent.</p>
          </header>
          <Table className="text-xs">
            <TableHeader><TableRow><TableHead>Pair</TableHead><NumHead>ρ</NumHead><TableHead>Why</TableHead></TableRow></TableHeader>
            <TableBody>
              {CORR_PAIRS.map(([a, b, rho, why]) => (
                <TableRow key={`${a}-${b}`}>
                  <TableCell className="numeric text-2xs">{a} / {b}</TableCell>
                  <NumCell>{rho.toFixed(2)}</NumCell>
                  <TableCell className="text-muted-foreground">{why}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </div>
  );
}
