import { describe, expect, it } from 'vitest';
import {
  binomialPrice,
  blackScholes,
  dividendYieldFromCash,
  impliedVolatility,
  ImpliedVolatilityError,
  normCdf,
  normInv,
  normPdf,
  priceOption,
  yearsBetween,
} from '../src/lib/options/pricing';

/**
 * Options pricing, against values that exist independently of this code.
 * =============================================================================
 * The textbook case is S=100, K=100, r=5%, σ=20%, T=1, no dividend, which
 * every options text carries and which can be worked by hand:
 *
 *   d1 = 0.35, d2 = 0.15
 *   N(d1) = 0.636831, N(d2) = 0.559618
 *   call  = 100(0.636831) − 100e^−0.05(0.559618) = 10.450584
 *   put   = call − S + Ke^−rT = 5.573526
 *
 * A test that only checked this code against itself would pass just as well
 * with the sign of theta reversed, so the anchors here are external
 * arithmetic, no-arbitrage identities, and limits — not recorded output.
 */

const BASE = {
  spot: 100,
  strike: 100,
  timeToExpiry: 1,
  riskFreeRate: 0.05,
  volatility: 0.2,
} as const;

describe('the normal distribution helpers', () => {
  it('matches known values of the standard normal CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normCdf(-1)).toBeCloseTo(0.158655, 5);
    expect(normCdf(1.96)).toBeCloseTo(0.975002, 5);
    expect(normCdf(0.35)).toBeCloseTo(0.636831, 5);
    expect(normCdf(0.15)).toBeCloseTo(0.559618, 5);
  });

  it('is symmetric', () => {
    for (const x of [0.1, 0.5, 1.3, 2.7]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 9);
    }
  });

  it('matches the density at known points', () => {
    expect(normPdf(0)).toBeCloseTo(0.398942, 6);
    expect(normPdf(1)).toBeCloseTo(0.241971, 6);
  });

  it('inverts the CDF', () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
    }
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
  });
});

