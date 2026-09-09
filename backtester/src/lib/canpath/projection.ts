/**
 * Compound growth and retirement projection.
 *
 * Ported from CanPath's `engine/projection.py` via its verified JavaScript
 * port. Real (today's dollars) is the default reporting basis throughout:
 * nominal figures flatter and mislead over a thirty-year horizon.
 */

/**
 * CPP and OAS parameters.
 *
 * Provenance: Canada.ca, January 2026 — carried over verbatim from CanPath's
 * Python reference, where the same figures are recorded. These are NOT in
 * `taxyear_2026.json`, which covers tax and benefits only.
 *
 * Averages matter more than maximums here: the maximum assumes roughly 39
 * years of contributions at the earnings ceiling, which almost nobody has.
 */
export const CPP_2026 = {
  average_monthly_at_65: 925.35,
  maximum_monthly_at_65: 1507.65,
  early_reduction_per_month: 0.006, // before 65
  late_increase_per_month: 0.007, // after 65
} as const;

export const OAS_2026 = {
  maximum_monthly_at_65: 742.31,
  late_increase_per_month: 0.006,
  bump_at_75: 0.1,
  clawback_threshold: 95_323,
  clawback_rate: 0.15,
} as const;

export const DEFAULT_INFLATION = 0.02;
export const DEFAULT_WITHDRAWAL_RATE = 0.04;

/** Fisher equation, not nominal minus inflation. */
export function realRate(nominal: number, inflation: number = DEFAULT_INFLATION): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/** `(1+r)^(1/12) - 1`, so twelve months reproduce exactly the annual rate typed. */
export function monthlyRate(annual: number): number {
  return Math.pow(1 + annual, 1 / 12) - 1;
}

export function futureValue(
  principal: number,
  monthly: number,
  annualRate: number,
  years: number,
  atStart = false,
): number {
  const n = Math.round(years * 12);
  const i = monthlyRate(annualRate);
  if (Math.abs(i) < 1e-12) return principal + monthly * n; // 0% would divide by zero
  const g = Math.pow(1 + i, n);
  let annuity = monthly * ((g - 1) / i);
  if (atStart) annuity *= 1 + i;
  return principal * g + annuity;
}

export function requiredMonthly(
  target: number,
  principal: number,
  annualRate: number,
  years: number,
): number {
  const n = Math.round(years * 12);
  if (n <= 0) return 0;
  const i = monthlyRate(annualRate);
  if (Math.abs(i) < 1e-12) return Math.max(0, (target - principal) / n);
  const g = Math.pow(1 + i, n);
  const remaining = target - principal * g;
  return remaining <= 0 ? 0 : (remaining * i) / (g - 1);
}

export interface ProjectionPoint {
  year: number;
  nominal: number;
  real: number;
  contributed: number;
  growth_nominal: number;
  growth_real: number;
}

