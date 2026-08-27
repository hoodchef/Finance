import { describe, expect, it } from 'vitest';
import {
  CPP_2026,
  OAS_2026,
  cppBreakevenAge,
  cppEstimate,
  costOfWaiting,
  oasEstimate,
  oasFullRecoveryIncome,
  oasRecoveryTax,
  retirementReadiness,
  type RetirementProfile,
} from '../src/lib/canpath/projection';

/**
 * CPP and OAS, against the published rules rather than against the module's
 * own output.
 *
 * These were ported with the rest of CanPath and covered by its parity
 * fixtures, then surfaced with no independent check of the two decisions that
 * actually matter: when to take CPP, and where the OAS recovery tax bites.
 */

const profile: RetirementProfile = {
  current_age: 40,
  retirement_age: 65,
  current_savings: 150_000,
  monthly_contribution: 1_500,
  target_annual_income: 70_000,
  annual_rate: 0.06,
  inflation: 0.02,
  cpp_start_age: 65,
  years_in_canada: 40,
};

describe('CPP timing', () => {
  it('reduces by exactly the published rate when taken early', () => {
    // 0.6% per month for 60 months is a 36% reduction. Not "about a third".
    const at65 = cppEstimate(65);
    const at60 = cppEstimate(60);
    // Months are negative for an early start, which is how the reduction is
    // applied: 1 + (-60 x 0.006).
    expect(at60 / at65).toBeCloseTo(1 - 60 * CPP_2026.early_reduction_per_month, 10);
    expect(at60 / at65).toBeCloseTo(0.64, 6);
  });

  it('increases by exactly the published rate when deferred', () => {
    // 0.7% per month for 60 months is a 42% increase.
    expect(cppEstimate(70) / cppEstimate(65)).toBeCloseTo(1.42, 6);
  });

  it('puts the 60-versus-65 breakeven where the published one is', () => {
    // Widely quoted as roughly 74. A breakeven that drifted would send people
    // to the wrong decision about an irreversible choice.
    const age = cppBreakevenAge(60, 65);
    expect(age).toBeGreaterThan(73);
    expect(age).toBeLessThan(75);
  });

  it('puts the 65-versus-70 breakeven near 82', () => {
    const age = cppBreakevenAge(65, 70);
    expect(age).toBeGreaterThan(81);
    expect(age).toBeLessThan(83);
  });

  it('scales with a partial contribution history', () => {
    expect(cppEstimate(65, 0.5)).toBeCloseTo(cppEstimate(65, 1) / 2, 6);
  });
});

describe('OAS and its recovery tax', () => {
  it('prorates by years in Canada, capped at forty', () => {
    expect(oasEstimate(65, 20)).toBeCloseTo(oasEstimate(65, 40) / 2, 6);
    // More than forty years earns no more than forty.
    expect(oasEstimate(65, 60)).toBeCloseTo(oasEstimate(65, 40), 6);
  });

  it('takes nothing below the threshold', () => {
    const gross = oasEstimate(65, 40);
    expect(oasRecoveryTax(gross, OAS_2026.clawback_threshold - 1)).toBe(0);
    expect(oasRecoveryTax(gross, 50_000)).toBe(0);
  });

  it('takes fifteen cents of every dollar above it', () => {
    const gross = oasEstimate(65, 40);
    const over = 10_000;
    expect(oasRecoveryTax(gross, OAS_2026.clawback_threshold + over)).toBeCloseTo(
      OAS_2026.clawback_rate * over,
      6,
    );
  });

  it('never takes back more than was paid', () => {
    const gross = oasEstimate(65, 40);
    expect(oasRecoveryTax(gross, 10_000_000)).toBeCloseTo(gross, 6);
  });

  it('puts full recovery exactly where the arithmetic says', () => {
    const gross = oasEstimate(65, 40);
    const full = oasFullRecoveryIncome(gross);
    expect(full).toBeCloseTo(
      OAS_2026.clawback_threshold + gross / OAS_2026.clawback_rate,
      4,
    );
    // And at that income, the whole benefit is gone.
    expect(oasRecoveryTax(gross, full)).toBeCloseTo(gross, 4);
  });
});

describe('readiness', () => {
  it('counts government benefits against the target before sizing the portfolio', () => {
    const r = retirementReadiness(profile);
    // The gap is what the portfolio has to cover, not the whole target — a
    // projection that ignored CPP and OAS would overstate what is needed by
    // twenty thousand a year.
    expect(r.government_annual).toBeCloseTo(r.cpp_annual + r.oas_annual, 6);
    expect(r.income_gap).toBeCloseTo(profile.target_annual_income - r.government_annual, 6);
    expect(r.income_gap).toBeLessThan(profile.target_annual_income);
  });

  it('sizes the nest egg from the withdrawal rate', () => {
    const r = retirementReadiness({ ...profile, withdrawal_rate: 0.04 });
    expect(r.nest_egg_needed).toBeCloseTo(r.income_gap / 0.04, 4);
  });

  it('says on track only when the projection covers the need', () => {
    const short = retirementReadiness({ ...profile, monthly_contribution: 100 });
    const ample = retirementReadiness({ ...profile, monthly_contribution: 6_000 });
    expect(short.on_track).toBe(false);
    expect(ample.on_track).toBe(true);
    expect(ample.coverage).toBeGreaterThan(short.coverage);
  });
});

describe('the cost of waiting', () => {
  it('costs more than the contributions skipped', () => {
    // The whole argument: the loss is compounding, not the deposits.
    for (const years of [1, 3, 5, 10]) {
      const w = costOfWaiting(profile, years);
      expect(w.cost).toBeGreaterThan(w.contributions_skipped);
      expect(w.lost_per_dollar_skipped).toBeGreaterThan(1);
    }
  });

  it('costs more in total but less per dollar the longer you wait', () => {
    const one = costOfWaiting(profile, 1);
    const ten = costOfWaiting(profile, 10);
    expect(ten.cost).toBeGreaterThan(one.cost);
    // Later dollars have less time to compound, so each one skipped costs less
    // — which is an argument for starting now, not for having started.
    expect(ten.lost_per_dollar_skipped).toBeLessThan(one.lost_per_dollar_skipped);
  });
});
