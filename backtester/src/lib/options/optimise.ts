import { normInv, priceOption, yearsToExpiry } from './pricing';
import {
  capitalRequired,
  netDebit,
  profitAtExpiry,
  summarise,
  valuePosition,
  type OptionLeg,
  type OptionPosition,
} from './strategy';
import { analysePositionProbability } from './analytics';

/**
 * Searching for a structure that meets an objective.
 * =============================================================================
 * WHY PRICING AND EVALUATION USE DIFFERENT ASSUMPTIONS
 *
 * This is the whole design, and getting it wrong makes the optimiser look
 * rigorous while being meaningless.
 *
 * If candidates are priced with a model and then scored on expected value
 * under that same model, every candidate scores zero. That is not a bug in the
 * search — it is what risk-neutral pricing means: the discounted expectation
 * of the payoff IS the price, so buying it at that price has no edge, and a
 * ranking of "expected value" would be ranking floating-point noise. An
 * optimiser built that way produces confident recommendations that are pure
 * rounding error, and nothing on screen would say so.
 *
 * So there are two sets of assumptions, deliberately separate:
 *
 *   - PRICING volatility, which decides what each candidate costs. From the
 *     chain where there is one, otherwise the user's assumption.
 *   - EVALUATION drift and volatility, which decide what each candidate is
 *     worth to you. These are the user's view of the world.
 *
 * Expected value is then the difference between what you pay and what you
 * think it is worth, which is the only sense in which one structure can beat
 * another. Where the two sets agree, expected values collapse toward zero and
 * the objective is telling you the truth: on your own assumptions, nothing
 * here has an edge.
 *
 * Objectives that do not depend on drift — probability of profit, maximum
 * loss, capital, theta, target delta — are well defined either way.
 */

export type Objective =
  | 'max-probability-of-profit'
  | 'max-expected-value'
  | 'max-theta'
  | 'min-max-loss'
  | 'max-risk-adjusted'
  | 'min-capital'
  | 'target-delta'
  | 'target-probability';

export interface OptimiseConstraints {
  /** Reject candidates that can lose more than this. Unlimited loss always fails. */
  maxLoss?: number;
  minProbabilityOfProfit?: number;
  maxContracts?: number;
  minStrike?: number;
  maxStrike?: number;
  maxCapital?: number;
  /** Require at least this credit — a positive number means a net credit. */
  minCredit?: number;
  maxDebit?: number;
  /** For the target objectives. */
  targetDelta?: number;
  targetProbability?: number;
}

export interface OptimiseRequest {
  underlying: string;
  spot: number;
  asOf: string;
  riskFreeRate: number;
  dividendYield: number;
  /** Volatility used to PRICE candidate legs. */
  pricingVolatility: number;
  /** The user's own view, used to SCORE candidates. */
  evaluation: { drift: number; volatility: number };
  /** Expiries to search over. */
  expiries: string[];
  /** Structures to enumerate. */
  shapes: ShapeId[];
  objective: Objective;
  constraints: OptimiseConstraints;
  contracts?: number;
  multiplier?: number;
  /** Cap on candidates evaluated, so the search stays bounded. */
  maxCandidates?: number;
}

export type ShapeId =
  | 'long-call'
  | 'long-put'
  | 'short-put'
  | 'covered-call'
  | 'bull-call-spread'
  | 'bear-call-spread'
  | 'bull-put-spread'
  | 'bear-put-spread'
  | 'straddle'
  | 'strangle'
  | 'iron-condor'
  | 'butterfly';

export interface Candidate {
  shape: ShapeId;
  label: string;
  legs: OptionLeg[];
  /** Positive is a debit paid, negative a credit received. */
  netDebit: number;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  capital: number;
  probabilityOfProfit: number;
  /** Under the EVALUATION assumptions, not the pricing ones. */
  expectedValue: number;
  expectedReturn: number | null;
  riskReward: number | null;
  delta: number;
  theta: number;
  vega: number;
  score: number;
}

/** Strikes to search: a grid around spot at a listed-looking increment. */
export function candidateStrikes(spot: number, span = 0.3, count = 13): number[] {
  const step = spot >= 500 ? 10 : spot >= 100 ? 5 : spot >= 25 ? 1 : 0.5;
  const centre = Math.round(spot / step) * step;
  const half = Math.floor(count / 2);
  const out: number[] = [];
  for (let i = -half; i <= half; i++) {
    const k = centre + i * step;
    if (k > 0 && Math.abs(k - spot) / spot <= span) out.push(k);
  }
  return out;
}

