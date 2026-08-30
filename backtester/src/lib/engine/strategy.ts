import type { IsoDate } from '@/lib/types';
import type { PreparedAsset } from './types';
import { estimateMoments } from '@/lib/analysis/correlated';
import {
  minimumVariance,
  riskParity,
  type OptimiseOptions,
  type OptimisedPortfolio,
} from '@/lib/analysis/optimise';

/**
 * Target-weight strategies.
 * =============================================================================
 * Before this existed, target weights were computed ONCE before the day loop
 * from static position weights. That made momentum, factor tilts, glidepaths
 * and optimisation impossible to express: every one of them needs weights to be
 * a function of date and portfolio state rather than a constant.
 *
 * A strategy is asked for weights at each rebalance. It returns fractions of
 * the whole portfolio; anything it leaves unallocated stays in cash.
 *
 * LOOK-AHEAD
 *
 * The context deliberately exposes no way to read a price after the current
 * day. `priceAt` clamps its index, so a strategy cannot see the future even by
 * accident — which is the single easiest way to produce a backtest that looks
 * extraordinary and means nothing. `tests/strategy.test.ts` asserts this
 * behaviourally, by running the same strategy against two datasets that differ
 * only after the decision date and requiring identical decisions.
 */

export interface StrategyContext {
  /** The day the decision is being made. */
  date: IsoDate;
  /** Index of that day on the master calendar. */
  index: number;
  /** Fraction of the backtest elapsed, 0 at the start and 1 at the end. */
  progress: number;
  /** Holdings available to allocate across, excluding any cash sleeve. */
  assets: readonly PreparedAsset[];
  /** The weights the user declared, as fractions. The baseline to tilt from. */
  declaredWeights: ReadonlyMap<string, number>;
  /** Portfolio value at this point, for strategies that scale with size. */
  totalValue: number;
  /**
   * Close for `symbol` `daysAgo` sessions back, or NaN when unavailable.
   * Negative values are clamped to zero: a strategy cannot read the future.
   */
  priceAt(symbol: string, daysAgo: number): number;
  /** Trailing total return over `lookbackDays`, or null when unavailable. */
  trailingReturn(symbol: string, lookbackDays: number): number | null;
}

export interface TargetWeightStrategy {
  id: string;
  label: string;
  /** Fractions of the whole portfolio. Any shortfall remains in cash. */
  targetWeights(ctx: StrategyContext): Map<string, number>;
}

/* ------------------------------------------------------------------ */

/**
 * The declared weights, unchanged. The default, and behaviourally identical to
 * the engine before strategies existed — the existing suite is the proof.
 */
export const fixedWeights: TargetWeightStrategy = {
  id: 'fixed',
  label: 'Fixed weights',
  targetWeights: (ctx) => new Map(ctx.declaredWeights),
};

export interface GlidepathOptions {
  /** Symbols treated as the growth sleeve. The rest are the defensive sleeve. */
  growthSymbols: string[];
  /** Growth allocation at the start, as a fraction. */
  startGrowth: number;
  /** Growth allocation at the end. */
  endGrowth: number;
}

/**
 * A linear glidepath: shifts from a growth sleeve to a defensive one as the
 * horizon shortens, which is what a target-date fund does.
 *
 * Within each sleeve the declared proportions are preserved, so a user who
 * split their equity 70/30 between two funds keeps that split as the sleeve
 * shrinks.
 */
export function glidepath(options: GlidepathOptions): TargetWeightStrategy {
  const growth = new Set(options.growthSymbols.map((s) => s.toUpperCase()));
  return {
    id: 'glidepath',
    label: 'Glidepath',
    targetWeights(ctx) {
      const target = options.startGrowth + (options.endGrowth - options.startGrowth) * ctx.progress;
      const growthTarget = Math.max(0, Math.min(1, target));

      let declaredGrowth = 0;
      let declaredDefensive = 0;
      for (const [symbol, w] of ctx.declaredWeights) {
        if (growth.has(symbol.toUpperCase())) declaredGrowth += w;
        else declaredDefensive += w;
      }

      const out = new Map<string, number>();
      for (const [symbol, w] of ctx.declaredWeights) {
        const isGrowth = growth.has(symbol.toUpperCase());
        const sleeveDeclared = isGrowth ? declaredGrowth : declaredDefensive;
        const sleeveTarget = isGrowth ? growthTarget : 1 - growthTarget;
        // Preserve the split inside each sleeve; an empty sleeve gets nothing.
        out.set(symbol, sleeveDeclared > 0 ? (w / sleeveDeclared) * sleeveTarget : 0);
      }
      return out;
    },
  };
}

