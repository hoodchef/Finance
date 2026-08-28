'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWorkspace } from '@/store/workspace';
import type { StrategyKind, StrategySpec } from '@/lib/types';

/**
 * Building a rule for how weights are decided.
 *
 * Until this existed, a portfolio's weights were the whole strategy: the
 * engine could express a glidepath, a momentum rotation or a trend filter, and
 * had been able to since the day loop was written, but nothing in the product
 * ever set one, so every backtest ran the declared weights.
 *
 * WHY IT SITS BESIDE REBALANCING
 *
 * A strategy decides *what* the targets are and rebalancing decides *when*
 * they are applied, and the two are useless apart. A momentum rule with
 * rebalancing set to never ranks holdings once and then holds them forever,
 * which is not the rule anyone intended. Putting them next to each other is
 * the cheapest way to make that dependency visible, and the note below says it
 * outright when the combination cannot work.
 */

const KIND_LABELS: Record<StrategyKind, string> = {
  fixed: 'Fixed weights — as typed',
  equal: 'Equal weight',
  glidepath: 'Glidepath — growth to defensive',
  momentum: 'Momentum — hold the strongest',
  trend: 'Trend filter — moving average',
  inverseVolatility: 'Inverse volatility',
};

/**
 * What each rule does, in a sentence, including what it costs you.
 *
 * Every one of these is a real tradeoff rather than a free improvement, and a
 * builder that lists rules without saying so invites the reader to assume the
 * fancier ones are better.
 */
const KIND_HINTS: Record<StrategyKind, string> = {
  fixed: 'Targets stay at the weights you typed. Rebalancing restores them.',
  equal:
    'Every holding gets the same share. Held as a rule, so it stays equal as prices diverge — which typing equal weights does not.',
  glidepath:
    'Shifts from a growth sleeve to a defensive one as the horizon shortens, the way a target-date fund does. Proportions inside each sleeve are preserved.',
  momentum:
    'Holds the strongest holdings over a trailing window and sells the rest. Trades more, and turns sharply at reversals — the window is what you are betting on.',
  trend:
    'Holds a position while it is above its own moving average and sits in cash while it is below. Each holding keeps its declared weight, so this cuts exposure rather than concentrating it.',
  inverseVolatility:
    'Weights inversely to trailing volatility, so each holding contributes a more even share of the movement. Ignores correlation, so holdings that move together are treated as diversifying when they are not.',
};

const DEFAULTS: Record<StrategyKind, StrategySpec> = {
  fixed: { kind: 'fixed' },
  equal: { kind: 'equal' },
  glidepath: { kind: 'glidepath', growthSymbols: [], startGrowthPct: 90, endGrowthPct: 40 },
  momentum: { kind: 'momentum', lookbackDays: 126, holdCount: 1, minimumReturnPct: 0 },
  // 200 sessions is the convention this rule is usually quoted at.
  trend: { kind: 'trend', windowDays: 200 },
  inverseVolatility: { kind: 'inverseVolatility', lookbackDays: 63 },
};