let seq = 0;
function mkLeg(
  req: OptimiseRequest,
  expiry: string,
  type: 'call' | 'put',
  side: 'buy' | 'sell',
  strike: number,
  contracts: number,
): OptionLeg {
  // Priced at the model on the PRICING volatility: this is what the candidate
  // would cost, before any view about whether that is a good price.
  const premium = priceOption(
    {
      spot: req.spot,
      strike,
      timeToExpiry: yearsToExpiry(req.asOf, expiry),
      riskFreeRate: req.riskFreeRate,
      volatility: req.pricingVolatility,
      dividendYield: req.dividendYield,
      type,
      style: 'european',
    },
  ).price;

  return {
    id: `opt-${seq++}`,
    type,
    side,
    strike,
    expiry,
    contracts,
    entryPremium: premium,
    multiplier: req.multiplier ?? 100,
    style: 'european',
    impliedVolatility: req.pricingVolatility,
  };
}

/**
 * Enumerates candidate structures.
 *
 * Bounded per shape rather than exhaustively: four independent strikes over a
 * thirteen-strike grid is 28,561 iron condors per expiry, almost all of them
 * nonsense (inverted wings, zero-width spreads). Enumerating short strikes and
 * a small set of wing widths covers the structures anyone would actually trade
 * and keeps the search interactive.
 */
function enumerate(req: OptimiseRequest): Array<{ shape: ShapeId; label: string; legs: OptionLeg[]; stock?: boolean }> {
  const n = req.contracts ?? 1;
  const strikes = candidateStrikes(req.spot).filter(
    (k) =>
      (req.constraints.minStrike == null || k >= req.constraints.minStrike) &&
      (req.constraints.maxStrike == null || k <= req.constraints.maxStrike),
  );
  const out: Array<{ shape: ShapeId; label: string; legs: OptionLeg[]; stock?: boolean }> = [];
  const widths = [1, 2, 3, 4];

  for (const expiry of req.expiries) {
    const L = (t: 'call' | 'put', s: 'buy' | 'sell', k: number, c = n) =>
      mkLeg(req, expiry, t, s, k, c);
    const d = expiry.slice(5);

    for (const shape of req.shapes) {
      if (shape === 'long-call') {
        for (const k of strikes) out.push({ shape, label: `Long ${k}C ${d}`, legs: [L('call', 'buy', k)] });
      }
      if (shape === 'long-put') {
        for (const k of strikes) out.push({ shape, label: `Long ${k}P ${d}`, legs: [L('put', 'buy', k)] });
      }
      if (shape === 'short-put') {
        for (const k of strikes) out.push({ shape, label: `Short ${k}P ${d}`, legs: [L('put', 'sell', k)] });
      }
      if (shape === 'covered-call') {
        for (const k of strikes) {
          out.push({ shape, label: `Covered ${k}C ${d}`, legs: [L('call', 'sell', k)], stock: true });
        }
      }
      if (shape === 'straddle') {
        for (const k of strikes) {
          out.push({ shape, label: `Straddle ${k} ${d}`, legs: [L('call', 'buy', k), L('put', 'buy', k)] });
        }
      }

      // Two-strike shapes: index pairs, bounded by width.
      for (let i = 0; i < strikes.length; i++) {
        for (const w of widths) {
          const j = i + w;
          if (j >= strikes.length) continue;
          const lo = strikes[i];
          const hi = strikes[j];
          if (shape === 'bull-call-spread') {
            out.push({ shape, label: `${lo}/${hi} call debit ${d}`, legs: [L('call', 'buy', lo), L('call', 'sell', hi)] });
          }
          if (shape === 'bear-call-spread') {
            out.push({ shape, label: `${lo}/${hi} call credit ${d}`, legs: [L('call', 'sell', lo), L('call', 'buy', hi)] });
          }
          if (shape === 'bull-put-spread') {
            out.push({ shape, label: `${lo}/${hi} put credit ${d}`, legs: [L('put', 'buy', lo), L('put', 'sell', hi)] });
          }
          if (shape === 'bear-put-spread') {
            out.push({ shape, label: `${lo}/${hi} put debit ${d}`, legs: [L('put', 'sell', lo), L('put', 'buy', hi)] });
          }
          if (shape === 'strangle' && lo < req.spot && hi > req.spot) {
            out.push({ shape, label: `Strangle ${lo}/${hi} ${d}`, legs: [L('put', 'buy', lo), L('call', 'buy', hi)] });
          }
          if (shape === 'butterfly') {
            const k = j + w;
            if (k >= strikes.length) continue;
            out.push({
              shape,
              label: `Butterfly ${lo}/${hi}/${strikes[k]} ${d}`,
              legs: [L('call', 'buy', lo), L('call', 'sell', hi, n * 2), L('call', 'buy', strikes[k])],
            });
          }
        }
      }

      if (shape === 'iron-condor') {
        for (let sp = 0; sp < strikes.length; sp++) {
          for (let sc = sp + 1; sc < strikes.length; sc++) {
            if (strikes[sp] >= req.spot || strikes[sc] <= req.spot) continue;
            for (const w of widths) {
              const lp = sp - w;
              const hc = sc + w;
              if (lp < 0 || hc >= strikes.length) continue;
              out.push({
                shape,
                label: `IC ${strikes[lp]}/${strikes[sp]}/${strikes[sc]}/${strikes[hc]} ${d}`,
                legs: [
                  L('put', 'buy', strikes[lp]),
                  L('put', 'sell', strikes[sp]),
                  L('call', 'sell', strikes[sc]),
                  L('call', 'buy', strikes[hc]),
                ],
              });
            }
          }
        }
      }
    }
  }
  return out;
}

