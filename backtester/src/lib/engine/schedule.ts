import type { ContributionFrequency, IsoDate, RebalanceFrequency } from '@/lib/types';

/**
 * Turns a frequency into a set of *calendar-day indices* on the master trading
 * calendar.
 *
 * The rule throughout is "first trading day on or after the scheduled date".
 * A rebalance or contribution scheduled for a weekend or an exchange holiday
 * therefore executes on the next day the market is actually open, which is what
 * happens in a real account — it is never silently dropped and never executed
 * on a day with no price.
 */

function periodMonths(freq: RebalanceFrequency): number | null {
  switch (freq) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'semiannual':
      return 6;
    case 'annual':
      return 12;
    default:
      return null;
  }
}

function contributionMonths(freq: ContributionFrequency): number | null {
  switch (freq) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'annual':
      return 12;
    default:
      return null;
  }
}

/**
 * Indices of the first trading day of each new period after the start.
 * Index 0 is never included — the initial investment already establishes the
 * target weights, so rebalancing on day one would be a no-op that still charges
 * trading costs.
 */
export function periodBoundaryIndices(calendar: IsoDate[], months: number): number[] {
  if (calendar.length === 0 || months <= 0) return [];
  const out: number[] = [];
  const startDate = calendar[0];
  const startYear = Number(startDate.slice(0, 4));
  const startMonth = Number(startDate.slice(5, 7)) - 1;

  // Absolute month number of the start, then step forward in `months` blocks.
  const startAbs = startYear * 12 + startMonth;
  let nextAbs = startAbs + months;

  for (let i = 1; i < calendar.length; i++) {
    const d = calendar[i];
    const abs = Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
    if (abs >= nextAbs) {
      out.push(i);
      // Advance past every boundary this day may have skipped (e.g. a long
      // market closure), so we never emit two rebalances for one period.
      while (nextAbs <= abs) nextAbs += months;
    }
  }
  return out;
}

export function rebalanceIndices(
  calendar: IsoDate[],
  freq: RebalanceFrequency,
): Set<number> {
  const months = periodMonths(freq);
  if (months == null) return new Set();
  return new Set(periodBoundaryIndices(calendar, months));
}

export function contributionIndices(
  calendar: IsoDate[],
  freq: ContributionFrequency,
): Set<number> {
  const months = contributionMonths(freq);
  if (months == null) return new Set();
  return new Set(periodBoundaryIndices(calendar, months));
}

/** Last trading-day index of each calendar month — when the fee is charged. */
export function monthEndIndices(calendar: IsoDate[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < calendar.length; i++) {
    const isLast = i === calendar.length - 1;
    if (isLast || calendar[i].slice(0, 7) !== calendar[i + 1].slice(0, 7)) out.add(i);
  }
  return out;
}
