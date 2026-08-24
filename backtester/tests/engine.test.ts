import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/lib/engine/engine';
import { computeMetrics, cashFlowsFromResult } from '../src/lib/metrics';
import { buildPrepared, flat, makeCalendar, ramp, testConfig } from './helpers';

/**
 * Every expected value below is arithmetic a reader can redo by hand. The point
 * is not coverage — it is that a wrong number fails, rather than a number that
 * merely differs from whatever the code happened to produce first.
 */

const portfolio = (symbols: Array<[string, number]>) => ({
  id: 'p',
  name: 'P',
  positions: symbols.map(([symbol, weight]) => ({ id: symbol, symbol, weight })),
});

describe('single asset, no frictions', () => {
  it('tracks share count and value exactly', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [{ symbol: 'A', prices: [100, 110, 121], weight: 100 }]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });

    // $10,000 / $100 = 100 shares, held throughout.
    expect(r.daily[0].positionShares.A).toBeCloseTo(100, 10);
    expect(r.daily[0].totalValue).toBeCloseTo(10_000, 8);
    expect(r.daily[1].totalValue).toBeCloseTo(11_000, 8);
    expect(r.daily[2].totalValue).toBeCloseTo(12_100, 8);

    expect(r.daily[1].twrReturn).toBeCloseTo(0.1, 12);
    expect(r.daily[2].twrReturn).toBeCloseTo(0.1, 12);
    expect(r.daily[2].index).toBeCloseTo(1.21, 12);
  });

  it('does not derive return from first and last price alone', () => {
    // A path that ends where it started still has real interim volatility.
    const cal = makeCalendar('2020-01-02', 5);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, 150, 80, 120, 100], weight: 100 },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });
    const m = computeMetrics({ daily: r.daily, periodsPerYear: 252, riskFree: data.riskFree });

    expect(m.returns.totalReturn).toBeCloseTo(0, 10);
    expect(m.risk.volatility).toBeGreaterThan(0.5);
    // Peak 150 → trough 80 is −46.67%.
    expect(m.risk.maxDrawdown).toBeCloseTo(80 / 150 - 1, 10);
  });
});

describe('contributions', () => {
  it('never counts contributed capital as investment return', () => {
    // Flat market for two years with $1,000 added every month.
    const cal = makeCalendar('2020-01-01', 522);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 100 },
    ]);
    const config = testConfig({
      initialInvestment: 10_000,
      contributionAmount: 1_000,
      contributionFrequency: 'monthly',
    });
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config, data });
    const m = computeMetrics({
      daily: r.daily,
      periodsPerYear: 252,
      riskFree: data.riskFree,
      cashFlows: cashFlowsFromResult(r),
    });

    expect(r.totals.totalContributions).toBeGreaterThan(20_000);
    expect(r.totals.finalValue).toBeCloseTo(r.totals.netInvested, 6);
    // The whole point: a flat market produces a 0% time-weighted return even
    // though the balance grew by more than 200%.
    expect(m.returns.totalReturn).toBeCloseTo(0, 9);
    expect(m.returns.cagr).toBeCloseTo(0, 9);
    expect(m.returns.moneyWeightedReturn ?? 0).toBeCloseTo(0, 6);
  });

  it('invests contributions at target weights', () => {
    const cal = makeCalendar('2020-01-01', 45);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 75 },
      { symbol: 'B', prices: flat(50, cal.length), weight: 25 },
    ]);
    const config = testConfig({
      initialInvestment: 10_000,
      contributionAmount: 4_000,
      contributionFrequency: 'monthly',
    });
    const r = runEngine({ portfolio: portfolio([['A', 75], ['B', 25]]), config, data });
    const last = r.daily[r.daily.length - 1];
    const total = last.totalValue;
    expect(last.positionValues.A / total).toBeCloseTo(0.75, 6);
    expect(last.positionValues.B / total).toBeCloseTo(0.25, 6);
  });

  it('rolls a contribution scheduled on a weekend to the next trading day', () => {
    // 2021-05-01 is a Saturday; the first trading day of May 2021 is Monday 3rd.
    const cal = makeCalendar('2021-04-01', 45);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 100 },
    ]);
    const config = testConfig({
      contributionAmount: 500,
      contributionFrequency: 'monthly',
    });
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config, data });
    const flows = r.daily.filter((d) => d.netFlow > 0 && d.date !== r.daily[0].date);
    expect(flows.map((f) => f.date)).toContain('2021-05-03');
    expect(flows.every((f) => cal.includes(f.date))).toBe(true);
  });
});

