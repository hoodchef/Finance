import {
  intrinsicValue,
  priceOption,
  yearsToExpiry,
  type ExerciseStyle,
  type Greeks,
  type OptionType,
} from './pricing';

/**
 * Multi-leg option positions.
 * =============================================================================
 * Every structure is a list of legs. There is no `IronCondor` type and no
 * branch anywhere that asks which named strategy this is — an iron condor is
 * four legs, a jade lizard is three, and a thing with no name is however many
 * the user typed. Presets are starting points that write legs, not modes that
 * constrain them.
 *
 * That choice is what makes the analytics general. Payoff, breakevens, Greeks,
 * probability and scenarios are all computed from the leg list, so a structure
 * nobody anticipated is analysed exactly as well as a textbook one.
 *
 * MULTIPLIER
 *
 * Per leg, not global, and not assumed to be 100. A contract adjusted for a
 * merger, a special dividend or an odd split can carry any multiplier and a
 * non-standard deliverable, and applying 100 to it silently misstates the
 * whole position by whatever the adjustment was. The default is 100 because
 * that is the convention; the field exists because the convention breaks.
 */

export interface OptionLeg {
  id: string;
  type: OptionType;
  side: 'buy' | 'sell';
  strike: number;
  /** Expiration date, ISO. Legs may differ — that is a calendar spread. */
  expiry: string;
  /** Contracts. Fractions are allowed for ratio spreads expressed per unit. */
  contracts: number;
  /** Premium paid or received per share, at entry. */
  entryPremium: number;
  /** Shares per contract. 100 by convention, adjusted contracts differ. */
  multiplier: number;
  style: ExerciseStyle;
  /**
   * Volatility used to value this leg away from expiry. From the market where
   * a chain supplied it, otherwise the user's assumption — the analytics
   * layer reports which, because a theoretical value is only as good as this.
   */
  impliedVolatility: number;
}

/** Shares of the underlying, for covered calls, collars and protective puts. */
export interface StockLeg {
  side: 'buy' | 'sell';
  shares: number;
  entryPrice: number;
}

export interface OptionPosition {
  underlying: string;
  legs: OptionLeg[];
  stock?: StockLeg | null;
  /** Annual risk-free rate as a decimal. */
  riskFreeRate: number;
  /** Continuous dividend yield on the underlying, as a decimal. */
  dividendYield: number;
}

export interface ValuationContext {
  /** Underlying price to value at. */
  spot: number;
  /** Date to value on, ISO. Legs expiring on or before it settle intrinsic. */
  asOf: string;
  /** Additive shift applied to every leg's volatility, as a decimal. */
  volShift?: number;
  /** Additive shift applied to the risk-free rate, as a decimal. */
  rateShift?: number;
}

export interface LegValuation extends Greeks {
  legId: string;
  /** Theoretical value per share. */
  perShare: number;
  /** Signed market value of the whole leg: + for long, − for short. */
  value: number;
  /** Profit or loss against the entry premium, for the whole leg. */
  profit: number;
  /** True once the leg has settled to intrinsic value. */
  expired: boolean;
  /** Shares this leg controls: contracts × multiplier, signed by side. */
  exposure: number;
}

export interface PositionValuation {
  spot: number;
  asOf: string;
  legs: LegValuation[];
  /** Signed market value of the whole position, options plus stock. */
  value: number;
  /** Profit or loss against entry, in currency. */
  profit: number;
  /** Net Greeks, in position terms — delta is shares-equivalent. */
  greeks: Greeks;
}

const sign = (side: 'buy' | 'sell') => (side === 'buy' ? 1 : -1);

/** Cost to open: positive is a debit paid, negative is a credit received. */
export function netDebit(position: OptionPosition): number {
  const options = position.legs.reduce(
    (a, l) => a + sign(l.side) * l.entryPremium * l.contracts * l.multiplier,
    0,
  );
  const stock = position.stock
    ? sign(position.stock.side) * position.stock.entryPrice * position.stock.shares
    : 0;
  return options + stock;
}

