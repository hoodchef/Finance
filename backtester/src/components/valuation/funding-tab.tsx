'use client';

import * as React from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { AXIS_PROPS, ChartFrame, ChartLegend, ChartTooltip, CURSOR_PROPS, GRID_PROPS } from '@/components/charts/chart-chrome';
import { cn } from '@/lib/utils';
import { PERIODS, SCENARIOS, SCENARIO_INDICES, type ScenarioIndex } from '@/lib/valuation/asts/inputs';
import { LIGADO_FACILITY } from '@/lib/valuation/asts/financing';
import type { MarketStats } from '@/lib/valuation/asts/engine';
import { RISK_REGISTER } from './provenance.generated';
import { SCENARIO_COLOR, type Valuation } from './use-asts-valuation';
import { mm, mmCell, mmFull, num, pct, usd } from './format';
import { ParamInput } from './param-input';

function Frame({ title, note, children, actions }: { title: string; note?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={title}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {note && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{note}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function FundingTab({ v }: { v: Valuation }) {
  const { fin, options, setOptions, price, model, inputs, snapshot, liveStats, live, discountLadder } = v;
  const basisLabel = options.issueBasis === 'value' ? 'each scenario’s fair value' : `today’s price, ${usd(price)}`;
  const [runwayS, setRunwayS] = React.useState<ScenarioIndex>(2);
  const rw = fin.scenarios[runwayS].runway;
  const chart = PERIODS.map((p, i) => ({
    p,
    ...Object.fromEntries(SCENARIO_INDICES.map((s) => [`s${s}`, fin.scenarios[s].runway.cash[i]])),
  }));

  return (
    <div className="space-y-4">
      <Frame
        title="Financing-adjusted value"
        note={
          <>
            The model assumes every shortfall is funded at fair value and says so (Notes, limitation 3). Here the Risk sheet’s gap —
            cumulative FCFF against available liquidity — is raised as new equity at a discount you set. Priced against each scenario’s own
            value, a 0% discount reproduces the model exactly and any discount dilutes. Priced against today’s price, the table shows the
            other lens: a market that never learns which world it is in, where new money overpays in the bad states. Debt service stays in
            the equity bridge at face, as in the model, so it is not charged twice.
          </>
        }
      >
        <div className="grid gap-4 border-b border-border p-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Price raises against</span>
            <div role="radiogroup" aria-label="Issue price basis" className="inline-flex w-fit rounded-md border border-border p-0.5">
              {([['value', 'Scenario fair value'], ['market', 'Today’s price']] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={options.issueBasis === k}
                  onClick={() => setOptions((o) => ({ ...o, issueBasis: k }))}
                  className={cn('rounded px-2.5 py-0.5 text-xs', options.issueBasis === k ? 'bg-muted font-medium' : 'text-muted-foreground')}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Issue discount to {basisLabel}</span>
            <span className="flex items-center gap-2">
              <ParamInput label="Issue discount" value={options.issueDiscount} delivered={0} unit="%" min={0} max={0.9}
                onCommit={(x) => setOptions((o) => ({ ...o, issueDiscount: x }))} />
              <span className="text-muted-foreground">%</span>
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Liquidity kept in reserve before raising</span>
            <span className="flex items-center gap-2">
              <ParamInput label="Reserve buffer" value={options.minBuffer} delivered={0} unit="$mm" min={0}
                onCommit={(x) => setOptions((o) => ({ ...o, minBuffer: x }))} />
              <span className="text-muted-foreground">$mm (the Risk sheet uses 0)</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Switch checked={options.useLigadoFacility} aria-label="Count the Ligado SPV facility"
              onCheckedChange={(c) => setOptions((o) => ({ ...o, useLigadoFacility: c }))} />
            <span>
              <span className="font-medium text-foreground">Count the {mm(LIGADO_FACILITY)} Ligado SPV facility</span>
              <span className="block text-muted-foreground">Committed non-recourse delayed-draw financing for the Ligado payment (10-K; A3-10). Available from the closing year.</span>
            </span>
          </label>
        </div>
        <div className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-56">$mm unless stated</TableHead>
                {SCENARIO_INDICES.map((s) => (
                  <NumHead key={s}><span aria-hidden className="mr-1 inline-block size-2 rounded-full" style={{ background: SCENARIO_COLOR[s] }} />{SCENARIOS[s]}</NumHead>
                ))}
                <NumHead>Weighted</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {([
                ['Available liquidity (cash less collateralised UBS loan)', (s) => mmFull(fin.scenarios[s].availableLiquidity), ''],
                ['Peak cumulative FCFF need', (s) => mmFull(model.runs[s].minFcf), ''],
                ['New equity raised (nominal)', (s) => mmFull(fin.scenarios[s].raisedNominal), ''],
                ['New equity raised (present value)', (s) => mmFull(fin.scenarios[s].raisedPv), ''],
                ['Issue price (today’s dollars)', (s) => (fin.scenarios[s].raisedPv > 0 ? usd(fin.scenarios[s].issuePrice) : '—'), ''],
                ['New shares issued', (s) => (Number.isFinite(fin.scenarios[s].newShares) ? `${num(fin.scenarios[s].newShares, 1)}mm` : 'the whole company'), ''],
                ['Value per share — model (funded at fair value)', (s) => usd(fin.scenarios[s].vpsModel), usd(fin.pwModel)],
                ['Value per share — raised as set above', (s) => usd(fin.scenarios[s].vpsFinanced), usd(fin.pwFinanced)],
                ['Transferred to (from) today’s holders, per share', (s) => signedUsd(fin.scenarios[s].transfer), signedUsd(fin.pwFinanced - fin.pwModel)],
              ] as Array<[string, (s: ScenarioIndex) => string, string]>).map(([label, f, w], k) => (
                <TableRow key={label} className={cn(k >= 6 && 'font-medium')}>
                  <TableCell className={cn(k >= 6 ? 'text-foreground' : 'text-muted-foreground')}>{label}</TableCell>
                  {SCENARIO_INDICES.map((s) => <NumCell key={s}>{f(s)}</NumCell>)}
                  <NumCell>{w}</NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <p>
            What a discount to fair value costs today’s holders — probability-weighted value if every raise comes in below scenario value:{' '}
            {discountLadder.map((x) => (
              <span key={x.d} className="numeric mr-3 inline-block text-foreground">{pct(x.d, 0)} → {usd(x.pw)}</span>
            ))}
            {discountLadder[0].pw > 0 && (discountLadder[0].pw - discountLadder[3].pw) / discountLadder[0].pw < 0.02 && (
              <span>
                The discount barely moves it: the scenarios that need large raises are the ones already worth little, so the funding risk
                sits in the scenario weights rather than in dilution.
              </span>
            )}
          </p>
          <p className="mt-1">
            Shares issued = PV of each raise ÷ issue price: the issue price is in today’s dollars and taken to accrete at the discount rate
            until the raise — the neutral convention. Raises happen in the period the shortfall arises.
          </p>
        </div>
      </Frame>

      <ChartFrame
        title="Liquidity runway before any new capital"
        description="Available liquidity plus FCFF, less the convertibles’ cash coupons and the principal of notes that do not convert in that scenario. Below zero, the company must raise or refinance."
        footer={<ChartLegend series={SCENARIO_INDICES.map((s) => ({ label: SCENARIOS[s], color: SCENARIO_COLOR[s] }))} />}
      >
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="p" {...AXIS_PROPS} interval="preserveStartEnd" />
              <YAxis {...AXIS_PROPS} width={60} tickFormatter={(x) => mm(x)} />
              <ReferenceLine y={0} stroke="hsl(var(--foreground))" />
              <Tooltip cursor={CURSOR_PROPS} content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <ChartTooltip title={String(label)} rows={SCENARIO_INDICES.map((s) => ({
                    label: SCENARIOS[s], value: mm(payload[0].payload[`s${s}`], 0), color: SCENARIO_COLOR[s],
                  }))} />
                ) : null} />
              {SCENARIO_INDICES.map((s) => (
                <Line key={s} dataKey={`s${s}`} stroke={SCENARIO_COLOR[s]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </ChartFrame>

      <Frame
        title="Runway detail"
        note={`First shortfall: ${rw.firstShortfall ?? 'none within the horizon'}. Deepest point ${mm(-rw.peakShortfall)}. The Trinity equipment loan's rate is not in the model's sources and is excluded rather than guessed.`}
        actions={
          <div role="radiogroup" aria-label="Runway scenario" className="inline-flex rounded-md border border-border p-0.5">
            {SCENARIO_INDICES.map((i) => (
              <button key={i} type="button" role="radio" aria-checked={runwayS === i} onClick={() => setRunwayS(i)}
                className={cn('rounded px-2.5 py-0.5 text-xs', runwayS === i ? 'bg-muted font-medium' : 'text-muted-foreground')}>
                {SCENARIOS[i]}
              </button>
            ))}
          </div>
        }
      >
        <div className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 min-w-52 bg-card">$mm</TableHead>
                {PERIODS.map((p) => <NumHead key={p} className="px-2">{p}</NumHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {([
                ['FCFF', model.runs[runwayS].fcf],
                ['− Convertible coupons', rw.interest.map((x) => -x)],
                ['− Principal of notes that do not convert', rw.principal.map((x) => -x)],
                ['+ Ligado facility (cumulative)', rw.facility],
                ['Liquidity, end of period', rw.cash],
              ] as Array<[string, number[]]>).map(([label, xs], k) => (
                <TableRow key={label} className={cn(k === 4 && 'font-medium')}>
                  <TableCell className="sticky left-0 bg-card text-muted-foreground">{label}</TableCell>
                  {xs.map((x, i) => (
                    <NumCell key={i} className={cn('px-2', k === 4 && x < 0 && 'text-negative')}>{mmCell(x, 0)}</NumCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Frame>

      <div className="grid gap-4 xl:grid-cols-2">
        <Frame title="Convertible maturity wall" note="Converts settle in cash or shares at the company’s election. Whether a tranche converts is the dilution engine’s answer at each scenario’s value.">
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow><TableHead>Tranche</TableHead><NumHead>Face</NumHead><NumHead>Coupon</NumHead><TableHead>Matures</TableHead><NumHead>Trigger</NumHead>
                  {SCENARIO_INDICES.map((s) => <NumHead key={s}>{SCENARIOS[s].slice(0, 4)}</NumHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {inputs.converts.map((c, k) => (
                  <TableRow key={c.label}>
                    <TableCell>{c.label}</TableCell>
                    <NumCell>{mmFull(c.face, 1)}</NumCell>
                    <NumCell>{pct(c.coupon, 3)}</NumCell>
                    <TableCell className="numeric">{c.maturity}</TableCell>
                    <NumCell>{usd(c.cap > 0 ? c.cap : c.convPrice)}</NumCell>
                    {SCENARIO_INDICES.map((s) => (
                      <NumCell key={s} className={model.runs[s].dilution.converts[k] ? 'text-foreground' : 'text-muted-foreground'}>
                        {model.runs[s].dilution.converts[k] ? 'converts' : 'repay'}
                      </NumCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Frame>
        <MarketRisk snapshot={snapshot} live={liveStats} liveNote={live?.marketNote ?? null} asOf={live?.market?.asOf ?? null} />
      </div>

      <Frame title="Risk register" note="The analyst’s qualitative risks and the model levers that carry each one.">
        <div className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader><TableRow><TableHead>Risk</TableHead><TableHead>Model lever(s)</TableHead><TableHead>Evidence / comment</TableHead></TableRow></TableHeader>
            <TableBody>
              {RISK_REGISTER.map((r) => (
                <TableRow key={r.risk}>
                  <TableCell>{r.risk}</TableCell>
                  <TableCell className="numeric text-muted-foreground">{r.levers}</TableCell>
                  <TableCell className="text-muted-foreground">{r.evidence}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Frame>
    </div>
  );
}

function signedUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '$0.00';
  return `${v > 0 ? '+' : '−'}${usd(Math.abs(v))}`;
}

function MarketRisk({ snapshot, live, liveNote, asOf }: { snapshot: MarketStats; live: MarketStats | null; liveNote: string | null; asOf: string | null }) {
  const rows: Array<[string, (m: MarketStats) => string]> = [
    ['Price', (m) => usd(m.price)],
    ['Annualised volatility (2y weekly)', (m) => pct(m.vol)],
    ['Idiosyncratic volatility', (m) => pct(m.idioVol)],
    ['Raw beta vs S&P 500 (± std. error)', (m) => `${m.betaRaw.toFixed(2)} ± ${m.betaSe.toFixed(2)}`],
    ['Blume-adjusted beta (used in WACC)', (m) => m.betaAdj.toFixed(3)],
    ['R-squared vs S&P 500', (m) => pct(m.r2)],
    ['Max drawdown (2y)', (m) => pct(m.maxDrawdown)],
    ['1-week VaR 95% (historical)', (m) => pct(m.var95)],
    ['1-week CVaR 95%', (m) => pct(m.cvar95)],
    ['1-week VaR 95% (parametric)', (m) => pct(m.pvar95)],
    ['Downside deviation (annualised)', (m) => pct(m.downsideDev)],
    ['2-year high / low close', (m) => `${usd(m.high)} / ${usd(m.low)}`],
    ['Full-week returns in regression', (m) => String(m.n)],
  ];
  return (
    <Frame title="Market risk" note={`Snapshot: IBKR weekly closes to 10-Sep-2026, as reviewed. Live: the app's provider${asOf ? ` to ${asOf}` : ''}, same method. An R² of ${pct(snapshot.r2, 0)} means the beta is statistically weak (R-01): most of this stock's risk is its own.`}>
      <Table className="text-xs">
        <TableHeader><TableRow><TableHead /><NumHead>Snapshot</NumHead><NumHead>Live</NumHead></TableRow></TableHeader>
        <TableBody>
          {rows.map(([label, f]) => (
            <TableRow key={label}>
              <TableCell className="text-muted-foreground">{label}</TableCell>
              <NumCell>{f(snapshot)}</NumCell>
              <NumCell className="text-muted-foreground">{live ? f(live) : '—'}</NumCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!live && liveNote && <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{liveNote}</p>}
    </Frame>
  );
}

