import type { CashflowLeg, IsoDate } from '@/lib/types';
import { addMonths } from '@/lib/market-data/dates';
import { periodBoundaryIndices } from './schedule';

/**
 * Cashflow legs.
 * =============================================================================
 * A real savings plan is rarely one uniform stream. "Save £500 a month until I
 * retire in 2040, then draw 4% a year" is two legs with different signs,
 * different schedules and different rules, and modelling it as a single
 * contribution rate gets the answer wrong in the way that matters most — the
 * transition.
 *
 * A leg resolves to a set of calendar indices and an amount at each. Every
 * scheduled date rolls forward to the next trading day, exactly as the simple
 * contribution does, so a flow is never dropped and never priced on a day the
 * market was shut.
 */

const MONTHS_PER_PERIOD: Record<CashflowLeg['frequency'], number | null> = {
  once: null,
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export interface LegOccurrence {
  /** Index on the master calendar. */
  index: number;
  /** Years elapsed since the leg's first scheduled date, for growth. */
  yearsSinceStart: number;
}

/** First calendar index on or after `date`; −1 when the window ends first. */
function indexOnOrAfter(calendar: IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = calendar.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid] >= date) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/**
 * Resolves a leg onto the calendar.
 *
 * The offset and duration are measured in calendar months from the backtest
 * start, not in trading days, because that is how someone describes a plan —
 * "in ten years" means ten calendar years, whatever the exchange holidays did.
 */
export function resolveLeg(calendar: IsoDate[], leg: CashflowLeg): LegOccurrence[] {
  if (!calendar.length || leg.amount === 0) return [];

  const start = calendar[0];
  const firstDate = addMonths(start, Math.max(0, Math.round(leg.offsetMonths)));
  const firstIndex = indexOnOrAfter(calendar, firstDate);
  if (firstIndex < 0) return [];

  const endDate =
    leg.durationMonths != null && leg.durationMonths > 0
      ? addMonths(firstDate, Math.round(leg.durationMonths))
      : null;

  if (leg.frequency === 'once') {
    return [{ index: firstIndex, yearsSinceStart: 0 }];
  }

  const months = MONTHS_PER_PERIOD[leg.frequency];
  if (months == null) return [];

  // Boundaries are generated from the leg's own first date, so a leg offset by
  // seven months fires in that month's cadence rather than the backtest's.
  const tail = calendar.slice(firstIndex);
  const offsets = periodBoundaryIndices(tail, months);

  const occurrences: LegOccurrence[] = [
    { index: firstIndex, yearsSinceStart: 0 },
    ...offsets.map((o) => ({
      index: firstIndex + o,
      yearsSinceStart:
        (Date.parse(`${tail[o]}T00:00:00Z`) - Date.parse(`${tail[0]}T00:00:00Z`)) /
        (365.25 * 86_400_000),
    })),
  ];

  return endDate
    ? occurrences.filter((o) => calendar[o.index] < endDate)
    : occurrences;
}

export interface ResolvedSchedule {
  /** Calendar index → the legs firing on it, with their growth factor. */
  byIndex: Map<number, Array<{ leg: CashflowLeg; growth: number }>>;
}

export function resolveCashflows(
  calendar: IsoDate[],
  legs: CashflowLeg[],
): ResolvedSchedule {
  const byIndex = new Map<number, Array<{ leg: CashflowLeg; growth: number }>>();

  for (const leg of legs) {
    for (const occurrence of resolveLeg(calendar, leg)) {
      const growth =
        leg.annualGrowthPct === 0
          ? 1
          : Math.pow(1 + leg.annualGrowthPct / 100, occurrence.yearsSinceStart);
      const bucket = byIndex.get(occurrence.index);
      if (bucket) bucket.push({ leg, growth });
      else byIndex.set(occurrence.index, [{ leg, growth }]);
    }
  }

  return { byIndex };
}

/**
 * The signed cash amount a leg moves on one occurrence.
 * `portfolioValue` is only consulted for percentage legs.
 */
export function legAmount(
  leg: CashflowLeg,
  growth: number,
  deflatorAtDate: number,
  portfolioValue: number,
): number {
  if (leg.kind === 'percentOfPortfolio') {
    // A percentage rule is defined against the balance on the day, so neither
    // growth nor inflation applies — both are already in the balance.
    return portfolioValue * (leg.amount / 100);
  }
  const inflationFactor = leg.adjustForInflation ? deflatorAtDate : 1;
  return leg.amount * growth * inflationFactor;
}

export function describeLeg(leg: CashflowLeg): string {
  const direction = leg.amount >= 0 ? 'Contribute' : 'Withdraw';
  const size =
    leg.kind === 'percentOfPortfolio'
      ? `${Math.abs(leg.amount)}% of the balance`
      : `$${Math.abs(leg.amount).toLocaleString()}`;
  const cadence = leg.frequency === 'once' ? 'once' : leg.frequency;
  const start = leg.offsetMonths > 0 ? ` starting after ${leg.offsetMonths} months` : '';
  const until =
    leg.durationMonths != null && leg.durationMonths > 0
      ? ` for ${leg.durationMonths} months`
      : '';
  const growth = leg.annualGrowthPct !== 0 ? `, growing ${leg.annualGrowthPct}% a year` : '';
  const inflation = leg.adjustForInflation ? ', inflation-adjusted' : '';
  return `${direction} ${size} ${cadence}${start}${until}${growth}${inflation}`;
}
