import { describe, expect, it } from 'vitest';
import {
  bcFamilyBenefit,
  canadaChildBenefit,
  cgeb,
  provincialChildBenefit,
} from '../src/lib/canpath/benefits';
import { TAX_CONFIG } from '../src/lib/canpath/tax';
import { effectiveMarginalRate } from '../src/lib/canpath/position';

/**
 * Benefit SHAPE tests.
 * =============================================================================
 * The parity suite proves the port agrees with the Python reference on 230
 * recorded cases. Mutation-testing it (CanPath's CONTINUE.md §4) found two
 * plausible bugs those cases do not catch, so these tests cover the shape of
 * each phase-out directly rather than at sampled points.
 *
 * Getting a benefit's maximum right but its shape wrong puts the clawback in
 * the wrong income band entirely — which is worse than not modelling it, because
 * the number still looks reasonable.
 */

describe('Alberta child benefit: the working-component gate', () => {
  // Found by mutation testing: replacing the employment-income gate with
  // `true` passed all 230 fixture cases, because the lowest Alberta fixture
  // sits at $15,000 and the gate is at $2,760. The gate is reachable in real
  // life and was completely untested.
  const ab = TAX_CONFIG.benefits.provincial_child_benefits?.AB;
  const gate = ab && ab.type === 'ab' ? ab.working_min_employment : 0;

  it('has a gate the fixtures never reach', () => {
    expect(ab?.type).toBe('ab');
    expect(gate).toBeGreaterThan(0);
  });

  it('pays the base component but no working component below the gate', () => {
    const below = provincialChildBenefit(gate - 1, [4, 8], 'AB', TAX_CONFIG, gate - 1);
    const above = provincialChildBenefit(gate + 1, [4, 8], 'AB', TAX_CONFIG, gate + 1);
    expect(below).toBeGreaterThan(0); // Base is not conditional on working.
    expect(above).toBeGreaterThan(below);
  });

  it('steps exactly at the gate, not gradually', () => {
    const justUnder = provincialChildBenefit(2_000, [4, 8], 'AB', TAX_CONFIG, gate - 0.01);
    const justOver = provincialChildBenefit(2_000, [4, 8], 'AB', TAX_CONFIG, gate + 0.01);
    // Same AFNI, different employment income: the difference is the whole
    // working component appearing at once.
    expect(justOver - justUnder).toBeGreaterThan(100);
  });

  it('gates on employment income, not on family net income', () => {
    // A household with high AFNI but employment income below the gate — an
    // investment-income household — gets no working component.
    const withWork = provincialChildBenefit(20_000, [4, 8], 'AB', TAX_CONFIG, 50_000);
    const withoutWork = provincialChildBenefit(20_000, [4, 8], 'AB', TAX_CONFIG, 0);
    expect(withWork).toBeGreaterThan(withoutWork);
  });

  it('falls back to family net income when employment income is not supplied', () => {
    const implied = provincialChildBenefit(20_000, [4, 8], 'AB');
    const explicit = provincialChildBenefit(20_000, [4, 8], 'AB', TAX_CONFIG, 20_000);
    expect(implied).toBeCloseTo(explicit, 10);
  });
});

describe('BC Family Benefit: the flat plateau', () => {
  const bc = TAX_CONFIG.benefits.bc_family_benefit!;

  /**
   * The plateau exists because the benefit tapers at 4% to a per-child floor,
   * holds at that floor, then tapers again above threshold 2.
   *
   * At 2026 parameters the floor is always reached BEFORE threshold 2, which
   * makes the two-band and single-band formulas numerically identical — that
   * is why mutation testing could not distinguish them. This test pins the
   * assumption rather than the arithmetic: if a future year's figures ever
   * push the taper past threshold 2, the plateau logic starts to matter and
   * this fails, pointing at the code that then needs re-checking.
   */
  it('reaches the per-child floor before the second threshold, at every child count', () => {
    for (let n = 1; n <= 4; n++) {
      let max = bc.max_first_child;
      let floor = bc.floor_first_child;
      if (n >= 2) {
        max += bc.max_second_child;
        floor += bc.floor_second_child;
      }
      if (n > 2) {
        max += bc.max_additional_child * (n - 2);
        floor += bc.floor_additional_child * (n - 2);
      }
      const incomeWhereFloorBinds = bc.threshold_1 + (max - floor) / bc.phaseout_rate;
      expect(incomeWhereFloorBinds).toBeLessThan(bc.threshold_2);
    }
  });

  it('holds flat across the plateau, so the margin costs nothing there', () => {
    const ages = [4, 8];
    const justBelowT2 = bcFamilyBenefit(bc.threshold_2 - 1_000, ages);
    const atT2 = bcFamilyBenefit(bc.threshold_2, ages);
    expect(justBelowT2).toBeCloseTo(atT2, 6);
  });

  it('tapers again above the second threshold', () => {
    const ages = [4, 8];
    const atT2 = bcFamilyBenefit(bc.threshold_2, ages);
    const above = bcFamilyBenefit(bc.threshold_2 + 5_000, ages);
    expect(above).toBeLessThan(atT2);
    expect(atT2 - above).toBeCloseTo(bc.phaseout_rate * 5_000, 6);
  });

  it('adds the single-parent supplement only for a single parent', () => {
    const single = bcFamilyBenefit(20_000, [4], TAX_CONFIG, true);
    const partnered = bcFamilyBenefit(20_000, [4], TAX_CONFIG, false);
    expect(single - partnered).toBeCloseTo(bc.single_parent_supplement, 6);
  });
});

