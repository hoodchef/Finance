import { normCdf, priceOption, yearsToExpiry } from './pricing';
import {
  profitAtExpiry,
  summarise,
  valuePosition,
  type OptionLeg,
  type OptionPosition,
} from './strategy';
import { candidateStrikes } from './optimise';

/**
 * Hedging an existing position.
 * =============================================================================
 * You hold something. You want it to behave differently. This searches for the
 * cheapest set of trades that gets it there, and is explicit about what "there"
 * actually means — because the usual phrasing hides two things that matter.
 *
 * DELTA NEUTRAL IS AN INSTANT, NOT A STATE
 *
 * A stock hedge is neutral at every price: short 100 shares against 100 long
 * and the two cancel exactly, forever, because both are linear in the spot.
 * An option hedge is neutral at ONE price and ONE moment. Gamma is the rate at
 * which it stops being neutral, so a position hedged with options today needs
 * re-hedging tomorrow, and the further the underlying moves the faster that
 * comes due. Both kinds of hedge are searched and reported side by side with
 * their gamma, because a tool that returns "buy 2 puts, you are delta neutral"
 * without that is describing a position that will not exist by Friday.
 *
 * CONTRACTS ARE INTEGERS
 *
 * The arithmetic wants 2.17 contracts. You can buy two or three. Every
 * candidate here is a whole number of contracts and reports the delta it
 * actually leaves behind, rather than the delta a fractional position would
 * have left. Residual delta is the honest output; zero is usually unreachable.
 */

export type HedgeObjective =
  /** Bring net delta to zero, or as close as whole contracts allow. */
  | 'delta-neutral'
  /** Bring net delta to a chosen number — keep some exposure deliberately. */
  | 'target-delta'
  /** Guarantee the position cannot be worth less than a floor at expiry. */
  | 'protect-floor'
  /** Cut the worst case as much as a fixed budget allows. */
  | 'cheapest-protection';

export interface HedgeRequest {
  /** What is already held. */
  position: OptionPosition;
  spot: number;
  asOf: string;
  /** Volatility used to price hedge candidates. */
  volatility: number;
  objective: HedgeObjective;
  /** For 'target-delta'. Share-equivalent. */
  targetDelta?: number;
  /** For 'protect-floor': the position value to protect, as an underlying price. */
  floorPrice?: number;
  /** Instruments the search may use. */
  instruments?: Array<'put' | 'call' | 'stock'>;
  expiries: string[];
  /** Largest number of contracts in a single hedge leg. */
  maxContracts?: number;
  /** Reject hedges costing more than this. */
  maxDebit?: number;
  multiplier?: number;
}

export interface HedgeCandidate {
  label: string;
  /** Legs to ADD to the position. */
  legs: OptionLeg[];
  /** Shares to buy (+) or short (−) as part of the hedge. */
  shares: number;
  /** Positive is money out, negative is money in. */
  cost: number;
  /** Net delta of the position AFTER the hedge. */
  residualDelta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** Worst outcome at expiry once hedged; null if unbounded. */
  hedgedMaxLoss: number | null;
  /** True when the hedge holds at every price, not just at today's. */
  linear: boolean;
  score: number;
}

let seq = 0;

function hedgeLeg(
  req: HedgeRequest,
  type: 'put' | 'call',
  side: 'buy' | 'sell',
  strike: number,
  expiry: string,
  contracts: number,
): OptionLeg {
  const premium = priceOption({
    spot: req.spot,
    strike,
    timeToExpiry: yearsToExpiry(req.asOf, expiry),
    riskFreeRate: req.position.riskFreeRate,
    volatility: req.volatility,
    dividendYield: req.position.dividendYield,
    type,
    style: 'european',
  }).price;

  return {
    id: `hedge-${seq++}`,
    type,
    side,
    strike,
    expiry,
    contracts,
    entryPremium: premium,
    multiplier: req.multiplier ?? 100,
    style: 'european',
    impliedVolatility: req.volatility,
  };
}

/** The position with a candidate hedge applied. */
function combined(req: HedgeRequest, legs: OptionLeg[], shares: number): OptionPosition {
  const existing = req.position.stock;
  const totalShares = (existing?.side === 'sell' ? -1 : 1) * (existing?.shares ?? 0) + shares;
  return {
    ...req.position,
    legs: [...req.position.legs, ...legs],
    stock:
      totalShares === 0
        ? null
        : {
            side: totalShares > 0 ? 'buy' : 'sell',
            shares: Math.abs(totalShares),
            // Hedge shares transact at today's price; existing ones keep their
            // basis, so the blended entry preserves the P/L already earned.
            entryPrice:
              existing && existing.shares > 0
                ? (existing.entryPrice * existing.shares + req.spot * Math.abs(shares)) /
                  (existing.shares + Math.abs(shares))
                : req.spot,
          },
  };
}