describe('withdrawals', () => {
  it('sells positions to fund a withdrawal and reports the flow', () => {
    const cal = makeCalendar('2020-01-01', 130);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 100 },
    ]);
    const config = testConfig({
      initialInvestment: 10_000,
      contributionAmount: 500,
      contributionFrequency: 'monthly',
      contributionIsWithdrawal: true,
    });
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config, data });
    expect(r.totals.totalWithdrawals).toBeGreaterThan(1_000);
    expect(r.totals.finalValue).toBeCloseTo(10_000 - r.totals.totalWithdrawals, 4);
  });
});

describe('dividends', () => {
  it('reinvests at the close of the ex-date', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, 100, 110], weight: 100, dividends: { 1: 5 } },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });

    // 100 shares × $5 = $500 of cash, buying 5 more shares at $100.
    expect(r.daily[1].positionShares.A).toBeCloseTo(105, 10);
    expect(r.daily[1].cash).toBeCloseTo(0, 8);
    expect(r.daily[1].totalValue).toBeCloseTo(10_500, 8);
    // The extra shares then participate in the next day's move.
    expect(r.daily[2].totalValue).toBeCloseTo(105 * 110, 8);
    expect(r.totals.totalDividends).toBeCloseTo(500, 8);
  });

  it('holds dividends as cash when reinvestment is off', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, 100, 110], weight: 100, dividends: { 1: 5 } },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ dividends: 'cash' }),
      data,
    });

    expect(r.daily[1].positionShares.A).toBeCloseTo(100, 10);
    expect(r.daily[1].cash).toBeCloseTo(500, 8);
    expect(r.daily[1].totalValue).toBeCloseTo(10_500, 8);
    // Cash does not participate in the rally, so this run ends lower.
    expect(r.daily[2].totalValue).toBeCloseTo(100 * 110 + 500, 8);
  });
});

describe('splits', () => {
  it('adjusts share counts when the provider returns raw prices', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, 50, 55], weight: 100, splitFactors: { 1: 2 } },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });

    expect(r.daily[1].positionShares.A).toBeCloseTo(200, 10);
    expect(r.daily[1].totalValue).toBeCloseTo(10_000, 8); // A split creates no value.
    expect(r.daily[1].twrReturn).toBeCloseTo(0, 12);
    expect(r.daily[2].totalValue).toBeCloseTo(11_000, 8);
  });

  it('needs no split handling for split-adjusted series', () => {
    // The same economics with the vendor's retroactive adjustment applied.
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [50, 50, 55], weight: 100 },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });
    expect(r.daily[2].totalValue).toBeCloseTo(11_000, 8);
  });
});

describe('rebalancing', () => {
  it('restores target weights on the first trading day of the period', () => {
    const cal = makeCalendar('2020-01-01', 300);
    // A doubles over the window, B is flat: without rebalancing A takes over.
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 200, cal.length), weight: 50 },
      { symbol: 'B', prices: flat(100, cal.length), weight: 50 },
    ]);

    const never = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'never' }),
      data,
    });
    const monthly = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data,
    });

    const endWeight = (r: typeof never) => {
      const d = r.daily[r.daily.length - 1];
      return d.positionValues.A / d.totalValue;
    };
    expect(endWeight(never)).toBeGreaterThan(0.6);
    expect(endWeight(monthly)).toBeLessThan(0.55);
    expect(monthly.totals.rebalanceCount).toBeGreaterThanOrEqual(13);

    // Immediately after each rebalance the split is back to 50/50.
    const day = monthly.daily.find((d) => d.rebalanced)!;
    expect(day.positionValues.A / day.totalValue).toBeCloseTo(0.5, 6);
  });

  it('rebalances on a drift band only when the band is breached', () => {
    const cal = makeCalendar('2020-01-01', 300);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 200, cal.length), weight: 50 },
      { symbol: 'B', prices: flat(100, cal.length), weight: 50 },
    ]);
    const tight = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'threshold', rebalanceThresholdPct: 1 }),
      data,
    });
    const loose = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'threshold', rebalanceThresholdPct: 10 }),
      data,
    });
    expect(tight.totals.rebalanceCount).toBeGreaterThan(loose.totals.rebalanceCount);
    expect(loose.totals.rebalanceCount).toBeGreaterThan(0);
  });

  it('normalises weights that do not sum to 100', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, 3), weight: 30 },
      { symbol: 'B', prices: flat(100, 3), weight: 10 },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 30], ['B', 10]]), config: testConfig(), data });
    // 30/40 and 10/40 of $10,000.
    expect(r.daily[0].positionValues.A).toBeCloseTo(7_500, 6);
    expect(r.daily[0].positionValues.B).toBeCloseTo(2_500, 6);
  });
});