describe('Canada Child Benefit: two zones that do not stack', () => {
  const c = TAX_CONFIG.benefits.ccb;

  it('withdraws nothing below the first threshold', () => {
    expect(canadaChildBenefit(c.threshold_1, [3])).toBeCloseTo(c.max_under_6, 6);
    expect(canadaChildBenefit(0, [3])).toBeCloseTo(c.max_under_6, 6);
  });

  it('carries the accumulated zone-1 reduction as a fixed amount into zone 2', () => {
    // The zone-2 rate must apply only to income above threshold 2; if the
    // zones stacked, the benefit at threshold 2 + $1 would fall off a cliff.
    const atT2 = canadaChildBenefit(c.threshold_2, [3]);
    const justAbove = canadaChildBenefit(c.threshold_2 + 1, [3]);
    expect(atT2 - justAbove).toBeLessThan(1);
  });

  it('tapers at each zone\'s own rate, gently above the second threshold', () => {
    // Zone 2 is GENTLER than zone 1, not steeper: 7% then 3.2% for one child.
    // The steep withdrawal happens first, which is why the effective marginal
    // rate spike sits in the lower income band rather than the higher one.
    for (const n of [1, 2, 3, 4]) {
      const ages = new Array(n).fill(3);
      const observed1 =
        (canadaChildBenefit(c.threshold_1, ages) -
          canadaChildBenefit(c.threshold_1 + 1_000, ages)) /
        1_000;
      const observed2 =
        (canadaChildBenefit(c.threshold_2, ages) -
          canadaChildBenefit(c.threshold_2 + 1_000, ages)) /
        1_000;

      expect(observed1).toBeCloseTo(c.phase1_rates[String(n)], 10);
      expect(observed2).toBeCloseTo(c.phase2_rates[String(n)], 10);
      expect(observed2).toBeLessThan(observed1);
    }
  });

  it('caps the rate table at four children', () => {
    // Five children draw the same rate as four; the table stops there.
    const four = new Array(4).fill(3);
    const five = new Array(5).fill(3);
    const rateFour =
      (canadaChildBenefit(c.threshold_1, four) -
        canadaChildBenefit(c.threshold_1 + 1_000, four)) / 1_000;
    const rateFive =
      (canadaChildBenefit(c.threshold_1, five) -
        canadaChildBenefit(c.threshold_1 + 1_000, five)) / 1_000;
    expect(rateFive).toBeCloseTo(rateFour, 10);
    // The maximum still rises with the fifth child even though the rate does not.
    expect(canadaChildBenefit(0, five)).toBeGreaterThan(canadaChildBenefit(0, four));
  });

  it('counts a child as under 6 or 6-to-17 and drops them at 18', () => {
    expect(canadaChildBenefit(0, [5])).toBeCloseTo(c.max_under_6, 6);
    expect(canadaChildBenefit(0, [6])).toBeCloseTo(c.max_6_to_17, 6);
    expect(canadaChildBenefit(0, [17])).toBeCloseTo(c.max_6_to_17, 6);
    expect(canadaChildBenefit(0, [18])).toBe(0);
  });

  it('never goes negative at high income', () => {
    expect(canadaChildBenefit(500_000, [3, 5, 7])).toBe(0);
  });
});

describe('CGEB: its own age limit', () => {
  const c = TAX_CONFIG.benefits.cgeb!;

  it('counts children under 19, not the CCB\'s 18', () => {
    expect(c.child_age_limit).toBe(19);
    const household = { province: 'BC', child_ages: [18], partnered: false };
    // An 18-year-old still counts for CGEB while contributing nothing to CCB.
    expect(cgeb(0, household)).toBeCloseTo(c.max_single + c.max_per_child, 6);
    expect(canadaChildBenefit(0, [18])).toBe(0);
  });

  it('pays the couple maximum when partnered, even with no partner income', () => {
    const single = cgeb(0, { province: 'BC', child_ages: [], partnered: false });
    const couple = cgeb(0, { province: 'BC', child_ages: [], partnered: true });
    expect(couple - single).toBeCloseTo(c.max_couple - c.max_single, 6);
  });
});

describe('the effective marginal rate this tool exists to surface', () => {
  it('exceeds the posted bracket for a family in a clawback band', () => {
    // The README's headline case: a BC couple with three children between
    // roughly $58,600 and $67,500 of income.
    const household = {
      province: 'BC',
      child_ages: [3, 6, 9],
      partner_income: 0,
      partnered: true,
    };
    const emr = effectiveMarginalRate(62_000, household);

    expect(emr.clawback_rate).toBeGreaterThan(0.2);
    expect(emr.effective_rate).toBeGreaterThan(emr.statutory_rate + 0.2);
    // Well above the top posted federal-plus-BC bracket at that income.
    expect(emr.effective_rate).toBeGreaterThan(0.45);
  });

  it('collapses to the statutory rate for a household with no benefits', () => {
    const emr = effectiveMarginalRate(200_000, {
      province: 'BC',
      child_ages: [],
      partner_income: 0,
    });
    expect(emr.clawback_rate).toBeCloseTo(0, 6);
    expect(emr.effective_rate).toBeCloseTo(emr.statutory_rate, 6);
  });
});
