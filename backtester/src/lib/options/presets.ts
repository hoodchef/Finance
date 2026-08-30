import type { OptionLeg, OptionPosition, StockLeg } from './strategy';

/**
 * Strategy templates.
 * =============================================================================
 * Each preset is a function that WRITES LEGS. Nothing downstream knows a
 * preset was used: once applied, an iron condor is four ordinary legs the user
 * can edit, delete or add to, and the analytics treat it exactly as they treat
 * a structure with no name.
 *
 * That is the difference between a template and a mode. A mode would keep the
 * structure valid by refusing edits, which is precisely the constraint that
 * makes options tools useless the moment anyone wants a broken wing, an
 * unbalanced ratio, or a leg rolled to a different expiry.
 *
 * Strikes are placed relative to spot and rounded to a sensible increment.
 * Premiums are left at zero deliberately: a real premium comes from the chain
 * or from the user, and inventing one would put a fabricated number in the
 * P/L of every preset. The builder flags legs with no premium.
 */

export type PresetId =
  | 'long-call'
  | 'long-put'
  | 'covered-call'
  | 'cash-secured-put'
  | 'protective-put'
  | 'bull-call-spread'
  | 'bear-put-spread'
  | 'bull-put-spread'
  | 'bear-call-spread'
  | 'calendar-call'
  | 'diagonal-call'
  | 'straddle'
  | 'strangle'
  | 'iron-condor'
  | 'iron-butterfly'
  | 'butterfly-call'
  | 'condor-call'
  | 'ratio-call-spread'
  | 'call-backspread'
  | 'collar'
  | 'jade-lizard'
  | 'poor-mans-covered-call'
  | 'box-spread';

export interface PresetContext {
  spot: number;
  /** Nearest listed expiry, ISO. */
  nearExpiry: string;
  /** A later expiry, for calendars and diagonals. */
  farExpiry: string;
  /** Assumed volatility for legs with no market quote. */
  volatility: number;
  contracts: number;
  multiplier: number;
}

export interface PresetDefinition {
  id: PresetId;
  label: string;
  /** What the structure is for, and what it costs you. */
  description: string;
  group: 'Directional' | 'Income' | 'Volatility' | 'Hedged' | 'Advanced';
  build: (ctx: PresetContext) => { legs: OptionLeg[]; stock?: StockLeg | null };
}

