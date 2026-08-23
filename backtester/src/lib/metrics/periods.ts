import type { IsoDate } from '@/lib/types';
import { chain } from './stats';

export type PeriodGranularity = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export interface PeriodReturn {
  /** `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-Www` depending on granularity. */
  key: string;
  year: number;
  /** 0–11 for monthly buckets; undefined for annual. */
  month?: number;
  return: number;
  startDate: IsoDate;
  endDate: IsoDate;
  /** True when the bucket does not cover the whole calendar period. */
  partial: boolean;
}

function bucket(
  dates: IsoDate[],
  returns: number[],
  keyOf: (d: IsoDate) => string,
): Map<string, { rs: number[]; start: IsoDate; end: IsoDate }> {
  const map = new Map<string, { rs: number[]; start: IsoDate; end: IsoDate }>();
  for (let i = 0; i < dates.length; i++) {
    const key = keyOf(dates[i]);
    const entry = map.get(key);
    if (entry) {
      entry.rs.push(returns[i]);
      entry.end = dates[i];
    } else {
      map.set(key, { rs: [returns[i]], start: dates[i], end: dates[i] });
    }
  }
  return map;
}

/**
 * Chains daily time-weighted returns into calendar-month buckets.
 *
 * The first day of the backtest is excluded from the chaining because its
 * "return" is the entry cost, not a market move; including it would make the
 * first month look different from the same month in a benchmark that started
 * with no entry cost.
 */
export function monthlyReturns(dates: IsoDate[], returns: number[]): PeriodReturn[] {
  const map = bucket(dates.slice(1), returns.slice(1), (d) => d.slice(0, 7));
  const out: PeriodReturn[] = [];
  const first = dates[1] ?? dates[0];
  const last = dates[dates.length - 1];

  for (const [key, v] of map) {
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7)) - 1;
    const startsMidMonth = key === first?.slice(0, 7) && Number(first.slice(8, 10)) > 5;
    const endsMidMonth =
      key === last?.slice(0, 7) && !isLikelyMonthEnd(last);
    out.push({
      key,
      year,
      month,
      return: chain(v.rs),
      startDate: v.start,
      endDate: v.end,
      partial: startsMidMonth || endsMidMonth,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function isLikelyMonthEnd(d: IsoDate): boolean {
  const day = Number(d.slice(8, 10));
  const daysInMonth = new Date(
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0),
  ).getUTCDate();
  // Within the last four calendar days covers month-end weekends and holidays.
  return day >= daysInMonth - 3;
}

export function annualReturns(dates: IsoDate[], returns: number[]): PeriodReturn[] {
  const map = bucket(dates.slice(1), returns.slice(1), (d) => d.slice(0, 4));
  const out: PeriodReturn[] = [];
  const first = dates[1] ?? dates[0];
  const last = dates[dates.length - 1];

  for (const [key, v] of map) {
    const year = Number(key);
    const startsMidYear = key === first?.slice(0, 4) && first.slice(5) > '01-08';
    const endsMidYear = key === last?.slice(0, 4) && last.slice(5) < '12-24';
    out.push({
      key,
      year,
      return: chain(v.rs),
      startDate: v.start,
      endDate: v.end,
      partial: startsMidYear || endsMidYear,
    });
  }
  return out.sort((a, b) => a.year - b.year);
}

export interface PeriodSummary {
  best: PeriodReturn | null;
  worst: PeriodReturn | null;
  average: number;
  median: number;
  positiveRate: number;
  count: number;
}

export function summarise(periods: PeriodReturn[]): PeriodSummary {
  if (!periods.length) {
    return { best: null, worst: null, average: 0, median: 0, positiveRate: 0, count: 0 };
  }
  const rs = periods.map((p) => p.return);
  const sorted = [...rs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    best: periods.reduce((a, b) => (b.return > a.return ? b : a)),
    worst: periods.reduce((a, b) => (b.return < a.return ? b : a)),
    average: rs.reduce((s, r) => s + r, 0) / rs.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    positiveRate: rs.filter((r) => r > 0).length / rs.length,
    count: rs.length,
  };
}


/* ------------------------------------------------------------------ */
/* Additional granularities                                            */
/* ------------------------------------------------------------------ */

/** ISO-8601 week key, `YYYY-Www`. Weeks start Monday and can straddle years. */
export function isoWeekKey(d: IsoDate): string {
  const date = new Date(`${d}T00:00:00.000Z`);
  // Shift to the Thursday of this week; the ISO year is that Thursday's year.
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function quarterKey(d: IsoDate): string {
  return `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
}

export function weeklyReturns(dates: IsoDate[], returns: number[]): PeriodReturn[] {
  const map = bucket(dates.slice(1), returns.slice(1), isoWeekKey);
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      year: Number(key.slice(0, 4)),
      return: chain(v.rs),
      startDate: v.start,
      endDate: v.end,
      // A week is partial when the backtest starts or ends inside it. Trading
      // holidays make a four-day week normal, so day count cannot decide this.
      partial: false,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function quarterlyReturns(dates: IsoDate[], returns: number[]): PeriodReturn[] {
  const map = bucket(dates.slice(1), returns.slice(1), quarterKey);
  const first = dates[1] ?? dates[0];
  const last = dates[dates.length - 1];

  return [...map.entries()]
    .map(([key, v]) => {
      const startsMid = key === quarterKey(first) && Number(first.slice(5, 7)) % 3 !== 1;
      const endsMid = key === quarterKey(last) && Number(last.slice(5, 7)) % 3 !== 0;
      return {
        key,
        year: Number(key.slice(0, 4)),
        return: chain(v.rs),
        startDate: v.start,
        endDate: v.end,
        partial: startsMid || endsMid,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Daily returns as period rows, for the raw table and CSV export. */
export function dailyReturns(dates: IsoDate[], returns: number[]): PeriodReturn[] {
  const out: PeriodReturn[] = [];
  for (let i = 1; i < dates.length; i++) {
    out.push({
      key: dates[i],
      year: Number(dates[i].slice(0, 4)),
      return: returns[i],
      startDate: dates[i],
      endDate: dates[i],
      partial: false,
    });
  }
  return out;
}
