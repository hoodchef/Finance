'use client';

import * as React from 'react';
import {
  deliveredInputs,
  GLOBAL_ROWS,
  SCENARIO_ROWS,
  SCENARIOS,
  type AstsInputs,
  type ScenarioIndex,
} from '@/lib/valuation/asts/inputs';
import { runModel, snapshotStats } from '@/lib/valuation/asts/engine';
import { runChecks } from '@/lib/valuation/asts/checks';
import {
  capexTimingTest,
  grid,
  GRID_COST_CIP,
  GRID_TAKE_ARPU,
  monteCarlo,
  reverseDcf,
  sensitivityGrid,
  tornado,
  type McResult,
} from '@/lib/valuation/asts/analytics';
import { headline } from '@/lib/valuation/asts/summary';
import { financing, valueBasisPrices } from '@/lib/valuation/asts/financing';
import type { LiveMarket } from '@/lib/valuation/asts/market-live';
import type { FilingStatus } from '@/lib/valuation/asts/filings';
import { loadStored, saveStored } from './storage';

/**
 * Colour follows the scenario everywhere on the page, never its rank, and is a
 * per-theme token (`--scenario-N` in globals.css) rather than a fixed series
 * index. No single index set works in all four themes: Terminal's near-
 * monochrome palette made Base and Distress the same orange, and the others
 * put Bear on green, which reads as "good" on a trading screen. Each theme's
 * mapping was chosen from its own series by the palette validator.
 */
export const SCENARIO_COLOR: Record<ScenarioIndex, string> = {
  0: 'var(--scenario-0)',
  1: 'var(--scenario-1)',
  2: 'var(--scenario-2)',
  3: 'var(--scenario-3)',
};

export interface LivePayload {
  market: LiveMarket | null;
  marketNote: string | null;
  filings: FilingStatus | null;
  filingsNote: string | null;
}

export interface ValuationOptions {
  /** Growth-phase beta: the reviewed snapshot estimate, or today's re-estimate. */
  betaBasis: 'snapshot' | 'live';
  /** Price the model is compared against. Value itself does not depend on it. */
  priceBasis: 'live' | 'snapshot';
  /**
   * What a raise is priced against: each scenario's own fair value (coherent —
   * a Bear-world raise happens at a Bear-world price, and 0% reproduces the
   * model) or today's market price (the lens where the market never learns).
   */
  issueBasis: 'value' | 'market';
  /** Discount to that basis at which new equity is issued. */
  issueDiscount: number;
  useLigadoFacility: boolean;
  minBuffer: number;
}

export const DEFAULT_OPTIONS: ValuationOptions = {
  betaBasis: 'snapshot',
  priceBasis: 'live',
  issueBasis: 'value',
  issueDiscount: 0,
  useLigadoFacility: false,
  minBuffer: 0,
};

export interface InputDiff {
  label: string;
  where: string;
  from: string | number;
  to: string | number;
}

/** Every input that differs from the delivered model, in words. */
export function diffInputs(a: AstsInputs, b: AstsInputs): InputDiff[] {
  const out: InputDiff[] = [];
  for (const r of GLOBAL_ROWS) {
    if (a.global[r.key] !== b.global[r.key]) out.push({ label: r.label, where: 'Global', from: a.global[r.key], to: b.global[r.key] });
  }
  for (const r of SCENARIO_ROWS) {
    a.scenario[r.key].forEach((v, s) => {
      if (v !== b.scenario[r.key][s]) out.push({ label: r.label, where: SCENARIOS[s], from: v, to: b.scenario[r.key][s] });
    });
  }
  const rows = <T extends { label: string }>(where: string, x: readonly T[], y: readonly T[], fields: (keyof T)[]) => {
    x.forEach((row, i) => {
      for (const f of fields) {
        if (y[i] && row[f] !== y[i][f]) {
          out.push({ label: `${row.label} — ${String(f)}`, where, from: row[f] as unknown as number, to: y[i][f] as unknown as number });
        }
      }
    });
  };
  rows('Shares', a.shares, b.shares, ['count']);
  rows('Cash', a.cash, b.cash, ['amount', 'include']);
  rows('Debt', a.debt, b.debt, ['face']);
  rows('Convertibles', a.converts, b.converts, ['face', 'convPrice', 'cap']);
  rows('Awards', a.awards, b.awards, ['count', 'strike']);
  return out;
}

export type McState =
  | { status: 'running'; progress: number; result: McResult | null }
  | { status: 'done'; progress: 1; result: McResult }
  | { status: 'error'; progress: number; result: McResult | null; message: string };

