/**
 * What an account wrapper does to a backtest's growth.
 * =============================================================================
 * The backtest says what the money did. This says what you keep.
 *
 * SCOPE, AND WHY IT STOPS WHERE IT DOES
 *
 * Registered accounts are modelled exactly, because they need one input each
 * and that input is real: the marginal rate, which CanPath computes from
 * `taxyear_2026.json` for nine provinces with a source recorded per figure.
 *
 * A TAXABLE account is NOT modelled. Doing it properly needs the capital-gains
 * inclusion rate and the dividend gross-up and tax-credit rates for eligible
 * and non-eligible dividends, federally and provincially. None of those are in
 * the data file. They are widely known numbers and it would take a minute to
 * type them in from memory, which is exactly the failure this project refuses:
 * a fabricated rate produces a plausible answer, passes every test here, and
 * is invisible in the output. `taxableAccountBlocked` says so in the product
 * rather than the absence being read as an oversight.
 *
 * THE RESULT IS SIMPLER THAN IT LOOKS
 *
 * For the same out-of-pocket cost, an RRSP holds more because the contribution
 * is deductible, and gives back less because the withdrawal is taxed:
 *
 *     RRSP / TFSA  =  (1 - rateLater) / (1 - rateNow)
 *
 * The growth rate cancels entirely. Which wrapper wins does not depend on what
 * the portfolio did — only on whether your rate in retirement is below your
 * rate today. A backtest cannot change that answer, and any tool suggesting
 * otherwise is selling something.
 */

export interface AccountComparisonInput {
  /** Out-of-pocket amount available to contribute, after tax. */
  contribution: number;
  /** Growth factor from the backtest: final value / invested. */
  growthFactor: number;
  /** Effective marginal rate today, as a fraction. From CanPath. */
  rateNow: number;
  /** Expected marginal rate on withdrawal. */
  rateLater: number;
}

export interface AccountOutcome {
  account: 'TFSA' | 'RRSP' | 'FHSA';
  /** What actually goes into the account. */
  contributed: number;
  /** Value before any withdrawal tax. */
  grossValue: number;
  /** Tax due on withdrawal. */
  taxOnWithdrawal: number;
  /** What you end up with. */
  netValue: number;
  note: string;
}

export interface AccountComparison {
  outcomes: AccountOutcome[];
  /** RRSP net divided by TFSA net. Above 1 means the RRSP wins. */
  rrspAdvantage: number;
  /** True when the two are within a rounding error of each other. */
  effectivelyEqual: boolean;
  taxableAccountBlocked: string;
}

export function compareAccounts(input: AccountComparisonInput): AccountComparison {
  const { contribution, growthFactor, rateNow, rateLater } = input;
  for (const [name, v] of Object.entries({ rateNow, rateLater })) {
    if (!Number.isFinite(v) || v < 0 || v >= 1) {
      throw new Error(`${name} must be a rate between 0 and 1, not ${v}.`);
    }
  }
  if (!Number.isFinite(contribution) || contribution < 0) {
    throw new Error('Contribution must be a non-negative amount.');
  }
  if (!Number.isFinite(growthFactor) || growthFactor < 0) {
    throw new Error('Growth factor must be non-negative.');
  }

  // TFSA and FHSA: contributions are after-tax and nothing is taxed later.
  // The FHSA differs going IN — it is deductible like an RRSP — so for the
  // same out-of-pocket cost it holds the grossed-up amount and still comes out
  // tax-free, which is why it wins outright when the room exists.
  const tfsa: AccountOutcome = {
    account: 'TFSA',
    contributed: contribution,
    grossValue: contribution * growthFactor,
    taxOnWithdrawal: 0,
    netValue: contribution * growthFactor,
    note: 'Contributed with after-tax money; nothing is taxed on the way out.',
  };

  const grossedUp = rateNow < 1 ? contribution / (1 - rateNow) : contribution;
  const rrspGross = grossedUp * growthFactor;
  const rrsp: AccountOutcome = {
    account: 'RRSP',
    contributed: grossedUp,
    grossValue: rrspGross,
    taxOnWithdrawal: rrspGross * rateLater,
    netValue: rrspGross * (1 - rateLater),
    note: 'The deduction lets the same out-of-pocket cost buy a larger contribution; the whole withdrawal is taxable.',
  };

  const fhsaGross = grossedUp * growthFactor;
  const fhsa: AccountOutcome = {
    account: 'FHSA',
    contributed: grossedUp,
    grossValue: fhsaGross,
    taxOnWithdrawal: 0,
    netValue: fhsaGross,
    note: 'Deductible going in and tax-free coming out, for a qualifying first home. The only account that is both.',
  };

  const advantage = tfsa.netValue > 0 ? rrsp.netValue / tfsa.netValue : 1;

  return {
    outcomes: [tfsa, rrsp, fhsa],
    rrspAdvantage: advantage,
    effectivelyEqual: Math.abs(advantage - 1) < 1e-9,
    taxableAccountBlocked:
      'A taxable account is not modelled. It would need the capital-gains inclusion rate and ' +
      'the dividend gross-up and credit rates for eligible and non-eligible dividends, ' +
      'federally and provincially. None are in the tax data file, and inventing them would ' +
      'produce a confident answer with nothing behind it.',
  };
}