function NumberField({
  id,
  label,
  suffix,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  id: string;
  label: string;
  suffix?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex shrink-0 items-center gap-1.5">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 text-xs"
        />
        {suffix && <span className="text-2xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

export function StrategyBuilder() {
  const config = useWorkspace((s) => s.config);
  const setConfig = useWorkspace((s) => s.setConfig);
  const positions = useWorkspace((s) => s.draft.positions);

  const spec: StrategySpec = config.strategy ?? { kind: 'fixed' };
  const update = (next: StrategySpec) => setConfig({ strategy: next });

  const symbols = React.useMemo(
    () => [...new Set(positions.map((p) => p.symbol.trim().toUpperCase()).filter(Boolean))],
    [positions],
  );

  // A rule that decides targets only acts when the targets are applied.
  const inert = spec.kind !== 'fixed' && config.rebalance === 'never';

  return (
    <div className="space-y-3">
      <Select value={spec.kind} onValueChange={(v) => update(DEFAULTS[v as StrategyKind])}>
        <SelectTrigger className="text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(KIND_LABELS) as StrategyKind[]).map((k) => (
            <SelectItem key={k} value={k}>
              {KIND_LABELS[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-2xs leading-relaxed text-muted-foreground">{KIND_HINTS[spec.kind]}</p>

      {inert && (
        <p className="rounded-md border border-[hsl(var(--negative))]/40 bg-[hsl(var(--negative))]/10 p-2 text-2xs leading-relaxed">
          Rebalancing is set to never, so this rule decides the targets once at the start and
          nothing ever moves to them. Choose a rebalancing frequency above for it to do anything.
        </p>
      )}

      {spec.kind === 'glidepath' && (
        <div className="space-y-2">
          <NumberField
            id="st-glide-start"
            label="Growth allocation at the start"
            suffix="%"
            value={spec.startGrowthPct}
            min={0}
            max={100}
            onChange={(v) => update({ ...spec, startGrowthPct: v })}
          />
          <NumberField
            id="st-glide-end"
            label="Growth allocation at the end"
            suffix="%"
            value={spec.endGrowthPct}
            min={0}
            max={100}
            onChange={(v) => update({ ...spec, endGrowthPct: v })}
          />
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Which holdings are the growth sleeve
            </p>
            {symbols.length === 0 ? (
              <p className="text-2xs text-muted-foreground">Add holdings first.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {symbols.map((s) => {
                  const on = spec.growthSymbols.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        update({
                          ...spec,
                          growthSymbols: on
                            ? spec.growthSymbols.filter((x) => x !== s)
                            : [...spec.growthSymbols, s],
                        })
                      }
                      className={
                        on
                          ? 'rounded border border-primary bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-foreground'
                          : 'rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground'
                      }
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            )}
            {spec.growthSymbols.length === 0 && symbols.length > 0 && (
              <p className="mt-1 text-2xs text-muted-foreground">
                Nothing selected, so everything counts as defensive and the glidepath has no
                growth sleeve to move out of.
              </p>
            )}
          </div>
        </div>
      )}

      {spec.kind === 'momentum' && (
        <div className="space-y-2">
          <NumberField
            id="st-mom-look"
            label="Ranking window"
            suffix="days"
            value={spec.lookbackDays}
            min={2}
            max={2520}
            onChange={(v) => update({ ...spec, lookbackDays: v })}
          />
          <NumberField
            id="st-mom-hold"
            label="Holdings to keep"
            value={spec.holdCount}
            min={1}
            max={Math.max(1, symbols.length)}
            onChange={(v) => update({ ...spec, holdCount: v })}
          />
          <NumberField
            id="st-mom-min"
            label="Skip anything returning less than"
            suffix="%"
            value={spec.minimumReturnPct}
            min={-100}
            max={100}
            onChange={(v) => update({ ...spec, minimumReturnPct: v })}
          />
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Holdings below the floor are left in cash rather than replaced, which is what makes
            this defensive in a fall rather than a rotation into the least-bad option.
          </p>
        </div>
      )}

      {spec.kind === 'trend' && (
        <NumberField
          id="st-trend-window"
          label="Moving-average window"
          suffix="days"
          value={spec.windowDays}
          min={2}
          max={2520}
          onChange={(v) => update({ ...spec, windowDays: v })}
        />
      )}

      {spec.kind === 'inverseVolatility' && (
        <NumberField
          id="st-vol-look"
          label="Volatility window"
          suffix="days"
          value={spec.lookbackDays}
          min={2}
          max={2520}
          onChange={(v) => update({ ...spec, lookbackDays: v })}
        />
      )}

      {spec.kind !== 'fixed' && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Benchmarks are unaffected — they stay buy-and-hold, so the comparison is against the
          market rather than against the same rule twice.
        </p>
      )}
    </div>
  );
}
