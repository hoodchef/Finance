import { totalBenefits } from './benefits';
import { combinedTax, TAX_CONFIG } from './tax';
import type {
  ContributionValue,
  Household,
  MarginalRate,
  NetPosition,
  TaxConfig,
} from './types';

/**
 * Where a household actually stands: tax paid, benefits received, and what the
 * next dollar is worth once both move together.
 */

/**
 * Tax and benefits at one income.
 *
 * `afni` is adjusted family net income and counts BOTH partners — benefits are
 * tested on the household, not the individual, which is why a raise for one
 * partner can claw back a benefit computed on the other.
 */
export function netPosition(
  income: number,
  household: Household,
  cfg: TaxConfig = TAX_CONFIG,
  deduction = 0,
): NetPosition {
  const taxable = Math.max(0, income - deduction);
  const partner = Math.max(0, household.partner_income || 0);
  const afni = taxable + partner;
  const tax = combinedTax(taxable, household.province, cfg);
  const partnerTax = partner ? combinedTax(partner, household.province, cfg) : 0;
  const benefits = totalBenefits(afni, household, cfg).total;

  return {
    gross_income: income,
    partner_income: partner,
    deduction,
    taxable_income: taxable,
    afni,
    tax,
    partner_tax: partnerTax,
    household_tax: tax + partnerTax,
    benefits,
    net_cash: income + partner - deduction - tax - partnerTax + benefits,
  };
}

/**
 * The effective marginal rate: income tax on the next dollar PLUS benefits
 * withdrawn on it.
 *
 * This is the number the whole tool exists to surface. A posted bracket of
 * 28.2% can sit under an effective rate above 56% once several benefits phase
 * out across the same income band, and that gap appears nowhere on a tax
 * return.
 *
 * Measured over a finite `delta` rather than analytically, because several
 * benefits have kinks and at least one has a literal cliff — a derivative
 * would be undefined exactly where the answer matters most.
 */
export function effectiveMarginalRate(
  income: number,
  household: Household,
  cfg: TaxConfig = TAX_CONFIG,
  delta = 100,
): MarginalRate {
  const lo = netPosition(income, household, cfg);
  const hi = netPosition(income + delta, household, cfg);
  const statutory = (hi.tax - lo.tax) / delta;
  const clawback = (lo.benefits - hi.benefits) / delta;
  return {
    income,
    statutory_rate: statutory,
    clawback_rate: clawback,
    effective_rate: statutory + clawback,
  };
}

/**
 * What a deductible contribution is actually worth: the tax refund plus any
 * benefit it restores by lowering adjusted family net income.
 *
 * The benefit half is routinely the larger of the two for families in a
 * clawback band, and is the part nobody is told about.
 */
export function valueOfContribution(
  income: number,
  contribution: number,
  household: Household,
  cfg: TaxConfig = TAX_CONFIG,
): ContributionValue {
  const before = netPosition(income, household, cfg, 0);
  const after = netPosition(income, household, cfg, contribution);
  const refund = before.tax - after.tax;
  const benefit = after.benefits - before.benefits;
  const total = refund + benefit;
  return {
    contribution,
    tax_refund: refund,
    benefit_restored: benefit,
    total_value: total,
    blended_rate: contribution ? total / contribution : 0,
    refund_share: total ? refund / total : 0,
  };
}

/** The marginal-rate curve across an income range, for charting. */
export function marginalRateCurve(
  household: Household,
  {
    from = 0,
    to = 200_000,
    step = 1_000,
    cfg = TAX_CONFIG,
  }: { from?: number; to?: number; step?: number; cfg?: TaxConfig } = {},
): MarginalRate[] {
  const out: MarginalRate[] = [];
  for (let income = from; income <= to; income += step) {
    out.push(effectiveMarginalRate(income, household, cfg, step));
  }
  return out;
}
