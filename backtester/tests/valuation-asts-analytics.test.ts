import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deliveredInputs, type AstsInputs, type GlobalKey, type Quad, type ScenarioKey } from '../src/lib/valuation/asts/inputs';
import { runModel, runScenario, snapshotStats, type ModelRun } from '../src/lib/valuation/asts/engine';
import { runChecks } from '../src/lib/valuation/asts/checks';
import {
  capexTimingTest,
  corrMatrix,
  DISTS,
  drawToOverride,
  grid,
  GRID_COST_CIP,
  GRID_TAKE_ARPU,
  marginal,
  monteCarloSync,
  reverseDcf,
  sensitivityGrid,
  tornado,
} from '../src/lib/valuation/asts/analytics';
import { cholesky, symmetricEigenvalues } from '../src/lib/valuation/numeric';

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'asts-reference.json'), 'utf8'));
const A = FIX.analytics;
const TOL = 1e-9;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));
function close(actual: number, expected: number, what: string, tol = TOL) {
  if (!(rel(actual, expected) < tol)) {
    throw new Error(`${what}: port ${actual} vs reference ${expected} (rel ${rel(actual, expected).toExponential(2)})`);
  }
}

const inputs = deliveredInputs();
const beta = snapshotStats(inputs).betaAdj;

describe('deterministic analytics — against analytics.py, recomputed and matching what was stamped', () => {
  it('tornado: same drivers, same order, same P10/P90 inputs and values', () => {
    const t = tornado(inputs, beta);
    close(t.base, A.baseV, 'base value');
    expect(t.bars.map((b) => b.key)).toEqual(A.tornado.map((b: { key: string }) => b.key));
    t.bars.forEach((b, i) => {
      const r = A.tornado[i];
      close(b.lo, r.lo, `${b.key} P10 input`);
      close(b.vLo, r.vLo, `${b.key} $/sh at P10`);
      close(b.hi, r.hi, `${b.key} P90 input`);
      close(b.vHi, r.vHi, `${b.key} $/sh at P90`);
      close(b.swing, r.swing, `${b.key} swing`);
    });
  });

  it('take-rate x ARPU and unit-cost x CIP grids', () => {
    const g1 = grid(inputs, beta, GRID_TAKE_ARPU.k1, GRID_TAKE_ARPU.v1, GRID_TAKE_ARPU.k2, GRID_TAKE_ARPU.v2);
    const g2 = grid(inputs, beta, GRID_COST_CIP.k1, GRID_COST_CIP.v1, GRID_COST_CIP.k2, GRID_COST_CIP.v2);
    g1.forEach((row, i) => row.forEach((v, j) => close(v, A.g1[i][j], `g1[${i}][${j}]`)));
    g2.forEach((row, i) => row.forEach((v, j) => close(v, A.g2[i][j], `g2[${i}][${j}]`)));
  });

  it('reverse DCF: implied take rate, WACC shift and scenario multiplier at $62.42', () => {
    const r = reverseDcf(inputs, beta, A.price);
    close(r.take as number, A.reverse.take, 'implied Tier-1 take');
    close(r.shift as number, A.reverse.shift, 'implied WACC shift');
    close(r.wHi as number, A.reverse.wHi, 'implied growth WACC');
    close(r.wT as number, A.reverse.wT, 'implied terminal WACC');
    close(r.mult as number, A.reverse.mult, 'implied take multiplier');
  });

  it('reverse DCF says "unreachable" rather than inventing a root', () => {
    // No Tier-1 take rate up to 60% gets Base to $10,000 a share.
    expect(reverseDcf(inputs, beta, 10000).take).toBeNull();
  });

  it('capex-timing test (A3-03)', () => {
    const c = capexTimingTest(inputs, beta);
    close(c.base, A.capexTiming.base, 'base');
    close(c.shifted, A.capexTiming.shifted, 'capex paid a period early');
    close(c.dpv, A.capexTiming.dpv, 'PV effect');
  });
});