describe('fees', () => {
  it('charges an annual management fee close to its stated rate', () => {
    const cal = makeCalendar('2020-01-01', 262); // ~1 calendar year of weekdays.
    const data = buildPrepared(cal, [{ symbol: 'A', prices: flat(100, cal.length), weight: 100 }]);
    const r = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ fees: { managementFeePct: 1, tradingCostBps: 0, commissionPerTrade: 0, defaultExpenseRatioPct: 0 } }),
      data,
    });
    // 1% of $10,000 over a year, charged monthly on a shrinking balance.
    expect(r.totals.totalManagementFees).toBeGreaterThan(95);
    expect(r.totals.totalManagementFees).toBeLessThan(101);
    expect(r.totals.finalValue).toBeCloseTo(10_000 - r.totals.totalManagementFees, 4);
  });

  it('models a fund expense ratio as NAV drag, not a cash charge', () => {
    const cal = makeCalendar('2020-01-01', 262);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 100, expenseRatioPct: 0.5 },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });
    expect(r.totals.totalExpenseRatioCost).toBeGreaterThan(47);
    expect(r.totals.totalExpenseRatioCost).toBeLessThan(51);
    // Drag reduces the share count; the cash balance is untouched.
    expect(r.daily[r.daily.length - 1].cash).toBeCloseTo(0, 6);
    expect(r.daily[r.daily.length - 1].positionShares.A).toBeLessThan(100);
  });

  it('charges trading costs on every rebalance', () => {
    const cal = makeCalendar('2020-01-01', 300);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 200, cal.length), weight: 50 },
      { symbol: 'B', prices: flat(100, cal.length), weight: 50 },
    ]);
    const free = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'monthly' }),
      data,
    });
    const costly = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({
        rebalance: 'monthly',
        fees: { managementFeePct: 0, tradingCostBps: 50, commissionPerTrade: 1, defaultExpenseRatioPct: 0 },
      }),
      data,
    });
    expect(costly.totals.totalTradingCosts).toBeGreaterThan(0);
    expect(costly.totals.finalValue).toBeLessThan(free.totals.finalValue);
  });
});

describe('cash', () => {
  it('keeps an explicit cash sleeve out of the market', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, 200, 200], weight: 50 },
      { symbol: 'CASH', prices: flat(1, 3), weight: 50, isCash: true },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 50], ['CASH', 50]]), config: testConfig(), data });
    expect(r.daily[0].cash).toBeCloseTo(5_000, 6);
    // Only the invested half doubles.
    expect(r.daily[1].totalValue).toBeCloseTo(15_000, 6);
  });

  it('pays interest on cash at the configured yield', () => {
    const cal = makeCalendar('2020-01-01', 262);
    const data = buildPrepared(cal, [
      { symbol: 'CASH', prices: flat(1, 262), weight: 100, isCash: true },
    ]);
    const r = runEngine({
      portfolio: portfolio([['CASH', 100]]),
      config: testConfig({ cashYieldPct: 5 }),
      data,
    });
    // ~5% simple daily accrual over ~one year.
    expect(r.totals.totalCashInterest).toBeGreaterThan(480);
    expect(r.totals.totalCashInterest).toBeLessThan(530);
  });
});

