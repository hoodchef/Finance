import { effectiveMarginalRate, netPosition } from './position';
import { TAX_CONFIG } from './tax';
import type {
  AccountKey,
  AllocationProfile,
  AllocationResult,
  AllocationStep,
  TaxConfig,
} from './types';

/**
 * The funding-order solver: given income and how much can be saved, decide how
 * much belongs in each account this year, and in what order.
 *
 * It works in small chunks and re-scores after each one, because the effective
 * marginal rate MOVES as deductions accumulate — a contribution that is worth
 * 56 cents on the dollar at the top of a clawback band is worth far less once
 * it has pulled the household out of that band. Scoring once up front and
 * funding to exhaustion gets this wrong.
 */

export function optimize(
  profile: AllocationProfile,
  cfg: TaxConfig = TAX_CONFIG,
  chunk = 250,
): AllocationResult {
  const a = cfg.accounts;

  const rrspRoom =
    profile.rrsp_room ??
    Math.min(profile.income * a.rrsp.earned_income_rate, a.rrsp.dollar_limit);
  const tfsaRoom = profile.tfsa_room ?? a.tfsa.annual_limit;

  // FHSA is capped over a LIFETIME, not only per year. Handing out the annual
  // limit indefinitely models an account that runs forever.
  const fhsaLife = profile.fhsa_lifetime_remaining ?? a.fhsa.lifetime_limit;
  const fhsaRoom =
    profile.fhsa_room ??
    (profile.fhsa_eligible ? Math.min(a.fhsa.annual_limit, Math.max(0, fhsaLife)) : 0);

  const allocated: Record<AccountKey, number> = {
    employer_match: 0,
    fhsa: 0,
    resp: 0,
    rrsp: 0,
    tfsa: 0,
    non_registered: 0,
  };

  // RESP room here means "contribution that still attracts the 20% grant",
  // not the lifetime contribution limit — an ungranted RESP dollar has no
  // special claim on the next dollar saved.
  const respKids =
    profile.resp_children ??
    (profile.household?.child_ages || []).filter((x) => x < 18).length;
  const cesgLeft = profile.cesg_remaining ?? a.resp.cesg_lifetime_max * respKids;
  const respRoom = Math.max(
    0,
    Math.min(
      a.resp.cesg_matched_contribution * respKids,
      a.resp.cesg_match_rate ? cesgLeft / a.resp.cesg_match_rate : 0,
    ),
  );

  const room: Record<string, number> = { fhsa: fhsaRoom, tfsa: tfsaRoom, resp: respRoom };

  // Employer match and RRSP share ONE pool: a group-RRSP match consumes the
  // same room the employee's own contributions do, and each matched dollar
  // costs (1 + rate) of it.
  let pool = rrspRoom;
  let matchLeft = profile.employer_match_cap || 0;
  const mult = 1 + (profile.employer_match_rate || 0);

  const steps: AllocationStep[] = [];
  const sequence: AccountKey[] = [];
  let remaining = profile.savings_capacity;
  let deducted = 0;
  let guard = 0;

  while (remaining > 0.01 && guard++ < 10000) {
    let amount = Math.min(chunk, remaining);
    const emr = effectiveMarginalRate(
      profile.income - deducted,
      profile.household,
      cfg,
    ).effective_rate;
    const matchRoom = Math.min(matchLeft, pool / mult);

    const scores: Partial<Record<AccountKey, number>> = {};
    if (matchRoom > 0) scores.employer_match = (profile.employer_match_rate || 0) + emr;
    if (room.fhsa > 0) scores.fhsa = emr;
    // Grant rate alone: an RESP contribution is not deductible.
    if (room.resp > 0) scores.resp = a.resp.cesg_match_rate;
    if (pool > 0) scores.rrsp = emr - profile.expected_retirement_rate;
    if (room.tfsa > 0) scores.tfsa = 0;

    const keys = Object.keys(scores) as AccountKey[];
    let best: AccountKey;

    // Registered room beats a taxable account even at a NEGATIVE score. This
    // scores year one only, whereas a taxable account's real cost is the tax
    // on every year of growth after it: 19.6% in and 25% out scores -5.4 but
    // still returns 7.10 per after-tax dollar over 30 years at 7%, against
    // 6.79 taxable.
    if (keys.length === 0 || Math.max(...keys.map((k) => scores[k] as number)) < 0) {
      if (room.tfsa > 0) best = 'tfsa';
      else if (pool > 0) best = 'rrsp';
      else {
        allocated.non_registered += amount;
        remaining -= amount;
        continue;
      }
    } else {
      best = keys.reduce((x, y) =>
        (scores[y] as number) > (scores[x] as number) ? y : x,
      );
    }

    if (best === 'employer_match') amount = Math.min(amount, matchRoom);
    else if (best === 'rrsp') amount = Math.min(amount, pool);
    else amount = Math.min(amount, room[best]);

    if (amount <= 1e-9) {
      allocated.non_registered += remaining;
      remaining = 0;
      continue;
    }

    if (best === 'employer_match') {
      matchLeft -= amount;
      pool -= amount * mult;
    } else if (best === 'rrsp') pool -= amount;
    else room[best] -= amount;

    allocated[best] += amount;
    remaining -= amount;
    if (sequence.indexOf(best) < 0) sequence.push(best);

    // "resp" is deliberately absent — its contributions are not deductible.
    if (best === 'rrsp' || best === 'fhsa' || best === 'employer_match') deducted += amount;
    steps.push({ account: best, amount, emr_at_step: emr });
  }

  const before = netPosition(profile.income, profile.household, cfg, 0);
  const after = netPosition(profile.income, profile.household, cfg, deducted);

  const allocation: Partial<Record<AccountKey, number>> = {};
  for (const [k, v] of Object.entries(allocated)) {
    if (v > 0) allocation[k as AccountKey] = v;
  }

  return {
    allocation,
    sequence,
    total_deducted: deducted,
    rrsp_room_used: rrspRoom - pool,
    rrsp_room_left: pool,
    tax_refund: before.tax - after.tax,
    benefit_restored: after.benefits - before.benefits,
    employer_match_earned: allocated.employer_match * (profile.employer_match_rate || 0),
    resp_grant_earned: allocated.resp * a.resp.cesg_match_rate,
    warnings: guardrails(profile, cfg, allocated, pool),
    steps,
  };
}

