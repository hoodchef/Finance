/**
 * Sensitivity, reverse DCF, and the Monte Carlo — live.
 *
 * The workbook stamps all of these as values from `analytics.py` and says so:
 * "re-run after changing inputs" (Notes, HOW TO USE). Here they are recomputed
 * from whatever inputs are on the page, so the tornado and the market-implied
 * take rate describe the model the reader is looking at rather than the one
 * that was delivered.
 *
 * Every deterministic routine is held to the analyst's `analytics.py` output
 * exactly. The simulation cannot share numpy's random stream, so it is held to
 * the analyst's 20,000-path result statistically — and everything downstream
 * of the uniforms (copula, marginals, the engine) is pinned exactly.
 */
import { normCdf } from '@/lib/options/pricing';
import { BASE, LENS, STARTS, SCENARIO_INDICES, type AstsInputs, type ParamKey, type ScenarioIndex } from './inputs';
import { capitalStructure, runScenario, snapshotStats, type Params, type ScenarioRun } from './engine';
import { brentq, BracketError, cholesky, makeUniform, mean, percentile, probit, sampleStd, symmetricEigenvalues } from '../numeric';

/* ------------------------------------------------------------------ distribution specification */

export type DistKind = 'lognormal' | 'tri' | 'uniform' | 'normal' | 'discrete';
export interface Dist {
  key: DriverKey;
  kind: DistKind;
  /** lognormal: [median, sigma(log)]; tri: [low, mode, high]; uniform: [low, high]; normal: [mean, sd]; discrete: [values, probs]. */
  params: readonly number[] | readonly [readonly number[], readonly number[]];
  desc: string;
}
/** Drivers are inputs, plus three that are not: a delay and two level multipliers. */
export type DriverKey = ParamKey | 'delay' | 'opex_mult' | 'gov_mult';

/** The analyst's simulation design, verbatim (analytics.py DISTS). */
export const DISTS: readonly Dist[] = [
  { key: 'take_t1', kind: 'lognormal', params: [0.1, 0.55], desc: 'Tier-1 peak take rate: median 10%, sigma(log) 0.55' },
  { key: 'take_t2', kind: 'lognormal', params: [0.03, 0.7], desc: 'Tier-2 peak take rate: median 3%, sigma(log) 0.70' },
  { key: 'arpu_t1', kind: 'tri', params: [3.5, 5.0, 6.5], desc: 'Tier-1 ARPU $/mo: triangular 3.50 / 5.00 / 6.50' },
  { key: 'arpu_t2', kind: 'tri', params: [0.4, 0.75, 1.1], desc: 'Tier-2 ARPU $/mo: triangular 0.40 / 0.75 / 1.10' },
  { key: 'unit_cost', kind: 'tri', params: [20.0, 22.0, 27.0], desc: 'Unit cost $mm: triangular 20 / 22 / 27 (overrun skew)' },
  { key: 'delay', kind: 'discrete', params: [[0, 1, 2], [0.45, 0.35, 0.2]],
    desc: 'Deployment & service delay (yrs): 0/1/2 @ 45/35/20%' },
  { key: 'cip_credit', kind: 'uniform', params: [0.25, 0.75], desc: 'CIP pre-funding share: uniform 25-75%' },
  { key: 'opex_mult', kind: 'lognormal', params: [1.0, 0.15], desc: 'Fixed-opex level multiplier: median 1.0, sigma 0.15' },
  { key: 'var_cost', kind: 'uniform', params: [0.09, 0.16], desc: 'Service variable cost %: uniform 9-16%' },
  { key: 'gov_mult', kind: 'lognormal', params: [1.0, 0.35], desc: 'Government revenue multiplier: median 1.0, sigma 0.35' },
  { key: 'wacc_shift', kind: 'normal', params: [0.0, 0.01], desc: 'WACC shift: normal(0, 1.0pp)' },
  { key: 'g', kind: 'tri', params: [0.015, 0.025, 0.03], desc: 'Terminal growth: triangular 1.5 / 2.5 / 3.0%' },
  { key: 'px_g', kind: 'uniform', params: [-0.03, 0.0], desc: 'ARPU repricing p.a. to 2032: uniform -3% to 0%' },
  { key: 'sat_life', kind: 'discrete', params: [[6, 7, 8], [0.25, 0.5, 0.25]],
    desc: 'Satellite life (yrs): 6/7/8 @ 25/50/25%' },
];

