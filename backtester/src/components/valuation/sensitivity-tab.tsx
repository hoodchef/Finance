'use client';

import * as React from 'react';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { BASE, GLOBAL_ROWS, SCENARIO_ROWS, type ParamKey } from '@/lib/valuation/asts/inputs';
import { grid, GRID_COST_CIP, GRID_TAKE_ARPU, type DriverKey } from '@/lib/valuation/asts/analytics';
import type { Valuation } from './use-asts-valuation';
import { pct, signedPct, usd } from './format';

const LABEL: Partial<Record<DriverKey, string>> = Object.fromEntries([
  ...GLOBAL_ROWS.map((r) => [r.key, r.label]),
  ...SCENARIO_ROWS.map((r) => [r.key, r.label]),
  ['delay', 'Deployment & service delay (years)'],
  ['opex_mult', 'Fixed-opex level (multiplier)'],
  ['gov_mult', 'Government revenue (multiplier)'],
]);

/** Diverging shade around the price: neutral at the price, positive above, negative below. */
function shade(value: number, price: number): React.CSSProperties {
  const d = Math.max(-1, Math.min(1, value / price - 1));
  const strength = Math.round(Math.min(1, Math.abs(d) / 0.8) * 42);
  if (strength < 2) return {};
  const token = d > 0 ? '--positive' : '--negative';
  return { background: `color-mix(in srgb, hsl(var(${token})) ${strength}%, transparent)` };
}