/**
 * Situations where the arithmetic is right but the answer still deserves a
 * caveat a solver cannot express as a score.
 */
export function guardrails(
  profile: AllocationProfile,
  cfg: TaxConfig,
  allocated: Record<AccountKey, number> | null,
  rrspLeft: number | null,
): string[] {
  const w: string[] = [];
  const emr = effectiveMarginalRate(profile.income, profile.household, cfg).effective_rate;

  if (emr < profile.expected_retirement_rate) {
    w.push(
      `RRSP contributions look value-destroying here: your effective rate now (${(emr * 100).toFixed(1)}%) is below the rate you expect to withdraw at (${(profile.expected_retirement_rate * 100).toFixed(1)}%). Fill the TFSA first.`,
    );
  }

  if (profile.income < 45000) {
    w.push(
      'At this income, RRSP or RRIF withdrawals in retirement may trigger GIS clawback of roughly 50 cents on the dollar. TFSA withdrawals do not affect GIS.',
    );
  }

  if (profile.fhsa_eligible && (profile.fhsa_room ?? cfg.accounts.fhsa.annual_limit) > 0) {
    w.push(
      'FHSA room is unused. It is the only account that is both deductible going in and tax-free coming out.',
    );
  }

  // An employer match larger than the room available to absorb it is not free
  // money; the CRA penalises the over-contribution at 1% a month. Only warn
  // when ROOM is what ran out — someone saving less than their employer would
  // match has a different problem.
  if (
    allocated &&
    (profile.employer_match_cap || 0) > 0 &&
    rrspLeft != null &&
    rrspLeft <= 0.01 &&
    allocated.employer_match < (profile.employer_match_cap || 0) - 0.01
  ) {
    w.push(
      `Your RRSP room only covers $${Math.round(allocated.employer_match).toLocaleString('en-CA')} of the $${Math.round(profile.employer_match_cap || 0).toLocaleString('en-CA')} your employer will match. The match uses the same room your own contributions do. Check your room in CRA My Account before topping up.`,
    );
  }

  return w;
}