function passes(c: Candidate, k: OptimiseConstraints): boolean {
  // Unlimited loss fails any maximum-loss constraint. It cannot be compared
  // against a number, and treating null as "no loss" would rank naked shorts
  // as the safest thing in the list.
  if (k.maxLoss != null) {
    if (c.maxLoss == null) return false;
    if (Math.abs(c.maxLoss) > k.maxLoss) return false;
  }
  if (k.minProbabilityOfProfit != null && c.probabilityOfProfit < k.minProbabilityOfProfit) return false;
  if (k.maxCapital != null && c.capital > k.maxCapital) return false;
  if (k.minCredit != null && -c.netDebit < k.minCredit) return false;
  if (k.maxDebit != null && c.netDebit > k.maxDebit) return false;
  if (k.maxContracts != null && c.legs.some((l) => l.contracts > k.maxContracts!)) return false;
  return true;
}

function scoreOf(c: Candidate, req: OptimiseRequest): number {
  const k = req.constraints;
  switch (req.objective) {
    case 'max-probability-of-profit':
      return c.probabilityOfProfit;
    case 'max-expected-value':
      return c.expectedValue;
    case 'max-theta':
      return c.theta;
    case 'min-max-loss':
      // Unlimited loss is the worst possible, not the best.
      return c.maxLoss == null ? -Infinity : -Math.abs(c.maxLoss);
    case 'max-risk-adjusted':
      return c.maxLoss == null || c.maxLoss === 0
        ? -Infinity
        : c.expectedValue / Math.abs(c.maxLoss);
    case 'min-capital':
      return -c.capital;
    case 'target-delta':
      return -Math.abs(c.delta - (k.targetDelta ?? 0));
    case 'target-probability':
      return -Math.abs(c.probabilityOfProfit - (k.targetProbability ?? 0.5));
    default:
      return 0;
  }
}

export interface OptimiseResult {
  candidates: Candidate[];
  /** How many structures were generated and how many survived constraints. */
  evaluated: number;
  feasible: number;
  /** Stated beside the ranking, because a ranking invites over-reading. */
  notes: string[];
}

