'use client';

import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWorkspace } from '@/store/workspace';
import { normaliseStrategy } from '@/lib/engine/build-strategy';
import type {
  StrategyBaseKind,
  StrategyBaseSpec,
  StrategyOverlayKind,
  StrategyOverlaySpec,
} from '@/lib/types';

/**
 * Building a strategy: one base, and overlays over it.
 *
 * The two layers are the point. Six mutually exclusive rules could not express
 * "hold the strongest three, but step out of any that have rolled over", which
 * is the combination most people actually want — and expressing it as rules
 * costs one new rule per pair. A base decides what to hold; each overlay
 * decides how much of it, given what the market is doing.
 *
 * Overlays only ever reduce or redistribute, so a stack of them can be read
 * top to bottom without holding the whole thing in your head: the result is
 * never more invested than the base asked for, and what they remove is cash.
 */

const BASE_LABELS: Record<StrategyBaseKind, string> = {
  fixed: 'Fixed weights — as typed',
  equal: 'Equal weight',
  glidepath: 'Glidepath — growth to defensive',
  momentum: 'Momentum — hold the strongest',
  inverseVolatility: 'Inverse volatility',
  minimumVariance: 'Minimum variance — solved each rebalance',
  riskParity: 'Risk parity — solved each rebalance',
};

/** What each rule does, and what it costs — never just what it does. */
const BASE_HINTS: Record<StrategyBaseKind, string> = {
  fixed: 'Targets stay at the weights you typed. Rebalancing restores them.',
  equal:
    'Every holding gets the same share, held as a rule — so it stays equal as prices diverge, which typing equal weights does not.',
  glidepath:
    'Shifts from a growth sleeve to a defensive one as the horizon shortens, the way a target-date fund does.',
  momentum:
    'Holds the strongest holdings over a trailing window and sells the rest. Trades more, and turns sharply at reversals.',
  inverseVolatility:
    'Weights inversely to trailing volatility. Ignores correlation, so holdings that move together are treated as diversifying when they are not.',
  minimumVariance:
    'Solves for the lowest-variance mix at every rebalance, using only the covariance known at the time. Uses no return forecast, which is why it tends to survive out of sample.',
  riskParity:
    'Equalises each holding’s contribution to portfolio risk at every rebalance, using the full covariance rather than volatility alone.',
};

const OVERLAY_LABELS: Record<StrategyOverlayKind, string> = {
  trend: 'Trend filter — hold only what is rising',
  volatilityTarget: 'Volatility target — scale exposure',
  cap: 'Position cap',
};

const OVERLAY_HINTS: Record<StrategyOverlayKind, string> = {
  trend:
    'Anything below its own moving average goes to cash, keeping its weight rather than handing it to whatever is still rising.',
  volatilityTarget:
    'Scales the whole portfolio toward a volatility target and leaves the rest in cash. Only ever cuts exposure — scaling up in calm years is leverage a backtest can claim and nobody could trade.',
  cap: 'Ceiling on any single holding, with the excess redistributed to the others and the remainder left in cash.',
};

const BASE_DEFAULTS: Record<StrategyBaseKind, StrategyBaseSpec> = {
  fixed: { kind: 'fixed' },
  equal: { kind: 'equal' },
  glidepath: { kind: 'glidepath', growthSymbols: [], startGrowthPct: 90, endGrowthPct: 40 },
  momentum: { kind: 'momentum', lookbackDays: 126, holdCount: 1, minimumReturnPct: 0 },
  inverseVolatility: { kind: 'inverseVolatility', lookbackDays: 63 },
  minimumVariance: {
    kind: 'minimumVariance',
    // A year of sessions: enough to estimate a covariance, recent enough to
    // still describe the market the portfolio is in.
    lookbackDays: 252,
    shrink: true,
    maxWeightPct: 40,
  },
  riskParity: { kind: 'riskParity', lookbackDays: 252, shrink: true, maxWeightPct: 40 },
};

