/**
 * The headline: what the model says against what the market pays.
 *
 * Reproduces the workbook's Valuation_Summary and Risk derivations — upside,
 * model-implied expected return, the Sharpe proxy, market-implied EV — at any
 * price, so the page can show them against today's quote while the tests hold
 * them to the workbook at the delivered $62.42.
 *
 * Expected return follows the workbook: E[R] = (V (1+Ke)^H / P)^(1/H) − 1, the
 * annual return if the price converges to value over H years while value itself
 * accretes at the cost of equity. It is the model's answer to "what does this
 * stock earn from here if the model is right", which is the only sense in which
 * a DCF produces an expected return. A value at or below zero returns −100%.
 */
import { SCENARIO_INDICES, YEARS, type AstsInputs } from './inputs';
import type { MarketStats, ModelRun } from './engine';

export function expectedReturn(value: number, price: number, ke: number, years: number): number {
  if (value <= 0) return -1;
  return ((value * (1 + ke) ** years) / price) ** (1 / years) - 1;
}

export interface Headline {
  price: number;
  pw: number;
  pwUpside: number;
  ke: number;
  er3: number;
  er5: number;
  /** (E[R] 3-yr − Rf) / volatility — the workbook's "model-implied Sharpe". */
  sharpe3: number;
  mktCap: number;
  mktEv: number;
  baseEvOverMkt: number;
  scenarios: Array<{
    vps: number;
    upside: number;
    ev: number;
    evRev: Record<number, number | null>;
    evEbitda: Record<number, number | null>;
  }>;
  /** Market-implied EV over each scenario's revenue and EBITDA in the same years. */
  mktEvRev: Array<Record<number, number | null>>;
  mktEvEbitda: Array<Record<number, number | null>>;
}

/** Forward years for the implied multiples: first full year of service, the build-out's end, and 2030. */
export const MULTIPLE_YEARS = [2027, 2028, 2030] as const;

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

export function headline(inputs: AstsInputs, model: ModelRun, price: number, market: MarketStats): Headline {
  const base = model.runs[2];
  const ke = base.keHi;
  const er3 = expectedReturn(model.pw, price, ke, 3);
  const mktCap = price * base.S0;
  const mktEv = mktCap + base.debt + base.convFace - base.cash;
  const at = (arr: number[], y: number) => arr[YEARS.indexOf(y)];
  const multiples = (ev: number, s: number) => {
    const r = model.runs[s];
    return {
      rev: Object.fromEntries(MULTIPLE_YEARS.map((y) => [y, ratio(ev, at(r.rev, y))])),
      ebitda: Object.fromEntries(MULTIPLE_YEARS.map((y) => [y, ratio(ev, at(r.ebitda, y))])),
    };
  };
  return {
    price,
    pw: model.pw,
    pwUpside: model.pw / price - 1,
    ke,
    er3,
    er5: expectedReturn(model.pw, price, ke, 5),
    sharpe3: (er3 - inputs.global.rf) / market.vol,
    mktCap,
    mktEv,
    baseEvOverMkt: base.ev / mktEv,
    scenarios: SCENARIO_INDICES.map((s) => {
      const r = model.runs[s];
      const m = multiples(r.ev, s);
      return { vps: r.vps, upside: r.vps / price - 1, ev: r.ev, evRev: m.rev, evEbitda: m.ebitda };
    }),
    mktEvRev: SCENARIO_INDICES.map((s) => multiples(mktEv, s).rev),
    mktEvEbitda: SCENARIO_INDICES.map((s) => multiples(mktEv, s).ebitda),
  };
}