describe('the simulation — exact where it can be, statistical where it cannot', () => {
  it('the copula: correlation matrix, Cholesky factor and PSD margin match numpy', () => {
    const C = corrMatrix();
    expect(C).toEqual(A.corr);
    const L = cholesky(C);
    L.forEach((row, i) => row.forEach((v, j) => close(v, A.cholesky[i][j], `L[${i}][${j}]`)));
    close(symmetricEigenvalues(C)[0], A.eigMin, 'min eigenvalue');
  });

  it('marginals and draw-to-override: five fixed uniform vectors to the same inputs and the same value', () => {
    const bp = runScenario(inputs, 2).p;
    for (const d of A.draws) {
      const x: Record<string, number> = {};
      DISTS.forEach((dist, i) => {
        x[dist.key] = marginal(d.u[i], dist);
        close(x[dist.key], d.x[dist.key], `marginal ${dist.key} at u=${d.u[i]}`, 1e-12);
      });
      const { overrides, delay } = drawToOverride(x, bp);
      expect(delay).toBe(d.delay);
      const r = runScenario(inputs, 2, { overrides, betaHi: A.beta, delay });
      close(r.vps, d.vps, 'value of the draw');
      close(r.ev, d.ev, 'EV of the draw');
    }
  });

  it('is reproducible from its seed', () => {
    const a = monteCarloSync(inputs, { n: 500, seed: 7, price: A.price });
    const b = monteCarloSync(inputs, { n: 500, seed: 7, price: A.price });
    const c = monteCarloSync(inputs, { n: 500, seed: 8, price: A.price });
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
    expect(a.mean).not.toBe(c.mean);
  });

  it('agrees with the analyst’s 20,000-path result within sampling error', () => {
    const mc = monteCarloSync(inputs, { n: 20000, price: A.price });
    const ref = A.mc;
    // Two independent 20k-path estimates: the difference has SE ≈ √2 × the reference SE.
    const z = (a: number, b: number, se: number) => Math.abs(a - b) / se;
    expect(z(mc.mean, ref.mean, Math.SQRT2 * ref.se), `mean ${mc.mean} vs ${ref.mean}`).toBeLessThan(4);
    const pSe = (p: number) => Math.SQRT2 * Math.sqrt((p * (1 - p)) / ref.n);
    expect(z(mc.pAbove, ref.p_above, pSe(ref.p_above)), 'P(value > price)').toBeLessThan(4);
    expect(z(mc.pZero, ref.p_zero, pSe(ref.p_zero)), 'P(value ~ 0)').toBeLessThan(4);
    // Median: SE ≈ 1.2533 σ / √n; σ from the reference SE.
    const sdRef = ref.se * Math.sqrt(ref.n);
    expect(z(mc.pct[50], ref.pct['50'], Math.SQRT2 * 1.2533 * sdRef / Math.sqrt(ref.n)), 'median').toBeLessThan(4);
    expect(mc.pct[5]).toBe(0);
    expect(mc.hist.reduce((t, x) => t + x, 0)).toBe(20000);
    expect(mc.conv[mc.conv.length - 1].mean).toBeCloseTo(mc.mean, 10);
  });
});

describe('the live WACC x g grid — an independent derivation, held to the workbook', () => {
  const model = runModel(inputs);
  const sens = sensitivityGrid(inputs, model.runs[2]);

  it('reproduces all 25 cached cells', () => {
    sens.values.forEach((row, i) => row.forEach((v, j) => close(v, FIX.workbook.sensitivity[i][j], `sens[${i}][${j}]`)));
  });

  it('agrees with the engine run with the same overrides — two derivations, one answer', () => {
    sens.shifts.forEach((sh, i) =>
      sens.gs.forEach((g, j) => {
        const e = runScenario(inputs, 2, { overrides: { wacc_shift: sh, g } }).vps;
        close(sens.values[i][j], e, `cell ${i},${j}`);
      }),
    );
  });
});

describe('the 44 checks — against the workbook’s Checks sheet', () => {
  const model = runModel(inputs);
  const report = runChecks(inputs, model, snapshotStats(inputs), sensitivityGrid(inputs, model.runs[2]).values[2][2]);

  it('same labels, same order, same values, all passing', () => {
    const wb = FIX.workbook.checks as Array<{ label: string; value: number; pass: boolean }>;
    expect(report.checks.map((c) => c.label)).toEqual(wb.map((c) => c.label));
    report.checks.forEach((c, i) => {
      close(c.value as number, wb[i].value, c.label);
      expect(c.pass, c.label).toBe(wb[i].pass);
    });
    expect(report.status).toBe(FIX.workbook.status);
    expect(report.status).toBe('ALL PASS');
  });
});

