import { describe, expect, it } from 'vitest';
import {
  contributionIndices,
  monthEndIndices,
  periodBoundaryIndices,
  rebalanceIndices,
} from '../src/lib/engine/schedule';
import { addMonths, addYears, daysBetween, unixToIso, yearsBetween } from '../src/lib/market-data/dates';
import { makeCalendar } from './helpers';

describe('date arithmetic', () => {
  it('clamps month arithmetic to the end of a short month', () => {
    expect(addMonths('2021-01-31', 1)).toBe('2021-02-28');
    expect(addMonths('2020-01-31', 1)).toBe('2020-02-29'); // Leap year.
    expect(addMonths('2021-03-31', -1)).toBe('2021-02-28');
  });

  it('handles leap days in year arithmetic', () => {
    expect(addYears('2020-02-29', 1)).toBe('2021-02-28');
    expect(addYears('2020-02-29', 4)).toBe('2024-02-29');
  });

  it('counts calendar days and years', () => {
    expect(daysBetween('2020-01-01', '2021-01-01')).toBe(366);
    expect(yearsBetween('2020-01-01', '2021-01-01')).toBeCloseTo(366 / 365.25, 10);
  });

  it('maps a market-open unix timestamp to its exchange date', () => {
    // 2020-08-31 13:30 UTC — the NYSE open on that day.
    expect(unixToIso(1598880600)).toBe('2020-08-31');
  });
});

describe('rebalance schedule', () => {
  const cal = makeCalendar('2020-01-01', 520); // ~two years of weekdays.

  it('never rebalances on the first day', () => {
    for (const freq of ['monthly', 'quarterly', 'annual'] as const) {
      expect(rebalanceIndices(cal, freq).has(0)).toBe(false);
    }
  });

  it('fires on the first trading day of each new month', () => {
    const idx = [...rebalanceIndices(cal, 'monthly')].sort((a, b) => a - b);
    const dates = idx.map((i) => cal[i]);
    // 2020-01-01 is a Wednesday, so the calendar starts there; the first
    // rebalance is the first weekday of February.
    expect(dates[0]).toBe('2020-02-03');
    expect(dates[1]).toBe('2020-03-02');
    // Every fired date is the first calendar-listed day of its month.
    for (const d of dates) {
      const firstOfMonth = cal.find((c) => c.slice(0, 7) === d.slice(0, 7));
      expect(d).toBe(firstOfMonth);
    }
    // 24 months of data → 23 boundaries after the start.
    expect(dates.length).toBeGreaterThanOrEqual(23);
  });

  it('spaces quarterly and annual rebalances correctly', () => {
    const q = [...rebalanceIndices(cal, 'quarterly')].sort((a, b) => a - b).map((i) => cal[i]);
    expect(q[0]).toBe('2020-04-01');
    expect(q[1]).toBe('2020-07-01');

    const a = [...rebalanceIndices(cal, 'annual')].sort((x, y) => x - y).map((i) => cal[i]);
    expect(a[0]).toBe('2021-01-01');
    expect(a).toHaveLength(1);
  });

  it('emits nothing when rebalancing is off', () => {
    expect(rebalanceIndices(cal, 'never').size).toBe(0);
    expect(rebalanceIndices(cal, 'threshold').size).toBe(0);
  });

  it('does not double-fire after a long market closure', () => {
    // A calendar that skips all of February entirely.
    const sparse = ['2020-01-02', '2020-01-15', '2020-03-02', '2020-03-15', '2020-04-01'];
    const idx = periodBoundaryIndices(sparse, 1);
    // February's boundary is absorbed by the 2 March bar, not fired twice.
    expect(idx.map((i) => sparse[i])).toEqual(['2020-03-02', '2020-04-01']);
  });
});

describe('contribution schedule', () => {
  const cal = makeCalendar('2020-01-01', 300);

  it('matches the rebalance cadence for the same period length', () => {
    const contributions = [...contributionIndices(cal, 'monthly')].sort((a, b) => a - b);
    const rebalances = [...rebalanceIndices(cal, 'monthly')].sort((a, b) => a - b);
    expect(contributions).toEqual(rebalances);
  });

  it('emits nothing for "none"', () => {
    expect(contributionIndices(cal, 'none').size).toBe(0);
  });
});

describe('month ends', () => {
  it('marks the last trading day of each month', () => {
    const cal = makeCalendar('2020-01-01', 70);
    const ends = [...monthEndIndices(cal)].sort((a, b) => a - b).map((i) => cal[i]);
    expect(ends).toContain('2020-01-31'); // A Friday.
    expect(ends).toContain('2020-02-28'); // The last weekday of February 2020.
    // The final day of the calendar always counts, partial month or not.
    expect(ends[ends.length - 1]).toBe(cal[cal.length - 1]);
  });
});
