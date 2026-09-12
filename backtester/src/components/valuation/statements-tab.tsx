'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { downloadCsv, toCsv } from '@/lib/export/csv';
import { PERIODS, SCENARIOS, SCENARIO_INDICES, type ScenarioIndex } from '@/lib/valuation/asts/inputs';
import type { ScenarioRun } from '@/lib/valuation/asts/engine';
import { SCENARIO_COLOR, type Valuation } from './use-asts-valuation';
import { mmCell, mmFull, mult, num, pct, signedPct, usd } from './format';

type Fmt = 'mm' | 'int' | 'one' | 'pct' | 'pct2' | 'factor' | 'mmUsers' | 'three';
type ArrayKey = { [K in keyof ScenarioRun]: ScenarioRun[K] extends number[] ? K : never }[keyof ScenarioRun];
interface Row { label: string; key: ArrayKey; fmt: Fmt; bold?: boolean; terminal?: (r: ScenarioRun) => number }

/** The workbook's Calc sheet, row for row, with the workbook's labels. */
const SECTIONS: Array<{ title: string; rows: Row[] }> = [
  {
    title: 'Constellation (Block 2 satellites)',
    rows: [
      { label: 'Target fleet, end of period', key: 'F', fmt: 'int' },
      { label: 'Beginning fleet', key: 'B', fmt: 'int' },
      { label: 'Retirements (end of design life)', key: 'R', fmt: 'int' },
      { label: 'Successful launches (net adds + replacements)', key: 'N', fmt: 'int' },
      { label: 'Ending fleet', key: 'E', fmt: 'int', bold: true },
      { label: 'Satellites built incl. launch losses', key: 'G', fmt: 'one' },
      { label: 'Average fleet in orbit', key: 'A', fmt: 'one' },
      { label: 'Unit cost incl. launch ($mm/sat)', key: 'U', fmt: 'factor' },
      { label: 'Satellite capex (gross, placed in service)', key: 'SC', fmt: 'mm' },
      { label: 'CIP credit applied (already-paid capex)', key: 'C', fmt: 'mm' },
      { label: 'Satellite capex, cash', key: 'netSC', fmt: 'mm', bold: true },
    ],
  },
  {
    title: 'Revenue build',
    rows: [
      { label: 'Tier-1 coverage (fraction of partner base)', key: 'cov1', fmt: 'pct' },
      { label: 'Tier-2 coverage', key: 'cov2', fmt: 'pct' },
      { label: 'Tier-1 adoption (take rate of covered subs)', key: 'ad1', fmt: 'pct2' },
      { label: 'Tier-2 adoption (take rate of covered subs)', key: 'ad2', fmt: 'pct2' },
      { label: 'MNO partner subscriber base (mm)', key: 'base', fmt: 'mm' },
      { label: 'Tier-1 paying users (mm, period avg)', key: 'subs1', fmt: 'one' },
      { label: 'Tier-2 paying users (mm, period avg)', key: 'subs2', fmt: 'one' },
      { label: 'ARPU index (2027 = 1.00)', key: 'pxf', fmt: 'factor' },
      { label: 'Tier-1 service revenue', key: 'rev1', fmt: 'mm' },
      { label: 'Tier-2 service revenue', key: 'rev2', fmt: 'mm' },
      { label: 'Government revenue', key: 'gov', fmt: 'mm' },
      { label: 'Gateway / product revenue', key: 'prod', fmt: 'mm' },
      { label: 'Total revenue', key: 'rev', fmt: 'mm', bold: true, terminal: (r) => r.rev[r.rev.length - 1] * (1 + r.p.g) },
      { label: 'Revenue growth (annualised)', key: 'growth', fmt: 'pct' },
      { label: 'Paying users per satellite in orbit (mm)', key: 'subsPerSat', fmt: 'three' },
    ],
  },
  {
    title: 'Operating costs & EBITDA',
    rows: [
      { label: 'Cost of revenue (gateway + government)', key: 'cogs', fmt: 'mm' },
      { label: 'Service variable cost', key: 'var', fmt: 'mm' },
      { label: 'Ligado revenue share', key: 'lig', fmt: 'mm' },
      { label: 'Spectrum usage payments', key: 'spec', fmt: 'mm' },
      { label: 'Fixed adj. opex (ex-COGS, ex-SBC)', key: 'opex', fmt: 'mm' },
      { label: 'Network, ground & insurance opex', key: 'netx', fmt: 'mm' },
      { label: 'Stock-based compensation (treated as cost)', key: 'sbc', fmt: 'mm' },
      { label: 'Total operating costs', key: 'costs', fmt: 'mm', bold: true },
      { label: 'EBITDA (after SBC)', key: 'ebitda', fmt: 'mm', bold: true, terminal: (r) => r.e41 },
      { label: 'EBITDA margin', key: 'margin', fmt: 'pct' },
    ],
  },
  {
    title: 'Capex & other investing items',
    rows: [
      { label: 'Other capex (ground, facilities)', key: 'ocx', fmt: 'mm', terminal: (r) => r.ocx41 },
      { label: 'Ligado spectrum closing payment', key: 'ligpay', fmt: 'mm' },
      { label: 'J-LEO non-dilutive capital (inflow)', key: 'jleo', fmt: 'mm' },
    ],
  },
  {
    title: 'Cash taxes (NOL + depreciation)',
    rows: [
      { label: 'Tax-basis capex placed in service', key: 'capexTax', fmt: 'mm' },
      { label: 'Tax depreciation', key: 'tdep', fmt: 'mm' },
      { label: 'Spectrum amortisation (15-yr, s.197)', key: 'samort', fmt: 'mm' },
      { label: 'Taxable income', key: 'ti', fmt: 'mm' },
      { label: 'NOL pool - beginning', key: 'nolB', fmt: 'mm' },
      { label: 'NOL utilised (80% cap)', key: 'nolU', fmt: 'mm' },
      { label: 'NOL pool - ending', key: 'nolE', fmt: 'mm' },
      { label: 'Cash taxes', key: 'tax', fmt: 'mm', bold: true, terminal: (r) => r.tax41 },
    ],
  },
  {
    title: 'Free cash flow to the firm',
    rows: [
      { label: 'Annualised revenue', key: 'ann', fmt: 'mm' },
      { label: 'Increase in net working capital', key: 'dnwc', fmt: 'mm', terminal: (r) => r.dnwc41 },
      { label: 'Contract-liability unwind (revenue already paid in cash)', key: 'cl', fmt: 'mm' },
      { label: 'FCFF', key: 'fcf', fmt: 'mm', bold: true, terminal: (r) => r.fcf41 },
      { label: 'Cumulative FCFF from 1-Jul-2026', key: 'cumFcf', fmt: 'mm' },
    ],
  },
  {
    title: 'Discounting (mid-period, from valuation date)',
    rows: [
      { label: 'WACC', key: 'w', fmt: 'pct2' },
      { label: 'Compounding factor to period end', key: 'comp', fmt: 'factor' },
      { label: 'Discount factor (mid-period)', key: 'df', fmt: 'factor' },
      { label: 'PV of FCFF', key: 'pv', fmt: 'mm', bold: true },
    ],
  },
];

