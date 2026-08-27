import { NextResponse } from 'next/server';
import {
  cppBreakevenAge,
  cppEstimate,
  costOfWaiting,
  oasEstimate,
  oasFullRecoveryIncome,
  oasRecoveryTax,
  retirementReadiness,
  type RetirementProfile,
} from '@/lib/canpath/projection';
import { errorResponse } from '@/lib/api-errors';
import { ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function num(v: unknown, label: string, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (v == null || v === '') return fallback;
  if (!Number.isFinite(n)) throw new ValidationError(`${label} must be a number.`, label);
  if (n < min || n > max) {
    throw new ValidationError(`${label} must be between ${min} and ${max}.`, label);
  }
  return n;
}

/**
 * Retirement projection, government benefits included.
 *
 * The CanPath engine has modelled CPP and OAS since it was ported and nothing
 * ever called it. Two of the decisions it covers are among the largest a
 * Canadian retiree makes and neither is obvious: when to start CPP, which has
 * a breakeven age rather than a right answer, and the OAS recovery tax, which
 * takes 15 cents of every dollar above a threshold and is invisible until it
 * happens.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const profile: RetirementProfile = {
      current_age: num(body.currentAge, 'Current age', 40, 18, 90),
      retirement_age: num(body.retirementAge, 'Retirement age', 65, 50, 95),
      current_savings: num(body.currentSavings, 'Current savings', 100_000, 0, 1e9),
      monthly_contribution: num(body.monthlyContribution, 'Monthly contribution', 1_000, 0, 1e6),
      target_annual_income: num(body.targetIncome, 'Target income', 60_000, 0, 1e7),
      annual_rate: num(body.annualRate, 'Expected return', 0.06, -0.5, 0.5),
      inflation: num(body.inflation, 'Inflation', 0.02, 0, 0.25),
      withdrawal_rate: num(body.withdrawalRate, 'Withdrawal rate', 0.04, 0.005, 0.2),
      cpp_start_age: num(body.cppStartAge, 'CPP start age', 65, 60, 70),
      cpp_share: num(body.cppShare, 'CPP share', 1, 0, 1),
      years_in_canada: num(body.yearsInCanada, 'Years in Canada', 40, 0, 40),
    };

    if (profile.retirement_age <= profile.current_age) {
      throw new ValidationError('Retirement age must be after your current age.', 'retirementAge');
    }

    const readiness = retirementReadiness(profile);

    // The CPP timing question, laid out rather than answered: every start age
    // against the one chosen, with the age at which waiting overtakes.
    const cppByAge = [60, 62, 65, 67, 70].map((age) => ({
      age,
      annual: cppEstimate(age, profile.cpp_share ?? 1),
      breakevenAgainst65:
        age === 65 ? null : cppBreakevenAge(Math.min(age, 65), Math.max(age, 65), profile.cpp_share ?? 1),
    }));

    const oasGross = oasEstimate(65, profile.years_in_canada ?? 40);

    return NextResponse.json({
      readiness,
      cppByAge,
      oas: {
        gross: oasGross,
        // Where the recovery tax starts biting, and where it takes everything.
        clawbackStarts: oasFullRecoveryIncome(0),
        fullyRecoveredAt: oasFullRecoveryIncome(oasGross),
        recoveryAtTarget: oasRecoveryTax(oasGross, profile.target_annual_income),
      },
      waiting: [1, 3, 5, 10].map((years) => costOfWaiting(profile, years)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