export function projectionSeries(
  principal: number,
  monthly: number,
  annualRate: number,
  years: number,
  inflation: number = DEFAULT_INFLATION,
): ProjectionPoint[] {
  const out: ProjectionPoint[] = [];
  const rr = realRate(annualRate, inflation);
  for (let y = 0; y <= years; y++) {
    const nominal = futureValue(principal, monthly, annualRate, y);
    const real = futureValue(principal, monthly, rr, y);
    const contributed = principal + monthly * 12 * y;
    out.push({
      year: y,
      nominal,
      real,
      contributed,
      growth_nominal: nominal - contributed,
      growth_real: Math.max(0, real - contributed),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Government pensions                                                */
/* ------------------------------------------------------------------ */

export function cppEstimate(startAge = 65, share = 1, useMax = false): number {
  const base =
    (useMax ? CPP_2026.maximum_monthly_at_65 : CPP_2026.average_monthly_at_65) * share;
  const months = (startAge - 65) * 12;
  const factor =
    months < 0
      ? 1 + months * CPP_2026.early_reduction_per_month
      : 1 + months * CPP_2026.late_increase_per_month;
  return Math.max(0, base * factor * 12);
}

export function oasEstimate(startAge = 65, yearsInCanada = 40): number {
  const base =
    OAS_2026.maximum_monthly_at_65 * Math.min(1, Math.max(0, yearsInCanada) / 40);
  const months = Math.max(0, (startAge - 65) * 12);
  return base * (1 + months * OAS_2026.late_increase_per_month) * 12;
}

/**
 * The OAS recovery tax, universally called the clawback: 15 cents of every
 * dollar of INDIVIDUAL net income above the threshold, capped at the pension
 * itself.
 *
 * Individual, not family — unlike CCB, the BC Family Benefit and CGEB, which
 * test against adjusted family net income. It adds 15 points to the effective
 * marginal rate across the recovery band.
 */
export function oasRecoveryTax(oasAnnual: number, netIncome: number): number {
  const t = OAS_2026.clawback_threshold;
  if (netIncome <= t || oasAnnual <= 0) return 0;
  return Math.min(oasAnnual, OAS_2026.clawback_rate * (netIncome - t));
}

export function oasAfterRecovery(oasAnnual: number, netIncome: number): number {
  return Math.max(0, oasAnnual - oasRecoveryTax(oasAnnual, netIncome));
}

/** Income at which OAS is fully recovered. */
export function oasFullRecoveryIncome(oasAnnual: number): number {
  return oasAnnual <= 0
    ? OAS_2026.clawback_threshold
    : OAS_2026.clawback_threshold + oasAnnual / OAS_2026.clawback_rate;
}

/**
 * The age at which cumulative CPP from a later start overtakes an earlier one.
 *
 * Nominal and undiscounted on purpose: the discounted answer depends on a rate
 * the user must supply and cannot verify, while the nominal crossover is a
 * fact about the pension formula.
 */
export function cppBreakevenAge(
  earlyStart: number,
  lateStart: number,
  share = 1,
  maxAge = 100,
): number {
  if (lateStart <= earlyStart) return earlyStart;
  const e = cppEstimate(earlyStart, share);
  const l = cppEstimate(lateStart, share);
  if (l <= e) return maxAge;

  for (let age = lateStart; age < maxAge; age += 1) {
    if (e * (age - earlyStart) <= l * (age - lateStart)) {
      for (let a = age - 1; a < age; a += 0.1) {
        if (e * (a - earlyStart) <= l * (a - lateStart)) return Math.round(a * 10) / 10;
      }
      return Math.round(age * 10) / 10;
    }
  }
  return maxAge;
}

/* ------------------------------------------------------------------ */
/* Readiness                                                          */
/* ------------------------------------------------------------------ */

export interface RetirementProfile {
  current_age: number;
  retirement_age: number;
  current_savings: number;
  monthly_contribution: number;
  target_annual_income: number;
  annual_rate: number;
  inflation?: number;
  withdrawal_rate?: number;
  cpp_start_age?: number;
  cpp_share?: number;
  years_in_canada?: number;
}

export interface RetirementReadiness {
  years_to_retirement: number;
  cpp_annual: number;
  cpp_start_age: number;
  oas_annual: number;
  oas_gross: number;
  oas_recovery_tax: number;
  government_annual: number;
  income_gap: number;
  nest_egg_needed: number;
  projected_real: number;
  projected_nominal: number;
  total_contributed: number;
  required_monthly: number;
  monthly_shortfall: number;
  on_track: boolean;
  coverage: number;
  portfolio_income: number;
  projected_retirement_income: number;
}

/**
 * Counts CPP and OAS FIRST, then sizes the portfolio against what is left.
 *
 * Sizing a nest egg against the whole target income ignores two pensions the
 * household will actually receive, and inflates the target substantially.
 */
export function retirementReadiness(p: RetirementProfile): RetirementReadiness {
  const years = Math.max(0, p.retirement_age - p.current_age);
  const wr = p.withdrawal_rate ?? DEFAULT_WITHDRAWAL_RATE;

  // CPP start is separable from the retirement date; default to it.
  const cppStart = p.cpp_start_age != null ? p.cpp_start_age : p.retirement_age;
  const cpp = cppEstimate(cppStart, p.cpp_share ?? 1);
  const oasGross = oasEstimate(Math.max(p.retirement_age, 65), p.years_in_canada ?? 40);

  // Break the circularity at the stated target income: the recovery tax
  // depends on net income, which depends on the portfolio, which depends on
  // the recovery tax.
  const oasRecovery = oasRecoveryTax(oasGross, p.target_annual_income);
  const oas = oasGross - oasRecovery;

  const government = cpp + oas;
  const gap = Math.max(0, p.target_annual_income - government);
  const nest = wr > 0 ? gap / wr : 0;

  const rr = realRate(p.annual_rate, p.inflation ?? DEFAULT_INFLATION);
  const projReal = futureValue(p.current_savings, p.monthly_contribution, rr, years);
  const projNom = futureValue(p.current_savings, p.monthly_contribution, p.annual_rate, years);
  const need = requiredMonthly(nest, p.current_savings, rr, years);

  return {
    years_to_retirement: years,
    cpp_annual: cpp,
    cpp_start_age: cppStart,
    oas_annual: oas,
    oas_gross: oasGross,
    oas_recovery_tax: oasRecovery,
    government_annual: government,
    income_gap: gap,
    nest_egg_needed: nest,
    projected_real: projReal,
    projected_nominal: projNom,
    total_contributed: p.current_savings + p.monthly_contribution * 12 * years,
    required_monthly: need,
    monthly_shortfall: Math.max(0, need - p.monthly_contribution),
    on_track: projReal >= nest,
    coverage: nest > 0 ? projReal / nest : 1,
    portfolio_income: projReal * wr,
    projected_retirement_income: government + projReal * wr,
  };
}

/**
 * How many full years a balance survives a fixed annual withdrawal.
 *
 * The 4%-rule framing answers "is this sustainable forever", which is a
 * different question from "when does the money run out". Withdrawal happens at
 * the START of each year: the retiree needs the cash before the market
 * cooperates, and assuming otherwise flatters the result by a year.
 */
export function depletionYears(
  balance: number,
  annualDraw: number,
  annualRate: number,
  maxYears = 60,
): number {
  if (annualDraw <= 0) return maxYears;
  let b = balance;
  for (let y = 0; y < maxYears; y++) {
    b -= annualDraw;
    if (b <= 0) return y;
    b *= 1 + annualRate;
  }
  return maxYears;
}

export interface CostOfWaiting {
  delay_years: number;
  start_now: number;
  start_later: number;
  cost: number;
  contributions_skipped: number;
  lost_per_dollar_skipped: number;
}

export function costOfWaiting(p: RetirementProfile, delay = 5): CostOfWaiting {
  const years = Math.max(0, p.retirement_age - p.current_age);
  const rr = realRate(p.annual_rate, p.inflation ?? DEFAULT_INFLATION);
  const now = futureValue(p.current_savings, p.monthly_contribution, rr, years);
  const later = futureValue(
    p.current_savings,
    p.monthly_contribution,
    rr,
    Math.max(0, years - delay),
  );
  const skipped = p.monthly_contribution * 12 * Math.min(delay, years);
  return {
    delay_years: delay,
    start_now: now,
    start_later: later,
    cost: Math.max(0, now - later),
    contributions_skipped: skipped,
    lost_per_dollar_skipped: skipped > 0 ? (now - later) / skipped : 0,
  };
}
