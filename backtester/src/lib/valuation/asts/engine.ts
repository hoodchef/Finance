/**
 * The ASTS valuation engine.
 *
 * A line-for-line port of `reference/asts/engine.py`, which the analyst wrote
 * independently of the workbook's formulas and audited against them to 1e-14.
 * `tests/valuation-asts-engine.test.ts` holds this file to that engine at every
 * row, every period and every scenario — at the delivered inputs, at 33 cases
 * built so that each branch binds, and at 20 random perturbations.
 *
 * The result also carries the rows the WORKBOOK computes and the Python engine
 * does not (revenue growth, users per satellite, cumulative FCFF, the terminal
 * multiple, ...), each computed the way the workbook's formula does, because
 * the checks and the page are built on them. Those are held to the workbook's
 * cached values.
 *
 * Arrays are indexed by period: 0 = 2026H2 (half year), 1..14 = 2027..2040.
 * Money is $ millions; shares are millions; value per share is dollars.
 *
 * One deliberate departure: satellite life is rounded half-away-from-zero, as
 * the workbook's ROUND does, where the Python engine's round() is banker's
 * rounding. The two agree for every integer life; the page only accepts
 * integers, because retirements are indexed by whole cohort years.
 */
import {
  LENS,
  NP,
  SCENARIO_INDICES,
  SCENARIO_ROWS,
  STARTS,
  YEARS,
  type AstsInputs,
  type ParamKey,
  type ScenarioIndex,
} from './inputs';
import { SNAPSHOT_ASTS, SNAPSHOT_SPY } from './market-snapshot';
import { mean, percentile, sampleStd } from '../numeric';

export type Params = Record<ParamKey, number>;

export function scenarioParams(inputs: AstsInputs, s: ScenarioIndex): Params {
  const p = { ...inputs.global } as Params;
  for (const row of SCENARIO_ROWS) p[row.key] = inputs.scenario[row.key][s];
  return p;
}

/* ------------------------------------------------------------------ market statistics */

export interface MarketStats {
  price: number;
  /** Full-week returns in the regression (the partial final week is dropped). */
  n: number;
  betaRaw: number;
  betaSe: number;
  betaT: number;
  r2: number;
  betaAdj: number;
  vol: number;
  benchVol: number;
  idioVol: number;
  maxDrawdown: number;
  var95: number;
  cvar95: number;
  pvar95: number;
  downsideDev: number;
  high: number;
  low: number;
}

/**
 * Every statistic on the workbook's Market_Data sheet, from weekly closes.
 *
 * The final bar is a partial week: it is the price, but its return is excluded
 * from the regression and every return statistic (R-02). Drawdown, high and low
 * use every bar including the last, as the workbook's ranges do.
 */
export function marketStats(closes: readonly number[], bench: readonly number[], blumeW: number): MarketStats {
  const ra: number[] = [];
  const rs: number[] = [];
  for (let i = 1; i < closes.length - 1; i++) {
    ra.push(closes[i] / closes[i - 1] - 1);
    rs.push(bench[i] / bench[i - 1] - 1);
  }
  const n = ra.length;
  const ma = mean(ra);
  const ms = mean(rs);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (rs[i] - ms) ** 2;
    syy += (ra[i] - ma) ** 2;
    sxy += (rs[i] - ms) * (ra[i] - ma);
  }
  const betaRaw = sxy / sxx;
  const steyx = Math.sqrt((syy - (sxy * sxy) / sxx) / (n - 2));
  const betaSe = steyx / Math.sqrt(sxx);
  const r2 = (sxy * sxy) / (sxx * syy);
  const vol = sampleStd(ra) * Math.sqrt(52);
  let peak = -Infinity;
  let mdd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    mdd = Math.min(mdd, c / peak - 1);
  }
  const sorted = [...ra].sort((a, b) => a - b);
  const var95 = percentile(sorted, 5);
  const tail = ra.filter((x) => x <= var95);
  let down = 0;
  for (const x of ra) if (x < 0) down += x * x;
  return {
    price: closes[closes.length - 1],
    n,
    betaRaw,
    betaSe,
    betaT: betaRaw / betaSe,
    r2,
    betaAdj: blumeW * betaRaw + (1 - blumeW),
    vol,
    benchVol: sampleStd(rs) * Math.sqrt(52),
    idioVol: vol * Math.sqrt(1 - r2),
    maxDrawdown: mdd,
    var95,
    cvar95: mean(tail),
    pvar95: ma - 1.645 * sampleStd(ra),
    downsideDev: Math.sqrt(down / n) * Math.sqrt(52),
    high: Math.max(...closes),
    low: Math.min(...closes),
  };
}

