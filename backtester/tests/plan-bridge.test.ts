import { describe, expect, it } from 'vitest';
import { planToBacktestConfig } from '../src/lib/plan-bridge';

/**
 * The bridge turns a one-year plan into a multi-decade projection, which is a
 * substantial extrapolation. These tests are mostly about the assumptions
 * travelling with it rather than the arithmetic, which is trivial.
 */

describe('plan to backtest', () => {
  const base = { savingsCapacity: 20_000, firstYearBoost: 9_110, includeBoost: false };

  it('carries the savings capacity as an annual contribution', () => {
    const { config } = planToBacktestConfig(base);
    expect(config.contributionAmount).toBe(20_000);
    expect(config.contributionFrequency).toBe('annual');
    expect(config.contributionIsWithdrawal).toBe(false);
  });

  it('adds the government boost only when asked', () => {
    expect(planToBacktestConfig(base).config.contributionAmount).toBe(20_000);
    expect(
      planToBacktestConfig({ ...base, includeBoost: true }).config.contributionAmount,
    ).toBe(29_110);
  });

  it('always states that one year is being repeated', () => {
    const { assumptions } = planToBacktestConfig(base);
    expect(assumptions.join(' ')).toMatch(/one year|stay where they are/i);
  });

  it('says what was left out when the boost is excluded', () => {
    // Silence here would understate the plan without explaining why.
    const { assumptions } = planToBacktestConfig(base);
    expect(assumptions.join(' ')).toMatch(/Excludes/i);
    expect(assumptions.join(' ')).toContain('9,110');
  });

  it('flags the reinvestment premise when the boost is included', () => {
    const { assumptions } = planToBacktestConfig({ ...base, includeBoost: true });
    expect(assumptions.join(' ')).toMatch(/reinvested rather than spent/i);
    // And that a refund does not arrive in the year that earned it.
    expect(assumptions.join(' ')).toMatch(/following spring/i);
  });

  it('never claims account-level tax treatment it does not model', () => {
    const { assumptions } = planToBacktestConfig(base);
    expect(assumptions.join(' ')).toMatch(/tax treatment is not modelled/i);
  });

  it('ignores a negative boost rather than subtracting it', () => {
    const { config } = planToBacktestConfig({
      savingsCapacity: 10_000,
      firstYearBoost: -500,
      includeBoost: true,
    });
    expect(config.contributionAmount).toBe(10_000);
  });
});
