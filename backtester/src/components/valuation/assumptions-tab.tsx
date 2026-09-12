'use client';

import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  basisOf,
  deliveredInputs,
  GLOBAL_SECTIONS,
  isFlagged,
  KEY_DRIVERS,
  SCENARIO_INDICES,
  SCENARIO_SECTIONS,
  SCENARIOS,
  type Basis,
  type GlobalKey,
  type Quad,
  type ScenarioKey,
} from '@/lib/valuation/asts/inputs';
import { ParamInput, boundsFor } from './param-input';
import { SCENARIO_COLOR, type Valuation } from './use-asts-valuation';
import { pct } from './format';

const DELIVERED = deliveredInputs();

const BASIS_LABEL: Record<Basis, string> = {
  data: 'Filing / market data',
  derived: 'Derived from data',
  secondary: 'Secondary source',
  law: 'Tax law',
  method: 'Method',
  logic: 'Logic',
  lever: 'What-if lever',
  assumption: 'Analyst judgement',
};

function BasisBadge({ source }: { source: string }) {
  const b = basisOf(source);
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant={b === 'data' || b === 'derived' ? 'primary' : b === 'assumption' ? 'default' : 'outline'} className="whitespace-nowrap text-2xs">
        {BASIS_LABEL[b]}
      </Badge>
      {isFlagged(source) && <Badge variant="warning" className="text-2xs">Flagged</Badge>}
    </span>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={title}>
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function Label({ label, keyName }: { label: string; keyName: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {KEY_DRIVERS.has(keyName as GlobalKey) && (
        <span aria-label="Key value driver" title="Key value driver" className="size-1.5 shrink-0 rounded-full bg-[hsl(var(--warning))]" />
      )}
      <span>{label}</span>
    </span>
  );
}

export function AssumptionsTab({ v }: { v: Valuation }) {
  const { inputs, update, reset, diffs, options, setOptions, snapshot, liveStats } = v;
  const [showDiffs, setShowDiffs] = React.useState(false);
  const probSum = inputs.scenario.prob.reduce((t, x) => t + x, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground">
          {diffs.length === 0 ? (
            <span>
              Every input is <strong className="text-foreground">as delivered</strong>. Edit a value and press Enter; everything
              recomputes, including the simulation, tornado and reverse DCF.
            </span>
          ) : (
            <span>
              <strong className="text-[hsl(var(--warning))]">{diffs.length} input{diffs.length === 1 ? '' : 's'}</strong>{' '}
              {diffs.length === 1 ? 'differs' : 'differ'} from the delivered model. Changed cells are marked; hover one for its delivered value.{' '}
              <button type="button" className="underline underline-offset-2" onClick={() => setShowDiffs((x) => !x)}>
                {showDiffs ? 'Hide' : 'List'} changes
              </button>
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={reset} disabled={diffs.length === 0}>
          <RotateCcw className="size-3.5" /> Reset to delivered
        </Button>
        {showDiffs && diffs.length > 0 && (
          <ul className="w-full space-y-0.5 border-t border-border pt-2 text-xs">
            {diffs.map((d) => (
              <li key={`${d.where}-${d.label}`} className="numeric text-muted-foreground">
                <span className="text-foreground">{d.label}</span> ({d.where}): {String(d.from)} → {String(d.to)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Section
        title="Market basis"
        note="The price moves the comparison, never the value. Beta moves the value; the reviewed snapshot estimate is the default (R-01)."
      >
        <div className="grid gap-4 p-4 text-xs sm:grid-cols-2">
          <label className="flex items-start gap-3">
            <Switch
              checked={options.betaBasis === 'live'}
              disabled={!liveStats}
              onCheckedChange={(c) => setOptions((o) => ({ ...o, betaBasis: c ? 'live' : 'snapshot' }))}
              aria-label="Use live beta"
            />
            <span>
              <span className="font-medium text-foreground">Value on today’s beta re-estimate</span>
              <span className="block text-muted-foreground">
                Snapshot Blume beta {snapshot.betaAdj.toFixed(3)} (raw {snapshot.betaRaw.toFixed(2)} ± {snapshot.betaSe.toFixed(2)}, R² {pct(snapshot.r2)}).
                {liveStats ? ` Live: ${liveStats.betaAdj.toFixed(3)}.` : ' Live estimate unavailable.'}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Switch
              checked={options.priceBasis === 'live'}
              disabled={v.livePrice == null}
              onCheckedChange={(c) => setOptions((o) => ({ ...o, priceBasis: c ? 'live' : 'snapshot' }))}
              aria-label="Compare against live price"
            />
            <span>
              <span className="font-medium text-foreground">Compare against today’s price</span>
              <span className="block text-muted-foreground">
                Snapshot ${snapshot.price.toFixed(2)} (IBKR, 10-Sep-2026).{v.livePrice != null ? ` Live $${v.livePrice.toFixed(2)}.` : ' Live price unavailable.'}
              </span>
            </span>
          </label>
        </div>
      </Section>

      {GLOBAL_SECTIONS.map((sec) => (
        <Section key={sec.title} title={`${sec.title} — all scenarios`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64">Parameter</TableHead>
                <NumHead>Value</NumHead>
                <TableHead>Basis</TableHead>
                <TableHead className="min-w-80">Source / rationale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sec.rows.map((r) => {
                const b = boundsFor(r.key, r.unit);
                return (
                  <TableRow key={r.key}>
                    <TableCell className="text-xs"><Label label={r.label} keyName={r.key} /></TableCell>
                    <NumCell>
                      {r.key === 'bonus_dep' ? (
                        <Switch
                          checked={inputs.global.bonus_dep === 1}
                          onCheckedChange={(c) => update((d) => { d.global.bonus_dep = c ? 1 : 0; })}
                          aria-label={r.label}
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <ParamInput
                            label={r.label}
                            value={inputs.global[r.key as GlobalKey]}
                            delivered={DELIVERED.global[r.key as GlobalKey]}
                            unit={r.unit}
                            {...b}
                            onCommit={(x) => update((d) => { d.global[r.key as GlobalKey] = x; })}
                          />
                          <span className="w-10 text-left text-2xs text-muted-foreground">{r.unit === '%' ? '%' : r.unit}</span>
                        </span>
                      )}
                    </NumCell>
                    <TableCell><BasisBadge source={r.source} /></TableCell>
                    <TableCell className="text-xs leading-relaxed text-muted-foreground">{r.source}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      ))}

      {SCENARIO_SECTIONS.map((sec) => (
        <Section
          key={sec.title}
          title={sec.title}
          note={sec.title.startsWith('Scenario probabilities') ? (
            <span className={cn(Math.abs(probSum - 1) > 1e-4 && 'font-medium text-negative')}>
              Probabilities sum to {pct(probSum, 1)}{Math.abs(probSum - 1) > 1e-4 ? ' — they must sum to 100%; the check has failed.' : '.'}
            </span>
          ) : undefined}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64">Parameter</TableHead>
                {SCENARIO_INDICES.map((s) => (
                  <NumHead key={s}>
                    <span aria-hidden className="mr-1 inline-block size-2 rounded-full" style={{ background: SCENARIO_COLOR[s] }} />
                    {SCENARIOS[s]}
                  </NumHead>
                ))}
                <TableHead>Unit</TableHead>
                <TableHead>Basis</TableHead>
                <TableHead className="min-w-72">Source / rationale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sec.rows.map((r) => {
                const b = boundsFor(r.key, r.unit);
                return (
                  <TableRow key={r.key}>
                    <TableCell className="text-xs"><Label label={r.label} keyName={r.key} /></TableCell>
                    {SCENARIO_INDICES.map((s) => (
                      <NumCell key={s} className="px-1.5">
                        <ParamInput
                          label={`${r.label}, ${SCENARIOS[s]}`}
                          value={inputs.scenario[r.key as ScenarioKey][s]}
                          delivered={DELIVERED.scenario[r.key as ScenarioKey][s]}
                          unit={r.unit}
                          {...b}
                          onCommit={(x) => update((d) => {
                            const q = [...d.scenario[r.key as ScenarioKey]] as number[];
                            q[s] = x;
                            d.scenario[r.key as ScenarioKey] = q as unknown as Quad;
                          })}
                        />
                      </NumCell>
                    ))}
                    <TableCell className="text-2xs text-muted-foreground">{r.unit}</TableCell>
                    <TableCell><BasisBadge source={r.source} /></TableCell>
                    <TableCell className="text-xs leading-relaxed text-muted-foreground">{r.source}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      ))}

      <CapitalStructure v={v} />
    </div>
  );
}

function CapitalStructure({ v }: { v: Valuation }) {
  const { inputs, update, model } = v;
  const base = model.runs[2];
  const capped = inputs.converts.find((c) => c.cap > 0);
  const cell = (
    label: string,
    value: number,
    delivered: number,
    commit: (x: number) => void,
    unit: '$mm' | 'x' = '$mm',
    integer = false,
  ) => <ParamInput label={label} value={value} delivered={delivered} unit={unit} integer={integer} min={0} onCommit={commit} className="w-24" />;

  return (
    <Section
      title="Capital structure — 30-Jun-2026 10-Q, pro forma the Jul-2026 convertible"
      note={`Basic economic shares ${base.S0.toFixed(3)}mm (Class A + B + C: the Up-C units are exchangeable 1:1, R-05). Cash & liquid assets ${base.cash.toFixed(1)}; debt ${base.debt.toFixed(1)}; convertibles ${base.convFace.toFixed(1)} ($mm).`}
    >
      <div className="grid gap-px bg-border lg:grid-cols-2">
        <div className="bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Shares</TableHead><NumHead>Count</NumHead><TableHead>Source</TableHead></TableRow></TableHeader>
            <TableBody>
              {inputs.shares.map((r, i) => (
                <TableRow key={r.label}>
                  <TableCell className="text-xs">{r.label}</TableCell>
                  <NumCell>{cell(r.label, r.count, DELIVERED.shares[i].count, (x) => update((d) => { d.shares[i].count = x; }), 'x', true)}</NumCell>
                  <TableCell className="text-xs text-muted-foreground">{r.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader><TableRow><TableHead>Cash & liquid assets ($mm)</TableHead><NumHead>Amount</NumHead><NumHead>Include</NumHead></TableRow></TableHeader>
            <TableBody>
              {inputs.cash.map((r, i) => (
                <TableRow key={r.label}>
                  <TableCell className="text-xs">{r.label}<span className="block text-xs text-muted-foreground">{r.source}</span></TableCell>
                  <NumCell>
                    <ParamInput label={r.label} value={r.amount} delivered={DELIVERED.cash[i].amount} unit="$mm"
                      onCommit={(x) => update((d) => { d.cash[i].amount = x; })} className="w-24" />
                  </NumCell>
                  <NumCell>
                    <Switch checked={r.include === 1} aria-label={`Include ${r.label}`}
                      onCheckedChange={(c) => update((d) => { d.cash[i].include = c ? 1 : 0; })} />
                  </NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader><TableRow><TableHead>Non-convertible debt ($mm face)</TableHead><NumHead>Face</NumHead><TableHead>Source</TableHead></TableRow></TableHeader>
            <TableBody>
              {inputs.debt.map((r, i) => (
                <TableRow key={r.label}>
                  <TableCell className="text-xs">{r.label}</TableCell>
                  <NumCell>{cell(r.label, r.face, DELIVERED.debt[i].face, (x) => update((d) => { d.debt[i].face = x; }))}</NumCell>
                  <TableCell className="text-xs text-muted-foreground">{r.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Convertible notes</TableHead><NumHead>Face $mm</NumHead><NumHead>Conv. $</NumHead><NumHead>Cap $</NumHead>
                <NumHead>Converts (Base)</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inputs.converts.map((r, i) => (
                <TableRow key={r.label}>
                  <TableCell className="text-xs">{r.label}<span className="block text-xs text-muted-foreground">{r.source}</span></TableCell>
                  <NumCell>{cell(`${r.label} face`, r.face, DELIVERED.converts[i].face, (x) => update((d) => { d.converts[i].face = x; }))}</NumCell>
                  <NumCell>{cell(`${r.label} conversion price`, r.convPrice, DELIVERED.converts[i].convPrice, (x) => update((d) => { d.converts[i].convPrice = x; }), 'x')}</NumCell>
                  <NumCell>{cell(`${r.label} cap`, r.cap, DELIVERED.converts[i].cap, (x) => update((d) => { d.converts[i].cap = x; }), 'x')}</NumCell>
                  <NumCell className="text-xs">{base.dilution.converts[i] ? 'Yes' : 'No'}</NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader><TableRow><TableHead>Equity awards</TableHead><NumHead>Count</NumHead><NumHead>Strike $</NumHead></TableRow></TableHeader>
            <TableBody>
              {inputs.awards.map((r, i) => (
                <TableRow key={r.label}>
                  <TableCell className="text-xs">
                    {r.label}
                    <span className={cn('block text-xs', /STALE/.test(r.source) ? 'text-[hsl(var(--warning))]' : 'text-muted-foreground')}>{r.source}</span>
                  </TableCell>
                  <NumCell>{cell(`${r.label} count`, r.count, DELIVERED.awards[i].count, (x) => update((d) => { d.awards[i].count = x; }), 'x', true)}</NumCell>
                  <NumCell>{cell(`${r.label} strike`, r.strike, DELIVERED.awards[i].strike, (x) => update((d) => { d.awards[i].strike = x; }), 'x')}</NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {capped && (
            <p className="px-4 py-2.5 text-xs text-muted-foreground">
              Capped call: the {capped.label.replace(/ converts.*/, '')} notes’ trigger is the ${capped.cap.toFixed(2)} cap, and conversion
              adds n × cap rather than face. The 2.375% notes’ capped call is ignored — conservative (R-09).
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