/** Cost of a hedge: option premiums plus any stock bought or sold. */
function hedgeCost(legs: OptionLeg[], shares: number, spot: number): number {
  const options = legs.reduce(
    (a, l) => a + (l.side === 'buy' ? 1 : -1) * l.entryPremium * l.contracts * l.multiplier,
    0,
  );
  return options + shares * spot;
}

export interface HedgeResult {
  /** Net delta before any hedge, for context. */
  currentDelta: number;
  candidates: HedgeCandidate[];
  evaluated: number;
  notes: string[];
}

export function findHedges(req: HedgeRequest): HedgeResult {
  const instruments = req.instruments ?? ['put', 'call', 'stock'];
  const maxContracts = Math.max(1, Math.min(50, req.maxContracts ?? 10));
  const mult = req.multiplier ?? 100;

  const before = valuePosition(req.position, { spot: req.spot, asOf: req.asOf });
  const currentDelta = before.greeks.delta;
  const target =
    req.objective === 'target-delta' ? (req.targetDelta ?? 0) : req.objective === 'delta-neutral' ? 0 : null;

  const strikes = candidateStrikes(req.spot, 0.45, 21);
  const raw: HedgeCandidate[] = [];

  const evaluate = (label: string, legs: OptionLeg[], shares: number, linear: boolean) => {
    const merged = combined(req, legs, shares);
    const v = valuePosition(merged, { spot: req.spot, asOf: req.asOf });
    const s = summarise(merged);
    raw.push({
      label,
      legs,
      shares,
      cost: hedgeCost(legs, shares, req.spot),
      residualDelta: v.greeks.delta,
      gamma: v.greeks.gamma,
      theta: v.greeks.theta,
      vega: v.greeks.vega,
      hedgedMaxLoss: s.maxLoss,
      linear,
      score: 0,
    });
  };

  // Stock. Exact and linear: the delta it removes is the delta it removes at
  // every price, which no option hedge can claim.
  if (instruments.includes('stock') && target != null) {
    const need = Math.round(target - currentDelta);
    if (need !== 0) {
      evaluate(
        `${need > 0 ? 'Buy' : 'Short'} ${Math.abs(need)} shares`,
        [],
        need,
        true,
      );
    }
  }

  // Single option legs, every strike, expiry and whole contract count.
  for (const expiry of req.expiries) {
    for (const type of ['put', 'call'] as const) {
      if (!instruments.includes(type)) continue;
      for (const strike of strikes) {
        for (const side of ['buy', 'sell'] as const) {
          for (let n = 1; n <= maxContracts; n++) {
            const leg = hedgeLeg(req, type, side, strike, expiry, n);
            evaluate(
              `${side === 'buy' ? 'Buy' : 'Sell'} ${n} × ${strike} ${type === 'put' ? 'put' : 'call'} ${expiry.slice(5)}`,
              [leg],
              0,
              false,
            );
          }
        }
      }
    }
  }

  // Collars: a long put paid for by a short call. The structure most people
  // actually want when they say "protect this without spending anything".
  if (instruments.includes('put') && instruments.includes('call')) {
    for (const expiry of req.expiries) {
      for (const put of strikes.filter((k) => k <= req.spot)) {
        for (const call of strikes.filter((k) => k >= req.spot)) {
          for (let n = 1; n <= Math.min(maxContracts, 5); n++) {
            const legs = [
              hedgeLeg(req, 'put', 'buy', put, expiry, n),
              hedgeLeg(req, 'call', 'sell', call, expiry, n),
            ];
            /*
             * A collar with both strikes equal is synthetic short stock: long
             * put plus short call at K has delta of exactly −1 per share and
             * no gamma, so it hedges as cleanly as shorting the shares and
             * takes in a credit of S − Ke^−rT instead of tying up the borrow.
             * Named, because "Collar 200/200" does not read as what it is, and
             * it is frequently the best answer in the list.
             */
            const synthetic = put === call;
            evaluate(
              synthetic
                ? `Synthetic short ×${n} (${put} put / ${call} call) ${expiry.slice(5)}`
                : `Collar ${put}/${call} ×${n} ${expiry.slice(5)}`,
              legs,
              0,
              // Delta is constant and gamma cancels exactly, so it does not
              // drift — the same property that makes the stock hedge exact.
              synthetic,
            );
          }
        }
      }
    }
  }

  /* ---------------- scoring ---------------- */

  const tolerance = Math.max(1, Math.abs(currentDelta) * 0.02);
  let feasible = raw;
  const notes: string[] = [];

  if (target != null) {
    // Anything that lands within tolerance of the target counts as achieving
    // it; among those, the cheapest wins. Ranking on residual alone would
    // return whichever candidate happened to round closest, at any price.
    const within = raw.filter((c) => Math.abs(c.residualDelta - target) <= tolerance);
    if (within.length) {
      feasible = within;
      for (const c of feasible) c.score = -c.cost;
    } else {
      // Nothing hits the target with whole contracts. Report the closest
      // rather than nothing, and say so.
      feasible = [...raw].sort(
        (a, b) => Math.abs(a.residualDelta - target) - Math.abs(b.residualDelta - target),
      );
      for (const c of feasible) c.score = -Math.abs(c.residualDelta - target);
      notes.push(
        `No whole-contract hedge reaches a delta of ${target.toFixed(0)} within ${tolerance.toFixed(0)}. ` +
          'These are the closest; the residual delta column is what you would actually be left holding.',
      );
    }
  }

  if (req.objective === 'protect-floor' || req.objective === 'cheapest-protection') {
    const floor = req.floorPrice ?? req.spot * 0.9;
    const floorValue = profitAtExpiry(req.position, floor);
    feasible = raw.filter((c) => {
      const merged = combined(req, c.legs, c.shares);
      // The hedge must hold at and below the floor, not merely at it.
      return [floor, floor * 0.8, floor * 0.5, 0.01].every(
        (s) => profitAtExpiry(merged, s) >= floorValue - 1e-6,
      );
    });
    for (const c of feasible) c.score = -c.cost;
    if (!feasible.length) {
      notes.push(
        `No available hedge holds the position at or above its value at ${floor.toFixed(2)} ` +
          'all the way down. Widen the strike range, allow more contracts, or lower the floor.',
      );
    }
  }

  if (req.maxDebit != null) {
    feasible = feasible.filter((c) => c.cost <= req.maxDebit!);
  }

  feasible.sort((a, b) => b.score - a.score);

  const best = feasible[0];
  if (best && !best.linear) {
    notes.push(
      'An option hedge is delta neutral at today’s price and at this moment only. Gamma is the ' +
        'rate at which it stops being: the further the underlying moves, the faster the hedge ' +
        'goes off. A stock hedge is exact at every price and never needs adjusting, which is why ' +
        'it is searched alongside and shown with its cost.',
    );
  }
  notes.push(
    'Hedges are priced from the model at the volatility above, not from live quotes. The ranking ' +
      'is by cost among the candidates that meet the objective.',
  );

  return {
    currentDelta,
    candidates: dedupe(feasible).slice(0, 12),
    evaluated: raw.length,
    notes,
  };
}