describe('edge cases', () => {
  it('carries a price forward when a security does not trade', () => {
    const cal = makeCalendar('2020-01-02', 4);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, null, null, 120], weight: 100 },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });
    expect(r.daily[1].totalValue).toBeCloseTo(10_000, 6);
    expect(r.daily[1].hasStalePrice).toBe(true);
    expect(r.daily[3].totalValue).toBeCloseTo(12_000, 6);
  });

  it('liquidates a delisted holding to cash and warns', () => {
    const cal = makeCalendar('2020-01-02', 6);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: [100, 110, 120, 0, 0, 0], weight: 50, lastIndex: 2 },
      { symbol: 'B', prices: flat(100, 6), weight: 50 },
    ]);
    const r = runEngine({ portfolio: portfolio([['A', 50], ['B', 50]]), config: testConfig(), data });

    expect(r.daily[2].positionShares.A).toBeCloseTo(0, 8);
    expect(r.daily[2].cash).toBeCloseTo(6_000, 4); // 50 shares × $120.
    expect(r.warnings.some((w) => w.code === 'position-liquidated')).toBe(true);
    expect(r.daily[5].totalValue).toBeCloseTo(11_000, 4);
  });

  it('holds the weight of a not-yet-listed asset in cash', () => {
    const cal = makeCalendar('2020-01-02', 4);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, 4), weight: 50 },
      { symbol: 'B', prices: [0, 0, 100, 200], weight: 50, firstIndex: 2 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 50], ['B', 50]]),
      config: testConfig({ rebalance: 'never', inceptionPolicy: 'cash' }),
      data,
    });
    expect(r.daily[0].positionShares.B).toBeCloseTo(0, 8);
    expect(r.daily[0].cash).toBeCloseTo(5_000, 4);
    // Still uninvested in B until a rebalance or contribution deploys the cash.
    expect(r.daily[3].cash).toBeCloseTo(5_000, 4);
  });

  it('produces an empty result rather than throwing on an empty window', () => {
    const data = buildPrepared([], []);
    const r = runEngine({ portfolio: portfolio([['A', 100]]), config: testConfig(), data });
    expect(r.daily).toHaveLength(0);
    expect(r.totals.finalValue).toBe(0);
  });
});

describe('attribution', () => {
  it('closes exactly against the portfolio result', () => {
    const cal = makeCalendar('2020-01-01', 400);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 240, cal.length), weight: 50, dividends: { 60: 1.2, 180: 1.4, 300: 1.5 }, expenseRatioPct: 0.2 },
      { symbol: 'B', prices: ramp(100, 80, cal.length), weight: 30, dividends: { 90: 0.8 } },
      { symbol: 'CASH', prices: flat(1, cal.length), weight: 20, isCash: true },
    ]);
    const config = testConfig({
      rebalance: 'quarterly',
      contributionAmount: 750,
      contributionFrequency: 'monthly',
      cashYieldPct: 2,
      fees: { managementFeePct: 0.6, tradingCostBps: 10, commissionPerTrade: 0.5, defaultExpenseRatioPct: 0 },
    });
    const r = runEngine({
      portfolio: portfolio([['A', 50], ['B', 30], ['CASH', 20]]),
      config,
      data,
    });

    // finalValue − netInvested must equal the sum of every symbol's P&L, plus
    // cash interest, minus the portfolio-level management fee. Trading costs
    // and expense-ratio drag are already inside each symbol's P&L.
    const symbolPnl = r.ledgers
      .filter((l) => l.symbol !== 'CASH')
      .reduce((s, l) => s + l.profitAndLoss, 0);
    const reconstructed =
      symbolPnl + r.totals.totalCashInterest - r.totals.totalManagementFees;

    expect(reconstructed).toBeCloseTo(r.totals.investmentGain, 4);
    expect(r.totals.finalValue - r.totals.netInvested).toBeCloseTo(r.totals.investmentGain, 6);
  });

  it('attributes gains to the asset that produced them', () => {
    const cal = makeCalendar('2020-01-02', 3);
    const data = buildPrepared(cal, [
      { symbol: 'WIN', prices: [100, 100, 300], weight: 50 },
      { symbol: 'FLAT', prices: [100, 100, 100], weight: 50 },
    ]);
    const r = runEngine({ portfolio: portfolio([['WIN', 50], ['FLAT', 50]]), config: testConfig(), data });
    const win = r.ledgers.find((l) => l.symbol === 'WIN')!;
    const flatL = r.ledgers.find((l) => l.symbol === 'FLAT')!;
    expect(win.profitAndLoss).toBeCloseTo(10_000, 6); // $5,000 → $15,000.
    expect(flatL.profitAndLoss).toBeCloseTo(0, 6);
    expect(win.shareOfGain).toBeCloseTo(1, 6);
  });
});