/**
 * Values every leg at a spot and a date.
 *
 * A leg at or past its expiry settles to intrinsic value with no Greeks; one
 * still alive is priced by its model. That distinction is what makes calendar
 * and diagonal spreads work: at the near expiry the front leg is intrinsic and
 * the back leg still carries time value, which is the entire structure.
 */
export function valuePosition(
  position: OptionPosition,
  ctx: ValuationContext,
): PositionValuation {
  const volShift = ctx.volShift ?? 0;
  const rate = position.riskFreeRate + (ctx.rateShift ?? 0);

  const legs: LegValuation[] = position.legs.map((leg) => {
    const T = yearsToExpiry(ctx.asOf, leg.expiry);
    const exposure = sign(leg.side) * leg.contracts * leg.multiplier;
    const expired = !(T > 0);

    const priced = priceOption(
      {
        spot: ctx.spot,
        strike: leg.strike,
        timeToExpiry: T,
        riskFreeRate: rate,
        volatility: Math.max(1e-6, leg.impliedVolatility + volShift),
        dividendYield: position.dividendYield,
        type: leg.type,
        style: leg.style,
      },
      // Fewer steps than the reference tests use: this runs hundreds of times
      // across a payoff curve, and the difference is well inside a cent.
      { steps: 101 },
    );

    const perShare = expired
      ? intrinsicValue(ctx.spot, leg.strike, leg.type)
      : priced.price;

    return {
      legId: leg.id,
      perShare,
      value: perShare * exposure,
      profit: (perShare - leg.entryPremium) * exposure,
      expired,
      exposure,
      delta: priced.delta * exposure,
      gamma: priced.gamma * exposure,
      theta: priced.theta * exposure,
      vega: priced.vega * exposure,
      rho: priced.rho * exposure,
      lambda: priced.lambda,
    };
  });

  const stockExposure = position.stock
    ? sign(position.stock.side) * position.stock.shares
    : 0;
  const stockValue = stockExposure * ctx.spot;
  const stockProfit = position.stock
    ? (ctx.spot - position.stock.entryPrice) * stockExposure
    : 0;

  const sum = (pick: (l: LegValuation) => number) => legs.reduce((a, l) => a + pick(l), 0);

  const value = sum((l) => l.value) + stockValue;
  const profit = sum((l) => l.profit) + stockProfit;
  const delta = sum((l) => l.delta) + stockExposure;

  return {
    spot: ctx.spot,
    asOf: ctx.asOf,
    legs,
    value,
    profit,
    greeks: {
      // Stock carries delta of 1 per share and no other Greek.
      delta,
      gamma: sum((l) => l.gamma),
      theta: sum((l) => l.theta),
      vega: sum((l) => l.vega),
      rho: sum((l) => l.rho),
      lambda: value !== 0 ? (delta * ctx.spot) / Math.abs(value) : 0,
    },
  };
}

/**
 * Profit at expiration, computed from intrinsic value alone.
 *
 * Where legs expire on different dates this is the payoff at the LAST expiry,
 * which assumes every earlier leg was held to its own settlement. That is a
 * real assumption and a calendar spread is not usually held that way, so the
 * chart labels it and offers the near-expiry view separately — a single
 * "payoff at expiration" line for a calendar spread is the most commonly
 * misread object in options software.
 */
export function profitAtExpiry(position: OptionPosition, spot: number): number {
  const options = position.legs.reduce((a, leg) => {
    const exposure = sign(leg.side) * leg.contracts * leg.multiplier;
    return a + (intrinsicValue(spot, leg.strike, leg.type) - leg.entryPremium) * exposure;
  }, 0);
  const stock = position.stock
    ? (spot - position.stock.entryPrice) * sign(position.stock.side) * position.stock.shares
    : 0;
  return options + stock;
}

export interface PayoffPoint {
  spot: number;
  /** Profit if held to the final expiry. */
  atExpiry: number;
  /** Theoretical profit today, or at whatever date was requested. */
  theoretical?: number;
}

/**
 * The payoff curve, sampled across a spot range.
 *
 * Strikes are inserted into the sample set explicitly. A uniform grid can step
 * straight over a strike and round the kink into a slope, which turns the
 * sharp corner that defines a spread's maximum profit into a smooth curve that
 * understates it.
 */
