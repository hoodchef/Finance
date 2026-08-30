import { normCdf, normInv, yearsBetween } from './pricing';
import {
  profitAtExpiry,
  summarise,
  valuePosition,
  expiries,
  type OptionPosition,
} from './strategy';

/**
 * Probability, scenarios and simulation.
 * =============================================================================
 * WHAT THE PROBABILITIES ACTUALLY ASSUME
 *
 * Every figure here rests on one model: the underlying is lognormal at expiry
 * with volatility equal to the implied volatility supplied, drifting at the
 * risk-free rate less the dividend yield. That is the Black–Scholes world, and
 * it is wrong in known ways — real returns have fatter tails and a volatility
 * that moves, so the probability of a large move is understated and the
 * probability of finishing near the money is overstated.
 *
 * It is used anyway because it is the same assumption the option prices
 * themselves embed, which makes the probabilities at least internally
 * consistent with the premiums being analysed. Mixing a fat-tailed probability
 * model with Black–Scholes prices would produce expected values that look
 * rigorous and are not.
 *
 * The drift is the RISK-NEUTRAL one, not a forecast. A probability of profit
 * computed this way is what the market's own pricing implies, not a prediction
 * that the position will make money — a distinction the UI states rather than
 * leaving to be inferred.
 */

export interface DistributionInputs {
  spot: number;
  /** Annualised volatility as a decimal. */
  volatility: number;
  /** Years to the horizon. */
  timeToExpiry: number;
  riskFreeRate: number;
  dividendYield: number;
}

/**
 * Probability the underlying finishes above a level, under the risk-neutral
 * lognormal. This is N(d2) for a call strike — the same quantity Black–Scholes
 * uses, which is why it agrees with the prices.
 */