export const CORR_PAIRS: ReadonlyArray<readonly [DriverKey, DriverKey, number, string]> = [
  ['take_t1', 'take_t2', 0.6, 'Common demand factor for D2D.'],
  ['take_t1', 'arpu_t1', -0.3, 'Price elasticity: cheaper plans lift take-up.'],
  ['take_t2', 'arpu_t2', -0.3, 'Price elasticity.'],
  ['unit_cost', 'delay', 0.4, 'Programme stress raises cost and slips schedule together.'],
  ['delay', 'take_t1', -0.2, 'Late network cedes share to Starlink D2C.'],
];

export function corrMatrix(): number[][] {
  const n = DISTS.length;
  const C: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (const [a, b, rho] of CORR_PAIRS) {
    const i = DISTS.findIndex((d) => d.key === a);
    const j = DISTS.findIndex((d) => d.key === b);
    C[i][j] = C[j][i] = rho;
  }
  return C;
}

/** Inverse CDF of each marginal, as scipy defines it (triang.ppf, norm.ppf, searchsorted for discrete). */
export function marginal(u: number, d: Dist): number {
  const p = d.params as readonly number[];
  switch (d.kind) {
    case 'lognormal':
      return p[0] * Math.exp(p[1] * probit(u));
    case 'tri': {
      const [a, m, b] = p;
      const c = (m - a) / (b - a);
      const x = u < c ? Math.sqrt(c * u) : 1 - Math.sqrt((1 - c) * (1 - u));
      return a + (b - a) * x;
    }
    case 'uniform':
      return p[0] + u * (p[1] - p[0]);
    case 'normal':
      return p[0] + p[1] * probit(u);
    case 'discrete': {
      const [vals, pr] = d.params as readonly [readonly number[], readonly number[]];
      // Cumulate by repeated addition, as np.cumsum does: 0.45 + 0.35 is 0.7999999999999999.
      let cum = 0;
      for (let i = 0; i < pr.length; i++) {
        cum += pr[i];
        if (u < cum) return vals[i];
      }
      return vals[vals.length - 1];
    }
  }
}

export type Draw = Partial<Record<DriverKey, number>>;

/** A draw becomes engine overrides exactly as analytics.draw_to_override does. */
export function drawToOverride(x: Draw, baseParams: Params): { overrides: Partial<Params>; delay: number } {
  const overrides: Partial<Params> = {};
  for (const k of ['take_t1', 'take_t2', 'arpu_t1', 'arpu_t2', 'unit_cost', 'cip_credit', 'var_cost', 'wacc_shift', 'g',
    'px_g', 'sat_life'] as const) {
    if (x[k] != null) overrides[k] = x[k] as number;
  }
  if (x.opex_mult != null) {
    overrides.opex_26 = baseParams.opex_26 * x.opex_mult;
    overrides.opex_27 = baseParams.opex_27 * x.opex_mult;
  }
  if (x.gov_mult != null) {
    for (const k of ['gov_26', 'gov_27', 'gov_28', 'gov_29', 'gov_30'] as const) overrides[k] = baseParams[k] * x.gov_mult;
  }
  return { overrides, delay: Math.trunc(x.delay ?? 0) };
}

const baseParamsOf = (inputs: AstsInputs) => runScenario(inputs, BASE).p;

/* ------------------------------------------------------------------ tornado and grids */

export interface TornadoBar {
  key: DriverKey;
  desc: string;
  lo: number;
  vLo: number;
  hi: number;
  vHi: number;
  swing: number;
}

