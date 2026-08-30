/**
 * Options pricing.
 * =============================================================================
 * Two models, chosen by exercise style rather than by convenience.
 *
 * Black–Scholes for European exercise, where it is exact under its own
 * assumptions. Cox–Ross–Rubinstein for American, where it is not: an American
 * put is worth strictly more than the European one whenever early exercise has
 * value, and pricing it with Black–Scholes understates it — silently, and by
 * more the deeper it is in the money. Nothing here applies a European formula
 * to an American contract.
 *
 * Everything is a pure function of its inputs. No market data, no clock, no
 * randomness: the same arguments give the same answer forever, which is what
 * makes the reference tests in `tests/options-pricing.test.ts` meaningful.
 *
 * CONVENTIONS, because every options library picks differently and mixing them
 * is how Greeks end up out by a factor of a hundred:
 *
 *   - Rates and volatilities are annual DECIMALS. 5% is 0.05.
 *   - Time is in YEARS.
 *   - Vega is per 1.00 of volatility (100 points), not per point.
 *   - Theta is per YEAR, not per day.
 *   - Rho is per 1.00 of rate, not per basis point.
 *
 * The per-day and per-point conversions belong at the display boundary, and
 * `perDay` / `perPoint` below are the only sanctioned way to do them.
 */

export type OptionType = 'call' | 'put';
export type ExerciseStyle = 'european' | 'american';

export interface PricingInputs {
  /** Underlying spot price. */
  spot: number;
  strike: number;
  /** Time to expiration in years. Zero or less is treated as expired. */
  timeToExpiry: number;
  /** Annual risk-free rate, continuously compounded, as a decimal. */
  riskFreeRate: number;
  /** Annualised volatility as a decimal. */
  volatility: number;
  /**
   * Continuous dividend yield as a decimal.
   *
   * A discrete dividend stream is converted to an equivalent yield by the
   * caller; see `dividendYieldFromCash`. Ignoring dividends entirely
   * overprices calls and underprices puts, and the error grows with the yield
   * and the horizon.
   */
  dividendYield?: number;
  type: OptionType;
  style?: ExerciseStyle;
}

export interface Greeks {
  /** ∂V/∂S — change in value per 1.00 move in the underlying. */
  delta: number;
  /** ∂²V/∂S² — change in delta per 1.00 move in the underlying. */
  gamma: number;
  /** ∂V/∂t — per YEAR. Divide by 365 for the daily figure. */
  theta: number;
  /** ∂V/∂σ — per 1.00 of volatility. Divide by 100 for "per vol point". */
  vega: number;
  /** ∂V/∂r — per 1.00 of rate. */
  rho: number;
  /**
   * Elasticity: the percentage change in option value per percentage change
   * in the underlying, delta × S / V. The leverage the position carries.
   */
  lambda: number;
}

export interface PricedOption extends Greeks {
  price: number;
  /** Which model produced this, so a result can be traced to its assumptions. */
  model: 'black-scholes' | 'cox-ross-rubinstein' | 'intrinsic';
}

/* ------------------------------------------------------------------ */
/* Normal distribution                                                 */
/* ------------------------------------------------------------------ */

/** Standard normal probability density. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cumulative distribution (Hart's rational approximation).
 *
 * Accurate to roughly machine precision, which is not fussiness: the earlier
 * Abramowitz & Stegun form is good to about 1.5e-7 in probability, and on a
 * $100 underlying that is ~1e-5 of price error — enough to miss a hand-worked
 * reference at five decimals and to leave implied volatility out in the fifth
 * digit. A pricing engine should not be the least accurate step in the chain.
 */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const z = Math.abs(x);
  if (z > 37) return x > 0 ? 1 : 0;

  const e = Math.exp(-0.5 * z * z);
  let n: number;
  if (z < 7.07106781186547) {
    let b = 3.52624965998911e-2 * z + 0.700383064443688;
    b = b * z + 6.37396220353165;
    b = b * z + 33.912866078383;
    b = b * z + 112.079291497871;
    b = b * z + 221.213596169931;
    b = b * z + 220.206867912376;
    let c = 8.83883476483184e-2 * z + 1.75566716318264;
    c = c * z + 16.064177579207;
    c = c * z + 86.7807322029461;
    c = c * z + 296.564248779674;
    c = c * z + 637.333633378831;
    c = c * z + 793.826512519948;
    c = c * z + 440.413735824752;
    n = (e * b) / c;
  } else {
    // Continued fraction in the far tail, where the rational form loses digits.
    let b = z + 0.65;
    b = z + 4 / b;
    b = z + 3 / b;
    b = z + 2 / b;
    b = z + 1 / b;
    n = e / (b * 2.506628274631);
  }
  return x > 0 ? 1 - n : n;
}

