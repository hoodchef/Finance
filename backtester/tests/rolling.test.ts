import { describe, expect, it } from 'vitest';
import { computeAllRolling, computeRolling } from '../src/lib/metrics/rolling';
import { makeCalendar } from './helpers';

/**
 * The rolling maths is arithmetic on an index, so the expected values here are
 * exact rather than approximate.
 */

/**
 * `makeCalendar` emits weekdays with no holidays, so a calendar year contains
 * 365.25 x 5/7 of them. Building the fixture on 252 would mean the series grew
 * at a different rate per calendar year than the one being asserted — the
 * windows are measured in calendar time, so the fixture must be too.
 */
const WEEKDAYS_PER_YEAR = (365.25 * 5) / 7;

/** A perfectly steady `annual`-per-calendar-year index over `days` weekdays. */
function steady(days: number, annual: number, ppy = WEEKDAYS_PER_YEAR) {
  const dates = makeCalendar('2000-01-03', days);
  const perDay = Math.pow(1 + annual, 1 / ppy) - 1;
  const index = [1];
  const returns: number[] = [];
  for (let i = 1; i < days; i++) {
    returns.push(perDay);
    index.push(index[i - 1] * (1 + perDay));
  }
  return { dates, index, returns };
}

describe('rolling windows', () => {
  it('recovers a constant growth rate in every window', () => {
    const { dates, index, returns } = steady(252 * 6, 0.08);
    const r = computeRolling(dates, index, returns, 3, WEEKDAYS_PER_YEAR)!;

    expect(r).not.toBeNull();
    expect(r.years).toBe(3);
    expect(r.summary.count).toBeGreaterThan(100);
    // Every window of a constant-growth series must annualise to the same rate.
    expect(r.summary.min).toBeCloseTo(0.08, 3);
    expect(r.summary.max).toBeCloseTo(0.08, 3);
    expect(r.summary.median).toBeCloseTo(0.08, 3);
    expect(r.summary.negativeRate).toBe(0);
    expect(r.summary.p5).toBeCloseTo(r.summary.p95, 3);
  });

  it('reports zero volatility and no drawdown for a monotonic index', () => {
    const { dates, index, returns } = steady(252 * 4, 0.06);
    const r = computeRolling(dates, index, returns, 2, WEEKDAYS_PER_YEAR)!;
    for (const p of r.points) {
      expect(p.volatility).toBeCloseTo(0, 8);
      expect(p.maxDrawdown ?? 0).toBeCloseTo(0, 10);
    }
  });

  it('returns null when the window is longer than the history', () => {
    const { dates, index, returns } = steady(252 * 2, 0.05);
    expect(computeRolling(dates, index, returns, 10, WEEKDAYS_PER_YEAR)).toBeNull();
  });

  it('separates a good era from a bad one', () => {
    // Three years up 20%/yr, then three years down 20%/yr.
    const days = 252 * 6;
    const dates = makeCalendar('2000-01-03', days);
    const up = Math.pow(1.2, 1 / WEEKDAYS_PER_YEAR) - 1;
    const down = Math.pow(0.8, 1 / WEEKDAYS_PER_YEAR) - 1;
    const index = [1];
    const returns: number[] = [];
    for (let i = 1; i < days; i++) {
      const r = i < days / 2 ? up : down;
      returns.push(r);
      index.push(index[i - 1] * (1 + r));
    }

    const r = computeRolling(dates, index, returns, 1, WEEKDAYS_PER_YEAR)!;
    // The best window sits in the rally, the worst in the decline.
    expect(r.summary.max).toBeCloseTo(0.2, 2);
    expect(r.summary.min).toBeCloseTo(-0.2, 2);
    expect(r.summary.bestWindow!.startDate < r.summary.worstWindow!.startDate).toBe(true);
    expect(r.summary.negativeRate).toBeGreaterThan(0.3);
    expect(r.summary.negativeRate).toBeLessThan(0.7);
  });

  it('measures drawdown inside the window, not across the whole series', () => {
    // A single 30% crash halfway through.
    const days = 252 * 4;
    const dates = makeCalendar('2000-01-03', days);
    const crashAt = Math.floor(days / 2);
    const index: number[] = [1];
    const returns: number[] = [];
    for (let i = 1; i < days; i++) {
      const r = i === crashAt ? -0.3 : 0;
      returns.push(r);
      index.push(index[i - 1] * (1 + r));
    }
    const r = computeRolling(dates, index, returns, 1, WEEKDAYS_PER_YEAR)!;
    // Every point here is measured; the skip threshold is far above this size.
    expect(r.points.every((p) => p.maxDrawdown != null)).toBe(true);
    const touching = r.points.filter((p) => (p.maxDrawdown ?? 0) < -0.01);
    const clean = r.points.filter((p) => (p.maxDrawdown ?? 0) >= -1e-9);
    // Windows containing the crash see it; windows entirely after it do not.
    expect(touching.length).toBeGreaterThan(0);
    expect(clean.length).toBeGreaterThan(0);
    for (const p of touching) expect(p.maxDrawdown!).toBeCloseTo(-0.3, 6);
  });

  it('orders percentiles and keeps the summary consistent', () => {
    const days = 252 * 8;
    const dates = makeCalendar('2000-01-03', days);
    const index = [1];
    const returns: number[] = [];
    for (let i = 1; i < days; i++) {
      const r = Math.sin(i / 37) * 0.01 + 0.0003;
      returns.push(r);
      index.push(index[i - 1] * (1 + r));
    }
    const r = computeRolling(dates, index, returns, 3, WEEKDAYS_PER_YEAR)!;
    const s = r.summary;
    expect(s.min).toBeLessThanOrEqual(s.p5);
    expect(s.p5).toBeLessThanOrEqual(s.p25);
    expect(s.p25).toBeLessThanOrEqual(s.median);
    expect(s.median).toBeLessThanOrEqual(s.p75);
    expect(s.p75).toBeLessThanOrEqual(s.p95);
    expect(s.p95).toBeLessThanOrEqual(s.max);
    expect(s.worstWindow!.annualised).toBeCloseTo(s.min, 10);
    expect(s.bestWindow!.annualised).toBeCloseTo(s.max, 10);
  });

  it('emits only the window lengths the data supports', () => {
    const { dates, index, returns } = steady(252 * 6, 0.07);
    const all = computeAllRolling(dates, index, returns, WEEKDAYS_PER_YEAR);
    const years = all.map((r) => r.years);
    expect(years).toContain(1);
    expect(years).toContain(5);
    expect(years).not.toContain(10);
    expect(years).not.toContain(20);
  });
});
