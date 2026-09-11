/**
 * The workbook's Checks sheet, live.
 *
 * Forty-four checks, each with the label, value and pass rule of the workbook
 * formula it ports, in the workbook's order. They answer two different
 * questions and the page keeps them apart: whether the MACHINERY is sound
 * (discount factors decreasing, NOL pool non-negative, dilution consistent) and
 * whether the ASSUMPTIONS are plausible (margin within the Iridium-anchored
 * band, users per satellite within capacity, FY26 within guidance). A failed
 * plausibility check is information about the inputs; a failed mechanical
 * check means the output should not be used.
 *
 * `tests/valuation-asts-analytics.test.ts` holds every value to the workbook's
 * cached value and confirms that the checks the analyst's break suite expected
 * to fire do fire — an untested check proves nothing (review item A3-04).
 */
import { SCENARIOS, type AstsInputs, type ScenarioIndex } from './inputs';
import type { MarketStats, ModelRun } from './engine';

export type CheckKind = 'mechanics' | 'plausibility' | 'reconciliation';

export interface Check {
  id: number;
  label: string;
  value: number | null;
  pass: boolean;
  why: string;
  kind: CheckKind;
  scenario: ScenarioIndex | null;
}

export interface CheckReport {
  checks: Check[];
  failed: number;
  /** The workbook's overall status string: "ALL PASS" or "n FAIL". */
  status: string;
}

/** Pro forma cash as the company defines "over $3.7bn": every restricted balance counts, the receivable does not. */
export function proFormaCash(inputs: AstsInputs): number {
  let t = 0;
  for (const r of inputs.cash) {
    if (r.role === 'restricted-current') t += r.amount;
    else if (r.role !== 'receivable') t += r.include === 1 ? r.amount : 0;
  }
  return t;
}

/** Debt face as at the 10-Q balance sheet: excludes notes issued after it. */
export function balanceSheetDebt(inputs: AstsInputs): number {
  const debt = inputs.debt.reduce((t, r) => t + r.face, 0);
  const conv = inputs.converts.reduce((t, r) => t + r.face, 0);
  const post = inputs.converts.filter((c) => c.postBalanceSheet).reduce((t, r) => t + r.face, 0);
  return debt + conv - post;
}

export function runChecks(
  inputs: AstsInputs,
  model: ModelRun,
  market: MarketStats,
  sensitivityCentre: number,
): CheckReport {
  const G = inputs.global;
  const base = model.runs[2];
  const checks: Check[] = [];
  const add = (
    label: string,
    value: number | null,
    pass: boolean,
    why: string,
    kind: CheckKind,
    scenario: ScenarioIndex | null = null,
  ) => checks.push({ id: checks.length + 1, label, value, pass, why, kind, scenario });

  const probSum = inputs.scenario.prob.reduce((t, x) => t + x, 0);
  add('Scenario probabilities sum to 100%', probSum, Math.abs(probSum - 1) < 0.0001,
    'Weights must be a probability distribution.', 'mechanics');
  add('Terminal g below risk-free rate', G.g - G.rf, G.g - G.rf < 0,
    'g > Rf implies firm outgrows economy forever.', 'plausibility');
  add('Terminal WACC exceeds g by >= 3pp', base.wT - G.g, base.wT - G.g >= 0.03,
    'Gordon model explodes as WACC -> g.', 'mechanics');
  add('WACC what-if lever is zero', G.wacc_shift, G.wacc_shift === 0,
    'Delivered valuation must not carry a manual shift.', 'reconciliation');
  const pf = proFormaCash(inputs);
  add("Pro forma cash within 3% of company's 'over $3.7bn'", pf, pf >= 3700 && pf <= 3700 * 1.03,
    'Reconciles bridge to company disclosure.', 'reconciliation');
  const debt = balanceSheetDebt(inputs);
  add('Debt schedule ties to 10-Q total face $3,022.152mm', debt, Math.abs(debt - 3022.152) < 0.01,
    'Catches omitted or double-counted debt.', 'reconciliation');
  add('Share count ties to 10-Q cover (389.168mm)', base.S0, Math.abs(base.S0 - 389.167494) < 0.001,
    'Up-C share classes all included.', 'reconciliation');
  const sens = sensitivityCentre - base.vps;
  add('Sensitivity grid centre = Calc_Base value', sens, Math.abs(sens) < 0.005,
    'Independent re-derivation of Base value.', 'mechanics');

  model.runs.forEach((r, i) => {
    const s = i as ScenarioIndex;
    const name = SCENARIOS[s];
    let rising = 0;
    for (let t = 1; t < r.df.length; t++) if (r.df[t] >= r.df[t - 1]) rising++;
    add(`${name}: discount factors strictly decreasing`, rising, rising === 0,
      'Detects broken discounting / negative WACC.', 'mechanics', s);
    const minFleet = Math.min(...r.E);
    add(`${name}: fleet never negative`, minFleet, minFleet >= 0, 'Fleet mechanics.', 'mechanics', s);
    const minNol = Math.min(...r.nolE);
    add(`${name}: NOL pool never negative`, minNol, minNol >= -0.001, 'Tax mechanics.', 'mechanics', s);
    const cip = r.C.reduce((t, x) => t + x, 0) - r.pool;
    add(`${name}: CIP credit used <= pool`, cip, cip <= 0.001, 'No double use of prepaid capex.', 'mechanics', s);
    add(`${name}: EBITDA margin 2040 within 40-75% (or scenario is Distress)`, r.m40,
      (r.m40 >= 0.4 && r.m40 <= 0.75) || s === 0, 'Benchmark: Iridium 56.8% (FY25).', 'plausibility', s);
    const cagr = r.cagr - G.g;
    add(`${name}: revenue CAGR 2036-40 within g +/- 1.5pp (or Distress)`, cagr, Math.abs(cagr) <= 0.015 || s === 0,
      'Explicit period must be consistent with terminal growth (A3-01).', 'plausibility', s);
    add(`${name}: paying users per satellite <= 2.5mm`, r.maxSubsPerSat, r.maxSubsPerSat <= 2.5,
      'Capacity plausibility (A2-04).', 'plausibility', s);
    const bad = r.instruments.filter((o, k) => r.dilution.converts[k] && o.K >= r.vps + 0.000001).length;
    add(`${name}: converted instruments all have K < value per share`, bad, bad === 0,
      'Dilution engine is value-consistent.', 'mechanics', s);
  });

  add('Base FY2026 revenue within guidance ($150-200mm)', base.fy26,
    base.fy26 >= G.guide_lo && base.fy26 <= G.guide_hi, 'Near-term anchor to management guidance.', 'plausibility');
  const v = model.runs.map((r) => r.vps);
  add('Scenario ordering: Distress <= Bear <= Base <= Bull', v[3] - v[0], v[0] <= v[1] && v[1] <= v[2] && v[2] <= v[3],
    'Monotonic scenarios; catches broken scenario wiring.', 'mechanics');
  // The workbook compares the text "n/m" with numbers, which fails AND(>=5, <=15). Same verdict here.
  add('Base implied terminal EV/EBITDA within 5-15x', base.tvMult,
    base.tvMult != null && base.tvMult >= 5 && base.tvMult <= 15, 'Cross-check Gordon TV vs trading multiples.',
    'plausibility');
  add('Beta regression uses >= 100 weekly observations', market.n, market.n >= 100, 'Statistical adequacy.',
    'mechanics');

  const failed = checks.filter((c) => !c.pass).length;
  return { checks, failed, status: failed === 0 ? 'ALL PASS' : `${failed} FAIL` };
}
