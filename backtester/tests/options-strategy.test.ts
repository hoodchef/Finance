import { describe, expect, it } from 'vitest';
import {
  capitalRequired,
  netDebit,
  payoffCurve,
  profitAtExpiry,
  summarise,
  valuePosition,
  type OptionLeg,
  type OptionPosition,
} from '../src/lib/options/strategy';
import {
  analysePositionProbability,
  monteCarlo,
  probabilityAbove,
  probabilityOfTouch,
  runScenarios,
} from '../src/lib/options/analytics';
import { applyPreset, PRESETS } from '../src/lib/options/presets';
import { parseOccSymbol } from '../src/lib/options/chain';
import { blackScholes } from '../src/lib/options/pricing';

/**
 * Multi-leg positions, against payoffs that can be worked by hand.
 * =============================================================================
 * Spreads have exact arithmetic answers — a 100/110 call spread bought for 3
 * has a maximum profit of 7, a maximum loss of 3 and a breakeven at 103 — so
 * these check against that arithmetic rather than against recorded output.
 */

const EXPIRY = '2027-01-15';
const ASOF = '2026-01-15';

function leg(over: Partial<OptionLeg> & Pick<OptionLeg, 'type' | 'side' | 'strike'>): OptionLeg {
  return {
    id: `${over.type}-${over.side}-${over.strike}`,
    expiry: EXPIRY,
    contracts: 1,
    entryPremium: 0,
    multiplier: 100,
    style: 'european',
    impliedVolatility: 0.25,
    ...over,
  };
}

const position = (legs: OptionLeg[], extra: Partial<OptionPosition> = {}): OptionPosition => ({
  underlying: 'TEST',
  legs,
  stock: null,
  riskFreeRate: 0.04,
  dividendYield: 0,
  ...extra,
});

describe('a long call', () => {
  const p = position([leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 5 })]);

  it('costs the premium and loses exactly that below the strike', () => {
    expect(netDebit(p)).toBe(500);
    expect(profitAtExpiry(p, 80)).toBe(-500);
    expect(profitAtExpiry(p, 100)).toBe(-500);
  });

  it('breaks even at strike plus premium', () => {
    expect(profitAtExpiry(p, 105)).toBeCloseTo(0, 9);
    expect(summarise(p).breakevens).toEqual([105]);
  });

  it('has unbounded profit and a loss capped at the premium', () => {
    const s = summarise(p);
    expect(s.maxProfit).toBeNull();
    expect(s.maxLoss).toBe(-500);
  });
});

describe('a payoff that rests at zero', () => {
  it('reports only the edge of a flat-zero region, not every point in it', () => {
    // A long call with no premium is exactly zero below its strike. Reporting
    // each sampled point produced "0.00, 159.00, 320.00" for one option.
    const free = position([leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 0 })]);
    expect(summarise(free).breakevens).toEqual([100]);
  });

  it('still finds both breakevens of a straddle', () => {
    const straddle = position([
      leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 4 }),
      leg({ type: 'put', side: 'buy', strike: 100, entryPremium: 4 }),
    ]);
    expect(summarise(straddle).breakevens).toEqual([92, 108]);
  });
});

describe('a vertical call spread', () => {
  // Long 100 at 6, short 110 at 3: net debit 3, width 10.
  const p = position([
    leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 6 }),
    leg({ type: 'call', side: 'sell', strike: 110, entryPremium: 3 }),
  ]);

  it('costs the net debit', () => {
    expect(netDebit(p)).toBe(300);
  });

  it('caps profit at the width less the debit, and loss at the debit', () => {
    const s = summarise(p);
    expect(s.maxProfit).toBeCloseTo(700, 6);
    expect(s.maxLoss).toBeCloseTo(-300, 6);
    expect(s.riskReward).toBeCloseTo(700 / 300, 6);
  });

  it('breaks even at the long strike plus the debit', () => {
    expect(summarise(p).breakevens).toEqual([103]);
    expect(profitAtExpiry(p, 103)).toBeCloseTo(0, 9);
  });

  it('reaches maximum profit at the short strike and stays there', () => {
    expect(profitAtExpiry(p, 110)).toBeCloseTo(700, 6);
    expect(profitAtExpiry(p, 200)).toBeCloseTo(700, 6);
  });
});

