import { describe, expect, it } from 'vitest';
import { LotBook, summariseByYear } from '../src/lib/engine/lots';
import { runEngine } from '../src/lib/engine/engine';
import { buildPrepared, flat, makeCalendar, ramp, testConfig } from './helpers';

/**
 * Cost basis is pure accounting, so every expected value below is arithmetic a
 * reader can redo. The last test is the one that matters most: realised plus
 * unrealised plus dividends must reconstruct the position's profit and loss,
 * with every engine feature switched on at once.
 */

const portfolio = (symbols: Array<[string, number]>) => ({
  id: 'p',
  name: 'P',
  positions: symbols.map(([symbol, weight]) => ({ id: symbol, symbol, weight })),
});

describe('lot book', () => {
  it('consumes the oldest shares first under FIFO', () => {
    const b = new LotBook('X', 'fifo');
    b.buy('2020-01-02', 10, 100, 0); // basis 1,000
    b.buy('2021-01-04', 10, 200, 0); // basis 2,000

    const g = b.sell('2022-01-03', 10, 300, 0)!;
    // The 2020 lot goes first: proceeds 3,000 against a 1,000 basis.
    expect(g.costBasis).toBeCloseTo(1_000, 10);
    expect(g.proceeds).toBeCloseTo(3_000, 10);
    expect(g.gain).toBeCloseTo(2_000, 10);
    expect(g.longTerm).toBe(true);
    expect(b.shares).toBeCloseTo(10, 10);
    expect(b.costBasis).toBeCloseTo(2_000, 10);
  });

  it('consumes the most expensive shares first under HIFO', () => {
    const b = new LotBook('X', 'hifo');
    b.buy('2020-01-02', 10, 100, 0);
    b.buy('2021-01-04', 10, 200, 0);

    const g = b.sell('2022-01-03', 10, 300, 0)!;
    // The 2,000 basis is used first, so the smallest gain is realised.
    expect(g.costBasis).toBeCloseTo(2_000, 10);
    expect(g.gain).toBeCloseTo(1_000, 10);
    expect(b.costBasis).toBeCloseTo(1_000, 10);
  });

  it('pools everything into one average cost', () => {
    const b = new LotBook('X', 'average');
    b.buy('2020-01-02', 10, 100, 0);
    b.buy('2021-01-04', 10, 200, 0);
    // (1,000 + 2,000) / 20 = 150 per share.
    expect(b.costBasis / b.shares).toBeCloseTo(150, 10);

    const g = b.sell('2022-01-03', 10, 300, 0)!;
    expect(g.costBasis).toBeCloseTo(1_500, 10);
    expect(g.gain).toBeCloseTo(1_500, 10);
    // An averaged share has no individual holding period.
    expect(g.holdingDays).toBeNull();
    expect(g.longTerm).toBeNull();
  });

  it('capitalises purchase costs and nets sale costs out of proceeds', () => {
    const b = new LotBook('X', 'fifo');
    b.buy('2020-01-02', 10, 100, 50); // basis 1,050
    const g = b.sell('2020-06-01', 10, 120, 30)!; // proceeds 1,170
    expect(g.costBasis).toBeCloseTo(1_050, 10);
    expect(g.proceeds).toBeCloseTo(1_170, 10);
    expect(g.gain).toBeCloseTo(120, 10);
  });

  it('classifies holding periods around the one-year line', () => {
    const b = new LotBook('X', 'fifo');
    b.buy('2020-01-02', 10, 100, 0);
    const short = b.sell('2020-12-15', 5, 110, 0)!;
    expect(short.longTerm).toBe(false);
    expect(short.holdingDays).toBe(348);

    const long = b.sell('2021-06-01', 5, 110, 0)!;
    expect(long.longTerm).toBe(true);
    expect(long.holdingDays).toBeGreaterThan(365);
  });

  it('leaves basis per share unchanged through a split', () => {
    const b = new LotBook('X', 'fifo');
    b.buy('2020-01-02', 10, 100, 0);
    b.applySplit(4);
    expect(b.shares).toBeCloseTo(40, 10);
    expect(b.costBasis).toBeCloseTo(1_000, 10); // Total basis is untouched.
    expect(b.costBasis / b.shares).toBeCloseTo(25, 10);
  });

  it('leaves total basis untouched when a fund charges its expense ratio', () => {
    const b = new LotBook('X', 'fifo');
    b.buy('2020-01-02', 100, 10, 0);
    b.applyDrag(0.99);

    expect(b.shares).toBeCloseTo(99, 10);
    // You still paid $1,000; the fee reduced value, not what it cost you. It
    // therefore surfaces as a smaller unrealised gain, not as a lower basis.
    expect(b.costBasis).toBeCloseTo(1_000, 8);

    // Selling everything at the unchanged price now shows the fee as a loss,
    // which is exactly what a real NAV reduction would produce.
    const g = b.sell('2020-06-01', 99, 10, 0)!;
    expect(g.proceeds).toBeCloseTo(990, 8);
    expect(g.costBasis).toBeCloseTo(1_000, 8);
    expect(g.gain).toBeCloseTo(-10, 8);
  });

  it('never sells more than it holds', () => {
    const b = new LotBook('X', 'fifo');
    b.buy('2020-01-02', 5, 100, 0);
    const g = b.sell('2020-06-01', 50, 120, 0)!;
    expect(g.shares).toBeCloseTo(5, 10);
    expect(b.shares).toBeCloseTo(0, 10);
    expect(b.sell('2020-07-01', 5, 120, 0)).toBeNull();
  });
});

