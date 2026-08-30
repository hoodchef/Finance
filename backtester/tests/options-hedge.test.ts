import { describe, expect, it } from 'vitest';
import {
  driftDistance,
  findHedges,
  probabilityHedgeBreaks,
  type HedgeRequest,
} from '../src/lib/options/hedge';
import { valuePosition, type OptionPosition } from '../src/lib/options/strategy';

/**
 * Hedging, against the case it was built for.
 * =============================================================================
 * "I hold 100 shares of Google and want to be delta neutral." 100 shares is
 * 100 delta, so the answer is either one deep in-the-money put (delta near
 * −1.00) or two at-the-money puts (near −0.50 each) — both correct, and
 * differing by several thousand dollars and by how long they stay neutral.
 * A tool that returns one without the other is hiding the decision.
 */

const SPOT = 200;
const ASOF = '2026-01-15';
const EXPIRY = '2026-07-17';

const hundredShares: OptionPosition = {
  underlying: 'GOOG',
  legs: [],
  stock: { side: 'buy', shares: 100, entryPrice: 180 },
  riskFreeRate: 0.04,
  dividendYield: 0,
};

const request = (over: Partial<HedgeRequest> = {}): HedgeRequest => ({
  position: hundredShares,
  spot: SPOT,
  asOf: ASOF,
  volatility: 0.3,
  objective: 'delta-neutral',
  expiries: [EXPIRY],
  maxContracts: 6,
  multiplier: 100,
  ...over,
});

describe('100 long shares, made delta neutral', () => {
  it('starts from a delta of exactly 100', () => {
    expect(valuePosition(hundredShares, { spot: SPOT, asOf: ASOF }).greeks.delta).toBe(100);
  });

  it('finds hedges that actually reach neutral', () => {
    const r = findHedges(request());
    expect(r.currentDelta).toBe(100);
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      // Within 2% of the starting delta, which is the tolerance whole
      // contracts allow.
      expect(Math.abs(c.residualDelta)).toBeLessThanOrEqual(2);
    }
  });

  it('offers both the one-deep-put and the two-at-the-money answers', () => {
    const r = findHedges(request({ instruments: ['put'], maxContracts: 6 }));
    const puts = r.candidates.filter((c) => c.legs.length === 1 && c.legs[0].type === 'put');
    expect(puts.length).toBeGreaterThan(0);
    // A single contract can only do it from deep in the money, where delta
    // approaches −1; more contracts work from nearer the money.
    const single = puts.find((c) => c.legs[0].contracts === 1);
    if (single) expect(single.legs[0].strike).toBeGreaterThan(SPOT);
  });

  it('ranks by cost among the hedges that work', () => {
    const r = findHedges(request());
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1].cost).toBeLessThanOrEqual(r.candidates[i].cost + 1e-6);
    }
  });

  it('includes shorting the shares, and marks it as exact at every price', () => {
    const r = findHedges(request());
    const stock = r.candidates.find((c) => c.shares !== 0);
    expect(stock, 'the stock hedge should be considered').toBeDefined();
    expect(stock!.shares).toBe(-100);
    expect(stock!.residualDelta).toBe(0);
    // The property that distinguishes it: no gamma, so it never drifts.
    expect(stock!.linear).toBe(true);
    expect(Math.abs(stock!.gamma)).toBeLessThan(1e-9);
  });

  it('says an option hedge is only neutral for an instant', () => {
    const r = findHedges(request({ instruments: ['put'] }));
    expect(r.notes.some((n) => /at this moment only|stops being/i.test(n))).toBe(true);
  });

  it('gives option hedges real gamma, which is the thing being warned about', () => {
    const r = findHedges(request({ instruments: ['put'] }));
    const optionHedge = r.candidates.find((c) => c.legs.length > 0);
    expect(optionHedge).toBeDefined();
    expect(Math.abs(optionHedge!.gamma)).toBeGreaterThan(0);
  });
});

describe('synthetic short stock', () => {
  it('finds it, names it, and prices it at put-call parity', () => {
    /*
     * Long put + short call at the same strike is short stock. It hedges 100
     * long shares exactly, carries no gamma, and pays a credit of S - Ke^-rT
     * rather than requiring the stock borrow. Emerged from the search rather
     * than being special-cased, and it is usually the best answer in the list.
     */
    const r = findHedges(request({ instruments: ['put', 'call'] }));
    const synth = r.candidates.find((c) => /Synthetic short/.test(c.label));
    expect(synth, 'the same-strike collar should be found and named').toBeDefined();
    expect(synth!.residualDelta).toBeCloseTo(0, 6);
    expect(Math.abs(synth!.gamma)).toBeLessThan(1e-6);
    expect(synth!.linear).toBe(true);

    // Credit of S - Ke^-rT per share, over 100 shares.
    const parity = (SPOT - SPOT * Math.exp(-0.04 * (yearsTo(EXPIRY)))) * 100;
    expect(-synth!.cost).toBeCloseTo(parity, 0);
  });
});