/**
 * Collapses candidates that differ only in ways nobody cares about.
 *
 * A search over 21 strikes and 10 contract counts produces long runs of
 * near-identical answers — 3 puts at 310 and 3 at 305 hedge almost the same
 * delta for almost the same price — and a list of twelve variations on one
 * idea is less useful than four genuinely different ones.
 */
function dedupe(candidates: HedgeCandidate[]): HedgeCandidate[] {
  const seen = new Set<string>();
  const out: HedgeCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.legs.length}|${c.shares !== 0}|${Math.round(c.residualDelta / 5)}|${Math.round(c.cost / 250)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * How far the underlying can move before a hedge is off by more than a given
 * number of deltas.
 *
 * Delta drifts at gamma per point, so this is the plain-language version of a
 * gamma reading: not "your gamma is 4.2" but "a $12 move and you are 50 deltas
 * long again". It is the number that decides how often the hedge needs work.
 */
export function driftDistance(gamma: number, allowedDelta = 25): number | null {
  if (!Number.isFinite(gamma) || Math.abs(gamma) < 1e-9) return null;
  return Math.abs(allowedDelta / gamma);
}

/**
 * Probability the underlying moves far enough to break the hedge, over a
 * horizon, under the same lognormal the rest of the analytics use.
 */
export function probabilityHedgeBreaks(
  spot: number,
  distance: number,
  volatility: number,
  days: number,
): number {
  const T = Math.max(0, days) / 365;
  if (!(T > 0) || !(volatility > 0) || !(spot > 0)) return 0;
  const sd = volatility * Math.sqrt(T) * spot;
  if (!(sd > 0)) return 0;
  // Two-sided: it breaks in either direction.
  const z = distance / sd;
  return Math.min(1, 2 * (1 - normCdf(z)));
}