/** Base value per share with each driver at its own P10 and P90, all others as delivered; widest first. */
export function tornado(inputs: AstsInputs, betaHi: number): { base: number; bars: TornadoBar[] } {
  const bp = baseParamsOf(inputs);
  const base = runScenario(inputs, BASE, { betaHi }).vps;
  const bars = DISTS.map((d) => {
    const at = (q: number) => {
      const v = marginal(q, d);
      const { overrides, delay } = drawToOverride({ [d.key]: v }, bp);
      return { v, vps: runScenario(inputs, BASE, { overrides, betaHi, delay }).vps };
    };
    const lo = at(0.1);
    const hi = at(0.9);
    return { key: d.key, desc: d.desc, lo: lo.v, vLo: lo.vps, hi: hi.v, vHi: hi.vps, swing: Math.abs(hi.vps - lo.vps) };
  });
  // Stable sort on descending swing, as Python's list.sort.
  return { base, bars: bars.map((b, i) => [b, i] as const).sort((a, b) => b[0].swing - a[0].swing || a[1] - b[1]).map((x) => x[0]) };
}

export function grid(
  inputs: AstsInputs,
  betaHi: number,
  k1: ParamKey,
  v1: readonly number[],
  k2: ParamKey,
  v2: readonly number[],
  s: ScenarioIndex = BASE,
): number[][] {
  return v1.map((a) => v2.map((b) => runScenario(inputs, s, { overrides: { [k1]: a, [k2]: b }, betaHi }).vps));
}

export const GRID_TAKE_ARPU = {
  k1: 'take_t1', v1: [0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2],
  k2: 'arpu_t1', v2: [3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5],
} as const;
export const GRID_COST_CIP = {
  k1: 'unit_cost', v1: [20, 22, 24, 26, 28],
  k2: 'cip_credit', v2: [0.25, 0.4, 0.5, 0.6, 0.75],
} as const;

/* ------------------------------------------------------------------ the live WACC x g grid, independently derived */

export const SENS_SHIFTS = [-0.02, -0.01, 0, 0.01, 0.02] as const;
export const SENS_G_OFFSETS = [-0.01, -0.005, 0, 0.005, 0.01] as const;

/**
 * One cell of the workbook's live WACC-shift x terminal-g grid, derived the
 * way the workbook derives it: Base FCFF held fixed, discount factors rebuilt
 * with the shifted WACC, a terminal value re-normalised to the cell's g, and
 * the dilution rerun from its own SUMIF-style prefix sums.
 *
 * Deliberately NOT a call to `runScenario` with overrides. The check "grid
 * centre = Calc_Base value" exists to compare two independent derivations of
 * the Base value; computing the grid with the same engine would make it agree
 * with itself by construction and the check would prove nothing.
 */
export function sensitivityCell(inputs: AstsInputs, base: ScenarioRun, shift: number, gCell: number): number {
  const V = inputs.global.val_date;
  const n = base.w.length;
  let comp = 0;
  let ev = 0;
  for (let i = 0; i < n; i++) {
    const w = base.w[i] + shift;
    let df: number;
    if (i === 0) {
      comp = (1 + w) ** (STARTS[0] + LENS[0] - V);
      df = 1 / (1 + w) ** (STARTS[0] + LENS[0] / 2 - V);
    } else {
      df = 1 / (comp * (1 + w) ** (LENS[i] / 2));
      comp *= (1 + w) ** LENS[i];
    }
    ev += base.fcf[i] * df;
  }
  const last = n - 1;
  const wTd = base.wT + shift;
  const e41 = base.ebitda[last] * (1 + gCell);
  const mnt = (base.maint / (1 + base.p.g)) * (1 + gCell);
  const ocx = base.ocx[last] * (1 + gCell);
  const tax = inputs.global.tax_rate * Math.max(0, e41 - mnt - ocx);
  const fcf41 = e41 - tax - mnt - ocx - inputs.global.nwc_pct * base.rev[last] * gCell;
  ev += (fcf41 * (1 + wTd) ** 0.5) / (wTd - gCell) / comp;

  const cs = capitalStructure(inputs);
  const E0 = ev + cs.cash - cs.debt - cs.convFace;
  let eq = E0;
  let sh = cs.S0;
  for (const m of cs.instruments) {
    let d = 0;
    let k = 0;
    for (const o of cs.instruments) if (o.K <= m.K) { d += o.D; k += o.n; }
    if ((E0 + d) / (cs.S0 + k) > m.K) { eq += m.D; sh += m.n; }
  }
  return Math.max(0, eq / sh);
}