function fmtCell(v: number, f: Fmt): string {
  switch (f) {
    case 'mm': return mmCell(v, 1);
    case 'int': return num(v, 0);
    case 'one': return num(v, 1);
    case 'three': return num(v, 3);
    case 'pct': return pct(v, 1);
    case 'pct2': return pct(v, 2);
    case 'factor': return num(v, 4);
    case 'mmUsers': return num(v, 1);
  }
}

function statementCsv(r: ScenarioRun): string {
  const rows: Array<Array<string | number>> = [['Line', 'Unit', ...PERIODS, '2041N']];
  for (const sec of SECTIONS) {
    rows.push([sec.title.toUpperCase()]);
    for (const row of sec.rows) {
      rows.push([row.label, row.fmt.startsWith('pct') ? 'fraction' : row.fmt === 'mm' ? '$mm' : '', ...(r[row.key] as number[]),
        row.terminal ? row.terminal(r) : '']);
    }
  }
  rows.push([], ['ENTERPRISE VALUE ($mm)', '', r.ev], ['Equity value after conversions ($mm)', '', r.Ef],
    ['Diluted shares (mm)', '', r.Sf], ['Value per share ($)', '', r.vps]);
  return toCsv(rows);
}

export function StatementsTab({ v }: { v: Valuation }) {
  const [s, setS] = React.useState<ScenarioIndex>(2);
  const r = v.model.runs[s];
  const price = v.price;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Scenario" className="inline-flex rounded-md border border-border bg-card p-0.5">
          {SCENARIO_INDICES.map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={s === i}
              onClick={() => setS(i)}
              className={cn('flex items-center gap-1.5 rounded px-3 py-1 text-xs', s === i ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <span aria-hidden className="size-2 rounded-full" style={{ background: SCENARIO_COLOR[i] }} />
              {SCENARIOS[i]}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={() => downloadCsv(`ASTS-${SCENARIOS[s]}-model.csv`, statementCsv(r))}>
          <Download className="size-3.5" /> Export {SCENARIOS[s]} to CSV
        </Button>
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={`${SCENARIOS[s]} scenario model`}>
        <div className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-72 bg-card">$ millions unless stated</TableHead>
                {PERIODS.map((p) => <NumHead key={p} className="px-2">{p}</NumHead>)}
                <NumHead className="px-2 text-muted-foreground" title="Normalised terminal year">2041N</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SECTIONS.map((sec) => (
                <React.Fragment key={sec.title}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={PERIODS.length + 2} className="sticky left-0 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {sec.title}
                    </TableCell>
                  </TableRow>
                  {sec.rows.map((row) => (
                    <TableRow key={row.label} className={cn(row.bold && 'font-medium')}>
                      <TableCell className={cn('sticky left-0 z-10 bg-card py-1.5', row.bold ? 'text-foreground' : 'text-muted-foreground')}>
                        {row.label}
                      </TableCell>
                      {(r[row.key] as number[]).map((x, i) => (
                        <NumCell key={i} className={cn('px-2 py-1.5', row.bold && 'border-t border-border')}>{fmtCell(x, row.fmt)}</NumCell>
                      ))}
                      <NumCell className="px-2 py-1.5 text-muted-foreground">{row.terminal ? fmtCell(row.terminal(r), row.fmt) : ''}</NumCell>
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Terminal value & enterprise value" rows={[
          ['Terminal WACC', pct(r.wT, 2)],
          ['Terminal growth g', pct(r.p.g, 2)],
          ['EBITDA 2041 (normalised)', mmFull(r.e41)],
          ['Normalised replacement satellite capex', mmFull(r.maint), 'Fleet ÷ life ÷ (1 − loss) × unit cost: the steady state, not the lumpy 2040 wave (A2-03).'],
          ['Other capex 2041', mmFull(r.ocx41)],
          ['Normalised cash tax', mmFull(r.tax41), 'Tax depreciation equals capex in steady state.'],
          ['Increase in NWC 2041', mmFull(r.dnwc41)],
          ['FCFF 2041 (normalised)', mmFull(r.fcf41), undefined, true],
          ['Terminal value at end-2040 (Gordon, mid-year consistent)', mmFull(r.tv)],
          ['PV of terminal value', mmFull(r.pvTv)],
          ['Sum of PV of explicit FCFF', mmFull(r.pvExplicit)],
          ['Enterprise value', mmFull(r.ev), undefined, true],
          ['Terminal value % of EV', pct(r.tvPct, 0)],
          ['Implied terminal EV / EBITDA (2041)', mult(r.tvMult)],
        ]} />
        <div className="space-y-4">
          <Block title="Equity bridge" rows={[
            ['Enterprise value', mmFull(r.ev)],
            ['+ Cash & liquid assets (pro forma)', mmFull(r.cash)],
            ['− Non-convertible debt', mmFull(r.debt)],
            ['− Convertible notes at face (all treated as debt first)', mmFull(r.convFace)],
            ['Equity value before conversions', mmFull(r.E0), undefined, true],
            ['+ Value added by instruments that convert', mmFull(r.Ef - r.E0)],
            ['Equity value after conversions', mmFull(r.Ef), undefined, true],
            ['Diluted shares', `${r.Sf.toFixed(2)}mm (basic ${r.S0.toFixed(2)}mm)`],
            ['Value per share (floored at 0)', usd(r.vps), undefined, true],
            ['vs price', signedPct(r.vps / price - 1)],
          ]} />
          <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Dilution engine">
            <header className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">Dilution engine</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                An instrument converts iff value per share, with it and every lower trigger converted, exceeds its trigger. Order-independent,
                no circular reference (R-07).
              </p>
            </header>
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow><TableHead>Instrument</TableHead><NumHead>Trigger K</NumHead><NumHead>Shares</NumHead><NumHead>Adds</NumHead><NumHead>Value if prefix converts</NumHead><NumHead>Converts</NumHead></TableRow>
                </TableHeader>
                <TableBody>
                  {r.instruments.map((o, i) => (
                    <TableRow key={o.label}>
                      <TableCell>{o.label}</TableCell>
                      <NumCell>{usd(o.K)}</NumCell>
                      <NumCell>{o.n.toFixed(3)}mm</NumCell>
                      <NumCell>{mmFull(o.D)}</NumCell>
                      <NumCell>{usd(r.dilution.prefixValue[i])}</NumCell>
                      <NumCell className={cn(r.dilution.converts[i] ? 'text-foreground' : 'text-muted-foreground')}>{r.dilution.converts[i] ? 'Yes' : 'No'}</NumCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>
      </div>

      <Block title="Diagnostics" rows={[
        ['FY2026 revenue (H1 actual + H2 model)', mmFull(r.fy26), `Guidance $${v.inputs.global.guide_lo}–${v.inputs.global.guide_hi}mm.`],
        ['Peak cumulative funding need (min cumulative FCFF)', mmFull(r.minFcf)],
        ['Max paying users per satellite', `${r.maxSubsPerSat.toFixed(3)}mm`, 'Capacity plausibility bound 2.5mm (A2-04).'],
        ['Revenue CAGR 2036–2040', pct(r.cagr, 2), `Terminal g ${pct(r.p.g, 1)}: the explicit period must meet it (A3-01).`],
        ['EBITDA margin 2040', pct(r.m40, 1), 'Iridium FY2025: 56.8%.'],
        ['Revenue 2030 / 2035', `${mmFull(r.rev30)} / ${mmFull(r.rev35)}`],
      ]} />
    </div>
  );
}

function Block({ title, rows }: { title: string; rows: Array<[string, string, string?, boolean?]> }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={title}>
      <header className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">{title}</h2></header>
      <Table className="text-xs">
        <TableBody>
          {rows.map(([label, value, note, bold]) => (
            <TableRow key={label} className={cn(bold && 'font-medium')}>
              <TableCell className={cn('py-1.5', bold ? 'text-foreground' : 'text-muted-foreground')}>
                {label}
                {note && <span className="block text-xs text-muted-foreground">{note}</span>}
              </TableCell>
              <NumCell className="py-1.5">{value}</NumCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
