'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Stat } from '@/components/ui/stat';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { AXIS_PROPS, ChartFrame, ChartLegend, ChartTooltip, CURSOR_PROPS, GRID_PROPS } from '@/components/charts/chart-chrome';
import { PERIODS, SCENARIOS, SCENARIO_INDICES, BASE } from '@/lib/valuation/asts/inputs';
import { MULTIPLE_YEARS } from '@/lib/valuation/asts/summary';
import { SCENARIO_COLOR, type Valuation } from './use-asts-valuation';
import { mm, mult, pct, signedPct, usd } from './format';

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: color }} />;
}

/**
 * What the numbers say, in sentences built from them. Nothing here is fixed
 * text about ASTS: change an input and the reading changes with it.
 */
function Reading({ v }: { v: Valuation }) {
  const { head, model, analytics, mc, price, priceIsLive, inputs } = v;
  const take = analytics.reverse.take;
  const baseTake = inputs.scenario.take_t1[BASE];
  const pAbove = mc.result?.pAbove;
  const lines: string[] = [];
  lines.push(
    `At ${usd(price)}${priceIsLive ? ' today' : ' (the delivered snapshot)'}, the probability-weighted intrinsic value of ${usd(head.pw)} is ${signedPct(head.pwUpside)} from the price.`,
  );
  if (take != null) {
    const rel = take / baseTake - 1;
    lines.push(
      `The price implies a Base-case Tier-1 peak take rate of ${pct(take)} against the model's ${pct(baseTake, 0)} — ${
        Math.abs(rel) < 0.1 ? 'the market is paying for roughly Base-case execution' : rel > 0 ? 'the market is paying for better than Base-case adoption' : 'the market is paying for less than Base-case adoption'
      }.`,
    );
  }
  lines.push(
    head.er3 < inputs.global.rf
      ? `If the price converges to value over three years, the model-implied return is ${pct(head.er3)} a year — below the ${pct(inputs.global.rf, 2)} risk-free rate, so at this price the model offers no premium for the risk it describes.`
      : `If the price converges to value over three years, the model-implied return is ${pct(head.er3)} a year against a ${pct(inputs.global.rf, 2)} risk-free rate.`,
  );
  if (mc.result) {
    lines.push(
      `The simulated distribution is lopsided: a ${pct(mc.result.pZero, 0)} chance of equity worth roughly nothing, a median of ${usd(mc.result.pct[50], 0)}, a P90 of ${usd(mc.result.pct[90], 0)}${pAbove != null ? `, and a ${pct(pAbove, 0)} chance that value exceeds the price` : ''}.`,
    );
  }
  const dist = model.runs[0].vps;
  const bear = model.runs[1].vps;
  lines.push(
    `Distress and Bear together carry ${pct(inputs.scenario.prob[0] + inputs.scenario.prob[1], 0)} of the weight and are worth ${usd(dist)} and ${usd(bear)} a share: the value sits almost entirely in the Base and Bull outcomes.`,
  );
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm leading-relaxed sm:p-5">
      <h2 className="mb-2 text-sm font-semibold">Reading</h2>
      <div className="space-y-2 text-muted-foreground">
        {lines.map((l) => (
          <p key={l.slice(0, 40)}>{l}</p>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        An analytical model, not investment advice. Every figure above is recomputed from the inputs on the Assumptions tab.
      </p>
    </div>
  );
}

export function SummaryTab({ v }: { v: Valuation }) {
  const { head, model, mc, price, priceIsLive, snapshot, livePrice, analytics, inputs } = v;
  const base = model.runs[BASE];

  const bars = SCENARIO_INDICES.map((s) => ({ name: SCENARIOS[s], value: model.runs[s].vps, s }));
  const pl = PERIODS.map((p, i) => ({ p, rev: base.rev[i], ebitda: base.ebitda[i], fcf: base.fcf[i] }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4 2xl:grid-cols-8">
        <Stat className="bg-card p-3" size="lg" label="Intrinsic value (prob-weighted)" value={usd(head.pw)}
          sub={`${SCENARIOS.map((_, s) => pct(inputs.scenario.prob[s], 0)).join(' / ')} weights`} />
        <Stat className="bg-card p-3" size="lg" label={priceIsLive ? 'Price (live)' : 'Price (snapshot)'} value={usd(price)}
          sub={priceIsLive ? `Model snapshot ${usd(snapshot.price)}` : livePrice != null ? `Live ${usd(livePrice)}` : 'IBKR, 10-Sep-2026'} />
        <Stat className="bg-card p-3" size="lg" label="Upside / (downside)" value={signedPct(head.pwUpside)}
          tone={head.pwUpside >= 0 ? 'positive' : 'negative'} sub="Probability-weighted vs price" />
        <Stat className="bg-card p-3" size="lg" label="Simulated P10 – P90"
          value={mc.result ? `${usd(mc.result.pct[10], 0)} – ${usd(mc.result.pct[90], 0)}` : '…'}
          sub={mc.result ? `P(value > price) ${pct(mc.result.pAbove, 0)}` : 'Running 20,000 paths'} />
        <Stat className="bg-card p-3" size="lg" label="Implied return, 3-yr" value={pct(head.er3)}
          tone={head.er3 >= inputs.global.rf ? 'positive' : 'negative'} sub={`Risk-free ${pct(inputs.global.rf, 2)}`} />
        <Stat className="bg-card p-3" size="lg" label="WACC growth → terminal" value={`${pct(base.wHi)} → ${pct(base.wT)}`}
          sub={`Ke ${pct(head.ke)}, beta ${v.betaHi.toFixed(2)}`} />
        <Stat className="bg-card p-3" size="lg" label="Market-implied Base take" value={analytics.reverse.take != null ? pct(analytics.reverse.take) : 'n/a'}
          sub={`Model Base ${pct(inputs.scenario.take_t1[BASE], 0)}`} />
        <Stat className="bg-card p-3" size="lg" label="P(equity worth ~0)" value={mc.result ? pct(mc.result.pZero, 0) : '…'}
          tone={mc.result && mc.result.pZero > 0.1 ? 'negative' : 'neutral'}
          sub={`Distress ${pct(inputs.scenario.prob[0], 0)} + draws that fail`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Reading v={v} />
        <ChartFrame
          title="Value per share by scenario"
          description="Floored at zero: equity is a limited-liability claim (A2-01)."
          footer={<ChartLegend series={[
            { label: `Price ${usd(price)}`, color: 'hsl(var(--foreground))', dashed: true },
            { label: `Prob-weighted ${usd(head.pw)}`, color: 'hsl(var(--muted-foreground))', dashed: true },
          ]} />}
        >
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} margin={{ top: 22, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="name" {...AXIS_PROPS} />
                <YAxis {...AXIS_PROPS} width={48} tickFormatter={(x) => usd(x, 0)} />
                <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} content={({ active, payload }) =>
                  active && payload?.length ? (
                    <ChartTooltip title={String(payload[0].payload.name)} rows={[
                      { label: 'Value per share', value: usd(payload[0].payload.value) },
                      { label: 'vs price', value: signedPct(payload[0].payload.value / price - 1) },
                      { label: 'Probability', value: pct(inputs.scenario.prob[payload[0].payload.s as 0], 0) },
                    ]} />
                  ) : null} />
                <ReferenceLine y={price} stroke="hsl(var(--foreground))" strokeDasharray="4 3" />
                <ReferenceLine y={head.pw} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 3" />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64}>
                  {bars.map((b) => <Cell key={b.name} fill={SCENARIO_COLOR[b.s as 0]} />)}
                  <LabelList dataKey="value" position="top" formatter={(x: number) => usd(x)}
                    className="fill-foreground text-2xs" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartFrame>
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Scenario summary">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-44">Scenario</TableHead>
                {SCENARIO_INDICES.map((s) => (
                  <NumHead key={s}><Swatch color={SCENARIO_COLOR[s]} />{SCENARIOS[s]}</NumHead>
                ))}
                <NumHead>Weighted</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {([
                ['Probability', (s: number) => pct(inputs.scenario.prob[s], 0), pct(1, 0)],
                ['Value per share', (s: number) => usd(model.runs[s].vps), usd(head.pw)],
                ['vs price', (s: number) => signedPct(head.scenarios[s].upside), signedPct(head.pwUpside)],
                ['Enterprise value', (s: number) => mm(model.runs[s].ev), ''],
                ['PV of terminal value, % of EV', (s: number) => pct(model.runs[s].tvPct, 0), ''],
                ['Terminal EV / EBITDA (2041)', (s: number) => mult(model.runs[s].tvMult), ''],
                ['Revenue 2030', (s: number) => mm(model.runs[s].rev30), ''],
                ['Revenue 2035', (s: number) => mm(model.runs[s].rev35), ''],
                ['EBITDA margin 2040', (s: number) => pct(model.runs[s].m40, 0), ''],
                ...MULTIPLE_YEARS.map((y) => [`EV / revenue ${y}`, (s: number) => mult(head.scenarios[s].evRev[y]), ''] as const),
                ['Peak cumulative funding need', (s: number) => mm(model.runs[s].minFcf), ''],
                ['Max paying users per satellite', (s: number) => `${model.runs[s].maxSubsPerSat.toFixed(2)}mm`, ''],
                ['Diluted shares', (s: number) => `${model.runs[s].Sf.toFixed(1)}mm`, ''],
              ] as Array<readonly [string, (s: number) => string, string]>).map(([label, f, w]) => (
                <TableRow key={label}>
                  <TableCell className="text-xs text-muted-foreground">{label}</TableCell>
                  {SCENARIO_INDICES.map((s) => <NumCell key={s} className="text-xs">{f(s)}</NumCell>)}
                  <NumCell className="text-xs font-medium">{w}</NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          Only floored per-share values are probability-weighted; weighting EVs would average in a negative Distress EV that no
          shareholder owns (A3-11). Market-implied EV at {usd(price)} is {mm(head.mktEv)}; Base-case EV is {pct(head.baseEvOverMkt, 1)} of it.
        </p>
      </section>

      <ChartFrame
        title="Base case: revenue, EBITDA and free cash flow"
        description="$ millions by period. 2026H2 is a half year. EBITDA is after stock-based compensation, which the model treats as a real cost (R-06)."
        footer={<ChartLegend series={[
          { label: 'Revenue', color: SCENARIO_COLOR[BASE] },
          { label: 'EBITDA', color: 'hsl(var(--foreground))' },
          { label: 'FCFF', color: 'hsl(var(--muted-foreground))' },
        ]} />}
      >
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={pl} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="p" {...AXIS_PROPS} interval="preserveStartEnd" />
              <YAxis {...AXIS_PROPS} width={56} tickFormatter={(x) => mm(x)} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Tooltip cursor={CURSOR_PROPS} content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <ChartTooltip title={String(label)} rows={[
                    { label: 'Revenue', value: mm(payload[0].payload.rev, 1), color: SCENARIO_COLOR[BASE] },
                    { label: 'EBITDA', value: mm(payload[0].payload.ebitda, 1), color: 'hsl(var(--foreground))' },
                    { label: 'FCFF', value: mm(payload[0].payload.fcf, 1), color: 'hsl(var(--muted-foreground))' },
                  ]} />
                ) : null} />
              <Bar dataKey="rev" fill={SCENARIO_COLOR[BASE]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Line dataKey="ebitda" stroke="hsl(var(--foreground))" strokeWidth={2} dot={false} />
              <Line dataKey="fcf" stroke="hsl(var(--muted-foreground))" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ChartFrame>
    </div>
  );
}
