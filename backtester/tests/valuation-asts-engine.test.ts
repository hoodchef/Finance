import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CASH,
  deliveredInputs,
  GLOBAL_ROWS,
  SCENARIO_ROWS,
  type AstsInputs,
  type GlobalKey,
  type Quad,
  type ScenarioIndex,
  type ScenarioKey,
} from '../src/lib/valuation/asts/inputs';
import { marketStats, runModel, runScenario, snapshotStats, type ScenarioRun } from '../src/lib/valuation/asts/engine';
import { SNAPSHOT_ASTS, SNAPSHOT_SPY, SNAPSHOT_TIME } from '../src/lib/valuation/asts/market-snapshot';

/**
 * The port against the analyst's own engine and workbook.
 *
 * Fixture: tests/fixtures/asts-reference.json, generated from reference/asts
 * (unmodified) by scripts/asts/make-asts-fixture.py. Tolerance is 1e-9
 * relative to max(1, |reference|) — the same metric the analyst's audit.py
 * used between their engine and the recalculated workbook.
 */
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'asts-reference.json'), 'utf8'));
const TOL = 1e-9;

/** Python engine key -> port key. */
const ARRAY_MAP: Record<string, keyof ScenarioRun> = {
  F: 'F', B: 'B', E: 'E', N: 'N', R: 'R', G: 'G', A: 'A', U: 'U', SC: 'SC', C: 'C', cov1: 'cov1', cov2: 'cov2',
  ad1: 'ad1', ad2: 'ad2', subs1: 'subs1', subs2: 'subs2', rev1: 'rev1', rev2: 'rev2', gov: 'gov', prod: 'prod',
  rev: 'rev', cogs: 'cogs', var: 'var', lig: 'lig', spec: 'spec', opex: 'opex', netx: 'netx', sbc: 'sbc',
  ebitda: 'ebitda', ocx: 'ocx', ligpay: 'ligpay', jleo: 'jleo', tdep: 'tdep', samort: 'samort', ti: 'ti',
  nol_e: 'nolE', tax: 'tax', dnwc: 'dnwc', cl: 'cl', fcf: 'fcf', w: 'w', df: 'df', Ecum: 'comp', pv: 'pv',
};
const SCALAR_MAP: Record<string, keyof ScenarioRun> = {
  w_hi: 'wHi', w_t: 'wT', ke_hi: 'keHi', fcf41: 'fcf41', e41: 'e41', maint: 'maint', tv: 'tv', pv_tv: 'pvTv',
  ev: 'ev', E0: 'E0', Ef: 'Ef', Sf: 'Sf', vps: 'vps', cash: 'cash', debt: 'debt', conv_face: 'convFace',
};

function rel(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(b));
}

function expectClose(actual: number, expected: number, what: string) {
  const d = rel(actual, expected);
  if (!(d < TOL)) throw new Error(`${what}: port ${actual} vs reference ${expected} (rel ${d.toExponential(2)})`);
}

function compareRun(run: ScenarioRun, ref: Record<string, unknown>, where: string): number {
  let compared = 0;
  for (const [pk, tk] of Object.entries(SCALAR_MAP)) {
    if (!(pk in ref)) continue;
    expectClose(run[tk] as number, ref[pk] as number, `${where} ${pk}`);
    compared++;
  }
  for (const [pk, tk] of Object.entries(ARRAY_MAP)) {
    if (!(pk in ref)) continue;
    const exp = ref[pk] as number[];
    const act = run[tk] as number[];
    expect(act.length, `${where} ${pk} length`).toBe(exp.length);
    exp.forEach((e, i) => expectClose(act[i], e, `${where} ${pk}[${i}]`));
    compared += exp.length;
  }
  expect(run.dilution.converts, `${where} conversion flags`).toEqual(ref.conv);
  return compared;
}

interface FixtureCase {
  name: string;
  why?: string;
  global: Record<string, number>;
  scenario: Record<string, number[]>;
  capital: Record<string, unknown[][]>;
  run: { beta_hi?: number; delay?: number };
  scenarios: Record<string, unknown>[];
  pw: number;
}