const OVERLAY_DEFAULTS: Record<StrategyOverlayKind, StrategyOverlaySpec> = {
  // 200 sessions is the convention this rule is usually quoted at.
  trend: { kind: 'trend', windowDays: 200 },
  volatilityTarget: { kind: 'volatilityTarget', targetVolPct: 10, lookbackDays: 63 },
  cap: { kind: 'cap', maxWeightPct: 25 },
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

  const { base, overlays } = React.useMemo(
    () => normaliseStrategy(config.strategy),
    [config.strategy],
  );

  /** Always stored composed once anything is configured; flat stays readable. */
  const write = (nextBase: StrategyBaseSpec, nextOverlays: StrategyOverlaySpec[]) => {
    if (nextBase.kind === 'fixed' && nextOverlays.length === 0) {
      setConfig({ strategy: undefined });
      return;
    }
    setConfig(
      nextOverlays.length === 0
        ? { strategy: nextBase }
        : { strategy: { kind: 'composed', base: nextBase, overlays: nextOverlays } },
    );
  };

  const setBase = (b: StrategyBaseSpec) => write(b, overlays);
  const setOverlay = (i: number, o: StrategyOverlaySpec) =>
    write(base, overlays.map((x, j) => (j === i ? o : x)));

  const symbols = React.useMemo(
    () => [...new Set(positions.map((p) => p.symbol.trim().toUpperCase()).filter(Boolean))],
    [positions],
  );

  const used = new Set(overlays.map((o) => o.kind));
  const addable = (Object.keys(OVERLAY_LABELS) as StrategyOverlayKind[]).filter(
    (k) => !used.has(k),
  );

  // A rule that decides targets only acts when the targets are applied.
  const configured = base.kind !== 'fixed' || overlays.length > 0;
  const inert = configured && config.rebalance === 'never';

  return (
    <div className="space-y-3">
      <Select
        value={base.kind}
        onValueChange={(v) => setBase(BASE_DEFAULTS[v as StrategyBaseKind])}
      >
        <SelectTrigger className="text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(BASE_LABELS) as StrategyBaseKind[]).map((k) => (
            <SelectItem key={k} value={k}>
              {BASE_LABELS[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-xs leading-relaxed text-muted-foreground">{BASE_HINTS[base.kind]}</p>

      {inert && (
        <p className="rounded-md border border-[hsl(var(--negative))]/40 bg-[hsl(var(--negative))]/10 p-2 text-xs leading-relaxed">
          Rebalancing is set to never, so this decides the targets once at the start and nothing
          ever moves to them. Choose a rebalancing frequency above for it to do anything.
        </p>
      )}

      {/* Base parameters */}
      {base.kind === 'glidepath' && (
        <div className="space-y-2">
          <NumberField
            id="st-glide-start"
            label="Growth allocation at the start"
            suffix="%"
            value={base.startGrowthPct}
            min={0}
            max={100}
            onChange={(v) => setBase({ ...base, startGrowthPct: v })}
          />
          <NumberField
            id="st-glide-end"
            label="Growth allocation at the end"
            suffix="%"
            value={base.endGrowthPct}
            min={0}
            max={100}
            onChange={(v) => setBase({ ...base, endGrowthPct: v })}
          />
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Which holdings are growth</p>
            {symbols.length === 0 ? (
              <p className="text-2xs text-muted-foreground">Add holdings first.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {symbols.map((s) => {
                  const on = base.growthSymbols.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setBase({
                          ...base,
                          growthSymbols: on
                            ? base.growthSymbols.filter((x) => x !== s)
                            : [...base.growthSymbols, s],
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
            {base.growthSymbols.length === 0 && symbols.length > 0 && (
              <p className="mt-1 text-2xs text-muted-foreground">
                Nothing selected, so everything counts as defensive and the glidepath has no
                growth sleeve to move out of.
              </p>
            )}
          </div>
        </div>
      )}

      {base.kind === 'momentum' && (
        <div className="space-y-2">
          <NumberField
            id="st-mom-look"
            label="Ranking window"
            suffix="days"
            value={base.lookbackDays}
            min={2}
            max={2520}
            onChange={(v) => setBase({ ...base, lookbackDays: v })}
          />
          <NumberField
            id="st-mom-hold"
            label="Holdings to keep"
            value={base.holdCount}
            min={1}
            max={Math.max(1, symbols.length)}
            onChange={(v) => setBase({ ...base, holdCount: v })}
          />
          <NumberField
            id="st-mom-min"
            label="Skip anything returning less than"
            suffix="%"
            value={base.minimumReturnPct}
            min={-100}
            max={100}
            onChange={(v) => setBase({ ...base, minimumReturnPct: v })}
          />
        </div>
      )}

      {base.kind === 'inverseVolatility' && (
        <NumberField
          id="st-vol-look"
          label="Volatility window"
          suffix="days"
          value={base.lookbackDays}
          min={2}
          max={2520}
          onChange={(v) => setBase({ ...base, lookbackDays: v })}
        />
      )}

      {(base.kind === 'minimumVariance' || base.kind === 'riskParity') && (
        <div className="space-y-2">
          <NumberField
            id="st-opt-look"
            label="Covariance window"
            suffix="days"
            value={base.lookbackDays}
            min={30}
            max={2520}
            onChange={(v) => setBase({ ...base, lookbackDays: v })}
          />
          <NumberField
            id="st-opt-cap"
            label="Cap on any one holding"
            suffix="%"
            value={base.maxWeightPct}
            min={1}
            max={100}
            onChange={(v) => setBase({ ...base, maxWeightPct: v })}
          />
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="st-opt-shrink" className="text-xs text-muted-foreground">
              Shrink the covariance estimate
            </label>
            <Switch
              id="st-opt-shrink"
              checked={base.shrink}
              onCheckedChange={(v) => setBase({ ...base, shrink: v })}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Shrinkage pulls the estimate toward a constant correlation, which costs a little
            accuracy when the sample is good and a great deal of nonsense when it is not.
            Optimisers concentrate into whatever the sample flattered by luck; this is the cheapest
            defence against it.
          </p>
        </div>
      )}

      {/* Overlays */}
      <div className="space-y-2 border-t border-border pt-3">
        {overlays.length > 0 && (
          <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70">
            Then
          </p>
        )}

        {overlays.map((o, i) => (
          <div key={o.kind} className="rounded-md border border-border p-2">
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <span className="text-xs font-medium">{OVERLAY_LABELS[o.kind]}</span>
              <button
                type="button"
                aria-label={`Remove ${OVERLAY_LABELS[o.kind]}`}
                onClick={() => write(base, overlays.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              {OVERLAY_HINTS[o.kind]}
            </p>

            {o.kind === 'trend' && (
              <NumberField
                id={`st-ov-trend-${i}`}
                label="Moving-average window"
                suffix="days"
                value={o.windowDays}
                min={2}
                max={2520}
                onChange={(v) => setOverlay(i, { ...o, windowDays: v })}
              />
            )}

            {o.kind === 'volatilityTarget' && (
              <div className="space-y-2">
                <NumberField
                  id={`st-ov-vol-${i}`}
                  label="Target volatility"
                  suffix="%/yr"
                  value={o.targetVolPct}
                  min={0.5}
                  max={100}
                  step={0.5}
                  onChange={(v) => setOverlay(i, { ...o, targetVolPct: v })}
                />
                <NumberField
                  id={`st-ov-volwin-${i}`}
                  label="Measured over"
                  suffix="days"
                  value={o.lookbackDays}
                  min={2}
                  max={2520}
                  onChange={(v) => setOverlay(i, { ...o, lookbackDays: v })}
                />
              </div>
            )}

            {o.kind === 'cap' && (
              <NumberField
                id={`st-ov-cap-${i}`}
                label="No holding above"
                suffix="%"
                value={o.maxWeightPct}
                min={1}
                max={100}
                onChange={(v) => setOverlay(i, { ...o, maxWeightPct: v })}
              />
            )}
          </div>
        ))}

        {addable.length > 0 && (
          <Select
            value=""
            onValueChange={(v) =>
              write(base, [...overlays, OVERLAY_DEFAULTS[v as StrategyOverlayKind]])
            }
          >
            <SelectTrigger className="text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Plus className="h-3 w-3" />
                Add an overlay
              </span>
            </SelectTrigger>
            <SelectContent>
              {addable.map((k) => (
                <SelectItem key={k} value={k}>
                  {OVERLAY_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {configured && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Benchmarks are unaffected — they stay buy-and-hold, so the comparison is against the
          market rather than against the same rule twice.
        </p>
      )}
    </div>
  );
}