/** stress.py's break suite: each case must fire the checks the analyst expected it to. */
const BREAKS: Array<[string, Partial<Record<GlobalKey, number>>, Partial<Record<ScenarioKey, number[]>>, string[]]> = [
  ['probabilities sum to 90%', {}, { prob: [0.15, 0.25, 0.3, 0.2] }, ['probabilities']],
  ['g = 6% (> Rf)', { g: 0.06 }, {}, ['below risk-free', 'exceeds g']],
  ['WACC lever +1%', { wacc_shift: 0.01 }, {}, ['lever is zero']],
  ['Bull take 40% (capacity breach)', {}, { take_t1: [0.03, 0.06, 0.1, 0.4] }, ['users per satellite']],
  ['bonus depreciation OFF', { bonus_dep: 0 }, {}, []],
  ['satellite life 5 yrs', { sat_life: 5 }, {}, []],
  ['zero commercial adoption', {}, { take_t1: [0, 0, 0, 0], take_t2: [0, 0, 0, 0] }, []],
  ['no launch losses', { loss_rate: 0 }, {}, []],
  ['Ligado closes 2026', { ligado_year: 2026 }, {}, []],
  ['Tier-1 start 2040', {}, { t1_start: [2040, 2040, 2040, 2040] }, []],
  ['fleet shrinks after 2029', {}, { fl_ss: [45, 60, 60, 80] }, []],
  ['valuation date after stub midpoint', { val_date: 2026.8 }, {}, []],
];

function withPatch(g: Partial<Record<GlobalKey, number>>, sc: Partial<Record<ScenarioKey, number[]>>): AstsInputs {
  const x = deliveredInputs();
  Object.assign(x.global, g);
  for (const [k, v] of Object.entries(sc)) x.scenario[k as ScenarioKey] = v as unknown as Quad;
  return x;
}

describe('checks can fail — the break suite (stress.py) and deliberate tampering (A3-04)', () => {
  it.each(BREAKS)('%s fires what it should', (_name, g, sc, expected) => {
    const x = withPatch(g, sc);
    const model = runModel(x);
    const report = runChecks(x, model, snapshotStats(x), sensitivityGrid(x, model.runs[2]).values[2][2]);
    const fired = report.checks.filter((c) => !c.pass).map((c) => c.label);
    for (const e of expected) expect(fired.some((f) => f.includes(e)), `expected a check containing "${e}"`).toBe(true);
    // The mechanical checks police the engine, not the inputs: no input may trip them.
    const mech = report.checks.filter((c) => c.kind === 'mechanics' && !c.pass && !c.label.includes('probabilities')
      && !c.label.includes('exceeds g'));
    expect(mech.map((c) => c.label)).toEqual([]);
  });

  // The mechanical checks cannot be tripped through inputs when the engine is
  // right, so prove they CAN fail by feeding them a corrupted run.
  const tamper: Array<[string, (m: ModelRun) => void]> = [
    ['discount factors strictly decreasing', (m) => { m.runs[1].df[5] = m.runs[1].df[4] + 0.01; }],
    ['fleet never negative', (m) => { m.runs[2].E[3] = -1; }],
    ['NOL pool never negative', (m) => { m.runs[0].nolE[7] = -5; }],
    ['CIP credit used <= pool', (m) => { m.runs[3].C[2] += 1000; }],
    ['converted instruments all have K < value per share', (m) => { m.runs[2].dilution.converts[4] = true; }],
    ['Scenario ordering', (m) => { m.runs[3].vps = 0; }],
  ];
  it.each(tamper)('"%s" fails on a corrupted run', (label, corrupt) => {
    const model = runModel(inputs);
    corrupt(model);
    const report = runChecks(inputs, model, snapshotStats(inputs), model.runs[2].vps);
    const failed = report.checks.filter((c) => !c.pass).map((c) => c.label);
    expect(failed.some((f) => f.includes(label)), `"${label}" did not fire; failed: ${failed.join('; ')}`).toBe(true);
  });

  it('the sensitivity cross-check fails when the two derivations disagree', () => {
    const model = runModel(inputs);
    const report = runChecks(inputs, model, snapshotStats(inputs), model.runs[2].vps + 1);
    expect(report.checks.find((c) => c.label.startsWith('Sensitivity'))?.pass).toBe(false);
  });
});