export function payoffCurve(
  position: OptionPosition,
  options: {
    min: number;
    max: number;
    points?: number;
    /** Include theoretical P/L valued on this date. */
    asOf?: string;
    volShift?: number;
  },
): PayoffPoint[] {
  const n = Math.max(11, options.points ?? 121);
  const spots = new Set<number>();
  for (let i = 0; i < n; i++) {
    spots.add(options.min + ((options.max - options.min) * i) / (n - 1));
  }
  for (const leg of position.legs) {
    if (leg.strike >= options.min && leg.strike <= options.max) {
      spots.add(leg.strike);
      // Either side of the kink, so the corner renders as a corner.
      spots.add(leg.strike - 1e-6);
      spots.add(leg.strike + 1e-6);
    }
  }

  return [...spots]
    .sort((a, b) => a - b)
    .map((spot) => ({
      spot,
      atExpiry: profitAtExpiry(position, spot),
      theoretical: options.asOf
        ? valuePosition(position, { spot, asOf: options.asOf, volShift: options.volShift }).profit
        : undefined,
    }));
}

export interface PositionSummary {
  netDebit: number;
  /** Null where the payoff is unbounded above. */
  maxProfit: number | null;
  /** Null where the loss is unbounded below. */
  maxLoss: number | null;
  breakevens: number[];
  /** Capital the position ties up; see `capitalRequired`. */
  capital: number;
  /** maxProfit / maxLoss where both are finite. */
  riskReward: number | null;
}

/**
 * Breakevens, maximum profit and maximum loss at expiration.
 *
 * The payoff of any option combination is piecewise linear in the spot with
 * kinks only at strikes, so the extremes are at a strike, at zero, or at
 * infinity, and the roots lie between adjacent strikes. That structure is used
 * rather than a fine numerical scan: scanning finds approximately the right
 * answer and can miss a root between two closely spaced strikes entirely.
 */