export function sensitivityGrid(inputs: AstsInputs, base: ScenarioRun) {
  const gs = SENS_G_OFFSETS.map((o) => inputs.global.g + o);
  return {
    shifts: [...SENS_SHIFTS],
    gs,
    values: SENS_SHIFTS.map((sh) => gs.map((g) => sensitivityCell(inputs, base, sh, g))),
  };
}

/* ------------------------------------------------------------------ reverse DCF */

export interface ReverseDcf {
  price: number;
  /** Base Tier-1 peak take rate that equates Base value to price; null when no rate in [0.1%, 60%] can. */
  take: number | null;
  /** Parallel WACC shift that equates Base value to price. */
  shift: number | null;
  wHi: number | null;
  wT: number | null;
  /** Multiplier on every scenario's Tier-1 take rate for the probability-weighted value to equal price. */
  mult: number | null;
}

function solve(f: (x: number) => number, a: number, b: number): number | null {
  try {
    return brentq(f, a, b);
  } catch (e) {
    if (e instanceof BracketError) return null;
    throw e;
  }
}

export function reverseDcf(inputs: AstsInputs, betaHi: number, price: number): ReverseDcf {
  const take = solve((t) => runScenario(inputs, BASE, { overrides: { take_t1: t }, betaHi }).vps - price, 0.001, 0.6);
  const shift = solve((x) => runScenario(inputs, BASE, { overrides: { wacc_shift: x }, betaHi }).vps - price, -0.04, 0.04);
  const at = shift == null ? null : runScenario(inputs, BASE, { overrides: { wacc_shift: shift }, betaHi });
  const mult = solve((m) => {
    let t = 0;
    for (const s of SCENARIO_INDICES) {
      t += inputs.scenario.prob[s] *
        runScenario(inputs, s, { overrides: { take_t1: inputs.scenario.take_t1[s] * m }, betaHi }).vps;
    }
    return t - price;
  }, 0.2, 5.0);
  return { price, take, shift, wHi: at?.wHi ?? null, wT: at?.wT ?? null, mult };
}

/** Review item A3-03: satellite capex paid one period before launch rather than at it. */
export function capexTimingTest(inputs: AstsInputs, betaHi: number) {
  const r = runScenario(inputs, BASE, { betaHi });
  const net = r.netSC;
  const shifted = [...net.slice(1), net[net.length - 1]];
  const dpv = shifted.reduce((t, x, i) => t - (x - net[i]) * r.df[i], 0);
  const cs = capitalStructure(inputs);
  let eq = r.E0 + dpv;
  let sh = cs.S0;
  const E0 = r.E0 + dpv;
  for (const m of cs.instruments) {
    let d = 0;
    let k = 0;
    for (const o of cs.instruments) if (o.K <= m.K) { d += o.D; k += o.n; }
    if ((E0 + d) / (cs.S0 + k) > m.K) { eq += m.D; sh += m.n; }
  }
  return { base: r.vps, shifted: Math.max(0, eq / sh), dpv };
}

/* ------------------------------------------------------------------ Monte Carlo */

export interface McResult {
  n: number;
  seed: number;
  price: number;
  mean: number;
  se: number;
  pct: Record<5 | 10 | 25 | 50 | 75 | 90 | 95, number>;
  pAbove: number;
  pZero: number;
  meanNonDistress: number;
  /** Paths per $10 bin from $0 to $300; the last bin holds everything at or above $290. */
  hist: number[];
  /** Running mean after the first k paths — the convergence evidence. */
  conv: Array<{ k: number; mean: number }>;
  eigMin: number;
  pDistress: number;
  er3: { p10: number; p50: number; p90: number };
  values: Float64Array;
}