export interface MomentumOptions {
  /** Trailing window used to rank, in trading days. */
  lookbackDays: number;
  /** How many of the top-ranked holdings to hold. */
  holdCount: number;
  /**
   * Skip holdings whose trailing return is below this. Unallocated weight
   * stays in cash, which is what makes this a defensive rule rather than
   * merely a rotation.
   */
  minimumReturn?: number;
}

/**
 * Cross-sectional momentum: hold the strongest N of the declared holdings over
 * a trailing window, equally weighted.
 *
 * Ranks only on data available at the decision date. Where fewer than N
 * holdings clear the threshold, the remainder stays in cash rather than being
 * forced into weaker ones.
 */
export function momentum(options: MomentumOptions): TargetWeightStrategy {
  const minimum = options.minimumReturn ?? Number.NEGATIVE_INFINITY;
  return {
    id: 'momentum',
    label: `Momentum (top ${options.holdCount}, ${options.lookbackDays}d)`,
    targetWeights(ctx) {
      const ranked = [...ctx.declaredWeights.keys()]
        .map((symbol) => ({ symbol, r: ctx.trailingReturn(symbol, options.lookbackDays) }))
        .filter((x): x is { symbol: string; r: number } => x.r != null && x.r >= minimum)
        .sort((a, b) => b.r - a.r)
        .slice(0, Math.max(1, options.holdCount));

      const out = new Map<string, number>();
      // Everything starts at zero so unheld positions are explicitly sold
      // rather than left at whatever they drifted to.
      for (const symbol of ctx.declaredWeights.keys()) out.set(symbol, 0);
      if (!ranked.length) return out;

      const each = 1 / ranked.length;
      for (const { symbol } of ranked) out.set(symbol, each);
      return out;
    },
  };
}

/**
 * Builds the context handed to a strategy, with the look-ahead bound enforced
 * here rather than trusted to each implementation.
 */