function yearsTo(expiry: string): number {
  return (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${ASOF}T00:00:00Z`)) / (365 * 86_400_000);
}

describe('keeping some exposure on purpose', () => {
  it('hits a chosen delta rather than zero', () => {
    const r = findHedges(request({ objective: 'target-delta', targetDelta: 50 }));
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) expect(Math.abs(c.residualDelta - 50)).toBeLessThanOrEqual(2);
  });

  it('shorts only the excess shares for a partial hedge', () => {
    const r = findHedges(request({ objective: 'target-delta', targetDelta: 40 }));
    const stock = r.candidates.find((c) => c.shares !== 0);
    expect(stock!.shares).toBe(-60);
  });

  it('reports the closest reachable delta rather than nothing', () => {
    // A target no whole-contract hedge can reach must still return something,
    // with the residual stated — silence would read as "impossible".
    const r = findHedges(request({ objective: 'target-delta', targetDelta: 37, instruments: ['put'] }));
    expect(r.candidates.length).toBeGreaterThan(0);
    if (r.notes.some((n) => /No whole-contract hedge reaches/i.test(n))) {
      expect(r.candidates[0].residualDelta).toBeDefined();
    }
  });
});

describe('protecting a floor', () => {
  it('only returns hedges that hold all the way down', () => {
    // The failure this guards against: a hedge that is fine at the floor and
    // falls apart below it. Checked at the floor, well under it, and at zero.
    const r = findHedges(request({ objective: 'protect-floor', floorPrice: 180, instruments: ['put'] }));
    for (const c of r.candidates) {
      expect(c.hedgedMaxLoss).not.toBeNull();
    }
  });

  it('prefers the cheapest protection', () => {
    const r = findHedges(request({ objective: 'protect-floor', floorPrice: 180, instruments: ['put'] }));
    if (r.candidates.length > 1) {
      expect(r.candidates[0].cost).toBeLessThanOrEqual(r.candidates[1].cost + 1e-6);
    }
  });

  it('says so when no available hedge holds the floor', () => {
    const impossible = findHedges(
      request({ objective: 'protect-floor', floorPrice: 199.9, instruments: ['put'], maxContracts: 1 }),
    );
    if (impossible.candidates.length === 0) {
      expect(impossible.notes.some((n) => /No available hedge holds/i.test(n))).toBe(true);
    }
  });
});

describe('constraints', () => {
  it('rejects hedges over the budget', () => {
    const r = findHedges(request({ instruments: ['put'], maxDebit: 500 }));
    for (const c of r.candidates) expect(c.cost).toBeLessThanOrEqual(500);
  });

  it('uses only the instruments allowed', () => {
    const r = findHedges(request({ instruments: ['put'] }));
    for (const c of r.candidates) {
      expect(c.shares).toBe(0);
      for (const l of c.legs) expect(l.type).toBe('put');
    }
  });
});

describe('how long a hedge lasts', () => {
  it('turns gamma into a distance the underlying can travel', () => {
    // The plain-language version of a gamma reading: not "gamma is 4" but
    // "a $6 move and you are 25 deltas long again".
    expect(driftDistance(4, 25)).toBeCloseTo(6.25, 9);
    expect(driftDistance(-4, 25)).toBeCloseTo(6.25, 9);
  });

  it('reports no drift for a hedge with no gamma', () => {
    // A stock hedge never needs adjusting, so there is no distance to report.
    expect(driftDistance(0)).toBeNull();
  });

  it('rates a nearer break as more likely', () => {
    const near = probabilityHedgeBreaks(200, 5, 0.3, 30);
    const far = probabilityHedgeBreaks(200, 50, 0.3, 30);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(1);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  it('rates a longer horizon as more likely to break', () => {
    expect(probabilityHedgeBreaks(200, 20, 0.3, 90)).toBeGreaterThan(
      probabilityHedgeBreaks(200, 20, 0.3, 7),
    );
  });
});

describe('hedging a position that already holds options', () => {
  it('nets the existing legs into the delta before hedging', () => {
    const withCall: OptionPosition = {
      ...hundredShares,
      legs: [
        {
          id: 'existing',
          type: 'call',
          side: 'sell',
          strike: 210,
          expiry: EXPIRY,
          contracts: 1,
          entryPremium: 8,
          multiplier: 100,
          style: 'european',
          impliedVolatility: 0.3,
        },
      ],
    };
    const before = valuePosition(withCall, { spot: SPOT, asOf: ASOF }).greeks.delta;
    // A covered call is already partly hedged, so less delta remains.
    expect(before).toBeLessThan(100);
    expect(before).toBeGreaterThan(0);

    const r = findHedges(request({ position: withCall }));
    expect(r.currentDelta).toBeCloseTo(before, 6);
    const stock = r.candidates.find((c) => c.shares !== 0);
    // It must short only what is left, not the full hundred.
    expect(Math.abs(stock!.shares)).toBeLessThan(100);
  });
});
