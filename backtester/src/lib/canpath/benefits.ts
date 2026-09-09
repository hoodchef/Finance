import { TAX_CONFIG } from './tax';
import type { BenefitBreakdown, Household, TaxConfig } from './types';

/**
 * Income-tested benefits.
 *
 * These are the reason a posted tax bracket understates what the next dollar
 * costs: each benefit withdraws as income rises, and several withdraw at once.
 * The phase-out *shapes* below are the substance of this module — a benefit
 * modelled with the right maximum but the wrong shape puts the clawback in the
 * wrong income band entirely, which is worse than not modelling it.
 */

function ccbMax(childAges: number[], cfg: TaxConfig): number {
  const c = cfg.benefits.ccb;
  return childAges.reduce(
    (t, age) => t + (age < 6 ? c.max_under_6 : age < 18 ? c.max_6_to_17 : 0),
    0,
  );
}

function rateFor(n: number, table: Record<string, number>): number {
  return table[String(Math.min(Math.max(n, 1), 4))];
}

/**
 * Canada Child Benefit.
 *
 * Two-zone phase-out. Zone 2 carries the ACCUMULATED zone-1 reduction as a
 * fixed amount — the rates do not stack.
 */
export function canadaChildBenefit(
  afni: number,
  childAges: number[],
  cfg: TaxConfig = TAX_CONFIG,
): number {
  const c = cfg.benefits.ccb;
  const n = childAges.filter((a) => a < 18).length;
  if (n === 0) return 0;

  const maximum = ccbMax(childAges, cfg);
  const t1 = c.threshold_1;
  const t2 = c.threshold_2;

  let reduction: number;
  if (afni <= t1) reduction = 0;
  else if (afni <= t2) reduction = rateFor(n, c.phase1_rates) * (afni - t1);
  else {
    reduction =
      rateFor(n, c.phase1_rates) * (t2 - t1) + rateFor(n, c.phase2_rates) * (afni - t2);
  }
  return Math.max(0, maximum - reduction);
}

/**
 * BC Family Benefit.
 *
 * Two 4% clawback bands with a FLAT PLATEAU between them. The benefit reduces
 * at 4% above threshold 1 but never below a per-child floor; the floor holds —
 * costing nothing at the margin — until threshold 2, then reduces at 4% again.
 * Modelling it as one continuous phase-out puts the clawback in the wrong
 * income bands entirely.
 */
export function bcFamilyBenefit(
  afni: number,
  childAges: number[],
  cfg: TaxConfig = TAX_CONFIG,
  singleParent = false,
): number {
  const b = cfg.benefits.bc_family_benefit;
  if (!b) return 0;
  const n = childAges.filter((a) => a < 18).length;
  if (!n) return 0;

  let max = b.max_first_child;
  let floor = b.floor_first_child;
  if (n >= 2) {
    max += b.max_second_child;
    floor += b.floor_second_child;
  }
  if (n > 2) {
    max += b.max_additional_child * (n - 2);
    floor += b.floor_additional_child * (n - 2);
  }
  if (singleParent) max += b.single_parent_supplement;

  const r = b.phaseout_rate;
  let v = Math.max(floor, max - r * Math.max(0, Math.min(afni, b.threshold_2) - b.threshold_1));
  if (afni > b.threshold_2) v -= r * (afni - b.threshold_2);
  return Math.max(0, v);
}

/**
 * Canada Groceries and Essentials Benefit — the renamed GST/HST credit.
 *
 * Its child age limit is under 19, NOT the CCB's 18.
 */
export function cgeb(
  afni: number,
  household: Household,
  cfg: TaxConfig = TAX_CONFIG,
): number {
  const c = cfg.benefits.cgeb;
  if (!c) return 0;
  const kids = (household.child_ages || []).filter((a) => a < c.child_age_limit).length;
  const partnered =
    household.partnered != null ? household.partnered : (household.partner_income || 0) > 0;
  const max = (partnered ? c.max_couple : c.max_single) + c.max_per_child * kids;
  return Math.max(0, max - c.phaseout_rate * Math.max(0, afni - c.threshold));
}

/** Sums a per-child amount table, repeating the last entry beyond its length. */
const stackedMax = (amounts: number[], n: number): number => {
  let t = 0;
  for (let i = 0; i < n; i++) t += amounts[Math.min(i, amounts.length - 1)];
  return t;
};

/**
 * Provincial child benefits other than BC's.
 *
 * `linear` is one phase-out rate; `tiered` is a literal STEP — a real cliff,
 * not a phase-out, where one dollar of income can cost hundreds of dollars of
 * benefit; `ab` is Alberta's two independent components. A province mapped to
 * null has no child benefit at all.
 */
export function provincialChildBenefit(
  afni: number,
  childAges: number[],
  province: string,
  cfg: TaxConfig = TAX_CONFIG,
  employmentIncome?: number | null,
): number {
  const table = cfg.benefits.provincial_child_benefits || {};
  const b = table[province];
  if (!b) return 0;

  const n = childAges.filter((a) => a < 18).length;
  if (!n) return 0;

  if (b.type === 'linear') {
    return Math.max(0, stackedMax(b.amounts, n) - b.rate * Math.max(0, afni - b.threshold));
  }

  if (b.type === 'tiered') {
    for (const t of b.tiers) if (afni <= t.upto) return t.per_child * n;
    return 0;
  }

  if (b.type === 'ab') {
    const base = Math.max(
      0,
      stackedMax(b.base_amounts, n) - b.base_rate * Math.max(0, afni - b.base_threshold),
    );
    const earned = employmentIncome == null ? afni : employmentIncome;
    let work = 0;
    if (earned > b.working_min_employment) {
      work = Math.max(
        0,
        stackedMax(b.working_amounts, n) -
          b.working_rate * Math.max(0, afni - b.working_threshold),
      );
    }
    return base + work;
  }

  return 0;
}

/** Every income-tested benefit this engine models, at one income. */
export function totalBenefits(
  afni: number,
  household: Household,
  cfg: TaxConfig = TAX_CONFIG,
): BenefitBreakdown {
  const partnered =
    household.partnered != null ? household.partnered : (household.partner_income || 0) > 0;
  const ccb = canadaChildBenefit(afni, household.child_ages, cfg);
  const bcfb =
    household.province === 'BC'
      ? bcFamilyBenefit(afni, household.child_ages, cfg, !partnered)
      : 0;
  const pcb = provincialChildBenefit(afni, household.child_ages, household.province, cfg);
  const g = cgeb(afni, household, cfg);
  return { ccb, bcfb, pcb, cgeb: g, total: ccb + bcfb + pcb + g };
}