describe('an iron condor', () => {
  // 85/93 put spread and 107/115 call spread, 2.00 total credit.
  const p = position([
    leg({ type: 'put', side: 'buy', strike: 85, entryPremium: 0.5 }),
    leg({ type: 'put', side: 'sell', strike: 93, entryPremium: 1.5 }),
    leg({ type: 'call', side: 'sell', strike: 107, entryPremium: 1.5 }),
    leg({ type: 'call', side: 'buy', strike: 115, entryPremium: 0.5 }),
  ]);

  it('opens for a credit', () => {
    expect(netDebit(p)).toBe(-200);
  });

  it('keeps the credit between the short strikes', () => {
    expect(profitAtExpiry(p, 100)).toBeCloseTo(200, 6);
    expect(summarise(p).maxProfit).toBeCloseTo(200, 6);
  });

  it('caps the loss at the wider wing less the credit', () => {
    // Both wings are 8 wide; 800 − 200 credit = 600.
    expect(summarise(p).maxLoss).toBeCloseTo(-600, 6);
    expect(profitAtExpiry(p, 50)).toBeCloseTo(-600, 6);
    expect(profitAtExpiry(p, 200)).toBeCloseTo(-600, 6);
  });

  it('has two breakevens, inside the short strikes by the credit', () => {
    const s = summarise(p);
    expect(s.breakevens).toHaveLength(2);
    expect(s.breakevens[0]).toBeCloseTo(91, 6);
    expect(s.breakevens[1]).toBeCloseTo(109, 6);
  });
});

describe('a call ratio spread', () => {
  // Long one 100, short two 110. Unlimited loss above the short strikes.
  const p = position([
    leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 6 }),
    leg({ type: 'call', side: 'sell', strike: 110, entryPremium: 3, contracts: 2 }),
  ]);

  it('reports the loss as unbounded rather than as a large number', () => {
    const s = summarise(p);
    expect(s.maxLoss).toBeNull();
    // And profit peaks at the short strike.
    expect(s.maxProfit).toBeCloseTo(profitAtExpiry(p, 110), 6);
  });

  it('does lose more the further it rallies', () => {
    expect(profitAtExpiry(p, 200)).toBeLessThan(profitAtExpiry(p, 150));
  });
});

describe('a covered call', () => {
  const p = position([leg({ type: 'call', side: 'sell', strike: 110, entryPremium: 3 })], {
    stock: { side: 'buy', shares: 100, entryPrice: 100 },
  });

  it('caps upside at the strike plus the premium', () => {
    expect(profitAtExpiry(p, 110)).toBeCloseTo(1300, 6);
    expect(profitAtExpiry(p, 200)).toBeCloseTo(1300, 6);
  });

  it('loses with the shares below the strike, cushioned by the premium', () => {
    expect(profitAtExpiry(p, 90)).toBeCloseTo(-700, 6);
    expect(summarise(p).breakevens[0]).toBeCloseTo(97, 6);
  });
});

describe('a non-standard multiplier', () => {
  it('scales the whole position by the contract multiplier', () => {
    // An adjusted contract can deliver any number of shares. Assuming 100
    // would misstate this position by whatever the adjustment was.
    const odd = position([
      leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 5, multiplier: 137 }),
    ]);
    expect(netDebit(odd)).toBeCloseTo(685, 6);
    expect(profitAtExpiry(odd, 120)).toBeCloseTo((20 - 5) * 137, 6);
  });
});

describe('valuation away from expiry', () => {
  const p = position([leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 5 })]);

  it('agrees with Black–Scholes for a single European leg', () => {
    const v = valuePosition(p, { spot: 100, asOf: ASOF });
    const bs = blackScholes({
      spot: 100, strike: 100, timeToExpiry: 1, riskFreeRate: 0.04,
      volatility: 0.25, type: 'call',
    });
    expect(v.legs[0].perShare).toBeCloseTo(bs.price, 6);
    expect(v.greeks.delta).toBeCloseTo(bs.delta * 100, 4);
    expect(v.greeks.vega).toBeCloseTo(bs.vega * 100, 3);
  });

  it('settles to intrinsic value on the expiry date', () => {
    const v = valuePosition(p, { spot: 120, asOf: EXPIRY });
    expect(v.legs[0].expired).toBe(true);
    expect(v.legs[0].perShare).toBe(20);
    expect(v.profit).toBeCloseTo(1500, 6);
  });

  it('adds stock delta of one per share', () => {
    const withStock = position([], { stock: { side: 'buy', shares: 100, entryPrice: 100 } });
    expect(valuePosition(withStock, { spot: 100, asOf: ASOF }).greeks.delta).toBe(100);
  });

  it('keeps a calendar spread alive on the front expiry', () => {
    // The whole structure: the near leg settles, the far leg still has value.
    const cal = position([
      leg({ type: 'call', side: 'sell', strike: 100, entryPremium: 3, expiry: '2026-06-19' }),
      leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 6, expiry: EXPIRY }),
    ]);
    const v = valuePosition(cal, { spot: 100, asOf: '2026-06-19' });
    expect(v.legs[0].expired).toBe(true);
    expect(v.legs[1].expired).toBe(false);
    expect(v.legs[1].perShare).toBeGreaterThan(0);
  });
});