export function snapshotStats(inputs: AstsInputs): MarketStats {
  return marketStats(SNAPSHOT_ASTS, SNAPSHOT_SPY, inputs.global.blume_w);
}

/* ------------------------------------------------------------------ capital structure */

export interface Instrument {
  label: string;
  kind: 'convert' | 'option' | 'rsu';
  /** Trigger: converts iff value per share (with every lower trigger converted) exceeds K. */
  K: number;
  /** Shares issued on conversion, millions. */
  n: number;
  /** Value added to equity on conversion, $mm: face (plain convert), n × cap (capped call), n × strike (option). */
  D: number;
}

export interface CapitalStructure {
  S0: number;
  cash: number;
  debt: number;
  convFace: number;
  instruments: Instrument[];
}

export function capitalStructure(inputs: AstsInputs): CapitalStructure {
  const instruments: Instrument[] = [];
  for (const c of inputs.converts) {
    const n = c.face / c.convPrice;
    const K = c.cap > 0 ? c.cap : c.convPrice;
    instruments.push({ label: c.label, kind: 'convert', K, n, D: n * K });
  }
  for (const a of inputs.awards) {
    const n = a.count / 1e6;
    instruments.push({ label: a.label, kind: a.strike > 0 ? 'option' : 'rsu', K: a.strike, n, D: n * a.strike });
  }
  return {
    S0: inputs.shares.reduce((t, r) => t + r.count, 0) / 1e6,
    cash: inputs.cash.reduce((t, r) => t + (r.include === 1 ? r.amount : 0), 0),
    debt: inputs.debt.reduce((t, r) => t + r.face, 0),
    convFace: inputs.converts.reduce((t, r) => t + r.face, 0),
    instruments,
  };
}

export interface PerShare {
  vps: number;
  equity: number;
  shares: number;
  converts: boolean[];
  /** Per instrument: value per share if it and every instrument with K ≤ its K converted. */
  prefixValue: number[];
}

/**
 * The value-consistent dilution engine (review item R-07).
 *
 * Instrument i converts iff the value per share — computed as if it and every
 * instrument with a trigger at or below its own converted — exceeds its
 * trigger. That is order-independent and needs no circular reference; the
 * analyst proved it and 12 break tests confirmed it. Value is floored at zero:
 * equity is a limited-liability claim (A2-01).
 */
export function perShare(E0: number, S0: number, instruments: readonly Instrument[]): PerShare {
  const prefixValue: number[] = [];
  const converts: boolean[] = [];
  for (const inst of instruments) {
    let D = 0;
    let n = 0;
    for (const o of instruments) {
      if (o.K <= inst.K) {
        D += o.D;
        n += o.n;
      }
    }
    const v = (E0 + D) / (S0 + n);
    prefixValue.push(v);
    converts.push(v > inst.K);
  }
  let equity = E0;
  let shares = S0;
  instruments.forEach((o, i) => {
    if (converts[i]) {
      equity += o.D;
      shares += o.n;
    }
  });
  return { vps: Math.max(0, equity / shares), equity, shares, converts, prefixValue };
}

/* ------------------------------------------------------------------ the run */

export interface RunOptions {
  /** Parameter overrides applied on top of the scenario's inputs (the Monte Carlo and tornado use these). */
  overrides?: Partial<Params>;
  /** Growth-phase beta. Defaults to the Blume-adjusted beta of the delivered IBKR snapshot. */
  betaHi?: number;
  /** Shift of the whole deployment and service timeline, in years. */
  delay?: number;
}