let counter = 0;
const legId = () => `leg-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Rounds to a strike increment that looks like a listed one. */
export function roundStrike(price: number): number {
  if (price >= 500) return Math.round(price / 10) * 10;
  if (price >= 100) return Math.round(price / 5) * 5;
  if (price >= 25) return Math.round(price);
  return Math.round(price * 2) / 2;
}

function leg(
  ctx: PresetContext,
  over: Partial<OptionLeg> & Pick<OptionLeg, 'type' | 'side' | 'strike'>,
): OptionLeg {
  return {
    id: legId(),
    expiry: ctx.nearExpiry,
    contracts: ctx.contracts,
    // Zero, not a guess. A fabricated premium would flow straight into P/L.
    entryPremium: 0,
    multiplier: ctx.multiplier,
    // Listed equity options are American; index options are typically
    // European. American is the safer default — it never understates value.
    style: 'american',
    impliedVolatility: ctx.volatility,
    ...over,
  };
}

export const PRESETS: PresetDefinition[] = [
  {
    id: 'long-call',
    label: 'Long call',
    group: 'Directional',
    description:
      'Unlimited upside, loss capped at the premium. Time decay works against you every day the underlying does not move.',
    build: (c) => ({ legs: [leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot) })] }),
  },
  {
    id: 'long-put',
    label: 'Long put',
    group: 'Directional',
    description: 'Profits as the underlying falls, loss capped at the premium.',
    build: (c) => ({ legs: [leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot) })] }),
  },
  {
    id: 'covered-call',
    label: 'Covered call',
    group: 'Income',
    description:
      'Shares plus a short call. Collects premium and caps your upside at the strike — you are selling the right tail.',
    build: (c) => ({
      legs: [leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.05) })],
      stock: { side: 'buy', shares: c.contracts * c.multiplier, entryPrice: c.spot },
    }),
  },
  {
    id: 'cash-secured-put',
    label: 'Cash-secured put',
    group: 'Income',
    description:
      'Short put with the cash to buy the shares. Identical payoff to a covered call at the same strike.',
    build: (c) => ({
      legs: [leg(c, { type: 'put', side: 'sell', strike: roundStrike(c.spot * 0.95) })],
    }),
  },
  {
    id: 'protective-put',
    label: 'Protective put',
    group: 'Hedged',
    description: 'Shares plus a long put: a floor under the position, paid for in premium.',
    build: (c) => ({
      legs: [leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot * 0.95) })],
      stock: { side: 'buy', shares: c.contracts * c.multiplier, entryPrice: c.spot },
    }),
  },
  {
    id: 'bull-call-spread',
    label: 'Bull call spread',
    group: 'Directional',
    description: 'Long a lower call, short a higher one. Defined risk and defined reward.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.1) }),
      ],
    }),
  },
  {
    id: 'bear-put-spread',
    label: 'Bear put spread',
    group: 'Directional',
    description: 'Long a higher put, short a lower one.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot) }),
        leg(c, { type: 'put', side: 'sell', strike: roundStrike(c.spot * 0.9) }),
      ],
    }),
  },
  {
    id: 'bull-put-spread',
    label: 'Bull put spread (credit)',
    group: 'Income',
    description: 'Short a higher put, long a lower one. Takes in a credit and wins if price holds up.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'put', side: 'sell', strike: roundStrike(c.spot * 0.95) }),
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot * 0.85) }),
      ],
    }),
  },
  {
    id: 'bear-call-spread',
    label: 'Bear call spread (credit)',
    group: 'Income',
    description: 'Short a lower call, long a higher one.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.05) }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.15) }),
      ],
    }),
  },
  {
    id: 'calendar-call',
    label: 'Calendar spread (call)',
    group: 'Volatility',
    description:
      'Short a near call, long a far one at the same strike. Profits from the near leg decaying faster — and from volatility rising.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot), expiry: c.nearExpiry }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot), expiry: c.farExpiry }),
      ],
    }),
  },
  {
    id: 'diagonal-call',
    label: 'Diagonal spread (call)',
    group: 'Advanced',
    description: 'A calendar with different strikes: time decay plus a directional lean.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.05), expiry: c.nearExpiry }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot), expiry: c.farExpiry }),
      ],
    }),
  },
  {
    id: 'straddle',
    label: 'Long straddle',
    group: 'Volatility',
    description:
      'Call and put at the same strike. Needs a move larger than the combined premium in either direction.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot) }),
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot) }),
      ],
    }),
  },
  {
    id: 'strangle',
    label: 'Long strangle',
    group: 'Volatility',
    description: 'Out-of-the-money call and put. Cheaper than a straddle and needs a bigger move.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.1) }),
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot * 0.9) }),
      ],
    }),
  },
  {
    id: 'iron-condor',
    label: 'Iron condor',
    group: 'Income',
    description:
      'Sells a call spread and a put spread. Wins in a range, defined risk on both wings.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot * 0.85) }),
        leg(c, { type: 'put', side: 'sell', strike: roundStrike(c.spot * 0.93) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.07) }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.15) }),
      ],
    }),
  },
  {
    id: 'iron-butterfly',
    label: 'Iron butterfly',
    group: 'Income',
    description: 'An iron condor with both short strikes at the money. More credit, narrower range.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot * 0.9) }),
        leg(c, { type: 'put', side: 'sell', strike: roundStrike(c.spot) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot) }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.1) }),
      ],
    }),
  },
  {
    id: 'butterfly-call',
    label: 'Call butterfly',
    group: 'Volatility',
    description: 'Long one low, short two middle, long one high. Peaks at the middle strike.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 0.95) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot), contracts: c.contracts * 2 }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.05) }),
      ],
    }),
  },
  {
    id: 'condor-call',
    label: 'Call condor',
    group: 'Volatility',
    description: 'A butterfly with a flat top: a wider band of maximum profit.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 0.9) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 0.97) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.03) }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.1) }),
      ],
    }),
  },
  {
    id: 'ratio-call-spread',
    label: 'Call ratio spread',
    group: 'Advanced',
    description:
      'Long one call, short two higher. Often opens for a credit and carries UNLIMITED loss above the short strikes.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.08), contracts: c.contracts * 2 }),
      ],
    }),
  },
  {
    id: 'call-backspread',
    label: 'Call backspread',
    group: 'Advanced',
    description: 'Short one lower call, long two higher. Loses in a small rally, profits in a large one.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot) }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.08), contracts: c.contracts * 2 }),
      ],
    }),
  },
  {
    id: 'collar',
    label: 'Collar',
    group: 'Hedged',
    description:
      'Shares, a long put and a short call. The call pays for the put; you give up upside for a floor.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'put', side: 'buy', strike: roundStrike(c.spot * 0.95) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.05) }),
      ],
      stock: { side: 'buy', shares: c.contracts * c.multiplier, entryPrice: c.spot },
    }),
  },
  {
    id: 'jade-lizard',
    label: 'Jade lizard',
    group: 'Advanced',
    description:
      'Short put plus a short call spread. Structured so the credit exceeds the call spread width, which removes upside risk entirely.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'put', side: 'sell', strike: roundStrike(c.spot * 0.92) }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.05) }),
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 1.12) }),
      ],
    }),
  },
  {
    id: 'poor-mans-covered-call',
    label: "Poor man's covered call",
    group: 'Income',
    description:
      'A deep in-the-money long-dated call standing in for the shares, with a short near call against it.',
    build: (c) => ({
      legs: [
        leg(c, { type: 'call', side: 'buy', strike: roundStrike(c.spot * 0.8), expiry: c.farExpiry }),
        leg(c, { type: 'call', side: 'sell', strike: roundStrike(c.spot * 1.05), expiry: c.nearExpiry }),
      ],
    }),
  },
  {
    id: 'box-spread',
    label: 'Box spread',
    group: 'Advanced',
    description:
      'A bull call spread and a bear put spread at the same strikes. Payoff is fixed at the strike width — a financing trade, not a directional one.',
    build: (c) => {
      const lo = roundStrike(c.spot * 0.95);
      const hi = roundStrike(c.spot * 1.05);
      return {
        legs: [
          leg(c, { type: 'call', side: 'buy', strike: lo }),
          leg(c, { type: 'call', side: 'sell', strike: hi }),
          leg(c, { type: 'put', side: 'buy', strike: hi }),
          leg(c, { type: 'put', side: 'sell', strike: lo }),
        ],
      };
    },
  },
];

export function applyPreset(
  id: PresetId,
  ctx: PresetContext,
): { legs: OptionLeg[]; stock: StockLeg | null } {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return { legs: [], stock: null };
  const built = preset.build(ctx);
  return { legs: built.legs, stock: built.stock ?? null };
}

/** A blank position, for building from scratch. */
export function emptyPosition(underlying: string): OptionPosition {
  return { underlying, legs: [], stock: null, riskFreeRate: 0.04, dividendYield: 0 };
}

export function newLeg(ctx: PresetContext): OptionLeg {
  return leg(ctx, { type: 'call', side: 'buy', strike: roundStrike(ctx.spot) });
}