/** Apply a fixture case's patch to the delivered inputs. */
function patched(c: FixtureCase): AstsInputs {
  const inputs = deliveredInputs();
  for (const [k, v] of Object.entries(c.global)) {
    expect(GLOBAL_ROWS.some((r) => r.key === k), `unknown global ${k}`).toBe(true);
    inputs.global[k as GlobalKey] = v;
  }
  for (const [k, v] of Object.entries(c.scenario)) {
    expect(SCENARIO_ROWS.some((r) => r.key === k), `unknown scenario key ${k}`).toBe(true);
    inputs.scenario[k as ScenarioKey] = v as unknown as Quad;
  }
  for (const [k, rows] of Object.entries(c.capital)) {
    if (k === 'AWARDS') {
      inputs.awards = rows.map(([label, count, strike, source]) => ({
        label: String(label), count: Number(count), strike: Number(strike), source: String(source),
      }));
    } else if (k === 'CONVERTS') {
      inputs.converts = rows.map(([label, face, convPrice, cap, source]) => ({
        label: String(label), face: Number(face), convPrice: Number(convPrice), cap: Number(cap),
        source: String(source), coupon: 0, maturity: '', postBalanceSheet: false,
      }));
    } else if (k === 'CASH') {
      inputs.cash = rows.map(([label, amount, include, source]) => ({
        label: String(label), amount: Number(amount), include: Number(include) as 0 | 1, source: String(source),
        role: CASH.find((x) => x.label === label)?.role ?? 'receivable',
      }));
    } else {
      throw new Error(`unhandled capital patch ${k}`);
    }
  }
  return inputs;
}

function runOpts(run: { beta_hi?: number; delay?: number }) {
  return { betaHi: run.beta_hi, delay: run.delay };
}

describe('market statistics — against the engine and the workbook Market_Data sheet', () => {
  it('uses the delivered IBKR snapshot, unaltered', () => {
    expect(SNAPSHOT_TIME).toEqual(FIX.market.time);
    expect(SNAPSHOT_ASTS).toEqual(FIX.market.asts);
    expect(SNAPSHOT_SPY).toEqual(FIX.market.spy);
  });

  it('reproduces the engine’s beta, volatility and price', () => {
    const m = snapshotStats(deliveredInputs());
    expectClose(m.betaRaw, FIX.market.betaRaw, 'raw beta');
    expectClose(m.betaAdj, FIX.market.betaAdj, 'Blume beta');
    expectClose(m.vol, FIX.market.vol, 'volatility');
    expect(m.price).toBe(FIX.market.price);
  });

  it('reproduces every Market_Data statistic, including those the engine never computed', () => {
    const m = marketStats(SNAPSHOT_ASTS, SNAPSHOT_SPY, 0.67);
    const wb = FIX.workbook.marketData as Record<string, number>;
    const pairs: Array<[string, number]> = [
      ['Current price (last close, $)', m.price],
      ['Full-week returns in regression (n)', m.n],
      ['Raw beta vs SPY (weekly, 2y)', m.betaRaw],
      ['Std. error of beta', m.betaSe],
      ['t-statistic', m.betaT],
      ['R-squared (systematic share of variance)', m.r2],
      ['Blume-adjusted beta (used in WACC)', m.betaAdj],
      ['ASTS annualised volatility', m.vol],
      ['SPY annualised volatility', m.benchVol],
      ['Idiosyncratic volatility', m.idioVol],
      ['Max drawdown (2y)', m.maxDrawdown],
      ['1-week historical VaR 95% (return)', m.var95],
      ['1-week CVaR 95% (mean of returns <= VaR)', m.cvar95],
      ['1-week parametric VaR 95% (normal)', m.pvar95],
      ['Annualised downside deviation (MAR 0)', m.downsideDev],
      ['2-yr high close', m.high],
      ['2-yr low close', m.low],
    ];
    for (const [label, v] of pairs) {
      expect(wb[label], `workbook has "${label}"`).toBeTypeOf('number');
      expectClose(v, wb[label], label);
    }
  });
});

describe('the delivered model — every row, every period, every scenario', () => {
  const inputs = deliveredInputs();
  const model = runModel(inputs);

  it.each([0, 1, 2, 3] as ScenarioIndex[])('scenario %i matches the engine at 1e-9', (s) => {
    const compared = compareRun(model.runs[s], FIX.delivered.scenarios[s], `delivered s${s}`);
    // 44 arrays x 15 periods + 16 scalars: nothing silently skipped.
    expect(compared).toBe(44 * 15 + 16);
  });

  it('probability-weights to the workbook’s $52.8790', () => {
    expectClose(model.pw, FIX.delivered.pw, 'prob-weighted');
    expectClose(model.pw, FIX.workbook.summary.pw, 'prob-weighted vs workbook');
    expect(model.pw.toFixed(4)).toBe('52.8790');
  });

  it.each([0, 1, 2, 3] as ScenarioIndex[])('scenario %i matches the workbook’s own rows and diagnostics', (s) => {
    const r = model.runs[s];
    const wb = FIX.workbook.calc[s];
    for (const k of ['growth', 'subsPerSat', 'costs', 'margin', 'cumFcf', 'netSC'] as const) {
      (wb[k] as number[]).forEach((e: number, i: number) => expectClose(r[k][i], e, `s${s} ${k}[${i}]`));
    }
    for (const k of ['pool', 'tvPct', 'pvExplicit', 'fy26', 'minFcf', 'maxSubsPerSat', 'cagr', 'm40', 'rev30', 'rev35'] as const) {
      expectClose(r[k], wb[k], `s${s} ${k}`);
    }
    if (wb.tvMult === 'n/m') expect(r.tvMult).toBeNull();
    else expectClose(r.tvMult as number, wb.tvMult, `s${s} tvMult`);
    expectClose(r.vps / FIX.workbook.summary.price - 1, wb.upside, `s${s} upside`);
  });

  it('builds the capital structure the workbook reconciles', () => {
    const r = model.runs[2];
    expectClose(r.S0, FIX.workbook.capital.S0, 'S0');
    expectClose(r.cash, FIX.workbook.capital.cash, 'cash');
    expectClose(r.debt, FIX.workbook.capital.debt, 'debt');
    expectClose(r.convFace, FIX.workbook.capital.convFace, 'convertible face');
  });
});