export function makeContext(
  index: number,
  calendar: IsoDate[],
  assets: readonly PreparedAsset[],
  declaredWeights: ReadonlyMap<string, number>,
  totalValue: number,
): StrategyContext {
  const byName = new Map(assets.map((a) => [a.symbol, a]));

  const priceAt = (symbol: string, daysAgo: number): number => {
    const asset = byName.get(symbol);
    if (!asset) return Number.NaN;
    // Clamped at both ends: never past today, never before the series starts.
    const i = Math.max(0, index - Math.max(0, daysAgo));
    const p = asset.prices[i];
    return Number.isFinite(p) ? p : Number.NaN;
  };

  return {
    date: calendar[index],
    index,
    progress: calendar.length > 1 ? index / (calendar.length - 1) : 0,
    assets,
    declaredWeights,
    totalValue,
    priceAt,
    trailingReturn(symbol, lookbackDays) {
      const now = priceAt(symbol, 0);
      const then = priceAt(symbol, lookbackDays);
      if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) return null;
      // Too early in the series for a full window: refuse rather than report a
      // shorter one, which would rank holdings on unequal periods.
      if (index - lookbackDays < 0) return null;
      return now / then - 1;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Further rules                                                       */
/* ------------------------------------------------------------------ */

/**
 * Equal weight across every declared holding.
 *
 * Worth having as a rule rather than as advice to retype the weights, because
 * it stays equal: with contributions and drift, a portfolio typed as equal
 * stops being equal within a year, and the difference between the two is
 * exactly what a rebalancing study is trying to measure.
 */
export const equalWeight: TargetWeightStrategy = {
  id: 'equal',
  label: 'Equal weight',
  targetWeights(ctx) {
    const symbols = [...ctx.declaredWeights.keys()];
    const out = new Map<string, number>();
    if (!symbols.length) return out;
    const each = 1 / symbols.length;
    for (const s of symbols) out.set(s, each);
    return out;
  },
};

export interface TrendOptions {
  /** Moving-average window, in trading days. */
  windowDays: number;
}

/**
 * A trend filter: hold a position while it is above its own moving average,
 * and sit in cash while it is below.
 *
 * The weights of the holdings that pass are scaled up to fill the portfolio
 * only if the others are absent — they are not. Each holding keeps its
 * declared weight and a failing one goes to cash, so the rule answers "what
 * would staying out of falling markets have done to this portfolio" rather
 * than silently turning it into a concentrated bet on whatever is rising.
 *
 * The average is over closes up to and including the decision day, which is
 * the only version of it that could have been computed at the time. Using the
 * window centred on the day, or ending the day after, is the classic way this
 * strategy backtests beautifully and cannot be traded.
 */
export function trendFilter(options: TrendOptions): TargetWeightStrategy {
  const window = Math.max(2, Math.round(options.windowDays));
  return {
    id: 'trend',
    label: `Trend filter (${window}d)`,
    targetWeights(ctx) {
      const out = new Map<string, number>();
      for (const [symbol, weight] of ctx.declaredWeights) {
        const today = ctx.priceAt(symbol, 0);
        if (!Number.isFinite(today)) {
          out.set(symbol, 0);
          continue;
        }
        // Refuse to decide on a partial window rather than compare against an
        // average of three days, which is not a trend.
        if (ctx.index < window - 1) {
          out.set(symbol, weight);
          continue;
        }
        let sum = 0;
        let n = 0;
        for (let back = 0; back < window; back++) {
          const p = ctx.priceAt(symbol, back);
          if (Number.isFinite(p)) {
            sum += p;
            n++;
          }
        }
        const average = n > 0 ? sum / n : Number.NaN;
        out.set(symbol, Number.isFinite(average) && today > average ? weight : 0);
      }
      return out;
    },
  };
}

export interface InverseVolatilityOptions {
  /** Window over which volatility is measured, in trading days. */
  lookbackDays: number;
}

/**
 * Weight inversely to trailing volatility, so each holding contributes a more
 * even share of the portfolio's movement.
 *
 * This is the cheap cousin of risk parity: it equalises volatility
 * contribution while ignoring correlation, where true risk parity solves for
 * equal marginal contribution to portfolio risk. Ignoring correlation is a
 * real approximation and it is named as one — two holdings that move together
 * are treated as diversifying here, and are not.
 *
 * A holding with no measurable volatility gets nothing rather than infinite
 * weight, which is what dividing by zero would otherwise buy.
 */
export function inverseVolatility(options: InverseVolatilityOptions): TargetWeightStrategy {
  const lookback = Math.max(2, Math.round(options.lookbackDays));
  return {
    id: 'inverseVolatility',
    label: `Inverse volatility (${lookback}d)`,
    targetWeights(ctx) {
      const out = new Map<string, number>();
      const inverse = new Map<string, number>();
      let total = 0;

      for (const symbol of ctx.declaredWeights.keys()) {
        out.set(symbol, 0);
        if (ctx.index < lookback) continue;

        // Daily log returns over the window, from closes available today.
        const returns: number[] = [];
        for (let back = 0; back < lookback; back++) {
          const now = ctx.priceAt(symbol, back);
          const prev = ctx.priceAt(symbol, back + 1);
          if (Number.isFinite(now) && Number.isFinite(prev) && prev > 0 && now > 0) {
            returns.push(Math.log(now / prev));
          }
        }
        if (returns.length < 2) continue;

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance =
          returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (returns.length - 1);
        const vol = Math.sqrt(variance);
        if (!Number.isFinite(vol) || vol <= 0) continue;

        const inv = 1 / vol;
        inverse.set(symbol, inv);
        total += inv;
      }

      // Before the window is full, or where nothing could be measured, fall
      // back to what the user declared rather than to an arbitrary split.
      if (total <= 0) return new Map(ctx.declaredWeights);
      for (const [symbol, inv] of inverse) out.set(symbol, inv / total);
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/**
 * Overlays, and why a strategy is two layers rather than one.
 * =============================================================================
 * The rules above each answer the whole question at once, which means they
 * cannot be combined. A trend filter and a momentum rotation are not
 * alternatives — holding the strongest holdings, and stepping out of the ones
 * that have rolled over, are different decisions that most people want to make
 * together. Expressed as six mutually exclusive rules, that costs one new rule
 * for every pair, and the useful combinations are exactly the ones nobody
 * writes.
 *
 * So a strategy is a BASE that decides target weights from nothing, and any
 * number of OVERLAYS that transform the weights it produced. The base answers
 * "what do I want to hold"; each overlay answers "and how much of that, given
 * what the market is doing".
 *
 * An overlay may only ever reduce or redistribute. None of them can invent
 * exposure the base did not ask for, and anything an overlay removes falls to
 * cash, which is what makes a stack of them safe to reason about: the result
 * is never more invested than the base intended.
 */
export interface WeightOverlay {
  id: string;
  label: string;
  apply(weights: Map<string, number>, ctx: StrategyContext): Map<string, number>;
}

/** Runs a base rule, then each overlay in order. */
export function compose(
  base: TargetWeightStrategy,
  overlays: readonly WeightOverlay[],
): TargetWeightStrategy {
  if (!overlays.length) return base;
  return {
    id: `${base.id}+${overlays.map((o) => o.id).join('+')}`,
    label: `${base.label} · ${overlays.map((o) => o.label).join(' · ')}`,
    targetWeights(ctx) {
      let w = base.targetWeights(ctx);
      for (const overlay of overlays) w = overlay.apply(w, ctx);
      return w;
    },
  };
}

/** Trailing simple returns per symbol, shaped for `estimateMoments`. */
function trailingReturns(
  symbols: string[],
  ctx: StrategyContext,
  lookbackDays: number,
): number[][] | null {
  if (ctx.index < lookbackDays) return null;
  const rows: number[][] = [];
  for (const symbol of symbols) {
    const row: number[] = [];
    for (let back = lookbackDays - 1; back >= 0; back--) {
      const now = ctx.priceAt(symbol, back);
      const prev = ctx.priceAt(symbol, back + 1);
      if (!Number.isFinite(now) || !Number.isFinite(prev) || prev <= 0) return null;
      row.push(now / prev - 1);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The trend filter as an overlay, so it can sit on top of any base.
 *
 * Identical arithmetic to `trendFilter`, applied to whatever weights arrived
 * rather than to the declared ones — which is the whole point: a trend filter
 * over a momentum rotation is a different and more useful strategy than
 * either alone, and was inexpressible while every rule read `declaredWeights`.
 */
export function trendOverlay(options: TrendOptions): WeightOverlay {
  const window = Math.max(2, Math.round(options.windowDays));
  return {
    id: `trend${window}`,
    label: `above ${window}d average`,
    apply(weights, ctx) {
      const out = new Map<string, number>();
      for (const [symbol, weight] of weights) {
        if (weight <= 0 || ctx.index < window - 1) {
          out.set(symbol, weight);
          continue;
        }
        let sum = 0;
        let n = 0;
        for (let back = 0; back < window; back++) {
          const p = ctx.priceAt(symbol, back);
          if (Number.isFinite(p)) {
            sum += p;
            n++;
          }
        }
        const today = ctx.priceAt(symbol, 0);
        const average = n > 0 ? sum / n : Number.NaN;
        out.set(symbol, Number.isFinite(average) && today > average ? weight : 0);
      }
      return out;
    },
  };
}

export interface VolatilityTargetOptions {
  /** Annualised portfolio volatility to aim for, as a fraction. */
  targetVol: number;
  /** Window over which realised volatility is measured, in trading days. */
  lookbackDays: number;
  /** Periods per year, for annualising. */
  periodsPerYear: number;
}

/**
 * Volatility targeting: scale total exposure so the portfolio's expected
 * volatility sits near a target, leaving the rest in cash.
 *
 * This is the overlay that changes the shape of a return distribution most
 * directly, and it is deliberately one-sided — it can cut exposure but never
 * raise it above what the base asked for. Scaling *up* when markets are calm
 * is leverage, and a backtest that quietly levers up in the quiet years before
 * a crash produces a number nobody could have traded.
 *
 * It uses the full covariance rather than a weighted average of individual
 * volatilities, so a portfolio of holdings that move together is correctly
 * seen as riskier than the same holdings uncorrelated.
 */
export function volatilityTargetOverlay(options: VolatilityTargetOptions): WeightOverlay {
  const lookback = Math.max(2, Math.round(options.lookbackDays));
  const target = Math.max(0, options.targetVol);
  return {
    id: `voltarget${Math.round(target * 100)}`,
    label: `${Math.round(target * 100)}% volatility target`,
    apply(weights, ctx) {
      const held = [...weights.entries()].filter(([, w]) => w > 0);
      if (!held.length || target <= 0) return weights;

      const symbols = held.map(([s]) => s);
      const rows = trailingReturns(symbols, ctx, lookback);
      // Not enough history to measure risk is not a reason to assume there is
      // none; leave the base's weights untouched.
      if (!rows) return weights;

      // Portfolio variance w'Σw on the held sleeve, renormalised so the
      // measurement is of the invested portion rather than of a part of it.
      const invested = held.reduce((a, [, w]) => a + w, 0);
      if (invested <= 0) return weights;
      const rel = held.map(([, w]) => w / invested);

      const T = rows[0].length;
      const means = rows.map((r) => r.reduce((a, b) => a + b, 0) / T);
      let variance = 0;
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows.length; j++) {
          let cov = 0;
          for (let t = 0; t < T; t++) {
            cov += (rows[i][t] - means[i]) * (rows[j][t] - means[j]);
          }
          variance += rel[i] * rel[j] * (cov / (T - 1));
        }
      }
      if (!(variance > 0)) return weights;

      const realised = Math.sqrt(variance * options.periodsPerYear);
      if (!Number.isFinite(realised) || realised <= 0) return weights;

      // Never above 1: this de-risks, it does not lever.
      const scale = Math.min(1, target / realised);
      const out = new Map<string, number>();
      for (const [symbol, w] of weights) out.set(symbol, w * scale);
      return out;
    },
  };
}

/**
 * Caps any single holding and hands the excess to the others in proportion.
 *
 * Redistribution stops when everything is at the cap, rather than looping
 * forever trying to place weight that has nowhere to go — a cap of 20% across
 * three holdings cannot invest more than 60%, and the remaining 40% belongs in
 * cash rather than in an infinite loop.
 */
export function capOverlay(maxWeight: number): WeightOverlay {
  const cap = Math.max(0, Math.min(1, maxWeight));
  return {
    id: `cap${Math.round(cap * 100)}`,
    label: `${Math.round(cap * 100)}% cap`,
    apply(weights) {
      const out = new Map(weights);
      for (let pass = 0; pass < 20; pass++) {
        let excess = 0;
        const room: string[] = [];
        for (const [symbol, w] of out) {
          if (w > cap) {
            excess += w - cap;
            out.set(symbol, cap);
          } else if (w > 0 && w < cap) {
            room.push(symbol);
          }
        }
        if (excess <= 1e-12 || !room.length) break;
        const capacity = room.reduce((a, s) => a + (cap - (out.get(s) ?? 0)), 0);
        if (capacity <= 1e-12) break;
        const share = Math.min(1, excess / capacity);
        for (const s of room) {
          const w = out.get(s) ?? 0;
          out.set(s, w + (cap - w) * share);
        }
      }
      return out;
    },
  };
}

export interface OptimisedOptions {
  /** Window the covariance is estimated over, in trading days. */
  lookbackDays: number;
  periodsPerYear: number;
  /** Ledoit–Wolf shrinkage toward constant correlation. */
  shrink: boolean;
  maxWeight?: number;
}

/**
 * Mean-variance rules, re-solved at every rebalance on trailing data.
 * =============================================================================
 * The optimiser page already solves these, once, on the whole history — which
 * answers "what allocation would have been best", a question that can only be
 * asked afterwards. Running the same solver inside the day loop answers the
 * one an investor can actually act on: what allocation would each rebalance
 * have chosen, knowing only what had happened by then.
 *
 * The two give materially different answers, and the difference is the cost of
 * not knowing the future. That gap is the single most useful thing this can
 * show, and it is invisible while the optimiser only runs in hindsight.
 *
 * Estimation failures fall back to the weights that arrived rather than
 * throwing: too little history, a singular covariance or a holding with no
 * prices are all ordinary early in a backtest, and a strategy that aborts the
 * run over them is useless.
 */
function optimisedBase(
  id: string,
  label: string,
  solve: (opts: OptimiseOptions) => OptimisedPortfolio,
  options: OptimisedOptions,
): TargetWeightStrategy {
  const lookback = Math.max(30, Math.round(options.lookbackDays));
  return {
    id,
    label,
    targetWeights(ctx) {
      const symbols = [...ctx.declaredWeights.keys()];
      const fallback = () => new Map(ctx.declaredWeights);
      if (symbols.length < 2) return fallback();

      const rows = trailingReturns(symbols, ctx, lookback);
      if (!rows) return fallback();

      try {
        const moments = estimateMoments(symbols, rows, { shrink: options.shrink });
        const solved = solve({
          moments,
          periodsPerYear: options.periodsPerYear,
          maxWeight: options.maxWeight ?? 1,
        });
        const out = new Map<string, number>();
        symbols.forEach((s, i) => out.set(s, Math.max(0, solved.weights[i] ?? 0)));
        return out;
      } catch {
        // A singular covariance or too few observations. Ordinary early on.
        return fallback();
      }
    },
  };
}

export function minimumVarianceStrategy(options: OptimisedOptions): TargetWeightStrategy {
  return optimisedBase(
    'minimumVariance',
    `Minimum variance (${options.lookbackDays}d)`,
    minimumVariance,
    options,
  );
}

export function riskParityStrategy(options: OptimisedOptions): TargetWeightStrategy {
  return optimisedBase(
    'riskParity',
    `Risk parity (${options.lookbackDays}d)`,
    riskParity,
    options,
  );
}
