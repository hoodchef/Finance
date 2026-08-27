import { describe, expect, it } from 'vitest';
import { compareAccounts } from '../src/lib/canpath/accounts-growth';

/**
 * The RRSP-versus-TFSA question has a closed form, and it is the reason this
 * module is short: for the same out-of-pocket cost,
 *
 *     RRSP / TFSA = (1 - rateLater) / (1 - rateNow)
 *
 * The growth rate cancels. These tests assert that identity holds, because a
 * tool that made the answer appear to depend on the backtest would be telling
 * people something false about their own decision.
 */

const base = { contribution: 10_000, growthFactor: 2.5, rateNow: 0.40, rateLater: 0.25 };

describe('the wrappers behave as the tax rules say', () => {
  it('leaves a TFSA entirely untaxed', () => {
    const { outcomes } = compareAccounts(base);
    const tfsa = outcomes.find((o) => o.account === 'TFSA')!;
    expect(tfsa.contributed).toBe(10_000);
    expect(tfsa.taxOnWithdrawal).toBe(0);
    expect(tfsa.netValue).toBeCloseTo(25_000, 6);
  });

  it('lets an RRSP hold the grossed-up contribution', () => {
    // $10,000 out of pocket at a 40% rate buys a $16,667 contribution, because
    // the deduction refunds the difference.
    const rrsp = compareAccounts(base).outcomes.find((o) => o.account === 'RRSP')!;
    expect(rrsp.contributed).toBeCloseTo(10_000 / 0.6, 6);
    expect(rrsp.grossValue).toBeCloseTo((10_000 / 0.6) * 2.5, 6);
    expect(rrsp.netValue).toBeCloseTo((10_000 / 0.6) * 2.5 * 0.75, 6);
  });

  it('makes the FHSA strictly best: deductible in, tax-free out', () => {
    const { outcomes } = compareAccounts(base);
    const fhsa = outcomes.find((o) => o.account === 'FHSA')!;
    const rrsp = outcomes.find((o) => o.account === 'RRSP')!;
    const tfsa = outcomes.find((o) => o.account === 'TFSA')!;
    expect(fhsa.netValue).toBeGreaterThan(rrsp.netValue);
    expect(fhsa.netValue).toBeGreaterThan(tfsa.netValue);
  });
});

describe('the closed form', () => {
  it.each([
    [0.40, 0.25],
    [0.30, 0.30],
    [0.20, 0.45],
    [0.53, 0.15],
  ])('RRSP/TFSA equals (1-later)/(1-now) at %s and %s', (rateNow, rateLater) => {
    const out = compareAccounts({ ...base, rateNow, rateLater });
    expect(out.rrspAdvantage).toBeCloseTo((1 - rateLater) / (1 - rateNow), 10);
  });

  it('does not depend on what the portfolio did', () => {
    // The single most important property. A backtest cannot change which
    // wrapper wins, and a tool implying otherwise is selling something.
    const slow = compareAccounts({ ...base, growthFactor: 1.05 });
    const fast = compareAccounts({ ...base, growthFactor: 40 });
    expect(slow.rrspAdvantage).toBeCloseTo(fast.rrspAdvantage, 12);
  });

  it('ties exactly when the rate never changes', () => {
    const out = compareAccounts({ ...base, rateNow: 0.35, rateLater: 0.35 });
    expect(out.effectivelyEqual).toBe(true);
    const [tfsa, rrsp] = out.outcomes;
    expect(rrsp.netValue).toBeCloseTo(tfsa.netValue, 6);
  });

  it('favours the RRSP only when the later rate is lower', () => {
    expect(compareAccounts({ ...base, rateNow: 0.45, rateLater: 0.20 }).rrspAdvantage).toBeGreaterThan(1);
    expect(compareAccounts({ ...base, rateNow: 0.20, rateLater: 0.45 }).rrspAdvantage).toBeLessThan(1);
  });
});

describe('what it refuses to model', () => {
  it('says a taxable account is absent, and why', () => {
    // Absence has to be stated. A missing account reads as an oversight;
    // a stated one reads as the boundary of the data.
    const note = compareAccounts(base).taxableAccountBlocked;
    expect(note).toMatch(/capital-gains inclusion/i);
    expect(note).toMatch(/dividend gross-up/i);
    expect(note).toMatch(/not in the tax data file|none are in the tax data file/i);
  });

  it('rejects a rate that is not a rate', () => {
    expect(() => compareAccounts({ ...base, rateNow: 1.4 })).toThrow(/between 0 and 1/);
    expect(() => compareAccounts({ ...base, rateLater: -0.1 })).toThrow(/between 0 and 1/);
    expect(() => compareAccounts({ ...base, contribution: -5 })).toThrow(/non-negative/);
  });
});