export interface ScenarioRun {
  s: ScenarioIndex;
  p: Params;
  delay: number;
  betaHi: number;
  life: number;
  // constellation
  F: number[]; B: number[]; E: number[]; N: number[]; R: number[]; G: number[]; A: number[]; U: number[];
  SC: number[]; C: number[]; netSC: number[]; pool: number;
  // revenue
  cov1: number[]; cov2: number[]; k: number; ad1: number[]; ad2: number[]; base: number[];
  subs1: number[]; subs2: number[]; pxf: number[]; rev1: number[]; rev2: number[]; gov: number[]; prod: number[];
  rev: number[]; growth: number[]; subsPerSat: number[];
  // costs
  cogs: number[]; var: number[]; lig: number[]; spec: number[]; opex: number[]; netx: number[]; sbc: number[];
  costs: number[]; ebitda: number[]; margin: number[];
  // capex and other
  ocx: number[]; ligpay: number[]; jleo: number[];
  // tax
  capexTax: number[]; tdep: number[]; samort: number[]; ti: number[];
  nolB: number[]; nolU: number[]; nolE: number[]; tax: number[];
  // FCFF
  ann: number[]; dnwc: number[]; cl: number[]; fcf: number[]; cumFcf: number[];
  // discounting
  w: number[]; comp: number[]; df: number[]; pv: number[];
  keHi: number; wHi: number; keT: number; wT: number;
  // terminal
  e41: number; maint: number; ocx41: number; tax41: number; dnwc41: number; fcf41: number;
  tv: number; pvTv: number; pvExplicit: number; ev: number; tvPct: number; tvMult: number | null;
  // bridge
  cash: number; debt: number; convFace: number; E0: number; S0: number;
  instruments: Instrument[]; dilution: PerShare; Ef: number; Sf: number; vps: number;
  // diagnostics (workbook column C)
  fy26: number; minFcf: number; maxSubsPerSat: number; cagr: number; m40: number; rev30: number; rev35: number;
}

const zeros = () => Array(NP).fill(0) as number[];

