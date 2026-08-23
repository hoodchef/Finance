import { describe, expect, it } from 'vitest';
import {
  computeCorrelationMatrix,
  isoWeekKey,
  quarterKey,
  quarterlyReturns,
  weeklyReturns,
} from '../src/lib/metrics';
import { makeCalendar } from './helpers';

describe('period keys', () => {
  it('computes ISO week numbers, including year boundaries', () => {
    expect(isoWeekKey('2021-01-04')).toBe('2021-W01'); // A Monday.
    expect(isoWeekKey('2021-01-10')).toBe('2021-W01'); // The Sunday after.
    expect(isoWeekKey('2021-01-11')).toBe('2021-W02');
    // 1 Jan 2021 was a Friday, so it belongs to the last ISO week of 2020.
    expect(isoWeekKey('2021-01-01')).toBe('2020-W53');
    // 31 Dec 2019 was a Tuesday, in the first ISO week of 2020.
    expect(isoWeekKey('2019-12-31')).toBe('2020-W01');
  });

  it('maps months to the right quarter', () => {
    expect(quarterKey('2021-01-15')).toBe('2021-Q1');
    expect(quarterKey('2021-03-31')).toBe('2021-Q1');
    expect(quarterKey('2021-04-01')).toBe('2021-Q2');
    expect(quarterKey('2021-12-31')).toBe('2021-Q4');
  });
});

describe('quarterly returns', () => {
  it('chains daily returns within a quarter', () => {
    const dates = ['2020-12-31', '2021-01-04', '2021-02-01', '2021-04-01'];
    const returns = [0, 0.1, 0.1, 0.05];
    const q = quarterlyReturns(dates, returns);
    expect(q.find((x) => x.key === '2021-Q1')!.return).toBeCloseTo(0.21, 12);
    expect(q.find((x) => x.key === '2021-Q2')!.return).toBeCloseTo(0.05, 12);
  });

  it('flags a quarter the backtest only partly covers', () => {
    // Starting in February means Q1 is incomplete.
    const dates = ['2021-02-01', '2021-02-15', '2021-03-01', '2021-04-01', '2021-06-30'];
    const q = quarterlyReturns(dates, [0, 0.01, 0.01, 0.01, 0.01]);
    expect(q.find((x) => x.key === '2021-Q1')!.partial).toBe(true);
    expect(q.find((x) => x.key === '2021-Q2')!.partial).toBe(false);
  });
});

describe('weekly returns', () => {
  it('buckets a calendar into weeks that each hold at most five trading days', () => {
    const cal = makeCalendar('2021-01-04', 40);
    const w = weeklyReturns(cal, new Array(cal.length).fill(0.001));
    expect(w.length).toBeGreaterThanOrEqual(8);
    expect(w[0].key).toMatch(/^\d{4}-W\d{2}$/);
    // Chaining eight weeks of the same daily return reproduces the total.
    const total = w.reduce((acc, p) => acc * (1 + p.return), 1) - 1;
    const expected = Math.pow(1.001, cal.length - 1) - 1;
    expect(total).toBeCloseTo(expected, 10);
  });
});

describe('correlation matrix', () => {
  const dates = makeCalendar('2020-01-01', 200);

  it('is 1 on the diagonal and symmetric off it', () => {
    const a = dates.map((_, i) => (i === 0 ? null : Math.sin(i / 5) * 0.01));
    const b = dates.map((_, i) => (i === 0 ? null : Math.cos(i / 7) * 0.01));
    const m = computeCorrelationMatrix(dates, [
      { symbol: 'A', returns: a },
      { symbol: 'B', returns: b },
    ], 252);

    expect(m.values[0][0]).toBe(1);
    expect(m.values[1][1]).toBe(1);
    expect(m.values[0][1]).toBeCloseTo(m.values[1][0], 12);
  });

  it('reports +1 for identical series and −1 for mirrored ones', () => {
    const a = dates.map((_, i) => (i === 0 ? null : Math.sin(i / 5) * 0.01));
    const same = [...a];
    const opposite = a.map((v) => (v == null ? null : -v));

    const m = computeCorrelationMatrix(dates, [
      { symbol: 'A', returns: a },
      { symbol: 'SAME', returns: same },
      { symbol: 'OPP', returns: opposite },
    ], 252);

    expect(m.values[0][1]).toBeCloseTo(1, 10);
    expect(m.values[0][2]).toBeCloseTo(-1, 10);
    expect(m.averageCorrelation).toBeCloseTo((1 - 1 - 1) / 3, 10);
  });

  it('uses only the days both series traded, and reports the overlap', () => {
    const a = dates.map((_, i) => (i === 0 ? null : 0.001));
    // B only has data for the second half.
    const b = dates.map((_, i) => (i < 100 ? null : 0.001));

    const m = computeCorrelationMatrix(dates, [
      { symbol: 'A', returns: a },
      { symbol: 'B', returns: b },
    ], 252);

    expect(m.overlap[0][1]).toBe(100);
    expect(m.overlap[0][0]).toBe(199);
  });

  it('annualises volatility on the diagonal', () => {
    const a = dates.map((_, i) => (i === 0 ? null : i % 2 === 0 ? 0.01 : -0.01));
    const m = computeCorrelationMatrix(dates, [{ symbol: 'A', returns: a }], 252);
    expect(m.volatility[0]).toBeCloseTo(0.01 * Math.sqrt(252), 3);
  });
});
