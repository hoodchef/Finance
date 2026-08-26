import type { BacktestConfig } from '@/lib/types';

/**
 * Carries a plan from the Planner into the Backtester.
 *
 * The Planner answers "how much, and into which account". The Backtester
 * answers "and then what happens to it". Until these were connected you could
 * compute that $8,000 belongs in an FHSA this year and then had to retype it,
 * which is the seam that made this feel like two products rather than one.
 *
 * WHAT THIS ASSUMES, AND WHY IT SAYS SO
 *
 * The Planner's answer is for ONE year. Projecting it forward assumes income,
 * contribution room and family circumstances hold steady — none of which they
 * do. The government boost is a further assumption on top: a refund arrives the
 * following spring and only compounds if it is reinvested rather than spent.
 *
 * These are stated on screen rather than folded silently into a number, because
 * the difference between "saving $20,000 a year" and "saving $20,000 a year
 * plus reinvesting every refund" compounds into a very large gap over decades.
 */

export interface PlanBridgeInput {
  /** Annual amount the plan allocates across accounts. */
  savingsCapacity: number;
  /** Refund + restored benefits + employer match + education grant, year one. */
  firstYearBoost: number;
  /** Include the boost as though it were reinvested each year. */
  includeBoost: boolean;
  /** Existing balance, if any. */
  initialInvestment?: number;
}

export interface PlanBridgeResult {
  config: Partial<BacktestConfig>;
  /** Assumptions the user must see beside the result. */
  assumptions: string[];
}

export function planToBacktestConfig(input: PlanBridgeInput): PlanBridgeResult {
  const annual =
    input.savingsCapacity + (input.includeBoost ? Math.max(0, input.firstYearBoost) : 0);

  const assumptions: string[] = [
    `Contributes ${formatPlain(annual)} every year. The plan sizes one year; repeating it assumes your income and contribution room stay where they are.`,
  ];

  if (input.includeBoost && input.firstYearBoost > 0) {
    assumptions.push(
      `Includes ${formatPlain(input.firstYearBoost)} of refund, restored benefits, employer match and grant, and assumes all of it is reinvested rather than spent. A refund arrives the following spring, so treating it as a same-year contribution is slightly generous.`,
    );
  } else if (input.firstYearBoost > 0) {
    assumptions.push(
      `Excludes the ${formatPlain(input.firstYearBoost)} of refund, restored benefits and match the plan generates. Reinvesting that would raise the result materially.`,
    );
  }

  assumptions.push(
    'Account-level tax treatment is not modelled. Registered and taxable accounts are backtested identically here; the plan is what distinguishes them.',
  );

  return {
    config: {
      initialInvestment: input.initialInvestment ?? 0,
      contributionAmount: annual,
      contributionFrequency: 'annual',
      contributionIsWithdrawal: false,
    },
    assumptions,
  };
}

/** Plain currency for embedding in a sentence. */
function formatPlain(v: number): string {
  return `$${Math.round(v).toLocaleString('en-CA')}`;
}