describe('Black–Scholes against hand-worked values', () => {
  const call = blackScholes({ ...BASE, type: 'call' });
  const put = blackScholes({ ...BASE, type: 'put' });

  it('prices the textbook call and put', () => {
    expect(call.price).toBeCloseTo(10.450584, 5);
    expect(put.price).toBeCloseTo(5.573526, 5);
  });

  it('produces the textbook Greeks', () => {
    expect(call.delta).toBeCloseTo(0.636831, 5);
    expect(put.delta).toBeCloseTo(-0.363169, 5);
    // Gamma and vega do not depend on the option type.
    expect(call.gamma).toBeCloseTo(0.018762, 6);
    expect(put.gamma).toBeCloseTo(0.018762, 6);
    expect(call.vega).toBeCloseTo(37.524035, 4);
    expect(put.vega).toBeCloseTo(37.524035, 4);
    // Per YEAR, and negative for a long option: time is working against it.
    expect(call.theta).toBeCloseTo(-6.414028, 4);
    expect(put.theta).toBeCloseTo(-1.657880, 4);
    expect(call.rho).toBeCloseTo(53.232482, 4);
    expect(put.rho).toBeCloseTo(-41.890460, 4);
  });

  it('satisfies put–call parity', () => {
    // C − P = Se^−qT − Ke^−rT, exactly, for any inputs.
    const parity = 100 * Math.exp(-0) - 100 * Math.exp(-0.05 * 1);
    expect(call.price - put.price).toBeCloseTo(parity, 9);
  });

  it('satisfies parity with a dividend yield too', () => {
    const args = { ...BASE, dividendYield: 0.03 } as const;
    const c = blackScholes({ ...args, type: 'call' });
    const p = blackScholes({ ...args, type: 'put' });
    const parity = 100 * Math.exp(-0.03) - 100 * Math.exp(-0.05);
    expect(c.price - p.price).toBeCloseTo(parity, 9);
  });

  it('lowers call value and raises put value as the dividend yield rises', () => {
    const c0 = blackScholes({ ...BASE, type: 'call', dividendYield: 0 }).price;
    const c5 = blackScholes({ ...BASE, type: 'call', dividendYield: 0.05 }).price;
    const p0 = blackScholes({ ...BASE, type: 'put', dividendYield: 0 }).price;
    const p5 = blackScholes({ ...BASE, type: 'put', dividendYield: 0.05 }).price;
    // Ignoring dividends overprices calls and underprices puts, which is the
    // reason the yield is a first-class input rather than an afterthought.
    expect(c5).toBeLessThan(c0);
    expect(p5).toBeGreaterThan(p0);
  });

  it('keeps delta inside its bounds across moneyness', () => {
    for (const spot of [50, 80, 100, 120, 200]) {
      const c = blackScholes({ ...BASE, spot, type: 'call' });
      const p = blackScholes({ ...BASE, spot, type: 'put' });
      expect(c.delta).toBeGreaterThanOrEqual(0);
      expect(c.delta).toBeLessThanOrEqual(1);
      expect(p.delta).toBeGreaterThanOrEqual(-1);
      expect(p.delta).toBeLessThanOrEqual(0);
      // Delta_call − Delta_put = e^−qT = 1 here.
      expect(c.delta - p.delta).toBeCloseTo(1, 9);
    }
  });

  it('respects the European lower bounds, which are not intrinsic value', () => {
    // A deep in-the-money European PUT is legitimately worth less than
    // intrinsic: you cannot exercise it early, so its floor is the discounted
    // strike less the spot, Ke^-rT - S, rather than K - S. Testing it against
    // intrinsic would be asserting a fact about American options.
    const discK = 100 * Math.exp(-0.05);
    for (const spot of [60, 90, 100, 110, 150]) {
      const c = blackScholes({ ...BASE, spot, type: 'call' });
      const p = blackScholes({ ...BASE, spot, type: 'put' });
      expect(c.price).toBeGreaterThanOrEqual(Math.max(0, spot - discK) - 1e-9);
      expect(p.price).toBeGreaterThanOrEqual(Math.max(0, discK - spot) - 1e-9);
    }
    // The American put, which can be exercised, never is below intrinsic.
    const amer = binomialPrice({ ...BASE, spot: 60, type: 'put', style: 'american' }, { steps: 301 });
    expect(amer.price).toBeGreaterThanOrEqual(40 - 1e-6);
  });

  it('returns intrinsic value at expiry rather than dividing by zero', () => {
    const c = blackScholes({ ...BASE, timeToExpiry: 0, spot: 110, type: 'call' });
    expect(c.price).toBe(10);
    expect(c.delta).toBe(1);
    expect(c.gamma).toBe(0);
    expect(c.model).toBe('intrinsic');
    const otm = blackScholes({ ...BASE, timeToExpiry: 0, spot: 90, type: 'call' });
    expect(otm.price).toBe(0);
    expect(otm.delta).toBe(0);
  });

  it('handles zero volatility as its limit, not as a division by zero', () => {
    const c = blackScholes({ ...BASE, volatility: 0, type: 'call' });
    // Certain forward of 100e^0.05 = 105.127, discounted intrinsic 5.127e^-0.05.
    expect(Number.isFinite(c.price)).toBe(true);
    expect(c.price).toBeCloseTo(Math.exp(-0.05) * (100 * Math.exp(0.05) - 100), 6);
    expect(c.gamma).toBe(0);
    expect(c.vega).toBe(0);
  });

  it('reports elasticity as the leverage the option carries', () => {
    // λ = δS/V, and an out-of-the-money option is more levered than a deep
    // in-the-money one, which is the whole point of quoting it.
    const atm = blackScholes({ ...BASE, type: 'call' });
    const otm = blackScholes({ ...BASE, spot: 80, type: 'call' });
    expect(atm.lambda).toBeCloseTo((atm.delta * 100) / atm.price, 9);
    expect(otm.lambda).toBeGreaterThan(atm.lambda);
  });
});

describe('the binomial tree', () => {
  it('converges to Black–Scholes for a European option', () => {
    const bs = blackScholes({ ...BASE, type: 'call' }).price;
    const tree = binomialPrice({ ...BASE, type: 'call', style: 'european' }, { steps: 801 }).price;
    expect(tree).toBeCloseTo(bs, 2);
  });

  it('converges more closely as steps increase', () => {
    const bs = blackScholes({ ...BASE, type: 'put' }).price;
    const coarse = Math.abs(
      binomialPrice({ ...BASE, type: 'put', style: 'european' }, { steps: 25 }).price - bs,
    );
    const fine = Math.abs(
      binomialPrice({ ...BASE, type: 'put', style: 'european' }, { steps: 601 }).price - bs,
    );
    expect(fine).toBeLessThan(coarse);
  });

  it('prices an American put above the European one', () => {
    // The reason this model exists. Early exercise has value on a put, and
    // Black–Scholes cannot express it.
    const euro = blackScholes({ ...BASE, spot: 80, type: 'put' }).price;
    const amer = binomialPrice({ ...BASE, spot: 80, type: 'put', style: 'american' }, { steps: 401 }).price;
    expect(amer).toBeGreaterThan(euro);
    // And never below intrinsic, which is what early exercise guarantees.
    expect(amer).toBeGreaterThanOrEqual(20 - 1e-9);
  });

  it('leaves an American call on a non-dividend payer equal to the European one', () => {
    // The classic result: it is never optimal to exercise such a call early,
    // so the American premium is zero. A tree that disagreed would be wrong.
    const euro = blackScholes({ ...BASE, type: 'call' }).price;
    const amer = binomialPrice({ ...BASE, type: 'call', style: 'american' }, { steps: 601 }).price;
    expect(amer).toBeCloseTo(euro, 2);
  });

  it('gives an American call early-exercise value once dividends are large', () => {
    const euro = blackScholes({ ...BASE, type: 'call', dividendYield: 0.15 }).price;
    const amer = binomialPrice(
      { ...BASE, type: 'call', dividendYield: 0.15, style: 'american' },
      { steps: 401 },
    ).price;
    expect(amer).toBeGreaterThan(euro);
  });

  it('produces Greeks close to the closed form for a European contract', () => {
    const bs = blackScholes({ ...BASE, type: 'call' });
    const tree = binomialPrice({ ...BASE, type: 'call', style: 'european' }, { steps: 801 });
    expect(tree.delta).toBeCloseTo(bs.delta, 2);
    expect(tree.gamma).toBeCloseTo(bs.gamma, 3);
    expect(tree.vega).toBeCloseTo(bs.vega, 0);
    expect(tree.theta).toBeCloseTo(bs.theta, 0);
    expect(tree.rho).toBeCloseTo(bs.rho, 0);
  });

  it('routes by exercise style without the caller choosing a model', () => {
    expect(priceOption({ ...BASE, type: 'put', style: 'european' }).model).toBe('black-scholes');
    expect(priceOption({ ...BASE, type: 'put', style: 'american' }, { steps: 51 }).model).toBe(
      'cox-ross-rubinstein',
    );
  });
});