/**
 * Inverse standard normal CDF (Acklam's algorithm), used by the probability
 * and Monte Carlo layers. Accurate to about 1.15e-9 relative.
 */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pLow = 0.02425;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* ------------------------------------------------------------------ */
/* Intrinsic value and expiry                                          */
/* ------------------------------------------------------------------ */

export function intrinsicValue(spot: number, strike: number, type: OptionType): number {
  return type === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/**
 * At or past expiry an option is worth its intrinsic value and has no Greeks
 * but delta, which is 0 or ±1. Returning Black–Scholes at T=0 would divide by
 * zero; returning this keeps every caller free of a special case.
 */
function atExpiry(spot: number, strike: number, type: OptionType): PricedOption {
  const itm = type === 'call' ? spot > strike : spot < strike;
  const price = intrinsicValue(spot, strike, type);
  return {
    price,
    delta: itm ? (type === 'call' ? 1 : -1) : 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    rho: 0,
    lambda: 0,
    model: 'intrinsic',
  };
}

/* ------------------------------------------------------------------ */
/* Black–Scholes–Merton                                                */
/* ------------------------------------------------------------------ */

/**
 * European option value and Greeks, with a continuous dividend yield.
 *
 * Zero volatility is handled as its limit — the forward is certain, so the
 * option is worth the discounted intrinsic value of the forward — rather than
 * as a division by zero.
 */
export function blackScholes(inputs: PricingInputs): PricedOption {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, volatility: sigma, type } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (!(T > 0)) return atExpiry(S, K, type);
  if (!(S > 0) || !(K > 0)) return atExpiry(Math.max(S, 0), K, type);

  if (!(sigma > 0)) {
    // Deterministic forward: no optionality left to value.
    const fwd = S * Math.exp((r - q) * T);
    const disc = Math.exp(-r * T);
    const payoff = intrinsicValue(fwd, K, type);
    const itm = type === 'call' ? fwd > K : fwd < K;
    return {
      price: disc * payoff,
      delta: itm ? (type === 'call' ? Math.exp(-q * T) : -Math.exp(-q * T)) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: itm ? (type === 'call' ? K * T * disc : -K * T * disc) : 0,
      lambda: 0,
      model: 'black-scholes',
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discR = Math.exp(-r * T);
  const discQ = Math.exp(-q * T);
  const pdf = normPdf(d1);

  let price: number;
  let delta: number;
  let theta: number;
  let rho: number;

  if (type === 'call') {
    price = S * discQ * normCdf(d1) - K * discR * normCdf(d2);
    delta = discQ * normCdf(d1);
    theta =
      -(S * discQ * pdf * sigma) / (2 * sqrtT) +
      q * S * discQ * normCdf(d1) -
      r * K * discR * normCdf(d2);
    rho = K * T * discR * normCdf(d2);
  } else {
    price = K * discR * normCdf(-d2) - S * discQ * normCdf(-d1);
    delta = -discQ * normCdf(-d1);
    theta =
      -(S * discQ * pdf * sigma) / (2 * sqrtT) -
      q * S * discQ * normCdf(-d1) +
      r * K * discR * normCdf(-d2);
    rho = -K * T * discR * normCdf(-d2);
  }

  const gamma = (discQ * pdf) / (S * sigma * sqrtT);
  const vega = S * discQ * pdf * sqrtT;

  return {
    price,
    delta,
    gamma,
    theta,
    vega,
    rho,
    lambda: price > 0 ? (delta * S) / price : 0,
    model: 'black-scholes',
  };
}

/* ------------------------------------------------------------------ */
/* Cox–Ross–Rubinstein binomial                                        */
/* ------------------------------------------------------------------ */

export interface BinomialOptions {
  /** Time steps. More is more accurate and slower; 200 is ample for display. */
  steps?: number;
}

/**
 * American (or European) option by a CRR binomial tree.
 *
 * Early exercise is tested at every node, which is the whole reason this
 * exists: an American put on a non-dividend-paying stock can be worth
 * exercising early, and an American call can when the dividend yield is high
 * enough. Black–Scholes cannot express either.
 *
 * Greeks come from the tree where the tree already provides them — delta and
 * gamma from the first two levels, theta from the centre node two steps in,
 * which costs nothing extra — and from central differences for vega and rho,
 * which have no nodal shortcut. Central rather than forward differences
 * because the forward version carries a first-order error that is easy to
 * mistake for a real skew in the Greeks.
 */
export function binomialPrice(inputs: PricingInputs, options: BinomialOptions = {}): PricedOption {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, volatility: sigma, type } = inputs;
  const q = inputs.dividendYield ?? 0;
  const american = (inputs.style ?? 'american') === 'american';

  if (!(T > 0)) return atExpiry(S, K, type);
  if (!(S > 0) || !(K > 0) || !(sigma > 0)) {
    // Falls back to the closed form, which handles these degenerate cases.
    return { ...blackScholes(inputs), model: 'black-scholes' };
  }

  // Odd step counts put a node at the money at expiry, which makes the tree
  // converge far more smoothly than an even count.
  const requested = Math.max(5, Math.round(options.steps ?? 201));
  const steps = requested % 2 === 0 ? requested + 1 : requested;

  const built = buildTree(S, K, T, r, sigma, q, type, american, steps);
  if (!built) {
    // The tree was arbitrageable at this step count; the closed form is the
    // honest answer rather than a number from a broken lattice.
    return { ...blackScholes(inputs), model: 'black-scholes' };
  }
  const { price, node, u, d, dt } = built;

  /*
   * Delta, gamma and theta from the lattice's own nodes.
   *
   * Finite differences in spot do not work here and the failure is silent: a
   * CRR tree is piecewise linear in the spot between the kinks its payoff
   * nodes sit on, so a small bump lands inside one segment and the second
   * difference cancels to machine zero — gamma comes back as 0.000. Widening
   * the bump until curvature appears then averages gamma over a range where
   * it genuinely varies, which was still 17% out against the closed form.
   *
   * The nodes are exact for the lattice and cost nothing extra: the tree has
   * already computed the three prices two steps in, straddling the spot.
   */
  const sUU = S * u * u;
  const sUD = S;
  const sDD = S * d * d;
  const deltaUp = (node.v20 - node.v21) / (sUU - sUD);
  const deltaDown = (node.v21 - node.v22) / (sUD - sDD);
  const delta = (node.v10 - node.v11) / (S * u - S * d);
  const gamma = (deltaUp - deltaDown) / (0.5 * (sUU - sDD));
  // The middle node two steps in sits at the same spot, two time steps later.
  const theta = (node.v21 - price) / (2 * dt);

  // Vega and rho have no nodal shortcut, so central differences it is —
  // central rather than forward because a forward difference carries a
  // first-order error easy to mistake for real structure in the Greeks.
  const value = (vol: number, rate: number) =>
    buildTree(S, K, T, rate, vol, q, type, american, steps)?.price ?? price;
  const dv = 1e-4;
  const vega = (value(sigma + dv, r) - value(Math.max(1e-8, sigma - dv), r)) / (2 * dv);
  const dr = 1e-4;
  const rho = (value(sigma, r + dr) - value(sigma, r - dr)) / (2 * dr);

  return {
    price,
    delta,
    gamma,
    theta,
    vega,
    rho,
    lambda: price > 0 ? (delta * S) / price : 0,
    model: 'cox-ross-rubinstein',
  };
}

interface BuiltTree {
  price: number;
  u: number;
  d: number;
  dt: number;
  /** Node values at steps 1 and 2, for the nodal Greeks. */
  node: { v10: number; v11: number; v20: number; v21: number; v22: number };
}

function buildTree(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  q: number,
  type: OptionType,
  american: boolean,
  steps: number,
): BuiltTree | null {
  const dt = T / steps;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);

  // A probability outside [0,1] means the lattice admits arbitrage — too few
  // steps for this rate and volatility. Refusing beats returning a number.
  if (!(p >= 0 && p <= 1)) return null;

  const values = new Array<number>(steps + 1);
  for (let i = 0; i <= steps; i++) {
    values[i] = intrinsicValue(S * Math.pow(u, steps - i) * Math.pow(d, i), K, type);
  }

  const node = { v10: 0, v11: 0, v20: 0, v21: 0, v22: 0 };
  for (let step = steps - 1; step >= 0; step--) {
    for (let i = 0; i <= step; i++) {
      const continuation = disc * (p * values[i] + (1 - p) * values[i + 1]);
      values[i] = american
        ? Math.max(continuation, intrinsicValue(S * Math.pow(u, step - i) * Math.pow(d, i), K, type))
        : continuation;
    }
    if (step === 2) {
      node.v20 = values[0];
      node.v21 = values[1];
      node.v22 = values[2];
    } else if (step === 1) {
      node.v10 = values[0];
      node.v11 = values[1];
    }
  }

  return { price: values[0], u, d, dt, node };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Prices by exercise style: Black–Scholes for European, a binomial tree for
 * American. The single entry point every other module uses, so no caller has
 * to remember which model a contract needs.
 */
export function priceOption(inputs: PricingInputs, options: BinomialOptions = {}): PricedOption {
  const style = inputs.style ?? 'european';
  return style === 'american' ? binomialPrice(inputs, options) : blackScholes(inputs);
}

/* ------------------------------------------------------------------ */
/* Implied volatility                                                  */
/* ------------------------------------------------------------------ */

export class ImpliedVolatilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpliedVolatilityError';
  }
}

