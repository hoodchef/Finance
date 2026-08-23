import type { IsoDate } from '@/lib/types';

const MS_PER_DAY = 86_400_000;

/** `Date` → `YYYY-MM-DD`, always in UTC so there is no timezone drift. */
export function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → UTC midnight `Date`. */
export function fromIso(s: IsoDate): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

export function isValidIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(fromIso(s).getTime());
}

export function toUnixSeconds(s: IsoDate): number {
  return Math.floor(fromIso(s).getTime() / 1000);
}

/**
 * Yahoo timestamps a daily bar at the exchange's market-open instant in UTC,
 * which for US exchanges is 13:30/14:30 UTC — i.e. always the same calendar day
 * in UTC. Truncating to the UTC date is therefore correct for US listings.
 */
export function unixToIso(seconds: number): IsoDate {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function addDays(s: IsoDate, n: number): IsoDate {
  return toIso(new Date(fromIso(s).getTime() + n * MS_PER_DAY));
}

export function addMonths(s: IsoDate, n: number): IsoDate {
  const d = fromIso(s);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  // Clamp to the last day of the target month (31 Jan + 1 month → 28/29 Feb).
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

export function addYears(s: IsoDate, n: number): IsoDate {
  return addMonths(s, n * 12);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((fromIso(b).getTime() - fromIso(a).getTime()) / MS_PER_DAY);
}

export function yearsBetween(a: IsoDate, b: IsoDate): number {
  return daysBetween(a, b) / 365.25;
}

export function year(s: IsoDate): number {
  return Number(s.slice(0, 4));
}

/** `YYYY-MM` bucket key. */
export function monthKey(s: IsoDate): string {
  return s.slice(0, 7);
}

export function monthIndex(s: IsoDate): number {
  return Number(s.slice(5, 7)) - 1;
}

export function maxIso(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function minIso(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function todayIso(): IsoDate {
  return toIso(new Date());
}