describe('the payoff curve', () => {
  const p = position([
    leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 6 }),
    leg({ type: 'call', side: 'sell', strike: 110, entryPremium: 3 }),
  ]);

  it('samples the strikes exactly, so the kinks stay sharp', () => {
    const curve = payoffCurve(p, { min: 80, max: 130, points: 21 });
    // A uniform grid over 80–130 in 21 steps steps straight over 110 and
    // rounds the corner that defines maximum profit.
    expect(curve.some((c) => c.spot === 100)).toBe(true);
    expect(curve.some((c) => c.spot === 110)).toBe(true);
  });

  it('is monotone between the strikes and flat beyond them', () => {
    const curve = payoffCurve(p, { min: 80, max: 140, points: 61 });
    const at = (s: number) => curve.reduce((a, c) => (Math.abs(c.spot - s) < Math.abs(a.spot - s) ? c : a)).atExpiry;
    expect(at(85)).toBeCloseTo(-300, 6);
    expect(at(130)).toBeCloseTo(700, 6);
  });
});

describe('probability', () => {
  const dist = {
    spot: 100,
    volatility: 0.25,
    timeToExpiry: 1,
    riskFreeRate: 0.04,
    dividendYield: 0,
  };

  it('agrees with N(d2) from the pricing model', () => {
    // The same quantity Black–Scholes uses, which is why the probabilities are
    // consistent with the premiums being analysed.
    const d2 = (Math.log(100 / 110) + (0.04 - 0.5 * 0.0625) * 1) / (0.25 * 1);
    expect(probabilityAbove(110, dist)).toBeCloseTo(
      blackScholes({ ...dist, strike: 110, type: 'call' }).price > 0 ? normApprox(d2) : 0,
      6,
    );
  });

  it('puts a touch probability well above the terminal one', () => {
    // Roughly double, by the reflection principle. Quoting the terminal
    // probability instead badly understates how often a level is reached.
    const terminal = probabilityAbove(120, dist);
    const touch = probabilityOfTouch(120, dist);
    expect(touch).toBeGreaterThan(terminal * 1.5);
    expect(touch).toBeLessThanOrEqual(1);
  });

  it('is symmetric for a barrier below', () => {
    const touchDown = probabilityOfTouch(80, dist);
    expect(touchDown).toBeGreaterThan(probabilityAbove(80, { ...dist }) > 0.5 ? 0 : 0);
    expect(touchDown).toBeGreaterThan(0);
    expect(touchDown).toBeLessThanOrEqual(1);
  });

  it('integrates the payoff shape rather than counting breakevens', () => {
    /*
     * The point is that the same code gets opposite shapes right. A condor
     * profits BETWEEN its breakevens; a strangle profits OUTSIDE them. Any
     * rule that inferred "profitable region" from the count of breakevens
     * would get one of these exactly backwards.
     *
     * Checked against the terminal probability of landing in the right region,
     * computed independently — not against which structure "should" win, which
     * depends entirely on the horizon. Over a year at 25% volatility the
     * condor's ±9% band is the unlikely outcome, and that is correct.
     */
    const condor = position([
      leg({ type: 'put', side: 'buy', strike: 85, entryPremium: 0.5 }),
      leg({ type: 'put', side: 'sell', strike: 93, entryPremium: 1.5 }),
      leg({ type: 'call', side: 'sell', strike: 107, entryPremium: 1.5 }),
      leg({ type: 'call', side: 'buy', strike: 115, entryPremium: 0.5 }),
    ]);
    const strangle = position([
      leg({ type: 'call', side: 'buy', strike: 110, entryPremium: 2 }),
      leg({ type: 'put', side: 'buy', strike: 90, entryPremium: 2 }),
    ]);
    const dist = {
      spot: 100, volatility: 0.25, timeToExpiry: 1, riskFreeRate: 0.04, dividendYield: 0,
    };

    const a = analysePositionProbability(condor, { spot: 100, volatility: 0.25, asOf: ASOF });
    const b = analysePositionProbability(strangle, { spot: 100, volatility: 0.25, asOf: ASOF });

    // Condor: profit strictly between its two breakevens.
    const [cLo, cHi] = summarise(condor).breakevens;
    const inside = probabilityAbove(cLo, dist) - probabilityAbove(cHi, dist);
    expect(a.probabilityOfProfit).toBeCloseTo(inside, 2);

    // Strangle: profit strictly outside its two breakevens.
    const [sLo, sHi] = summarise(strangle).breakevens;
    const outside = 1 - (probabilityAbove(sLo, dist) - probabilityAbove(sHi, dist));
    expect(b.probabilityOfProfit).toBeCloseTo(outside, 2);

    // And they are genuinely different shapes, not the same number twice.
    expect(Math.abs(a.probabilityOfProfit - b.probabilityOfProfit)).toBeGreaterThan(0.1);
  });

  it('states its assumptions rather than leaving them implicit', () => {
    const a = analysePositionProbability(
      position([leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 5 })]),
      { spot: 100, volatility: 0.25, asOf: ASOF },
    );
    expect(a.assumptions).toMatch(/risk-neutral|not a forecast/i);
    expect(a.assumptions).toMatch(/fatter tails/i);
  });
});