describe('look-ahead', () => {
  it('is unaffected by data after the decision date', () => {
    // Two runs identical up to day 3, diverging afterwards. Every record up to
    // and including day 3 must match to the last bit.
    const cal = makeCalendar('2020-01-02', 8);
    const shared = [100, 105, 98, 103];
    const a = buildPrepared(cal, [
      { symbol: 'A', prices: [...shared, 110, 120, 130, 140], weight: 60 },
      { symbol: 'B', prices: flat(50, 8), weight: 40 },
    ]);
    const b = buildPrepared(cal, [
      { symbol: 'A', prices: [...shared, 40, 30, 20, 10], weight: 60 },
      { symbol: 'B', prices: flat(50, 8), weight: 40 },
    ]);
    const cfg = testConfig({ rebalance: 'monthly', contributionAmount: 100, contributionFrequency: 'monthly' });
    const ra = runEngine({ portfolio: portfolio([['A', 60], ['B', 40]]), config: cfg, data: a });
    const rb = runEngine({ portfolio: portfolio([['A', 60], ['B', 40]]), config: cfg, data: b });

    for (let i = 0; i <= 3; i++) {
      expect(rb.daily[i].totalValue).toBe(ra.daily[i].totalValue);
      expect(rb.daily[i].positionShares.A).toBe(ra.daily[i].positionShares.A);
      expect(rb.daily[i].cash).toBe(ra.daily[i].cash);
    }
    expect(rb.daily[7].totalValue).not.toBeCloseTo(ra.daily[7].totalValue, 2);
  });

  it('is deterministic across repeated runs', () => {
    const cal = makeCalendar('2020-01-01', 200);
    const spec = [
      { symbol: 'A', prices: ramp(100, 180, 200), weight: 60, dividends: { 30: 1, 120: 1 } },
      { symbol: 'B', prices: ramp(100, 90, 200), weight: 40 },
    ];
    const cfg = testConfig({ rebalance: 'quarterly', contributionAmount: 200, contributionFrequency: 'monthly' });
    const first = runEngine({ portfolio: portfolio([['A', 60], ['B', 40]]), config: cfg, data: buildPrepared(cal, spec) });
    const second = runEngine({ portfolio: portfolio([['A', 60], ['B', 40]]), config: cfg, data: buildPrepared(cal, spec) });
    expect(JSON.stringify(second.daily)).toBe(JSON.stringify(first.daily));
  });
});

describe('regressions', () => {
  it('does not report a value reset when the account simply starts empty', () => {
    // A contribution-only backtest has V0 = 0 by design, not by collapse.
    const cal = makeCalendar('2020-01-01', 300);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 100 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({
        initialInvestment: 0,
        contributionAmount: 500,
        contributionFrequency: 'monthly',
      }),
      data,
    });
    expect(r.warnings.some((w) => w.code === 'value-reset')).toBe(false);
    expect(r.totals.finalValue).toBeGreaterThan(0);
  });

  it('still reports a value reset when a funded account is drained', () => {
    const cal = makeCalendar('2020-01-01', 200);
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, cal.length), weight: 100 },
    ]);
    const r = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({
        initialInvestment: 1_000,
        contributionAmount: 900,
        contributionFrequency: 'monthly',
        contributionIsWithdrawal: true,
      }),
      data,
    });
    expect(r.warnings.some((w) => w.code === 'withdrawal-shortfall')).toBe(true);
  });
});