export function optimise(req: OptimiseRequest): OptimiseResult {
  const cap = Math.max(50, Math.min(20_000, req.maxCandidates ?? 6000));
  const generated = enumerate(req).slice(0, cap);

  const evaluated: Candidate[] = generated.map((g) => {
    const position: OptionPosition = {
      underlying: req.underlying,
      legs: g.legs,
      stock: g.stock
        ? { side: 'buy', shares: (req.contracts ?? 1) * (req.multiplier ?? 100), entryPrice: req.spot }
        : null,
      riskFreeRate: req.riskFreeRate,
      dividendYield: req.dividendYield,
    };

    const s = summarise(position);
    // Scored under the USER'S assumptions, not the pricing ones. See the note
    // at the top: scoring under the pricing model gives every candidate zero.
    const prob = analysePositionProbability(position, {
      spot: req.spot,
      volatility: req.evaluation.volatility,
      asOf: req.asOf,
    });
    const expected = expectedValueUnderDrift(position, req);
    const v = valuePosition(position, { spot: req.spot, asOf: req.asOf });

    const c: Candidate = {
      shape: g.shape,
      label: g.label,
      legs: g.legs,
      netDebit: netDebit(position),
      maxProfit: s.maxProfit,
      maxLoss: s.maxLoss,
      breakevens: s.breakevens,
      capital: capitalRequired(position),
      probabilityOfProfit: prob.probabilityOfProfit,
      expectedValue: expected,
      expectedReturn: s.capital > 0 ? expected / s.capital : null,
      riskReward: s.riskReward,
      delta: v.greeks.delta,
      theta: v.greeks.theta,
      vega: v.greeks.vega,
      score: 0,
    };
    c.score = scoreOf(c, req);
    return c;
  });

  const feasible = evaluated.filter((c) => passes(c, req.constraints));
  feasible.sort((a, b) => b.score - a.score);

  const notes: string[] = [];
  const sameAssumptions =
    Math.abs(req.evaluation.volatility - req.pricingVolatility) < 1e-9 &&
    Math.abs(req.evaluation.drift - (req.riskFreeRate - req.dividendYield)) < 1e-9;
  if (sameAssumptions) {
    notes.push(
      'Your evaluation assumptions match the ones used to price these candidates, so every ' +
        'expected value is approximately zero — correctly. Under the pricing model nothing has ' +
        'an edge, by definition. Change the drift or the evaluation volatility to express a view.',
    );
  }
  if (feasible.length === 0 && evaluated.length > 0) {
    notes.push('No structure met every constraint. Relax the tightest one and search again.');
  }
  notes.push(
    'Candidates are priced from the model, not from live quotes, so these are theoretical ' +
      'structures rather than trades you can place at these prices.',
  );
  notes.push(
    `Ranking ${feasible.length} structures on one set of assumptions and taking the top one is ` +
      'a selection problem: the best of many looks good partly by construction. Treat the list ' +
      'as a shortlist to understand, not a recommendation.',
  );

  return { candidates: feasible.slice(0, 25), evaluated: evaluated.length, feasible: feasible.length, notes };
}

/**
 * Present value of the expected profit, under the user's own drift and
 * volatility.
 *
 * The discounting is not a refinement. The premium is paid TODAY and the
 * payoff arrives at EXPIRY, so comparing them undiscounted overstates every
 * long position by the interest on the premium — with a $1,700 spread over six
 * months at 4% that is $34 of pure carry, which looked exactly like edge and
 * ranked above structures that had some. Under matching assumptions the
 * discounted expectation of the payoff IS the price the candidate was built
 * at, so the expected value comes out at zero to floating point, which is the
 * signal the optimiser needs to report the degeneracy honestly.
 */
function expectedValueUnderDrift(position: OptionPosition, req: OptimiseRequest): number {
  const expiries = [...new Set(position.legs.map((l) => l.expiry))].sort();
  const T = yearsToExpiry(req.asOf, expiries[expiries.length - 1] ?? req.asOf);
  const paid = netDebit(position);
  if (!(T > 0)) return profitAtExpiry(position, req.spot);

  const sigma = Math.max(1e-8, req.evaluation.volatility);
  const mu = Math.log(req.spot) + (req.evaluation.drift - 0.5 * sigma * sigma) * T;
  const sd = sigma * Math.sqrt(T);

  const steps = 800;
  let gross = 0;
  for (let i = 0; i < steps; i++) {
    const p = (i + 0.5) / steps;
    const z = normInv(p);
    // profitAtExpiry is net of what was paid; add it back for the gross payoff.
    gross += profitAtExpiry(position, Math.exp(mu + sd * z)) + paid;
  }
  return Math.exp(-req.riskFreeRate * T) * (gross / steps) - paid;
}