function Frame({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={title}>
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Grid({
  rows, cols, values, rowFmt, colFmt, corner, price, isBase,
}: {
  rows: readonly number[]; cols: readonly number[]; values: number[][];
  rowFmt: (x: number) => string; colFmt: (x: number) => string; corner: string; price: number;
  isBase: (i: number, j: number) => boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="text-2xs">{corner}</TableHead>
            {cols.map((c) => <NumHead key={c}>{colFmt(c)}</NumHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((rv, i) => (
            <TableRow key={rv} className="hover:bg-transparent">
              <TableCell className="numeric font-medium">{rowFmt(rv)}</TableCell>
              {cols.map((_, j) => (
                <NumCell
                  key={j}
                  style={shade(values[i][j], price)}
                  className={cn('px-2', isBase(i, j) && 'font-semibold outline outline-1 -outline-offset-1 outline-foreground')}
                  title={`${usd(values[i][j])} — ${signedPct(values[i][j] / price - 1)} vs price`}
                >
                  {usd(values[i][j])}
                </NumCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Drivers offered for the custom grid, with the steps each one moves in. */
const CUSTOM: Array<{ key: ParamKey; steps: (b: number) => number[]; fmt: (x: number) => string }> = [
  { key: 'take_t1', steps: (b) => [0.5, 0.75, 1, 1.25, 1.5].map((m) => b * m), fmt: (x) => pct(x, 1) },
  { key: 'arpu_t1', steps: (b) => [0.7, 0.85, 1, 1.15, 1.3].map((m) => b * m), fmt: (x) => usd(x) },
  { key: 'take_t2', steps: (b) => [0.5, 0.75, 1, 1.25, 1.5].map((m) => b * m), fmt: (x) => pct(x, 1) },
  { key: 'px_g', steps: (b) => [-0.02, -0.01, 0, 0.01, 0.02].map((d) => b + d), fmt: (x) => pct(x, 1) },
  { key: 'unit_cost', steps: (b) => [0.8, 0.9, 1, 1.1, 1.25].map((m) => b * m), fmt: (x) => `$${x.toFixed(1)}mm` },
  { key: 'fl_ss', steps: (b) => [-30, -15, 0, 15, 30].map((d) => Math.max(20, b + d)), fmt: (x) => String(x) },
  { key: 't1_start', steps: (b) => [-1, 0, 1, 2, 3].map((d) => b + d), fmt: (x) => String(x) },
  { key: 'opex_27', steps: (b) => [0.8, 0.9, 1, 1.1, 1.25].map((m) => b * m), fmt: (x) => `$${x.toFixed(0)}mm` },
  { key: 'var_cost', steps: (b) => [-0.04, -0.02, 0, 0.02, 0.04].map((d) => b + d), fmt: (x) => pct(x, 0) },
  { key: 'wacc_shift', steps: () => [-0.02, -0.01, 0, 0.01, 0.02], fmt: (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp` },
  { key: 'g', steps: (b) => [-0.01, -0.005, 0, 0.005, 0.01].map((d) => b + d), fmt: (x) => pct(x, 1) },
  { key: 'sat_life', steps: (b) => [-2, -1, 0, 1, 2].map((d) => b + d), fmt: (x) => `${x} yrs` },
  { key: 'loss_rate', steps: () => [0, 0.025, 0.05, 0.1, 0.15], fmt: (x) => pct(x, 1) },
  { key: 'spec_fee', steps: (b) => [0.5, 0.75, 1, 1.5, 2].map((m) => b * m), fmt: (x) => `$${x.toFixed(0)}mm` },
  { key: 'ligado_share', steps: () => [0, 0.03, 0.05, 0.1, 0.15], fmt: (x) => pct(x, 0) },
];

export function SensitivityTab({ v }: { v: Valuation }) {
  const { analytics, sens, price, inputs, model, betaHi } = v;
  const base = model.runs[BASE];
  const t = analytics.tornado;
  const span = Math.max(...t.bars.map((b) => Math.max(Math.abs(b.vLo - t.base), Math.abs(b.vHi - t.base))), 1);

  const [rowKey, setRowKey] = React.useState<ParamKey>('take_t1');
  const [colKey, setColKey] = React.useState<ParamKey>('px_g');
  const baseParams = base.p;
  const rowDef = CUSTOM.find((c) => c.key === rowKey)!;
  const colDef = CUSTOM.find((c) => c.key === colKey)!;
  const rowVals = rowDef.steps(baseParams[rowKey]);
  const colVals = colDef.steps(baseParams[colKey]);
  const custom = React.useMemo(
    () => (rowKey === colKey ? null : grid(v.inputs, betaHi, rowKey, rowVals, colKey, colVals)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v.inputs, betaHi, rowKey, colKey, JSON.stringify(rowVals), JSON.stringify(colVals)],
  );

  const r = analytics.reverse;
  const takeBase = inputs.scenario.take_t1[BASE];
  const arpuBase = inputs.scenario.arpu_t1[BASE];

  return (
    <div className="space-y-4">
      <Frame
        title="Tornado — Base value per share with each driver at its P10 and P90"
        note={`Every other input as on the Assumptions tab. Base value ${usd(t.base)}. Ranges are the simulation's own distributions, so the tornado and the Monte Carlo describe the same uncertainty. Widest first.`}
      >
        <div className="divide-y divide-border">
          {t.bars.map((b) => {
            const lo = Math.min(b.vLo, b.vHi);
            const hi = Math.max(b.vLo, b.vHi);
            const left = 50 + ((lo - t.base) / span) * 50;
            const right = 50 + ((hi - t.base) / span) * 50;
            const fmtIn = (x: number) =>
              b.key === 'delay' ? `${x} yr` : b.key === 'sat_life' ? `${x} yrs` : b.key.endsWith('_mult') ? `${x.toFixed(2)}×`
              : b.key.startsWith('arpu') ? usd(x) : b.key === 'unit_cost' ? `$${x.toFixed(1)}mm` : pct(x, 2);
            return (
              <div key={b.key} className="grid grid-cols-[minmax(0,14rem)_1fr] items-center gap-3 px-4 py-2 sm:grid-cols-[minmax(0,18rem)_1fr_10rem]">
                <div className="min-w-0 text-xs">
                  <div className="truncate text-foreground" title={b.desc}>{LABEL[b.key] ?? b.key}</div>
                  <div className="truncate text-2xs text-muted-foreground">{b.desc}</div>
                </div>
                <div className="relative h-5" aria-label={`${LABEL[b.key]}: ${usd(b.vLo)} at P10, ${usd(b.vHi)} at P90`}>
                  <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/60" />
                  <div
                    className="absolute inset-y-1 rounded-[4px]"
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(0.5, 50 - left)}%`,
                      background: 'hsl(var(--negative) / 0.7)',
                      display: lo < t.base ? undefined : 'none',
                    }}
                  />
                  <div
                    className="absolute inset-y-1 rounded-[4px]"
                    style={{
                      left: '50%',
                      width: `${Math.max(0.5, right - 50)}%`,
                      background: 'hsl(var(--positive) / 0.7)',
                      display: hi > t.base ? undefined : 'none',
                    }}
                  />
                </div>
                <div className="numeric col-span-2 text-right text-2xs text-muted-foreground sm:col-span-1">
                  P10 {fmtIn(b.lo)} → <span className="text-foreground">{usd(b.vLo)}</span>
                  <br />
                  P90 {fmtIn(b.hi)} → <span className="text-foreground">{usd(b.vHi)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Frame>

      <div className="grid gap-4 xl:grid-cols-2">
        <Frame
          title="WACC shift × terminal growth"
          note="Base value per share. Derived independently of the engine — Base cash flows held, discounting, terminal value and dilution rebuilt — and checked against it (check 8). Outlined: the inputs as set."
        >
          <Grid rows={sens.shifts} cols={sens.gs} values={sens.values} price={price} corner="WACC shift ↓ / g →"
            rowFmt={(x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}pp`} colFmt={(x) => pct(x, 1)} isBase={(i, j) => i === 2 && j === 2} />
        </Frame>
        <Frame title="Reverse DCF — what the price implies" note={`At ${usd(price)}. Each lever is solved alone with everything else as set (Brent's method, scipy's tolerances).`}>
          <Table className="text-xs">
            <TableBody>
              <TableRow>
                <TableCell className="text-muted-foreground">Base Tier-1 peak take rate that equates Base value to price</TableCell>
                <NumCell className="font-medium">{r.take != null ? pct(r.take, 1) : 'unreachable'}</NumCell>
                <NumCell className="text-muted-foreground">model {pct(takeBase, 1)}</NumCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">Parallel WACC shift that equates Base value to price</TableCell>
                <NumCell className="font-medium">{r.shift != null ? `${r.shift >= 0 ? '+' : ''}${(r.shift * 100).toFixed(2)}pp` : 'unreachable'}</NumCell>
                <NumCell className="text-muted-foreground">{r.wHi != null && r.wT != null ? `${pct(r.wHi, 2)} → ${pct(r.wT, 2)}` : ''}</NumCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">Multiplier on every scenario’s Tier-1 take for the weighted value to equal price</TableCell>
                <NumCell className="font-medium">{r.mult != null ? `${r.mult.toFixed(2)}×` : 'unreachable'}</NumCell>
                <NumCell className="text-muted-foreground">model 1.00×</NumCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">Capex paid one period before launch instead of at it (A3-03)</TableCell>
                <NumCell className="font-medium">{usd(analytics.capexTiming.shifted)}</NumCell>
                <NumCell className="text-muted-foreground">{signedPct(analytics.capexTiming.shifted / analytics.capexTiming.base - 1)}</NumCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            “Unreachable” means no value of that lever within its search range gets the model to the price — an answer about the model,
            not a failure of the solver.
          </p>
        </Frame>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Frame title="Tier-1 take rate × Tier-1 ARPU" note="Base value per share: the two inputs the value turns on most.">
          <Grid rows={GRID_TAKE_ARPU.v1} cols={GRID_TAKE_ARPU.v2} values={analytics.takeArpu} price={price} corner="Take ↓ / ARPU →"
            rowFmt={(x) => pct(x, 0)} colFmt={(x) => usd(x)}
            isBase={(i, j) => GRID_TAKE_ARPU.v1[i] === takeBase && GRID_TAKE_ARPU.v2[j] === arpuBase} />
        </Frame>
        <Frame title="Satellite unit cost × CIP pre-funding share" note="Base value per share. Second-order: build cost matters far less than adoption (R-04).">
          <Grid rows={GRID_COST_CIP.v1} cols={GRID_COST_CIP.v2} values={analytics.costCip} price={price} corner="Unit cost ↓ / CIP →"
            rowFmt={(x) => `$${x}mm`} colFmt={(x) => pct(x, 0)}
            isBase={(i, j) => GRID_COST_CIP.v1[i] === inputs.scenario.unit_cost[BASE] && GRID_COST_CIP.v2[j] === inputs.scenario.cip_credit[BASE]} />
        </Frame>
      </div>

      <Frame title="Any two drivers" note="Base value per share across five steps of each driver around its current Base value.">
        <div className="flex flex-wrap gap-3 px-4 pt-3 text-xs">
          {([['Rows', rowKey, setRowKey], ['Columns', colKey, setColKey]] as const).map(([label, val, set]) => (
            <label key={label} className="flex items-center gap-2">
              <span className="text-muted-foreground">{label}</span>
              <select
                value={val}
                onChange={(e) => set(e.target.value as ParamKey)}
                className="h-7 rounded border border-border bg-background px-2 text-xs"
              >
                {CUSTOM.map((c) => <option key={c.key} value={c.key}>{LABEL[c.key]}</option>)}
              </select>
            </label>
          ))}
        </div>
        {custom ? (
          <Grid rows={rowVals} cols={colVals} values={custom} price={price} corner={`${rowKey} ↓ / ${colKey} →`}
            rowFmt={rowDef.fmt} colFmt={colDef.fmt}
            isBase={(i, j) => rowVals[i] === baseParams[rowKey] && colVals[j] === baseParams[colKey]} />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">Pick two different drivers.</p>
        )}
      </Frame>
    </div>
  );
}