describe('price-return mode', () => {
  const cal = makeCalendar('2020-01-02', 260);
  const data = () =>
    buildPrepared(cal, [
      // A steady riser paying four quarterly dividends.
      { symbol: 'A', prices: ramp(100, 130, 260), weight: 100, dividends: { 40: 1.5, 100: 1.5, 160: 1.5, 220: 1.5 } },
    ]);

  it('excludes dividends from the result entirely', () => {
    const total = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ dividends: 'reinvest' }),
      data: data(),
    });
    const price = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ dividends: 'ignore' }),
      data: data(),
    });

    // No cash is credited and no shares are bought.
    expect(price.totals.totalDividends).toBe(0);
    expect(price.daily[price.daily.length - 1].cash).toBeCloseTo(0, 6);
    expect(price.daily[price.daily.length - 1].positionShares.A).toBeCloseTo(100, 6);

    // And the result is materially lower than the total return.
    expect(price.totals.finalValue).toBeLessThan(total.totals.finalValue);
  });

  it('measures and reports what it left out rather than hiding it', () => {
    const price = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ dividends: 'ignore' }),
      data: data(),
    });

    // 100 shares x 1.5 x four payments.
    expect(price.totals.dividendsExcluded).toBeCloseTo(600, 6);

    const warning = price.warnings.find((w) => w.code === 'price-return-only');
    expect(warning, 'a price-return run must say so').toBeTruthy();
    expect(warning!.severity).toBe('warning');
    expect(warning!.message).toContain('PRICE returns');
    expect(warning!.message).toContain('600.00');
  });

  it('equals a pure price series, confirming nothing else changed', () => {
    const price = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig({ dividends: 'ignore' }),
      data: data(),
    });
    // 100 shares bought at 100, held to 130 — the dividends are simply absent.
    expect(price.totals.finalValue).toBeCloseTo(13_000, 4);
  });

  it('leaves the default untouched, and reinvestment compounds', () => {
    const defaulted = runEngine({
      portfolio: portfolio([['A', 100]]),
      config: testConfig(),
      data: data(),
    });

    // More than the 600 a static 100 shares would receive: each reinvested
    // dividend buys shares that collect the next one. That compounding is
    // precisely what the price-return mode discards.
    expect(defaulted.totals.totalDividends).toBeGreaterThan(600);
    expect(defaulted.totals.totalDividends).toBeLessThan(650);
    expect(defaulted.totals.dividendsExcluded).toBe(0);
    expect(defaulted.warnings.some((w) => w.code === 'price-return-only')).toBe(false);
  });
});

describe('a holding whose data cannot be loaded', () => {
  /**
   * The bug this covers: asking for A 50% / B 50%, losing B, and receiving a
   * fully-invested 100% position in A — a different portfolio reported as the
   * one requested. The warning existed; the number was still wrong.
   */
  const cal = makeCalendar('2020-01-02', 200);
  const onlyA = () =>
    buildPrepared(cal, [{ symbol: 'A', prices: ramp(100, 200, 200), weight: 50 }]);

  it('leaves the missing weight in cash instead of inflating the survivors', () => {
    const r = runEngine({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: 'a', symbol: 'A', weight: 50 },
          { id: 'b', symbol: 'B', weight: 50 },
        ],
      },
      config: testConfig({ rebalance: 'never' }),
      data: onlyA(),
    });

    const first = r.daily[0];
    // Half invested, half in cash — not 100% A.
    expect(first.positionValues.A).toBeCloseTo(5_000, 4);
    expect(first.cash).toBeCloseTo(5_000, 4);
    expect(first.positionValues.A / first.totalValue).toBeCloseTo(0.5, 6);

    // A doubles, so the honest answer is 15,000, not 20,000.
    expect(r.totals.finalValue).toBeCloseTo(15_000, 4);
  });

  it('is unaffected when every holding loads', () => {
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: ramp(100, 200, 200), weight: 50 },
      { symbol: 'B', prices: flat(100, 200), weight: 50 },
    ]);
    const r = runEngine({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: 'a', symbol: 'A', weight: 50 },
          { id: 'b', symbol: 'B', weight: 50 },
        ],
      },
      config: testConfig({ rebalance: 'never' }),
      data,
    });
    expect(r.daily[0].cash).toBeCloseTo(0, 6);
    expect(r.totals.finalValue).toBeCloseTo(15_000, 4);
  });

  it('still normalises weights that do not sum to 100', () => {
    // 30 and 10 of a declared 40 remain 75/25 of the portfolio.
    const data = buildPrepared(cal, [
      { symbol: 'A', prices: flat(100, 200), weight: 30 },
      { symbol: 'B', prices: flat(100, 200), weight: 10 },
    ]);
    const r = runEngine({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: 'a', symbol: 'A', weight: 30 },
          { id: 'b', symbol: 'B', weight: 10 },
        ],
      },
      config: testConfig(),
      data,
    });
    expect(r.daily[0].positionValues.A).toBeCloseTo(7_500, 4);
    expect(r.daily[0].positionValues.B).toBeCloseTo(2_500, 4);
    expect(r.daily[0].cash).toBeCloseTo(0, 6);
  });
});