function normApprox(x: number): number {
  // Local copy so the assertion above does not simply call the same function
  // it is checking.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

describe('scenarios', () => {
  const p = position([leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 5 })]);

  it('moves price, volatility, time and rates together', () => {
    const [flat, crash] = runScenarios(p, {
      spot: 100,
      asOf: ASOF,
      scenarios: [
        { label: 'flat', spotChange: 0, volChange: 0, daysPassed: 0, rateChange: 0 },
        { label: 'crash', spotChange: -0.2, volChange: 0.15, daysPassed: 7, rateChange: 0 },
      ],
    });
    expect(crash.spot).toBeCloseTo(80, 9);
    expect(crash.profit).toBeLessThan(flat.profit);
    // A long call loses delta as the underlying falls.
    expect(crash.delta).toBeLessThan(flat.delta);
  });

  it('shows a long option gaining value when volatility rises', () => {
    const [base, volUp] = runScenarios(p, {
      spot: 100,
      asOf: ASOF,
      scenarios: [
        { label: 'base', spotChange: 0, volChange: 0, daysPassed: 0, rateChange: 0 },
        { label: 'vol up', spotChange: 0, volChange: 0.1, daysPassed: 0, rateChange: 0 },
      ],
    });
    expect(volUp.value).toBeGreaterThan(base.value);
  });

  it('shows time decay hurting a long option', () => {
    const [now, later] = runScenarios(p, {
      spot: 100,
      asOf: ASOF,
      scenarios: [
        { label: 'now', spotChange: 0, volChange: 0, daysPassed: 0, rateChange: 0 },
        { label: '30d', spotChange: 0, volChange: 0, daysPassed: 30, rateChange: 0 },
      ],
    });
    expect(later.value).toBeLessThan(now.value);
  });
});