describe('yearly summary', () => {
  it('splits realised gains into short and long term and adds dividend income', () => {
    const rows = summariseByYear(
      [
        { date: '2021-03-01', symbol: 'A', shares: 1, proceeds: 100, costBasis: 60, gain: 40, holdingDays: 100, longTerm: false },
        { date: '2021-09-01', symbol: 'A', shares: 1, proceeds: 100, costBasis: 40, gain: 60, holdingDays: 500, longTerm: true },
        { date: '2022-01-01', symbol: 'B', shares: 1, proceeds: 50, costBasis: 80, gain: -30, holdingDays: 20, longTerm: false },
      ],
      new Map([
        [2021, 25],
        [2022, 30],
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ year: 2021, realisedGain: 100, shortTerm: 40, longTerm: 60, dividends: 25, saleCount: 2 });
    expect(rows[1]).toMatchObject({ year: 2022, realisedGain: -30, shortTerm: -30, longTerm: 0, dividends: 30 });
  });
});

describe('engine integration', () => {
  it('realises nothing when nothing is ever sold', () => {
    const cal = makeCalendar('2020-01-02', 250);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 150, 250), weight: 100 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ rebalance: 'never' }),
      data,
    });
    expect(r.totals.totalRealisedGain).toBeCloseTo(0, 8);
    expect(r.totals.totalUnrealisedGain).toBeCloseTo(r.totals.investmentGain, 6);
  });

  it('shows rebalancing crystallising gains that buy-and-hold leaves open', () => {
    const cal = makeCalendar('2020-01-01', 500);
    const spec = [
      { symbol: 'A', prices: ramp(100, 300, 500), weight: 50 },
      { symbol: 'B', prices: flat(100, 500), weight: 50 },
    ];
    const hold = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'never' }),
      data: buildPrepared(cal, spec),
    });
    const rebalanced = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'quarterly' }),
      data: buildPrepared(cal, spec),
    });

    expect(hold.totals.totalRealisedGain).toBeCloseTo(0, 6);
    // Trimming the winner every quarter turns paper gains into realised ones —
    // the tax drag of rebalancing, before any tax is applied.
    expect(rebalanced.totals.totalRealisedGain).toBeGreaterThan(500);
    expect(rebalanced.realisedByYear.length).toBeGreaterThan(0);
  });

  it('reconciles realised, unrealised and dividends against profit and loss', () => {
    const cal = makeCalendar('2020-01-01', 700);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 260, 700), weight: 50, dividends: { 60: 1.1, 300: 1.3, 600: 1.5 }, expenseRatioPct: 0.2 },
      { symbol: 'B', prices: ramp(100, 70, 700), weight: 30, dividends: { 120: 0.9 } },
      { symbol: 'CASH', prices: flat(1, 700), weight: 20, isCash: true },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 50], ['B', 30], ['CASH', 20]]),
      config: testConfig({
        rebalance: 'quarterly',
        contributionAmount: 400,
        contributionFrequency: 'monthly',
        cashYieldPct: 2,
        fees: { managementFeePct: 0.4, tradingCostBps: 8, commissionPerTrade: 0.75, defaultExpenseRatioPct: 0 },
      }),
      data,
    });

    for (const symbol of ['A', 'B']) {
      const ledger = r.ledgers.find((l) => l.symbol === symbol)!;
      const lot = r.lots.find((l) => l.symbol === symbol)!;
      // realised + unrealised + dividends === the position's total P&L.
      expect(lot.realisedGain + lot.unrealisedGain + lot.dividends).toBeCloseTo(
        ledger.profitAndLoss,
        4,
      );
    }

    expect(r.totals.totalRealisedGain).not.toBeCloseTo(0, 2);
    expect(r.lots.every((l) => l.openCostBasis >= 0)).toBe(true);
  });

  it('realises smaller gains under HIFO than under FIFO', () => {
    // A must oscillate, not just trend: a one-directional move is bought and
    // sold from a single lot, and every basis method then agrees.
    const days = 900;
    const cal = makeCalendar('2020-01-01', days);
    const oscillating = Array.from(
      { length: days },
      (_, i) => 100 * (1 + 0.45 * Math.sin(i / 24)),
    );
    const spec = [
      { symbol: 'A', prices: oscillating, weight: 50 },
      { symbol: 'B', prices: flat(100, days), weight: 50 },
    ];
    const run = (method: 'fifo' | 'hifo' | 'average') =>
      runEngine({
        portfolio: portfolio([['A', 50], ['B', 50]]),
        config: testConfig({ rebalance: 'monthly', costBasisMethod: method }),
        data: buildPrepared(cal, spec),
      });

    const fifo = run('fifo');
    const hifo = run('hifo');
    const average = run('average');

    // Selling the most expensive shares first realises the smallest gain.
    expect(hifo.totals.totalRealisedGain).toBeLessThan(fifo.totals.totalRealisedGain);
    expect(average.totals.totalRealisedGain).not.toBeCloseTo(
      fifo.totals.totalRealisedGain,
      2,
    );

    // The method moves gains between realised and unrealised; it cannot change
    // the total the portfolio actually made, nor the trades it executed.
    for (const other of [hifo, average]) {
      expect(other.totals.investmentGain).toBeCloseTo(fifo.totals.investmentGain, 6);
      expect(other.totals.finalValue).toBeCloseTo(fifo.totals.finalValue, 6);
      expect(other.totals.tradeCount).toBe(fifo.totals.tradeCount);
      expect(other.totals.totalRealisedGain + other.totals.totalUnrealisedGain).toBeCloseTo(
        fifo.totals.totalRealisedGain + fifo.totals.totalUnrealisedGain,
        4,
      );
    }

    // Average cost cannot classify a holding period, so nothing is bucketed
    // short or long term under it.
    expect(average.realisedGains.every((g) => g.longTerm === null)).toBe(true);
    expect(fifo.realisedGains.some((g) => g.longTerm !== null)).toBe(true);
  });
});