/**
 * The volatility that reproduces an observed market price.
 *
 * Newton–Raphson on vega, falling back to bisection. Newton alone is not
 * enough in practice: vega collapses toward zero for deep in- or
 * out-of-the-money contracts, and dividing by it throws the iteration a long
 * way from the root. Bracketing first and bisecting on failure is slower and
 * always converges.
 *
 * A price below intrinsic or above the underlying has no implied volatility at
 * all — no volatility reproduces it — and that is reported rather than
 * returned as a number. Silently clamping to a bound is how a stale or crossed
 * quote becomes a plausible-looking 300% IV.
 */
export function impliedVolatility(
  marketPrice: number,
  inputs: Omit<PricingInputs, 'volatility'>,
  options: { tolerance?: number; maxIterations?: number } & BinomialOptions = {},
): number {
  const tol = options.tolerance ?? 1e-9;
  const maxIter = options.maxIterations ?? 100;
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, type } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (!(marketPrice > 0)) {
    throw new ImpliedVolatilityError('A non-positive price has no implied volatility.');
  }
  if (!(T > 0)) {
    throw new ImpliedVolatilityError('An expired option has no implied volatility.');
  }

  // No-arbitrage bounds. Outside them the quote is not a European option price.
  const discR = Math.exp(-r * T);
  const discQ = Math.exp(-q * T);
  const lower =
    type === 'call'
      ? Math.max(0, S * discQ - K * discR)
      : Math.max(0, K * discR - S * discQ);
  const upper = type === 'call' ? S * discQ : K * discR;
  if (marketPrice < lower - 1e-8) {
    throw new ImpliedVolatilityError(
      `A price of ${marketPrice} is below the no-arbitrage floor of ${lower.toFixed(4)}.`,
    );
  }
  if (marketPrice > upper + 1e-8) {
    throw new ImpliedVolatilityError(
      `A price of ${marketPrice} is above the no-arbitrage ceiling of ${upper.toFixed(4)}.`,
    );
  }

  const priceAt = (sigma: number) =>
    priceOption({ ...inputs, volatility: sigma }, options).price;

  // Newton from a sensible seed: Brenner–Subrahmanyam for a near-the-money
  // start, which is close enough that Newton usually lands in a few steps.
  let sigma = Math.max(0.05, Math.sqrt((2 * Math.PI) / T) * (marketPrice / S));
  sigma = Math.min(Math.max(sigma, 1e-3), 5);

  for (let i = 0; i < maxIter; i++) {
    const priced = priceOption({ ...inputs, volatility: sigma }, options);
    const diff = priced.price - marketPrice;
    if (Math.abs(diff) < tol) return sigma;
    if (!(priced.vega > 1e-8)) break;
    const next = sigma - diff / priced.vega;
    if (!Number.isFinite(next) || next <= 0 || next > 5) break;
    if (Math.abs(next - sigma) < 1e-10) return next;
    sigma = next;
  }

  // Bisection. Slower, but it cannot wander.
  let lo = 1e-6;
  let hi = 5;
  if (priceAt(hi) < marketPrice) {
    throw new ImpliedVolatilityError(
      'No volatility up to 500% reproduces this price; the quote is likely stale or crossed.',
    );
  }
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const diff = priceAt(mid) - marketPrice;
    if (Math.abs(diff) < tol) return mid;
    if (diff > 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/* ------------------------------------------------------------------ */
/* Dividends and conversions                                           */
/* ------------------------------------------------------------------ */

/**
 * Converts a discrete cash dividend stream into the equivalent continuous
 * yield the models take.
 *
 * An approximation, and named as one: the exact treatment subtracts the
 * present value of each dividend from the spot and prices on the remainder,
 * which matters for a single large dividend just before expiry. For the
 * regular quarterly stream most listed names pay, the yield form is within a
 * cent or two and keeps one model rather than two.
 */
export function dividendYieldFromCash(
  spot: number,
  dividends: Array<{ amount: number; timeToPayment: number }>,
  timeToExpiry: number,
  riskFreeRate: number,
): number {
  if (!(spot > 0) || !(timeToExpiry > 0) || dividends.length === 0) return 0;
  const pv = dividends
    .filter((d) => d.timeToPayment > 0 && d.timeToPayment <= timeToExpiry)
    .reduce((a, d) => a + d.amount * Math.exp(-riskFreeRate * d.timeToPayment), 0);
  if (pv <= 0 || pv >= spot) return 0;
  return -Math.log(1 - pv / spot) / timeToExpiry;
}

/** Theta per calendar day, from the per-year figure the models return. */
export function perDay(thetaPerYear: number): number {
  return thetaPerYear / 365;
}

/** Vega or rho per one point (1%), from the per-1.00 figure. */
export function perPoint(perUnit: number): number {
  return perUnit / 100;
}

/**
 * Years to expiry on an ACT/365 basis, the convention listed equity options
 * are quoted on.
 *
 * Deliberately NOT called `yearsBetween`: `market-data/dates.ts` exports a
 * function of that name using ACT/365.25, which is the right basis for
 * annualising a multi-year return series and the wrong one for a contract
 * whose expiry is a fixed calendar date. Two same-named functions with
 * different denominators, one import away from each other, is a trap — the
 * difference is small enough that nothing would look wrong.
 */
export function yearsToExpiry(from: Date | string, to: Date | string): number {
  const a = typeof from === 'string' ? Date.parse(`${from}T00:00:00Z`) : from.valueOf();
  const b = typeof to === 'string' ? Date.parse(`${to}T00:00:00Z`) : to.valueOf();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / (365 * 86_400_000));
}