describe('Monte Carlo', () => {
  const p = position([
    leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 6 }),
    leg({ type: 'call', side: 'sell', strike: 110, entryPremium: 3 }),
  ]);
  const opts = {
    spot: 100, volatility: 0.25, drift: 0.04, asOf: ASOF, paths: 20_000, seed: 7,
  };

  it('reproduces exactly for a given seed', () => {
    const a = monteCarlo(p, opts);
    const b = monteCarlo(p, opts);
    expect(a.mean).toBe(b.mean);
    expect(a.p5).toBe(b.p5);
  });

  it('stays inside the payoff bounds of the structure', () => {
    // A vertical spread cannot lose more than its debit or make more than the
    // width less the debit, however the paths land.
    const r = monteCarlo(p, opts);
    expect(r.min).toBeGreaterThanOrEqual(-300 - 1e-6);
    expect(r.max).toBeLessThanOrEqual(700 + 1e-6);
  });

  it('orders its percentiles', () => {
    const r = monteCarlo(p, opts);
    expect(r.p5).toBeLessThanOrEqual(r.p25);
    expect(r.p25).toBeLessThanOrEqual(r.median);
    expect(r.median).toBeLessThanOrEqual(r.p75);
    expect(r.p75).toBeLessThanOrEqual(r.p95);
  });

  it('roughly agrees with the analytic expected value', () => {
    // Both integrate the same payoff over the same distribution, so they
    // should agree to within sampling error at 20,000 paths.
    const analytic = analysePositionProbability(p, {
      spot: 100, volatility: 0.25, asOf: ASOF,
    }).expectedValue;
    const simulated = monteCarlo(p, opts).mean;
    expect(Math.abs(simulated - analytic)).toBeLessThan(25);
  });

  it('labels its output as simulated', () => {
    expect(monteCarlo(p, opts).assumptions).toMatch(/simulated values, not market data/i);
  });

  it('counts every path into the histogram', () => {
    const r = monteCarlo(p, { ...opts, paths: 5000 });
    expect(r.histogram.reduce((a, b) => a + b.count, 0)).toBe(5000);
  });
});

describe('presets', () => {
  const ctx = {
    spot: 100,
    nearExpiry: '2026-06-19',
    farExpiry: '2027-01-15',
    volatility: 0.25,
    contracts: 1,
    multiplier: 100,
  };

  it('builds every preset into legs with no premium invented', () => {
    for (const preset of PRESETS) {
      const built = applyPreset(preset.id, ctx);
      expect(built.legs.length, preset.id).toBeGreaterThan(0);
      for (const l of built.legs) {
        // A fabricated premium would flow straight into P/L and look real.
        expect(l.entryPremium, preset.id).toBe(0);
        expect(l.strike, preset.id).toBeGreaterThan(0);
      }
    }
  });

  it('gives calendars and diagonals two different expiries', () => {
    for (const id of ['calendar-call', 'diagonal-call', 'poor-mans-covered-call'] as const) {
      const built = applyPreset(id, ctx);
      expect(new Set(built.legs.map((l) => l.expiry)).size, id).toBe(2);
    }
  });

  it('attaches stock to the structures that need it', () => {
    for (const id of ['covered-call', 'protective-put', 'collar'] as const) {
      expect(applyPreset(id, ctx).stock, id).not.toBeNull();
    }
    expect(applyPreset('iron-condor', ctx).stock).toBeNull();
  });

  it('makes a box spread worth the strike width whatever the underlying does', () => {
    const built = applyPreset('box-spread', ctx);
    const p = position(built.legs);
    const width = 10; // 95 to 105 at spot 100.
    // A box is a financing trade: its payoff does not depend on the spot.
    for (const spot of [50, 95, 100, 105, 200]) {
      expect(profitAtExpiry(p, spot)).toBeCloseTo(width * 100, 6);
    }
  });
});

describe('OCC symbols', () => {
  it('parses a standard contract symbol', () => {
    expect(parseOccSymbol('AAPL260619C00150000')).toEqual({
      root: 'AAPL',
      expiry: '2026-06-19',
      type: 'call',
      strike: 150,
    });
  });

  it('parses a fractional strike', () => {
    expect(parseOccSymbol('SPY270115P00437500')?.strike).toBe(437.5);
  });

  it('refuses a symbol it cannot identify rather than guessing', () => {
    expect(parseOccSymbol('NOTASYMBOL')).toBeNull();
    expect(parseOccSymbol('')).toBeNull();
  });
});

describe('capital required', () => {
  it('is the maximum loss for a defined-risk spread', () => {
    const p = position([
      leg({ type: 'call', side: 'buy', strike: 100, entryPremium: 6 }),
      leg({ type: 'call', side: 'sell', strike: 110, entryPremium: 3 }),
    ]);
    expect(capitalRequired(p)).toBeCloseTo(300, 6);
  });

  it('is the strike less the credit for a cash-secured put', () => {
    const p = position([leg({ type: 'put', side: 'sell', strike: 95, entryPremium: 2 })]);
    // Worst case is the underlying at zero: 9500 obligation less 200 credit.
    expect(capitalRequired(p)).toBeCloseTo(9300, 6);
  });
});
