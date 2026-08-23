import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api-errors';
import { ValidationError } from '@/lib/validate';
import { optimize } from '@/lib/canpath/allocate';
import { effectiveMarginalRate, marginalRateCurve, netPosition } from '@/lib/canpath/position';
import { totalBenefits } from '@/lib/canpath/benefits';
import { payrollDeductions, supportedProvinces, TAX_CONFIG } from '@/lib/canpath/tax';
import type { Household } from '@/lib/canpath/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The planning side of the platform: what the next dollar is actually worth,
 * and which account it belongs in.
 *
 * Every figure comes from `taxyear_2026.json`, whose provenance is recorded in
 * its own `source_notes`. Nothing here is estimated or assumed — if a parameter
 * were missing the correct behaviour is to fail, not to substitute a plausible
 * number.
 */

function num(v: unknown, field: string, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback != null) return fallback;
    throw new ValidationError(`${field} is required.`, field);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number.`, field);
  return n;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const province = String(body.province ?? 'BC').toUpperCase();
    if (!TAX_CONFIG.provinces[province]) {
      throw new ValidationError(
        `${province} is not covered by the ${TAX_CONFIG.tax_year} data set. Supported: ${supportedProvinces().join(', ')}.`,
        'province',
      );
    }

    const income = num(body.income, 'Income');
    if (income < 0) throw new ValidationError('Income cannot be negative.', 'income');
    if (income > 10_000_000) {
      throw new ValidationError('Income above $10,000,000 is out of range.', 'income');
    }

    const partnerIncome = Math.max(0, num(body.partnerIncome, 'Partner income', 0));
    const savingsCapacity = Math.max(0, num(body.savingsCapacity, 'Savings capacity', 0));

    const childAges: number[] = Array.isArray(body.childAges)
      ? body.childAges
          .map((a: unknown) => Number(a))
          .filter((a: number) => Number.isFinite(a) && a >= 0 && a < 30)
          .slice(0, 12)
      : [];

    const retirementRate = num(body.expectedRetirementRate, 'Expected retirement rate', 0.25);
    if (retirementRate < 0 || retirementRate > 1) {
      throw new ValidationError(
        'The expected retirement rate must be between 0 and 1 (e.g. 0.25 for 25%).',
        'expectedRetirementRate',
      );
    }

    const household: Household = {
      province,
      child_ages: childAges,
      partner_income: partnerIncome,
      partnered: body.partnered != null ? Boolean(body.partnered) : partnerIncome > 0,
    };

    const position = netPosition(income, household);
    const marginal = effectiveMarginalRate(income, household);
    const benefits = totalBenefits(position.afni, household);
    const payroll = payrollDeductions(income);

    const allocation =
      savingsCapacity > 0
        ? optimize({
            income,
            household,
            savings_capacity: savingsCapacity,
            expected_retirement_rate: retirementRate,
            fhsa_eligible: Boolean(body.fhsaEligible),
            employer_match_rate: Math.max(0, num(body.employerMatchRate, 'Employer match rate', 0)),
            employer_match_cap: Math.max(0, num(body.employerMatchCap, 'Employer match cap', 0)),
          })
        : null;

    // Sampled coarsely enough to stay fast, finely enough to show the cliffs.
    const curve = marginalRateCurve(household, { from: 0, to: 200_000, step: 1_000 });

    return NextResponse.json({
      taxYear: TAX_CONFIG.tax_year,
      province,
      position,
      marginal,
      benefits,
      payroll,
      allocation,
      curve,
      provinces: supportedProvinces(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
