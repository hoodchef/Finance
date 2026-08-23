import { describe, expect, it } from 'vitest';
import type { CashflowLeg } from '../src/lib/types';
import { describeLeg, legAmount, resolveLeg } from '../src/lib/engine/cashflows';
import { runEngine } from '../src/lib/engine/engine';
import { buildPrepared, flat, makeCalendar, testConfig } from './helpers';

const leg = (over: Partial<CashflowLeg> = {}): CashflowLeg => ({
  id: 'l1',
  amount: 1_000,
  kind: 'fixed',
  frequency: 'monthly',
  offsetMonths: 0,
  durationMonths: null,
  annualGrowthPct: 0,
  adjustForInflation: false,
  ...over,
});

const portfolio = { id: 'p', name: 'P', positions: [{ id: 'A', symbol: 'A', weight: 100 }] };

describe('leg scheduling', () => {
  const cal = makeCalendar('2020-01-01', 800); // ~3 years of weekdays.

  it('fires a one-off exactly once, at the offset', () => {
    const occurrences = resolveLeg(cal, leg({ frequency: 'once', offsetMonths: 6 }));
    expect(occurrences).toHaveLength(1);
    // 2020-07-01 was a Wednesday, so no rolling is needed.
    expect(cal[occurrences[0].index]).toBe('2020-07-01');
  });

  it('rolls an offset landing on a weekend to the next trading day', () => {
    // Start + 2 months is 2020-03-01, a Sunday.
    const occurrences = resolveLeg(cal, leg({ frequency: 'once', offsetMonths: 2 }));
    expect(cal[occurrences[0].index]).toBe('2020-03-02');
  });

  it('honours the offset and then keeps its own cadence', () => {
    const occurrences = resolveLeg(cal, leg({ frequency: 'quarterly', offsetMonths: 7 }));
    const dates = occurrences.map((o) => cal[o.index]);
    expect(dates[0]).toBe('2020-08-03'); // 1 Aug 2020 was a Saturday.
    expect(dates[1]).toBe('2020-11-02');
    expect(dates[2]).toBe('2021-02-01');
  });

  it('stops after the stated duration', () => {
    const occurrences = resolveLeg(cal, leg({ frequency: 'monthly', durationMonths: 12 }));
    const dates = occurrences.map((o) => cal[o.index]);
    expect(dates).toHaveLength(12);
    expect(dates[0].startsWith('2020-01')).toBe(true);
    expect(dates[dates.length - 1].startsWith('2020-12')).toBe(true);
  });

  it('runs to the end of the window when no duration is set', () => {
    const occurrences = resolveLeg(cal, leg({ frequency: 'annual' }));
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('emits nothing for a zero amount or an offset past the window', () => {
    expect(resolveLeg(cal, leg({ amount: 0 }))).toHaveLength(0);
    expect(resolveLeg(cal, leg({ offsetMonths: 600 }))).toHaveLength(0);
  });
});

describe('leg amounts', () => {
  it('compounds annual growth from the leg start', () => {
    const l = leg({ annualGrowthPct: 10 });
    expect(legAmount(l, 1, 1, 0)).toBeCloseTo(1_000, 8);
    expect(legAmount(l, Math.pow(1.1, 2), 1, 0)).toBeCloseTo(1_210, 8);
  });

  it('applies inflation only when the leg asks for it', () => {
    expect(legAmount(leg({ adjustForInflation: false }), 1, 1.5, 0)).toBeCloseTo(1_000, 8);
    expect(legAmount(leg({ adjustForInflation: true }), 1, 1.5, 0)).toBeCloseTo(1_500, 8);
  });

  it('takes a percentage from the balance on the day, ignoring growth', () => {
    const l = leg({ kind: 'percentOfPortfolio', amount: -4, annualGrowthPct: 10, adjustForInflation: true });
    // Both adjustments are already inside the balance; applying them again
    // would compound the same effect twice.
    expect(legAmount(l, 3, 2, 250_000)).toBeCloseTo(-10_000, 8);
  });

  it('describes itself in words', () => {
    expect(describeLeg(leg({ amount: -500, frequency: 'annual', offsetMonths: 12 }))).toBe(
      'Withdraw $500 annual starting after 12 months',
    );
  });
});

describe('engine integration', () => {
  const cal = makeCalendar('2020-01-01', 800);
  const data = () => buildPrepared(cal, [{ symbol: 'A', prices: flat(100, cal.length), weight: 100 }]);

  it('adds a one-off contribution to the balance', () => {
    const r = runEngine({
      portfolio,
      config: testConfig({
        initialInvestment: 10_000,
        cashflows: [leg({ amount: 5_000, frequency: 'once', offsetMonths: 6 })],
      }),
      data: data(),
    });
    // A flat market means the balance is exactly what was paid in.
    expect(r.totals.finalValue).toBeCloseTo(15_000, 4);
    expect(r.totals.totalContributions).toBeCloseTo(5_000, 4);
  });

  it('runs a contribution leg and a later withdrawal leg together', () => {
    const r = runEngine({
      portfolio,
      config: testConfig({
        initialInvestment: 10_000,
        cashflows: [
          leg({ id: 'save', amount: 1_000, frequency: 'monthly', durationMonths: 12 }),
          leg({ id: 'draw', amount: -500, frequency: 'monthly', offsetMonths: 12 }),
        ],
      }),
      data: data(),
    });

    expect(r.totals.totalContributions).toBeCloseTo(12_000, 4);
    expect(r.totals.totalWithdrawals).toBeGreaterThan(9_000);
    expect(r.totals.finalValue).toBeCloseTo(
      10_000 + r.totals.totalContributions - r.totals.totalWithdrawals,
      4,
    );
  });

  it('nets two legs firing on the same day into one flow', () => {
    const r = runEngine({
      portfolio,
      config: testConfig({
        initialInvestment: 10_000,
        cashflows: [
          leg({ id: 'in', amount: 1_000, frequency: 'monthly' }),
          leg({ id: 'out', amount: -400, frequency: 'monthly' }),
        ],
      }),
      data: data(),
    });
    // Net +600 a month: recorded as a contribution, with no offsetting
    // withdrawal and no wasted round trip through the market.
    expect(r.totals.totalWithdrawals).toBe(0);
    expect(r.totals.finalValue).toBeCloseTo(10_000 + r.totals.totalContributions, 4);
  });

  it('scales a percentage withdrawal with the balance', () => {
    const rising = makeCalendar('2020-01-01', 800);
    const r = runEngine({
      portfolio,
      config: testConfig({
        initialInvestment: 100_000,
        cashflows: [leg({ amount: -10, kind: 'percentOfPortfolio', frequency: 'annual' })],
      }),
      data: buildPrepared(rising, [
        { symbol: 'A', prices: flat(100, rising.length), weight: 100 },
      ]),
    });

    const withdrawals = r.transactions.filter((t) => t.type === 'withdrawal');
    expect(withdrawals.length).toBeGreaterThanOrEqual(3);
    // Each 10% is smaller than the last because the balance keeps shrinking.
    const amounts = withdrawals.map((t) => Math.abs(t.amount));
    expect(amounts[0]).toBeCloseTo(10_000, 2);
    expect(amounts[1]).toBeLessThan(amounts[0]);
    expect(amounts[1]).toBeCloseTo(9_000, 2);
  });

  it('grows a leg with inflation when asked', () => {
    const deflator = cal.map((_, i) => Math.pow(1.1, i / 261));
    const run = (adjust: boolean) =>
      runEngine({
        portfolio,
        config: testConfig({
          initialInvestment: 0,
          cashflows: [leg({ amount: 1_000, frequency: 'monthly', adjustForInflation: adjust })],
          inflation: { mode: 'constant', constantPct: 10, adjustContributions: false },
        }),
        data: buildPrepared(cal, [{ symbol: 'A', prices: flat(100, cal.length), weight: 100 }], 0, deflator),
      });

    expect(run(true).totals.totalContributions).toBeGreaterThan(
      run(false).totals.totalContributions,
    );
  });

  it('leaves a config with no legs exactly as it was', () => {
    const withNone = runEngine({ portfolio, config: testConfig({ initialInvestment: 10_000 }), data: data() });
    const withEmpty = runEngine({
      portfolio,
      config: testConfig({ initialInvestment: 10_000, cashflows: [] }),
      data: data(),
    });
    expect(withEmpty.totals.finalValue).toBe(withNone.totals.finalValue);
  });
});