describe('branch cases — each one built so that a specific branch binds', () => {
  it.each((FIX.branches as FixtureCase[]).map((c) => [c.name, c.why ?? '', c] as [string, string, FixtureCase]))(
    '%s (%s)',
    (_name, _why, c) => {
      const inputs = patched(c);
      const opts = runOpts(c.run);
      let compared = 0;
      for (const s of [0, 1, 2, 3] as ScenarioIndex[]) {
        compared += compareRun(runScenario(inputs, s, opts), c.scenarios[s], `${c.name} s${s}`);
      }
      expect(compared).toBeGreaterThan(4 * 16);
      expectClose(runModel(inputs, opts).pw, c.pw, `${c.name} prob-weighted`);
    },
  );

  // A branch case that does not actually differ from the delivered model proves
  // nothing about its branch. Each must move the valuation somewhere.
  it('every branch case changes the model it was built to change', () => {
    const delivered = FIX.delivered.scenarios.map((x: { ev: number }) => x.ev);
    for (const c of FIX.branches) {
      const moved = c.scenarios.some((x: { ev: number }, s: number) => rel(x.ev, delivered[s]) > 1e-12);
      expect(moved, `${c.name} leaves every scenario's EV unchanged`).toBe(true);
    }
  });
});

describe('fuzz — every scenario input perturbed ±25% at once', () => {
  it.each((FIX.fuzz as FixtureCase[]).map((c) => [c.name, c] as [string, FixtureCase]))('%s', (_name, c) => {
    const inputs = patched(c);
    const opts = runOpts(c.run);
    for (const s of [0, 1, 2, 3] as ScenarioIndex[]) {
      compareRun(runScenario(inputs, s, opts), c.scenarios[s], `${c.name} s${s}`);
    }
    expectClose(runModel(inputs, opts).pw, c.pw, `${c.name} prob-weighted`);
  });
});

describe('economic properties (final_validation.py) — same grids, same values', () => {
  it.each(Object.entries(FIX.properties))('value responds to %s as the reference does', (key, grid) => {
    const g = grid as { x: number[]; vps: number[] };
    const beta = snapshotStats(deliveredInputs()).betaAdj;
    g.x.forEach((x, i) => {
      const v = runScenario(deliveredInputs(), 2, { overrides: { [key]: x }, betaHi: beta }).vps;
      expectClose(v, g.vps[i], `${key}=${x}`);
    });
  });

  it('per-share value is continuous through the conversion triggers', () => {
    // The dilution engine is value-consistent, so crossing a trigger must not
    // make value jump. 400 steps over the $72.07 trigger of the 2.375% notes.
    const inputs = deliveredInputs();
    let prev: number | null = null;
    let maxStep = 0;
    for (let i = 0; i < 400; i++) {
      const t = 0.1 + (0.04 * i) / 399;
      const v = runScenario(inputs, 2, { overrides: { take_t1: t } }).vps;
      if (prev != null) maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(maxStep).toBeLessThan(0.5);
  });

  it('is finite and non-negative under extremes', () => {
    const inputs = deliveredInputs();
    for (const ov of [{ take_t1: 0.6 }, { unit_cost: 100 }, { wacc_shift: 0.05 }, { g: 0 }, { take_t1: 0, take_t2: 0 }]) {
      const v = runScenario(inputs, 2, { overrides: ov }).vps;
      expect(Number.isFinite(v) && v >= 0, JSON.stringify(ov)).toBe(true);
    }
  });
});

describe('inputs are the delivered model', () => {
  it('leaves the delivered set untouched when a copy is edited', () => {
    const a = deliveredInputs();
    a.global.rf = 0.99;
    a.scenario.take_t1 = [1, 1, 1, 1];
    a.converts[0].face = 0;
    const b = deliveredInputs();
    expect(b.global.rf).toBe(0.0484);
    expect(b.scenario.take_t1).toEqual([0.03, 0.06, 0.1, 0.15]);
    expect(b.converts[0].face).toBe(3.514);
  });
});