export interface McOptions {
  n?: number;
  seed?: number;
  price: number;
  betaHi?: number;
  /** Paths per slice between yields to the event loop (async only). */
  chunk?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

function* mcPaths(inputs: AstsInputs, n: number, seed: number, betaHi: number) {
  const L = cholesky(corrMatrix());
  const k = DISTS.length;
  const u = makeUniform(seed);
  const bp = baseParamsOf(inputs);
  const pDistress = inputs.scenario.prob[0];
  const vDistress = runScenario(inputs, 0, { betaHi }).vps;
  for (let t = 0; t < n; t++) {
    const z = Array.from({ length: k }, () => probit(u()));
    const draw: Draw = {};
    for (let i = 0; i < k; i++) {
      let zc = 0;
      for (let j = 0; j <= i; j++) zc += L[i][j] * z[j];
      draw[DISTS[i].key] = marginal(normCdf(zc), DISTS[i]);
    }
    if (u() < pDistress) {
      yield { v: vDistress, distress: true };
      continue;
    }
    const { overrides, delay } = drawToOverride(draw, bp);
    yield { v: runScenario(inputs, BASE, { overrides, betaHi, delay }).vps, distress: false };
  }
}

function summarise(inputs: AstsInputs, values: Float64Array, distress: Uint8Array, seed: number, price: number, betaHi: number): McResult {
  const n = values.length;
  const v = Array.from(values);
  const sorted = [...v].sort((a, b) => a - b);
  const m = mean(v);
  const hist = Array(30).fill(0) as number[];
  for (const x of v) hist[Math.min(29, Math.floor(Math.min(x, 300) / 10))]++;
  const conv: McResult['conv'] = [];
  let run = 0;
  const marks = new Set([Math.round(n / 8), Math.round(n / 4), Math.round(n / 2), n]);
  v.forEach((x, i) => {
    run += x;
    if (marks.has(i + 1)) conv.push({ k: i + 1, mean: run / (i + 1) });
  });
  const nd = v.filter((_, i) => !distress[i]);
  const ke = runScenario(inputs, BASE, { betaHi }).keHi;
  const er = v.map((x) => (Math.max(x, 1e-9) * (1 + ke) ** 3 / price) ** (1 / 3) - 1).sort((a, b) => a - b);
  return {
    n, seed, price, mean: m, se: sampleStd(v) / Math.sqrt(n),
    pct: {
      5: percentile(sorted, 5), 10: percentile(sorted, 10), 25: percentile(sorted, 25), 50: percentile(sorted, 50),
      75: percentile(sorted, 75), 90: percentile(sorted, 90), 95: percentile(sorted, 95),
    },
    pAbove: v.filter((x) => x > price).length / n,
    pZero: v.filter((x) => x <= 0.005).length / n,
    meanNonDistress: nd.length ? mean(nd) : Number.NaN,
    hist, conv,
    eigMin: symmetricEigenvalues(corrMatrix())[0],
    pDistress: inputs.scenario.prob[0],
    er3: { p10: percentile(er, 10), p50: percentile(er, 50), p90: percentile(er, 90) },
    values,
  };
}

const DEFAULT_SEED = 20260910; // the analyst's seed; the stream differs, the intent does not

export function monteCarloSync(inputs: AstsInputs, opts: McOptions): McResult {
  const n = opts.n ?? 20000;
  const seed = opts.seed ?? DEFAULT_SEED;
  const betaHi = opts.betaHi ?? snapshotStats(inputs).betaAdj;
  const values = new Float64Array(n);
  const distress = new Uint8Array(n);
  let i = 0;
  for (const p of mcPaths(inputs, n, seed, betaHi)) {
    values[i] = p.v;
    distress[i++] = p.distress ? 1 : 0;
  }
  return summarise(inputs, values, distress, seed, opts.price, betaHi);
}

/** The same simulation, yielding to the event loop so a page stays responsive while 20,000 paths run. */
export async function monteCarlo(inputs: AstsInputs, opts: McOptions): Promise<McResult> {
  const n = opts.n ?? 20000;
  const seed = opts.seed ?? DEFAULT_SEED;
  const chunk = opts.chunk ?? 1000;
  const betaHi = opts.betaHi ?? snapshotStats(inputs).betaAdj;
  const values = new Float64Array(n);
  const distress = new Uint8Array(n);
  let i = 0;
  for (const p of mcPaths(inputs, n, seed, betaHi)) {
    values[i] = p.v;
    distress[i++] = p.distress ? 1 : 0;
    if (i % chunk === 0) {
      opts.onProgress?.(i, n);
      await new Promise((r) => setTimeout(r, 0));
      if (opts.signal?.aborted) throw new DOMException('Monte Carlo cancelled', 'AbortError');
    }
  }
  opts.onProgress?.(n, n);
  return summarise(inputs, values, distress, seed, opts.price, betaHi);
}