export function runScenario(inputs: AstsInputs, s: ScenarioIndex, opts: RunOptions = {}): ScenarioRun {
  const p = { ...scenarioParams(inputs, s), ...(opts.overrides ?? {}) } as Params;
  const betaHi = opts.betaHi ?? snapshotStats(inputs).betaAdj;
  const delay = opts.delay ?? 0;
  const Y = YEARS;
  const L = LENS;
  const ST = STARTS;
  const M = ST.map((st, i) => st + L[i] / 2);
  const life = Math.round(p.sat_life);

  /* ---- fleet: targets drive launches; cohorts retire at end of design life */
  const tgt = (y: number) => {
    const yy = y - delay;
    if (yy < 2026) return p.fleet_open;
    switch (Math.trunc(yy)) {
      case 2026: return p.fl_26;
      case 2027: return p.fl_27;
      case 2028: return p.fl_28;
      case 2029: return p.fl_29;
      default: return p.fl_ss;
    }
  };
  const F = Y.map(tgt);
  const B = zeros(); const E = zeros(); const N = zeros(); const R = zeros();
  for (let i = 0; i < NP; i++) {
    B[i] = i === 0 ? p.fleet_open : E[i - 1];
    const yr = Y[i] - life;
    let r = 0;
    if (yr === 2026) r = N[0] + p.fleet_open;
    else if (yr >= 2027) r = N[Math.trunc(yr - 2026)];
    R[i] = r;
    N[i] = Math.max(0, F[i] - B[i] + R[i]);
    E[i] = B[i] - R[i] + N[i];
  }
  const G = N.map((x) => x / (1 - p.loss_rate));
  const A = B.map((b, i) => (b + E[i]) / 2);
  const U = Y.map((y) => p.unit_cost * (1 + p.unit_infl) ** Math.max(0, y - 2028));
  const SC = G.map((g, i) => g * U[i]);
  const pool = p.cip_sat * p.cip_credit;
  const C = zeros();
  let used = 0;
  for (let i = 0; i < NP; i++) {
    C[i] = Math.min(SC[i], pool - used);
    used += C[i];
  }

  /* ---- revenue: partner base x coverage(fleet) x logistic adoption x ARPU */
  const cover = (s0: number, sf: number) => A.map((a) => Math.min(1, Math.max(0, (a - s0) / (sf - s0))));
  const cov1 = cover(p.s0_t1, p.sf_t1);
  const cov2 = cover(p.s0_t2, p.sf_t2);
  const k = (2 * Math.log(19)) / p.ramp;
  const adopt = (start: number, peak: number) => {
    const y0 = start + delay;
    return M.map((m) => (m >= y0 ? peak / (1 + Math.exp(-k * (m - (y0 + p.ramp / 2)))) : 0));
  };
  const ad1 = adopt(p.t1_start, p.take_t1);
  const ad2 = adopt(p.t2_start, p.take_t2);
  const baseG = Y.map((y) => (1 + p.sub_g) ** Math.max(0, y - 2026));
  const base = baseG.map((b) => p.partner_subs * b);
  const subs1 = baseG.map((b, i) => p.partner_subs * b * p.t1_share * cov1[i] * ad1[i]);
  const subs2 = baseG.map((b, i) => p.partner_subs * b * (1 - p.t1_share) * cov2[i] * ad2[i]);
  const pxf = Y.map(
    (y) =>
      (1 + p.px_g) ** Math.min(Math.max(y - 2027, 0), p.px_end - 2027) *
      (1 + p.arpu_lr_g) ** Math.max(0, y - p.px_end),
  );
  const rev1 = subs1.map((x, i) => x * p.arpu_t1 * pxf[i] * 12 * L[i]);
  const rev2 = subs2.map((x, i) => x * p.arpu_t2 * pxf[i] * 12 * L[i]);
  const gov = Y.map((y) => {
    switch (y) {
      case 2026: return p.gov_26;
      case 2027: return p.gov_27;
      case 2028: return p.gov_28;
      case 2029: return p.gov_29;
      case 2030: return p.gov_30;
      default: return p.gov_30 * (1 + p.gov_g) ** (y - 2030);
    }
  });
  const prod = Y.map((y) => (y === 2026 ? p.prod_26 : y === 2027 ? p.prod_27 : y === 2028 ? p.prod_28 : p.prod_ss));
  const rev = rev1.map((r1, i) => r1 + rev2[i] + gov[i] + prod[i]);

  /* ---- operating costs */
  const cogs = prod.map((x, i) => x * (1 - p.prod_margin) + gov[i] * p.gov_cogs);
  const vc = rev1.map((r1, i) => (r1 + rev2[i]) * p.var_cost);
  const lig = rev1.map((r1) => r1 * p.ligado_share);
  const spec = Y.map((y, i) => (y >= p.ligado_year ? p.spec_fee * L[i] : 0));
  const opex = zeros();
  for (let i = 0; i < NP; i++) {
    const y = Y[i];
    if (y === 2026) opex[i] = p.opex_26;
    else if (y === 2027) opex[i] = p.opex_27;
    else if (y === 2028) opex[i] = opex[i - 1] * (1 + p.opex_g28);
    else if (y === 2029) opex[i] = opex[i - 1] * (1 + p.opex_g29);
    else if (y === 2030) opex[i] = opex[i - 1] * (1 + p.opex_g30);
    else opex[i] = opex[i - 1] * (1 + p.opex_gss);
  }
  const sbc = Y.map((y, i) =>
    y === 2026 ? p.sbc_26 : Math.max(p.sbc_27 * (1 - p.sbc_decay) ** Math.max(0, y - 2027), p.sbc_floor * rev[i]),
  );
  const netx = A.map((a, i) => a * p.net_opex_sat * L[i]);
  const ebitda = rev.map((r, i) => r - cogs[i] - vc[i] - lig[i] - spec[i] - opex[i] - netx[i] - sbc[i]);

  /* ---- capex and other investing items */
  const ocx = Y.map((y, i) => {
    if (y >= 2029) return Math.max(p.ocx_floor, p.ocx_pct * rev[i]);
    return y === 2026 ? p.ocx_26 : y === 2027 ? p.ocx_27 : y === 2028 ? p.ocx_28 : 0;
  });
  const ligpay = Y.map((y) => (y === p.ligado_year ? p.ligado_pay : 0));
  const jleo = Y.map((y) => (y === 2028 ? p.jleo : 0));

  /* ---- cash tax: NOL pool with the 80% cap; bonus or straight-line depreciation */
  const capexTax = SC.map((x, i) => x + ocx[i]);
  const tdep =
    p.bonus_dep === 1
      ? [...capexTax]
      : Y.map((y, i) => {
          let sum = 0;
          for (let j = 0; j < NP; j++) if (Y[j] > y - life && Y[j] <= y) sum += capexTax[j];
          return (sum / life) * L[i];
        });
  const samort = Y.map((y, i) =>
    y >= p.ligado_year && y < p.ligado_year + 15 ? (p.ligado_pay / 15) * L[i] : 0,
  );
  const ti = ebitda.map((e, i) => e - tdep[i] - samort[i]);
  const nolB = zeros(); const nolU = zeros(); const nolE = zeros(); const tax = zeros();
  for (let i = 0; i < NP; i++) {
    nolB[i] = i === 0 ? p.nol_open : nolE[i - 1];
    nolU[i] = Math.min(nolB[i], Math.max(0, ti[i]) * p.nol_limit);
    nolE[i] = nolB[i] - nolU[i] + Math.max(0, -ti[i]);
    tax[i] = p.tax_rate * Math.max(0, ti[i] - nolU[i]);
  }

  /* ---- free cash flow to the firm */
  const ann = rev.map((r, i) => r / L[i]);
  const dnwc = ann.map((a, i) => p.nwc_pct * (a - (i === 0 ? p.h1_ann_rev : ann[i - 1])));
  const cl = Y.map((y, i) =>
    y >= p.cl_unwind_start && y < p.cl_unwind_start + p.cl_unwind_yrs ? (p.contract_liab / p.cl_unwind_yrs) * L[i] : 0,
  );
  const netSC = SC.map((x, i) => x - C[i]);
  const fcf = ebitda.map((e, i) => e - tax[i] - netSC[i] - ocx[i] - ligpay[i] + jleo[i] - dnwc[i] - cl[i]);

  /* ---- discounting: mid-period, from the valuation date, growth WACC fading to mature */
  const keHi = p.rf + betaHi * p.erp;
  const keT = p.rf + p.beta_term * p.erp;
  const wHi = (1 - p.dv_hi) * keHi + p.dv_hi * p.kd_hi * (1 - p.t_hi) + p.wacc_shift;
  const wT = (1 - p.dv_term) * keT + p.dv_term * p.kd_term * (1 - p.t_term) + p.wacc_shift;
  const fs = p.wacc_fade_start;
  const fe = p.wacc_fade_end;
  const w = Y.map((y) => (y < fs ? wHi : y >= fe ? wT : wHi + ((wT - wHi) * (y - fs + 1)) / (fe - fs + 1)));
  const V = p.val_date;
  const comp = zeros();
  const df = zeros();
  for (let i = 0; i < NP; i++) {
    if (i === 0) {
      comp[0] = (1 + w[0]) ** (ST[0] + L[0] - V);
      df[0] = 1 / (1 + w[0]) ** (M[0] - V);
    } else {
      comp[i] = comp[i - 1] * (1 + w[i]) ** L[i];
      df[i] = 1 / (comp[i - 1] * (1 + w[i]) ** (L[i] / 2));
    }
  }
  const pv = fcf.map((x, i) => x * df[i]);

  /* ---- terminal value: Gordon growth on a normalised 2041, steady-state replacement capex (A2-03) */
  const last = NP - 1;
  const g = p.g;
  const e41 = ebitda[last] * (1 + g);
  const maint = (p.fl_ss / life / (1 - p.loss_rate)) * U[last] * (1 + g);
  const ocx41 = ocx[last] * (1 + g);
  const tax41 = p.tax_rate * Math.max(0, e41 - maint - ocx41);
  const dnwc41 = p.nwc_pct * rev[last] * g;
  const fcf41 = e41 - tax41 - maint - ocx41 - dnwc41;
  const tv = (fcf41 * (1 + wT) ** 0.5) / (wT - g);
  const pvTv = tv / comp[last];
  const pvExplicit = pv.reduce((t, x) => t + x, 0);
  const ev = pvExplicit + pvTv;

  /* ---- equity bridge and dilution */
  const cs = capitalStructure(inputs);
  const E0 = ev + cs.cash - cs.debt - cs.convFace;
  const dilution = perShare(E0, cs.S0, cs.instruments);

  /* ---- workbook-only rows, computed the way the workbook's formulas are */
  const growth = rev.map((r, i) => {
    if (i === 0) return p.h1_rev === 0 ? 0 : r / L[0] / (p.h1_rev / 0.5) - 1;
    return rev[i - 1] === 0 ? 0 : r / L[i] / (rev[i - 1] / L[i - 1]) - 1;
  });
  const subsPerSat = A.map((a, i) => (a === 0 ? 0 : (subs1[i] + subs2[i]) / a));
  const costs = cogs.map((c, i) => c + vc[i] + lig[i] + spec[i] + opex[i] + netx[i] + sbc[i]);
  const margin = rev.map((r, i) => (r === 0 ? 0 : ebitda[i] / r));
  const cumFcf: number[] = [];
  fcf.reduce((t, x) => (cumFcf.push(t + x), t + x), 0);
  const i2036 = YEARS.indexOf(2036);

  return {
    s, p, delay, betaHi, life,
    F, B, E, N, R, G, A, U, SC, C, netSC, pool,
    cov1, cov2, k, ad1, ad2, base, subs1, subs2, pxf, rev1, rev2, gov, prod, rev, growth, subsPerSat,
    cogs, var: vc, lig, spec, opex, netx, sbc, costs, ebitda, margin,
    ocx, ligpay, jleo,
    capexTax, tdep, samort, ti, nolB, nolU, nolE, tax,
    ann, dnwc, cl, fcf, cumFcf,
    w, comp, df, pv, keHi, wHi, keT, wT,
    e41, maint, ocx41, tax41, dnwc41, fcf41, tv, pvTv, pvExplicit, ev,
    tvPct: ev <= 0 ? 0 : pvTv / ev,
    tvMult: e41 <= 0 ? null : tv / e41,
    cash: cs.cash, debt: cs.debt, convFace: cs.convFace, E0, S0: cs.S0,
    instruments: cs.instruments, dilution, Ef: dilution.equity, Sf: dilution.shares, vps: dilution.vps,
    fy26: p.h1_rev + rev[0],
    minFcf: Math.min(...cumFcf),
    maxSubsPerSat: Math.max(...subsPerSat),
    cagr: rev[i2036] <= 0 ? 0 : (rev[last] / rev[i2036]) ** (1 / 4) - 1,
    m40: margin[last],
    rev30: rev[YEARS.indexOf(2030)],
    rev35: rev[YEARS.indexOf(2035)],
  };
}

export interface ModelRun {
  runs: [ScenarioRun, ScenarioRun, ScenarioRun, ScenarioRun];
  probs: [number, number, number, number];
  /** Probability-weighted value per share. Only floored per-share values are weighted (A3-11). */
  pw: number;
}

export function runModel(inputs: AstsInputs, opts: RunOptions = {}): ModelRun {
  const runs = SCENARIO_INDICES.map((s) => runScenario(inputs, s, opts)) as ModelRun['runs'];
  const probs = [...inputs.scenario.prob] as ModelRun['probs'];
  return { runs, probs, pw: runs.reduce((t, r, i) => t + probs[i] * r.vps, 0) };
}