export function probabilityAbove(level: number, d: DistributionInputs): number {
  const { spot: S, volatility: sigma, timeToExpiry: T, riskFreeRate: r, dividendYield: q } = d;
  if (!(T > 0)) return S > level ? 1 : 0;
  if (!(sigma > 0)) return S * Math.exp((r - q) * T) > level ? 1 : 0;
  if (!(level > 0)) return 1;
  const d2 = (Math.log(S / level) + (r - q - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d2);
}

export function probabilityBelow(level: number, d: DistributionInputs): number {
  return 1 - probabilityAbove(level, d);
}

/**
 * Probability the underlying TOUCHES a level at any point before expiry.
 *
 * Roughly twice the probability of finishing beyond it, which is the standard
 * reflection-principle result and is materially larger — a level with a 30%
 * chance of being finished beyond has more like a 55% chance of being touched
 * at some point. Anyone managing a position at a breakeven cares about the
 * touch probability, and quoting the terminal one instead badly understates
 * how often the position will be under water on the way.
 */
export function probabilityOfTouch(level: number, d: DistributionInputs): number {
  const { spot: S, volatility: sigma, timeToExpiry: T, riskFreeRate: r, dividendYield: q } = d;
  if (!(S > 0) || !(level > 0)) return 0;
  if (level === S) return 1;
  if (!(T > 0) || !(sigma > 0)) {
    const terminal = S * Math.exp((r - q) * Math.max(T, 0));
    return (level > S ? terminal >= level : terminal <= level) ? 1 : 0;
  }

  // Log-space barrier and drift: X_t = ln(S_t/S) = vt + sigma W_t.
  const b = Math.log(level / S);
  const v = r - q - 0.5 * sigma * sigma;
  const sT = sigma * Math.sqrt(T);
  const reflect = Math.exp((2 * v * b) / (sigma * sigma));

  // First-passage for Brownian motion with drift. With zero drift both reduce
  // to twice the terminal probability, which is the reflection principle and
  // the check that these are the right way round.
  const p =
    level > S
      ? 1 - normCdf((b - v * T) / sT) + reflect * normCdf((-b - v * T) / sT)
      : normCdf((b - v * T) / sT) + reflect * normCdf((b + v * T) / sT);

  return Math.min(1, Math.max(0, p));
}

/** The one-standard-deviation move implied by the volatility over the horizon. */
export function expectedMove(d: DistributionInputs): { oneSigma: number; low: number; high: number } {
  const move = d.spot * d.volatility * Math.sqrt(Math.max(0, d.timeToExpiry));
  return { oneSigma: move, low: d.spot - move, high: d.spot + move };
}

export interface ProbabilityAnalysis {
  /** Probability the position is profitable at the final expiry. */
  probabilityOfProfit: number;
  probabilityOfLoss: number;
  /** Per breakeven, the chance of trading through it before expiry. */
  touchBreakeven: Array<{ level: number; probability: number }>;
  /** Probability-weighted profit under the same lognormal. */
  expectedValue: number;
  expectedMove: { oneSigma: number; low: number; high: number };
  /** expectedValue / capital, where capital is non-zero. */
  expectedReturn: number | null;
  riskReward: number | null;
  /** Per leg, the chance it finishes in the money. */
  legs: Array<{ legId: string; strike: number; type: string; probabilityITM: number }>;
  /** Restates what the numbers assume, for display beside them. */
  assumptions: string;
}

/**
 * Probability of profit, by integrating the payoff over the terminal
 * distribution rather than by counting breakevens.
 *
 * Counting breakevens is the usual shortcut and it is wrong for anything with
 * more than two of them: an iron condor profits BETWEEN its inner breakevens
 * and a butterfly does too, while a strangle profits outside them, and a rule
 * that assumes one shape misreads the other. Integrating the actual payoff
 * cannot get the shape wrong because it never assumes one.
 */
export interface ProbabilityOptions {
  spot: number;
  volatility: number;
  asOf: string;
  /** Integration points across the terminal distribution. */
  steps?: number;
}

/** Probability analysis at an explicit spot. */
export function analysePositionProbability(
  position: OptionPosition,
  options: ProbabilityOptions,
): ProbabilityAnalysis {
  const expiryDates = expiries(position);
  const finalExpiry = expiryDates[expiryDates.length - 1] ?? options.asOf;
  const T = yearsBetween(options.asOf, finalExpiry);

  const dist: DistributionInputs = {
    spot: options.spot,
    volatility: options.volatility,
    timeToExpiry: T,
    riskFreeRate: position.riskFreeRate,
    dividendYield: position.dividendYield,
  };

  const summary = summarise(position);
  const steps = Math.max(200, options.steps ?? 1200);

  // Integrate over the terminal lognormal using equal-probability slices, so
  // every sample carries the same weight and the tails are represented without
  // an arbitrary cut-off.
  let grossPayoff = 0;
  let probProfit = 0;
  // The premium was paid today and the payoff arrives at expiry, so the two
  // are only comparable once the payoff is discounted back. Left undiscounted
  // this reports the interest on the premium as if it were edge.
  const paid = position.legs.reduce(
    (a, l) => a + (l.side === 'buy' ? 1 : -1) * l.entryPremium * l.contracts * l.multiplier,
    0,
  ) + (position.stock ? (position.stock.side === 'buy' ? 1 : -1) * position.stock.entryPrice * position.stock.shares : 0);
  const mu = Math.log(options.spot) +
    (position.riskFreeRate - position.dividendYield - 0.5 * options.volatility ** 2) * T;
  const sd = options.volatility * Math.sqrt(Math.max(T, 0));

  for (let i = 0; i < steps; i++) {
    const p = (i + 0.5) / steps;
    const z = normInv(p);
    const terminal = sd > 0 ? Math.exp(mu + sd * z) : options.spot;
    const profit = profitAtExpiry(position, terminal);
    grossPayoff += (profit + paid) / steps;
    if (profit > 0) probProfit += 1 / steps;
  }
  const expectedValue = Math.exp(-position.riskFreeRate * T) * grossPayoff - paid;

  const legs = position.legs.map((l) => ({
    legId: l.id,
    strike: l.strike,
    type: l.type,
    probabilityITM:
      l.type === 'call'
        ? probabilityAbove(l.strike, { ...dist, timeToExpiry: yearsBetween(options.asOf, l.expiry) })
        : probabilityBelow(l.strike, { ...dist, timeToExpiry: yearsBetween(options.asOf, l.expiry) }),
  }));

  return {
    probabilityOfProfit: probProfit,
    probabilityOfLoss: 1 - probProfit,
    touchBreakeven: summary.breakevens.map((level) => ({
      level,
      probability: probabilityOfTouch(level, dist),
    })),
    expectedValue,
    expectedMove: expectedMove(dist),
    expectedReturn: summary.capital > 0 ? expectedValue / summary.capital : null,
    riskReward: summary.riskReward,
    legs,
    assumptions:
      `Lognormal terminal distribution at ${(options.volatility * 100).toFixed(1)}% volatility, ` +
      `drifting at the risk-free rate less the dividend yield over ${(T * 365).toFixed(0)} days. ` +
      'This is the risk-neutral distribution the option prices themselves embed, not a forecast: ' +
      'it says what the market’s pricing implies, not that the position will make money. Real ' +
      'returns have fatter tails, so large moves are understated.',
  };
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export interface ScenarioSpec {
  label: string;
  /** Multiplicative change in the underlying, e.g. -0.1 for −10%. */
  spotChange: number;
  /** Additive change in volatility, e.g. 0.05 for +5 points. */
  volChange: number;
  /** Days from `asOf`. */
  daysPassed: number;
  /** Additive change in the risk-free rate. */
  rateChange: number;
}

export interface ScenarioResult extends ScenarioSpec {
  spot: number;
  date: string;
  value: number;
  profit: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Re-values the position under each scenario.
 *
 * All four dimensions move together rather than one at a time, because that is
 * how markets behave: a 10% fall usually comes with a volatility rise, and a
 * table that shows them separately lets a reader add the two effects when the
 * real combination is not their sum.
 */
export function runScenarios(
  position: OptionPosition,
  options: { spot: number; asOf: string; scenarios: ScenarioSpec[] },
): ScenarioResult[] {
  return options.scenarios.map((s) => {
    const spot = options.spot * (1 + s.spotChange);
    const date = addDays(options.asOf, s.daysPassed);
    const v = valuePosition(position, {
      spot,
      asOf: date,
      volShift: s.volChange,
      rateShift: s.rateChange,
    });
    return {
      ...s,
      spot,
      date,
      value: v.value,
      profit: v.profit,
      delta: v.greeks.delta,
      gamma: v.greeks.gamma,
      theta: v.greeks.theta,
      vega: v.greeks.vega,
      rho: v.greeks.rho,
    };
  });
}

/** The standard grid: price moves against time, at unchanged volatility. */
export function defaultScenarios(): ScenarioSpec[] {
  const out: ScenarioSpec[] = [];
  for (const days of [0, 7, 30]) {
    for (const move of [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2]) {
      out.push({
        label: `${move >= 0 ? '+' : ''}${(move * 100).toFixed(0)}% · ${days}d`,
        spotChange: move,
        volChange: 0,
        daysPassed: days,
        rateChange: 0,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Monte Carlo                                                         */
/* ------------------------------------------------------------------ */

export interface MonteCarloOptions {
  spot: number;
  /** Annualised volatility as a decimal. */
  volatility: number;
  /** Annual drift as a decimal. Risk-neutral by default; see the note. */
  drift: number;
  asOf: string;
  paths: number;
  /** Steps per path. More matters only for path-dependent measures. */
  steps?: number;
  seed?: number;
}

export interface MonteCarloResult {
  paths: number;
  /** Terminal profit distribution summary. */
  mean: number;
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  min: number;
  max: number;
  probabilityOfLoss: number;
  /** Histogram of terminal profit. */
  histogram: Array<{ from: number; to: number; count: number }>;
  /** Sample terminal prices, for charting. */
  terminalSpots: number[];
  assumptions: string;
}

/** Deterministic generator, so a simulation can be reproduced exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulates terminal outcomes under geometric Brownian motion.
 *
 * Seeded, so the same configuration gives the same answer — an unreproducible
 * risk number is not one anybody can check. The drift is a separate input from
 * the risk-free rate on purpose: under the risk-neutral drift this agrees with
 * the option prices and answers "what does the market imply", while a drift a
 * user supplies answers "what if I am right about direction", which is a
 * different and clearly-labelled question.
 *
 * GBM shares Black–Scholes' thin tails, so the extreme percentiles are
 * optimistic. Stated rather than corrected: a fatter-tailed simulation would
 * disagree with the prices being simulated.
 */
export function monteCarlo(
  position: OptionPosition,
  options: MonteCarloOptions,
): MonteCarloResult {
  const expiryDates = expiries(position);
  const finalExpiry = expiryDates[expiryDates.length - 1] ?? options.asOf;
  const T = yearsBetween(options.asOf, finalExpiry);
  const n = Math.max(100, Math.min(200_000, Math.round(options.paths)));
  const rand = mulberry32(options.seed ?? 12345);

  const sigma = Math.max(1e-8, options.volatility);
  const drift = options.drift;
  const profits = new Float64Array(n);
  const terminals = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    // Box–Muller from the seeded uniform stream.
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const terminal = options.spot * Math.exp((drift - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z);
    terminals[i] = terminal;
    profits[i] = profitAtExpiry(position, terminal);
  }

  const sorted = Array.from(profits).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const losses = sorted.filter((p) => p < 0).length;

  // Histogram over the observed range, which keeps every bin populated rather
  // than padding the tails with empty ones.
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const bins = 40;
  const width = (max - min) / bins || 1;
  const histogram = Array.from({ length: bins }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
  }));
  for (const p of sorted) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((p - min) / width)));
    histogram[idx].count++;
  }

  return {
    paths: n,
    mean,
    median: at(0.5),
    p5: at(0.05),
    p25: at(0.25),
    p75: at(0.75),
    p95: at(0.95),
    min,
    max,
    probabilityOfLoss: losses / n,
    histogram,
    terminalSpots: Array.from(terminals.slice(0, Math.min(2000, n))),
    assumptions:
      `${n.toLocaleString()} geometric Brownian motion paths at ${(sigma * 100).toFixed(1)}% ` +
      `volatility and ${(drift * 100).toFixed(2)}% annual drift over ${(T * 365).toFixed(0)} days, ` +
      'seeded so the result reproduces exactly. These are simulated values, not market data, ' +
      'and GBM has thinner tails than real returns — the extreme percentiles are optimistic.',
  };
}
