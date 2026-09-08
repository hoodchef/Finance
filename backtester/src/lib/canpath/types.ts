/**
 * Types for the CanPath tax and benefit engine.
 *
 * These mirror the shape of `data/taxyear_2026.json`, which is the single
 * source of truth for every Canadian tax parameter in this application.
 *
 * THE ONE RULE, inherited from CanPath and repeated here because it is the
 * easiest rule in this codebase to break by accident:
 *
 *   Never invent a Canadian tax parameter. Not a bracket, not a threshold,
 *   not a phase-out rate, not a benefit maximum.
 *
 * Every figure in the data file carries its provenance in `source_notes`. If a
 * figure is needed and absent, the correct move is to say so and stop. A
 * fabricated rate would pass every test in this repository, because the
 * fixtures are generated *from* the data file — and would then produce
 * confidently wrong advice to someone making a real financial decision.
 */

export type ProvinceCode =
  | 'AB' | 'BC' | 'MB' | 'NB' | 'NL' | 'NS' | 'ON' | 'PE' | 'SK';

export interface Bracket {
  floor: number;
  rate: number;
}

export interface FederalConfig {
  brackets: Bracket[];
  credit_rate: number;
  bpa: {
    base: number;
    additional: number;
    phaseout_start: number;
    phaseout_end: number;
  };
}

export interface TaxReduction {
  max_credit: number;
  threshold: number;
  phaseout_rate: number;
}

export interface ProvinceConfig {
  brackets: Bracket[];
  bpa: number;
  credit_rate: number;
  tax_reduction?: TaxReduction | null;
}

export interface CcbConfig {
  max_under_6: number;
  max_6_to_17: number;
  threshold_1: number;
  threshold_2: number;
  phase1_rates: Record<string, number>;
  phase2_rates: Record<string, number>;
}

export interface BcFamilyBenefitConfig {
  max_first_child: number;
  max_second_child: number;
  max_additional_child: number;
  floor_first_child: number;
  floor_second_child: number;
  floor_additional_child: number;
  single_parent_supplement: number;
  phaseout_rate: number;
  threshold_1: number;
  threshold_2: number;
}

export interface CgebConfig {
  max_single: number;
  max_couple: number;
  max_per_child: number;
  child_age_limit: number;
  threshold: number;
  phaseout_rate: number;
}

/** Linear phase-out, a literal step cliff, or Alberta's two-component form. */
export type ProvincialChildBenefit =
  | {
      type: 'linear';
      amounts: number[];
      rate: number;
      threshold: number;
    }
  | {
      type: 'tiered';
      tiers: Array<{ upto: number; per_child: number }>;
    }
  | {
      type: 'ab';
      base_amounts: number[];
      base_rate: number;
      base_threshold: number;
      working_amounts: number[];
      working_rate: number;
      working_threshold: number;
      working_min_employment: number;
    };

export interface BenefitsConfig {
  ccb: CcbConfig;
  bc_family_benefit?: BcFamilyBenefitConfig;
  cgeb?: CgebConfig;
  provincial_child_benefits?: Record<string, ProvincialChildBenefit | null>;
}

export interface AccountsConfig {
  rrsp: { earned_income_rate: number; dollar_limit: number };
  tfsa: { annual_limit: number };
  fhsa: { annual_limit: number; lifetime_limit: number };
  resp: {
    cesg_match_rate: number;
    cesg_matched_contribution: number;
    cesg_lifetime_max: number;
  };
  hbp_withdrawal_limit?: number;
}

export interface PayrollConfig {
  cpp: { rate: number; ympe: number; basic_exemption: number };
  cpp2: { rate: number; yampe: number };
  ei: { rate: number; max_insurable: number };
}

export interface TaxConfig {
  tax_year: number;
  source_notes: unknown;
  federal: FederalConfig;
  provinces: Record<string, ProvinceConfig>;
  benefits: BenefitsConfig;
  accounts: AccountsConfig;
  payroll: PayrollConfig;
}

/* ------------------------------------------------------------------ */
/* Household and profile                                              */
/* ------------------------------------------------------------------ */

export interface Household {
  province: ProvinceCode | string;
  /** Ages of dependent children. Age limits differ per benefit. */
  child_ages: number[];
  /** Partner's net income. Zero or absent means no partner. */
  partner_income?: number;
  /**
   * Explicit partnership flag. When absent, partnership is inferred from
   * `partner_income > 0` — which is wrong for a non-earning partner, so set it
   * explicitly wherever the answer is known.
   */
  partnered?: boolean;
}

export interface AllocationProfile {
  income: number;
  savings_capacity: number;
  household: Household;
  /** Marginal rate expected at withdrawal, as a decimal. */
  expected_retirement_rate: number;
  fhsa_eligible?: boolean;
  employer_match_rate?: number;
  employer_match_cap?: number;
  rrsp_room?: number;
  tfsa_room?: number;
  fhsa_room?: number;
  fhsa_lifetime_remaining?: number;
  resp_children?: number;
  cesg_remaining?: number;
}

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

export interface PayrollDeductions {
  cpp: number;
  cpp2: number;
  ei: number;
  total: number;
}

export interface BenefitBreakdown {
  ccb: number;
  bcfb: number;
  pcb: number;
  cgeb: number;
  total: number;
}

export interface NetPosition {
  gross_income: number;
  partner_income: number;
  deduction: number;
  taxable_income: number;
  /** Adjusted family net income: both partners, after deductions. */
  afni: number;
  tax: number;
  partner_tax: number;
  household_tax: number;
  benefits: number;
  net_cash: number;
}

export interface MarginalRate {
  income: number;
  /** Income tax on the next dollar. */
  statutory_rate: number;
  /** Benefits withdrawn on the next dollar. */
  clawback_rate: number;
  /** What the next dollar is actually worth: statutory + clawback. */
  effective_rate: number;
}

export interface ContributionValue {
  contribution: number;
  tax_refund: number;
  benefit_restored: number;
  total_value: number;
  blended_rate: number;
  refund_share: number;
}

export type AccountKey =
  | 'employer_match'
  | 'fhsa'
  | 'resp'
  | 'rrsp'
  | 'tfsa'
  | 'non_registered';

export interface AllocationStep {
  account: AccountKey;
  amount: number;
  emr_at_step: number;
}

export interface AllocationResult {
  allocation: Partial<Record<AccountKey, number>>;
  /** Order the accounts were first funded in. */
  sequence: AccountKey[];
  total_deducted: number;
  rrsp_room_used: number;
  rrsp_room_left: number;
  tax_refund: number;
  benefit_restored: number;
  employer_match_earned: number;
  resp_grant_earned: number;
  warnings: string[];
  steps: AllocationStep[];
}
