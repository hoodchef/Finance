/**
 * Funding: the model's stated gap, made explicit.
 *
 * The delivered model values the firm on FCFF and assumes every shortfall is
 * funded at fair value. Its own Notes list what that leaves out — "raising
 * below intrinsic value would dilute further (see Risk funding gap)" — and its
 * Risk sheet measures the gap but stops there. This module finishes the
 * thought, in two views that are deliberately kept apart:
 *
 * 1. VALUE — the financing-adjusted value per share. The FCFF shortfall the
 *    Risk sheet measures (cumulative FCFF against available liquidity) is
 *    raised as new equity at an issue price the reader sets. New holders pay
 *    PV(X) and receive PV(X) / P shares; today's holders keep the rest. The
 *    issue price is in today's dollars, i.e. the share price is taken to
 *    accrete at the discount rate until the raise — the neutral convention.
 *
 *    Raised at the model's own value, this reproduces the model's value
 *    exactly: (E0 + X) / (S + X/V) = V when V = E0/S, and conversions are
 *    undisturbed because every prefix value moves toward V. The delivered
 *    model is the special case "raised at fair value", and the tests hold the
 *    module to that. Below V it dilutes; ABOVE V it is accretive — if the
 *    market pays more than the model thinks the stock is worth, selling it to
 *    them helps the holders who stay. Both directions are reported.
 *
 *    Debt service stays where the model puts it: in the equity bridge, at
 *    face. Counting coupons here as well would charge them twice.
 *
 * 2. CASH — the liquidity runway. FCFF less the convertibles' cash coupons and
 *    the principal of notes that do NOT convert in that scenario, against
 *    available liquidity. This is the question "when does the money run out
 *    before any refinancing", which the valuation never asks. Coupons are the
 *    tranche coupons from the filings; the Trinity equipment loan's rate is not
 *    in the model's sources and is left out rather than guessed.
 *
 * Available liquidity is included cash less debt that is cash-collateralised
 * (the UBS bridge and its restricted cash net to nil) — the Risk sheet's
 * definition, which reproduces its $3,335.2mm.
 */
import { LENS, PERIODS, SCENARIO_INDICES, YEARS, type AstsInputs } from './inputs';
import { perShare, type ModelRun, type ScenarioRun } from './engine';

/** The $550mm non-recourse delayed-draw SPV facility committed for the Ligado payment (10-K; review A3-10). */
export const LIGADO_FACILITY = 550;

export interface FinancingOptions {
  /** Issue price for new equity, $ per share in today's dollars. */
  issuePrice: number;
  /** Count the committed Ligado SPV facility as liquidity from the closing year. */
  useLigadoFacility: boolean;
  /** Liquidity kept in reserve before a raise is triggered, $mm. The Risk sheet's measure is 0. */
  minBuffer: number;
}

export interface ScenarioFinancing {
  s: number;
  availableLiquidity: number;
  /** New equity raised each period, $mm nominal (value view). */
  raises: number[];
  raisedNominal: number;
  raisedPv: number;
  newShares: number;
  vpsModel: number;
  vpsFinanced: number;
  /** Per-share value transferred to (+) or from (−) today's holders by raising at the issue price. */
  transfer: number;
  runway: {
    interest: number[];
    principal: number[];
    facility: number[];
    /** Liquidity at the end of each period before any new capital, $mm. */
    cash: number[];
    firstShortfall: string | null;
    peakShortfall: number;
  };
}

export interface FinancingReport {
  scenarios: ScenarioFinancing[];
  pwModel: number;
  pwFinanced: number;
}

export function availableLiquidity(inputs: AstsInputs): number {
  const cash = inputs.cash.reduce((t, r) => t + (r.include === 1 ? r.amount : 0), 0);
  const collateralised = inputs.debt.filter((d) => d.collateralised).reduce((t, d) => t + d.face, 0);
  return cash - collateralised;
}

/** Fraction of calendar year `y` a note is outstanding, given an ISO maturity date. */
function outstandingFraction(y: number, maturity: string): number {
  const my = Number(maturity.slice(0, 4));
  if (!Number.isFinite(my) || y > my) return 0;
  if (y < my) return 1;
  const month = Number(maturity.slice(5, 7));
  const day = Number(maturity.slice(8, 10));
  return (month - 1 + (day - 1) / 30) / 12;
}

export function scenarioFinancing(inputs: AstsInputs, r: ScenarioRun, o: FinancingOptions): ScenarioFinancing {
  const L0 = availableLiquidity(inputs);
  const facilityCum = YEARS.map((y) => (o.useLigadoFacility && y >= r.p.ligado_year ? LIGADO_FACILITY : 0));

  /* ---- value view: raise the FCFF shortfall, just in time */
  const raises = YEARS.map(() => 0);
  let raised = 0;
  r.cumFcf.forEach((c, i) => {
    const cash = L0 + facilityCum[i] + c + raised;
    if (cash < o.minBuffer) {
      raises[i] = o.minBuffer - cash;
      raised += raises[i];
    }
  });
  const raisedPv = raises.reduce((t, x, i) => t + x * r.df[i], 0);
  const newShares = o.issuePrice > 0 ? raisedPv / o.issuePrice : raisedPv > 0 ? Infinity : 0;
  const vpsFinanced =
    raisedPv === 0 ? r.vps : Number.isFinite(newShares) ? perShare(r.E0 + raisedPv, r.S0 + newShares, r.instruments).vps : 0;

  /* ---- cash view: coupons and non-converting principal against liquidity */
  const interest = YEARS.map((y, i) => {
    let t = 0;
    for (const c of inputs.converts) {
      // 2026H2 is the second half: a note maturing in 2026 would be pro-rated; none does.
      const frac = i === 0 ? Math.min(LENS[0], outstandingFraction(y, c.maturity)) : outstandingFraction(y, c.maturity);
      t += c.face * c.coupon * frac;
    }
    return t;
  });
  const principal = YEARS.map((y) =>
    inputs.converts.reduce((t, c, k) => {
      const converts = r.dilution.converts[k];
      return t + (!converts && Number(c.maturity.slice(0, 4)) === y ? c.face : 0);
    }, 0),
  );
  let running = L0;
  const cash = YEARS.map((_, i) => {
    running += r.fcf[i] - interest[i] - principal[i];
    return running + facilityCum[i];
  });
  const firstIdx = cash.findIndex((c) => c < 0);

  return {
    s: r.s,
    availableLiquidity: L0,
    raises,
    raisedNominal: raised,
    raisedPv,
    newShares: Number.isFinite(newShares) ? newShares : 0,
    vpsModel: r.vps,
    vpsFinanced,
    transfer: vpsFinanced - r.vps,
    runway: {
      interest,
      principal,
      facility: facilityCum,
      cash,
      firstShortfall: firstIdx >= 0 ? PERIODS[firstIdx] : null,
      peakShortfall: Math.max(0, -Math.min(...cash)),
    },
  };
}

export function financing(inputs: AstsInputs, model: ModelRun, o: FinancingOptions): FinancingReport {
  const scenarios = SCENARIO_INDICES.map((s) => scenarioFinancing(inputs, model.runs[s], o));
  return {
    scenarios,
    pwModel: model.pw,
    pwFinanced: scenarios.reduce((t, f, i) => t + model.probs[i] * f.vpsFinanced, 0),
  };
}