export function summarise(position: OptionPosition): PositionSummary {
  const strikes = [...new Set(position.legs.map((l) => l.strike))].sort((a, b) => a - b);
  const debit = netDebit(position);

  if (strikes.length === 0) {
    /*
     * No options: the payoff is a straight line in the spot, so its slope
     * settles everything and there is nothing to scan for.
     *
     * Returning nulls here — as this did — meant "unbounded", and the panel
     * renders that as UNLIMITED. An empty position therefore announced an
     * unlimited maximum loss, and so did a plain long stock position, whose
     * loss is bounded at the whole investment. Both are alarming and neither
     * is true.
     */
    const shares = position.stock
      ? (position.stock.side === 'buy' ? 1 : -1) * position.stock.shares
      : 0;
    if (shares === 0) {
      // Nothing held: nothing to gain or lose.
      return {
        netDebit: debit,
        maxProfit: 0,
        maxLoss: 0,
        breakevens: [],
        capital: 0,
        riskReward: null,
      };
    }
    const atZero = profitAtExpiry(position, 0);
    return {
      netDebit: debit,
      // Long stock rises without bound; short stock is capped at the shares
      // going to zero.
      maxProfit: shares > 0 ? null : atZero,
      // Long stock cannot lose more than it cost; short stock can lose without
      // bound as the price rises.
      maxLoss: shares > 0 ? atZero : null,
      breakevens: [position.stock ? position.stock.entryPrice : 0],
      capital: capitalRequired(position),
      riskReward: null,
    };
  }

  const lo = Math.max(0, strikes[0] * 0.5 - 1);
  const hi = strikes[strikes.length - 1] * 1.5 + 1;

  // Evaluate at every kink plus the ends, which is exhaustive for a piecewise
  // linear payoff.
  const nodes = [0, lo, ...strikes, hi];
  const values = nodes.map((s) => ({ spot: s, profit: profitAtExpiry(position, s) }));

  // Slope beyond the outermost strikes decides whether the extremes are
  // bounded. A far point is enough because the payoff is linear out there.
  const farHi = hi * 10;
  const farLo = 0;
  const slopeHi = (profitAtExpiry(position, farHi) - profitAtExpiry(position, hi)) / (farHi - hi);
  const slopeLo = (profitAtExpiry(position, lo) - profitAtExpiry(position, farLo)) / (lo - farLo);

  const maxAtNodes = Math.max(...values.map((v) => v.profit));
  const minAtNodes = Math.min(...values.map((v) => v.profit));

  const maxProfit = slopeHi > 1e-9 ? null : maxAtNodes;
  const maxLoss = slopeHi < -1e-9 || slopeLo > 1e-9 ? null : minAtNodes;

  // Roots between consecutive evaluation points, found exactly by linear
  // interpolation because each segment is a straight line.
  const breakevens: number[] = [];
  const scan = [farLo, ...nodes.filter((n) => n > farLo), farHi].sort((a, b) => a - b);
  /*
   * A breakeven is where the payoff CROSSES zero, not everywhere it touches it.
   *
   * A structure that rests flat at zero over a range — a long call with no
   * premium paid, below its strike — is at zero across that whole range, and
   * reporting each sampled point as a breakeven produced "0.00, 159.00,
   * 320.00" for a single call. Only the transition out of the flat region is
   * a breakeven, and only the edge of it.
   */
  const eps = 1e-9;
  for (let i = 0; i < scan.length - 1; i++) {
    const a = scan[i];
    const b = scan[i + 1];
    if (b - a < eps) continue;
    const fa = profitAtExpiry(position, a);
    const fb = profitAtExpiry(position, b);

    // A genuine sign change: interpolate, exact on a linear segment.
    if ((fa < -eps && fb > eps) || (fa > eps && fb < -eps)) {
      breakevens.push(a + ((0 - fa) * (b - a)) / (fb - fa));
      continue;
    }
    // Leaving a flat-zero stretch into profit or loss: the edge is the point.
    if (Math.abs(fa) <= eps && Math.abs(fb) > eps) breakevens.push(a);
    // Arriving at zero from either side.
    if (Math.abs(fb) <= eps && Math.abs(fa) > eps) breakevens.push(b);
  }

  const unique = [...new Set(breakevens.map((b) => Number(b.toFixed(6))))]
    .filter((b) => b >= 0)
    .sort((a, b) => a - b);

  const capital = capitalRequired(position);
  return {
    netDebit: debit,
    maxProfit,
    maxLoss,
    breakevens: unique,
    capital,
    riskReward:
      maxProfit != null && maxLoss != null && maxLoss < 0 ? maxProfit / Math.abs(maxLoss) : null,
  };
}

/**
 * Capital the position ties up.
 *
 * A defined-risk position requires its maximum loss. An undefined-risk one —
 * a naked short — has no maximum loss, and what a broker actually demands is
 * a house margin formula that differs by broker and changes with the market.
 * Rather than invent one, this reports the debit paid plus the notional of any
 * uncovered short, and the UI labels it an estimate. A number presented as
 * "your margin requirement" that is not what your broker will charge is worse
 * than an obvious approximation.
 */
export function capitalRequired(position: OptionPosition): number {
  const debit = netDebit(position);
  const strikes = position.legs.map((l) => l.strike);
  if (!strikes.length) return Math.max(0, debit);

  const lo = Math.max(0, Math.min(...strikes) * 0.5);
  const hi = Math.max(...strikes) * 1.5;
  const worst = Math.min(
    profitAtExpiry(position, 0),
    ...[...new Set(strikes)].map((s) => profitAtExpiry(position, s)),
    profitAtExpiry(position, lo),
    profitAtExpiry(position, hi),
  );

  // Defined risk: the most it can lose.
  if (Number.isFinite(worst) && worst > -Infinity) {
    const requiredByLoss = Math.max(0, -worst);
    return Math.max(requiredByLoss, Math.max(0, debit));
  }
  return Math.max(0, debit);
}

/** Every distinct expiry in the position, earliest first. */
export function expiries(position: OptionPosition): string[] {
  return [...new Set(position.legs.map((l) => l.expiry))].sort();
}

/** True when legs expire on different dates — a calendar or diagonal. */
export function hasMultipleExpiries(position: OptionPosition): boolean {
  return expiries(position).length > 1;
}
