import type { CostBasisMethod, IsoDate } from '@/lib/types';
import { daysBetween } from '@/lib/market-data/dates';

/**
 * Lot-level cost basis tracking.
 * =============================================================================
 * This computes **no tax**. It computes the quantities a tax calculation would
 * be built from: which gains were realised, when, from what basis, and how long
 * the shares were held. Those are facts about the transactions, and they are the
 * same whatever jurisdiction reads them — so they can be produced honestly
 * without a single rate table.
 *
 * The invariant that keeps it correct:
 *
 *   realised + unrealised + dividends === the position's total profit and loss
 *
 * Purchase costs are capitalised into basis and sale costs are netted out of
 * proceeds, which is both the tax treatment and what makes that identity hold.
 * `tests/lots.test.ts` asserts it on a run with every feature switched on.
 */

export interface TaxLot {
  /** Acquisition date. */
  date: IsoDate;
  shares: number;
  /** Purchase price per share, including the trading cost paid to acquire it. */
  costPerShare: number;
}

export interface RealisedGain {
  date: IsoDate;
  symbol: string;
  shares: number;
  /** Sale value net of the trading cost paid to sell. */
  proceeds: number;
  costBasis: number;
  gain: number;
  /** Null under average cost, where an individual share has no holding period. */
  holdingDays: number | null;
  /** Held more than one year. Null under average cost. */
  longTerm: boolean | null;
}

/**
 * A per-symbol book of lots. `average` keeps one pooled lot, which is what an
 * adjusted-cost-base regime requires; the others keep them separate.
 */
export class LotBook {
  private lots: TaxLot[] = [];

  constructor(
    private readonly symbol: string,
    private readonly method: CostBasisMethod,
  ) {}

  get shares(): number {
    return this.lots.reduce((s, l) => s + l.shares, 0);
  }

  /** Total remaining cost basis of the open position. */
  get costBasis(): number {
    return this.lots.reduce((s, l) => s + l.shares * l.costPerShare, 0);
  }

  get openLots(): readonly TaxLot[] {
    return this.lots;
  }

  /** Records a purchase. `cost` is the trading cost, capitalised into basis. */
  buy(date: IsoDate, shares: number, price: number, cost: number): void {
    if (shares <= 0) return;
    const costPerShare = price + cost / shares;

    if (this.method === 'average') {
      const totalShares = this.shares + shares;
      const totalBasis = this.costBasis + shares * costPerShare;
      // One pooled lot; the date is the earliest acquisition, retained only so
      // the lot has a sensible label. Holding period is not reported.
      const earliest = this.lots.length ? this.lots[0].date : date;
      this.lots = [
        { date: earliest, shares: totalShares, costPerShare: totalBasis / totalShares },
      ];
      return;
    }

    this.lots.push({ date, shares, costPerShare });
  }

  /**
   * Records a sale, consuming lots in the order the method requires.
   * `cost` is the trading cost, netted out of proceeds.
   */
  sell(date: IsoDate, shares: number, price: number, cost: number): RealisedGain | null {
    if (shares <= 0 || !this.lots.length) return null;

    const order =
      this.method === 'hifo'
        ? [...this.lots].sort((a, b) => b.costPerShare - a.costPerShare)
        : this.lots; // fifo and average both consume from the front

    let remaining = Math.min(shares, this.shares);
    if (remaining <= 0) return null;

    const soldShares = remaining;
    let basis = 0;
    let weightedDays = 0;
    let allLongTerm = true;
    let anyMeasured = false;

    for (const lot of order) {
      if (remaining <= 1e-12) break;
      const take = Math.min(lot.shares, remaining);
      basis += take * lot.costPerShare;
      lot.shares -= take;
      remaining -= take;

      if (this.method !== 'average') {
        const held = daysBetween(lot.date, date);
        weightedDays += held * take;
        if (held <= 365) allLongTerm = false;
        anyMeasured = true;
      }
    }

    this.lots = this.lots.filter((l) => l.shares > 1e-12);

    const proceeds = soldShares * price - cost;
    const holdingDays = anyMeasured ? weightedDays / soldShares : null;

    return {
      date,
      symbol: this.symbol,
      shares: soldShares,
      proceeds,
      costBasis: basis,
      gain: proceeds - basis,
      holdingDays,
      longTerm: anyMeasured ? allLongTerm : null,
    };
  }

  /**
   * A split in a raw price series multiplies share counts without changing
   * total basis, so basis per share divides by the same factor.
   */
  applySplit(factor: number): void {
    if (factor === 1 || factor <= 0) return;
    for (const lot of this.lots) {
      lot.shares *= factor;
      lot.costPerShare /= factor;
    }
  }

  /**
   * Fund expense-ratio drag.
   *
   * A fund charges its fee internally: the shareholder's share count is
   * unchanged and the net asset value per share falls. The engine models the
   * identical value effect as a reduction in share count at a constant price,
   * so here the *total* basis must be held constant — you still paid what you
   * paid, and the fee shows up as a smaller unrealised gain.
   *
   * Shrinking basis alongside shares instead would leak the fee out of the
   * realised/unrealised split, and the reconciliation against profit and loss
   * would fail by exactly the amount of the fee.
   */
  applyDrag(retainedFraction: number): void {
    if (retainedFraction >= 1 || retainedFraction <= 0) return;
    for (const lot of this.lots) {
      lot.shares *= retainedFraction;
      lot.costPerShare /= retainedFraction;
    }
  }
}

export interface RealisedByYear {
  year: number;
  realisedGain: number;
  shortTerm: number;
  longTerm: number;
  unclassified: number;
  dividends: number;
  saleCount: number;
}

export interface LotSummary {
  symbol: string;
  /** Cost basis of the shares still held at the end. */
  openCostBasis: number;
  openShares: number;
  /** Market value at the end minus the open cost basis. */
  unrealisedGain: number;
  realisedGain: number;
  realisedShortTerm: number;
  realisedLongTerm: number;
  dividends: number;
}

export function summariseByYear(
  gains: RealisedGain[],
  dividendsByYear: Map<number, number>,
): RealisedByYear[] {
  const map = new Map<number, RealisedByYear>();

  const bucket = (year: number): RealisedByYear => {
    let b = map.get(year);
    if (!b) {
      b = {
        year,
        realisedGain: 0,
        shortTerm: 0,
        longTerm: 0,
        unclassified: 0,
        dividends: 0,
        saleCount: 0,
      };
      map.set(year, b);
    }
    return b;
  };

  for (const g of gains) {
    const b = bucket(Number(g.date.slice(0, 4)));
    b.realisedGain += g.gain;
    b.saleCount += 1;
    if (g.longTerm === true) b.longTerm += g.gain;
    else if (g.longTerm === false) b.shortTerm += g.gain;
    else b.unclassified += g.gain;
  }

  for (const [year, amount] of dividendsByYear) bucket(year).dividends += amount;

  return [...map.values()].sort((a, b) => a.year - b.year);
}