describe('implied volatility', () => {
  it('recovers the volatility that produced a price', () => {
    for (const sigma of [0.08, 0.2, 0.45, 0.9]) {
      for (const spot of [80, 100, 130]) {
        const price = blackScholes({ ...BASE, spot, volatility: sigma, type: 'call' }).price;
        const iv = impliedVolatility(price, { ...BASE, spot, type: 'call' });
        expect(iv).toBeCloseTo(sigma, 5);
        // The contract the solver actually guarantees is on price, not on
        // sigma: where vega is small a tiny price tolerance is a much larger
        // tolerance in volatility, so the round trip is the real assertion.
        const back = blackScholes({ ...BASE, spot, volatility: iv, type: 'call' }).price;
        expect(back).toBeCloseTo(price, 8);
      }
    }
  });

  it('recovers it for puts and with a dividend yield', () => {
    const price = blackScholes({
      ...BASE, volatility: 0.33, dividendYield: 0.02, type: 'put',
    }).price;
    const iv = impliedVolatility(price, { ...BASE, dividendYield: 0.02, type: 'put' });
    expect(iv).toBeCloseTo(0.33, 5);
  });

  it('converges where vega is tiny and Newton alone would not', () => {
    // Deep out of the money: vega collapses, Newton divides by nearly zero and
    // is thrown clear of the root. The bisection fallback is what saves this.
    const price = blackScholes({ ...BASE, spot: 40, volatility: 0.6, type: 'call' }).price;
    const iv = impliedVolatility(price, { ...BASE, spot: 40, type: 'call' });
    expect(iv).toBeCloseTo(0.6, 4);
  });

  it('refuses a price below the no-arbitrage floor', () => {
    // A call cannot be worth less than S − Ke^−rT. Clamping instead of
    // refusing is how a crossed quote becomes a plausible-looking IV.
    expect(() => impliedVolatility(0.5, { ...BASE, spot: 150, type: 'call' })).toThrow(
      ImpliedVolatilityError,
    );
  });

  it('refuses a price above the underlying', () => {
    expect(() => impliedVolatility(120, { ...BASE, type: 'call' })).toThrow(
      /no-arbitrage ceiling/,
    );
  });

  it('refuses an expired or worthless contract', () => {
    expect(() => impliedVolatility(5, { ...BASE, timeToExpiry: 0, type: 'call' })).toThrow(
      ImpliedVolatilityError,
    );
    expect(() => impliedVolatility(0, { ...BASE, type: 'call' })).toThrow(ImpliedVolatilityError);
  });
});

describe('dividends and conversions', () => {
  it('turns a cash dividend stream into an equivalent yield', () => {
    // Two $1 dividends on a $100 stock over a year is roughly a 2% yield.
    const y = dividendYieldFromCash(
      100,
      [
        { amount: 1, timeToPayment: 0.25 },
        { amount: 1, timeToPayment: 0.75 },
      ],
      1,
      0.05,
    );
    expect(y).toBeGreaterThan(0.018);
    expect(y).toBeLessThan(0.021);
  });

  it('ignores dividends paid after expiry', () => {
    const y = dividendYieldFromCash(100, [{ amount: 5, timeToPayment: 2 }], 1, 0.05);
    expect(y).toBe(0);
  });

  it('measures time in years on a 365-day calendar', () => {
    expect(yearsBetween('2026-01-01', '2027-01-01')).toBeCloseTo(1, 6);
    expect(yearsBetween('2026-01-01', '2026-01-31')).toBeCloseTo(30 / 365, 6);
    // Never negative: an expiry in the past is expired, not worth −0.2 years.
    expect(yearsBetween('2026-06-01', '2026-01-01')).toBe(0);
  });
});