export function useAstsValuation() {
  const [inputs, setInputs] = React.useState<AstsInputs>(deliveredInputs);
  const [options, setOptions] = React.useState<ValuationOptions>(DEFAULT_OPTIONS);
  const [restored, setRestored] = React.useState(false);

  // Edits persist per browser, and are dropped if the delivered model changed under them.
  React.useEffect(() => {
    const s = loadStored<ValuationOptions>();
    if (s) {
      setInputs(s.inputs);
      setOptions({ ...DEFAULT_OPTIONS, ...s.options });
    }
    setRestored(true);
  }, []);
  React.useEffect(() => {
    if (restored) saveStored(inputs, options);
  }, [inputs, options, restored]);

  const update = React.useCallback((fn: (draft: AstsInputs) => void) => {
    setInputs((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }, []);
  const reset = React.useCallback(() => setInputs(deliveredInputs()), []);

  /* ---- live context: price, beta re-estimate, filings */
  const [live, setLive] = React.useState<LivePayload | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch('/api/valuation/asts')
      .then((r) => r.json())
      .then((d: LivePayload) => alive && setLive(d))
      .catch(() =>
        alive && setLive({ market: null, marketNote: 'Live data request failed.', filings: null, filingsNote: 'Filing check request failed.' }),
      );
    return () => {
      alive = false;
    };
  }, []);

  /* ---- the model, recomputed on every edit (about 200 engine runs, ~10 ms) */
  const deferred = React.useDeferredValue(inputs);
  const snapshot = React.useMemo(() => snapshotStats(deferred), [deferred]);
  const liveStats = live?.market?.stats ?? null;
  const betaHi = options.betaBasis === 'live' && liveStats ? liveStats.betaAdj : snapshot.betaAdj;
  const livePrice = live?.market?.price ?? null;
  const price = options.priceBasis === 'live' && livePrice != null ? livePrice : snapshot.price;
  const priceIsLive = options.priceBasis === 'live' && livePrice != null;

  const core = React.useMemo(() => {
    const model = runModel(deferred, { betaHi });
    const sens = sensitivityGrid(deferred, model.runs[2]);
    const checks = runChecks(deferred, model, snapshot, sens.values[2][2]);
    const head = headline(deferred, model, price, snapshot);
    const finOpts = { useLigadoFacility: options.useLigadoFacility, minBuffer: options.minBuffer };
    const fin = financing(deferred, model, {
      ...finOpts,
      issuePrice:
        options.issueBasis === 'value'
          ? valueBasisPrices(model, options.issueDiscount)
          : price * (1 - options.issueDiscount),
    });
    // What the discount is worth: the weighted value if every raise comes in below fair value.
    const discountLadder = [0, 0.1, 0.2, 0.3].map((d) => ({
      d,
      pw: financing(deferred, model, { ...finOpts, issuePrice: valueBasisPrices(model, d) }).pwFinanced,
    }));
    return { model, sens, checks, head, fin, discountLadder };
  }, [deferred, betaHi, price, snapshot, options.issueBasis, options.issueDiscount, options.useLigadoFacility, options.minBuffer]);

  const analytics = React.useMemo(
    () => ({
      tornado: tornado(deferred, betaHi),
      takeArpu: grid(deferred, betaHi, GRID_TAKE_ARPU.k1, GRID_TAKE_ARPU.v1, GRID_TAKE_ARPU.k2, GRID_TAKE_ARPU.v2),
      costCip: grid(deferred, betaHi, GRID_COST_CIP.k1, GRID_COST_CIP.v1, GRID_COST_CIP.k2, GRID_COST_CIP.v2),
      reverse: reverseDcf(deferred, betaHi, price),
      capexTiming: capexTimingTest(deferred, betaHi),
    }),
    [deferred, betaHi, price],
  );

  /* ---- the simulation: 20,000 paths in slices, restarted when the model changes */
  const [mc, setMc] = React.useState<McState>({ status: 'running', progress: 0, result: null });
  React.useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      setMc((m) => ({ status: 'running', progress: 0, result: m.result }));
      monteCarlo(deferred, {
        price,
        betaHi,
        signal: ac.signal,
        chunk: 1000,
        onProgress: (d, n) => d % 5000 === 0 && setMc((m) => ({ ...m, status: 'running', progress: d / n }) as McState),
      })
        .then((result) => setMc({ status: 'done', progress: 1, result }))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setMc((m) => ({ status: 'error', progress: m.progress, result: m.result, message: String(e) }));
        });
    }, 500);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [deferred, betaHi, price]);

  const diffs = React.useMemo(() => diffInputs(deliveredInputs(), inputs), [inputs]);

  return {
    inputs, update, reset, options, setOptions, restored,
    live, snapshot, liveStats, betaHi, price, livePrice, priceIsLive,
    ...core, analytics, mc, diffs,
    stale: deferred !== inputs,
  };
}

export type Valuation = ReturnType<typeof useAstsValuation>;
