import { describe, expect, it } from 'vitest';
import {
  alignSeries,
  correlationMatrix,
  InsufficientHistoryError,
  logReturns,
  MINIMUM_OBSERVATIONS,
  periodsPerYear,
  realizedVolatility,
  volatilities,
  type DatedClose,
} from '../src/lib/lattice/realized';

/**
 * Measured inputs, against arithmetic done by hand.
 * =============================================================================
 * These decide whether the pictures on the lab mean anything, so they are
 * checked against constructed series whose answer is known in advance rather
 * than against recorded output.
 */

/** A series with a constant daily log return, so its volatility is zero. */
function steady(days: number, start = 100, growth = 1.001): DatedClose[] {
  const out: DatedClose[] = [];
  let close = start;
  for (let i = 0; i < days; i++) {
    out.push({ date: isoDay(i), close });
    close *= growth;
  }
  return out;
}

/** Consecutive weekdays, so the median gap is one day. */
function isoDay(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function isoWeek(i: number): string {
  return new Date(Date.UTC(2024, 0, 1) + i * 7 * 86_400_000).toISOString().slice(0, 10);
}

describe('log returns', () => {
  it('are the log of successive ratios', () => {
    expect(logReturns([100, 110])).toHaveLength(1);
    expect(logReturns([100, 110])[0]).toBeCloseTo(Math.log(1.1), 12);
  });

  it('skip non-positive closes rather than producing NaN', () => {
    expect(logReturns([100, 0, 110])).toHaveLength(0);
    expect(logReturns([100])).toHaveLength(0);
  });
});

describe('realized volatility', () => {
  it('is zero for a perfectly steady compounding series', () => {
    // Every log return identical, so the standard deviation is zero.
    expect(realizedVolatility(steady(120))).toBeCloseTo(0, 12);
  });

  it('scales by the square root of the observed frequency', () => {
    /*
     * The same per-period deviation on a daily and a weekly calendar must NOT
     * annualise the same. Applying the daily factor to weekly data overstates
     * volatility by sqrt(252/52) = 2.2 — the exact error that once produced a
     * 7.22% reading in this codebase where the truth was 15.73%.
     */
    const pattern = (i: number) => 100 * Math.exp(i % 2 === 0 ? 0.01 : -0.01);
    const daily = Array.from({ length: 120 }, (_, i) => ({ date: isoDay(i), close: pattern(i) }));
    const weekly = Array.from({ length: 120 }, (_, i) => ({ date: isoWeek(i), close: pattern(i) }));

    const ratio = realizedVolatility(daily) / realizedVolatility(weekly);
    expect(ratio).toBeCloseTo(Math.sqrt(252 / 52), 6);
  });

  it('reproduces a known standard deviation', () => {
    // Alternating +1%/-1% log returns: mean 0, sample sd ~= 0.01 (with the
    // n-1 correction over 119 returns), annualised by sqrt(252).
    const closes = Array.from({ length: 120 }, (_, i) => ({
      date: isoDay(i),
      close: 100 * Math.exp(i % 2 === 0 ? 0.01 : -0.01),
    }));
    const v = realizedVolatility(closes);
    expect(v).toBeGreaterThan(0.01 * Math.sqrt(252) * 0.98);
    expect(v).toBeLessThan(0.01 * Math.sqrt(252) * 1.02 * 2);
  });

  it('refuses a series too short to estimate from', () => {
    expect(() => realizedVolatility(steady(5))).toThrow(InsufficientHistoryError);
    expect(() => realizedVolatility(steady(MINIMUM_OBSERVATIONS - 1))).toThrow(
      /cannot support a volatility estimate/,
    );
  });
});

describe('observed frequency', () => {
  it('reads a daily calendar as 252', () => {
    expect(periodsPerYear(steady(60))).toBe(252);
  });

  it('reads a weekly calendar as 52', () => {
    const weekly = Array.from({ length: 60 }, (_, i) => ({ date: isoWeek(i), close: 100 + i }));
    expect(periodsPerYear(weekly)).toBe(52);
  });

  it('reads a monthly calendar as 12', () => {
    const monthly = Array.from({ length: 40 }, (_, i) => ({
      date: new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 10),
      close: 100 + i,
    }));
    expect(periodsPerYear(monthly)).toBe(12);
  });

  it('uses the median, so one long gap does not reclassify the series', () => {
    // A daily series with a single three-month outage is still daily.
    const s = steady(90);
    s[45] = { date: '2024-09-01', close: s[45].close };
    expect(periodsPerYear(s)).toBe(252);
  });
});

describe('aligning several series', () => {
  const a: DatedClose[] = Array.from({ length: 80 }, (_, i) => ({ date: isoDay(i), close: 100 + i }));

  it('keeps only the dates every symbol traded', () => {
    // B is missing two days A has.
    const b = a.filter((_, i) => i !== 10 && i !== 20);
    const aligned = alignSeries({ A: a, B: b });
    expect(aligned.dates).toHaveLength(78);
    expect(aligned.dates).not.toContain(isoDay(10));
    // Returns are one shorter than the dates they came from.
    for (const r of aligned.returns) expect(r).toHaveLength(77);
  });

  it('refuses when the overlap is too small to mean anything', () => {
    // A correlation from eleven shared days is not a correlation.
    const short = a.slice(0, 12);
    expect(() => alignSeries({ A: a, B: short })).toThrow(InsufficientHistoryError);
    expect(() => alignSeries({ A: a, B: short })).toThrow(/share only 12 trading days/);
  });

  it('handles an empty request without throwing', () => {
    expect(alignSeries({})).toEqual({ symbols: [], dates: [], returns: [] });
  });
});

describe('correlation', () => {
  const days = 200;
  const dates = Array.from({ length: days }, (_, i) => isoDay(i));

  /** Builds a close series from a list of log returns. */
  const fromReturns = (rs: number[]): DatedClose[] => {
    let c = 100;
    return [{ date: dates[0], close: c }].concat(
      rs.map((r, i) => {
        c *= Math.exp(r);
        return { date: dates[i + 1], close: c };
      }),
    );
  };

  const base = Array.from({ length: days - 1 }, (_, i) => Math.sin(i * 0.7) * 0.01);

  it('is exactly one against itself', () => {
    const aligned = alignSeries({ A: fromReturns(base), B: fromReturns(base) });
    const m = correlationMatrix(aligned);
    expect(m[0][0]).toBe(1);
    expect(m[0][1]).toBeCloseTo(1, 9);
  });

  it('is exactly minus one against its mirror', () => {
    const aligned = alignSeries({
      A: fromReturns(base),
      B: fromReturns(base.map((r) => -r)),
    });
    expect(correlationMatrix(aligned)[0][1]).toBeCloseTo(-1, 9);
  });

  it('is symmetric with ones down the diagonal', () => {
    const aligned = alignSeries({
      A: fromReturns(base),
      B: fromReturns(base.map((r, i) => r * 0.5 + Math.cos(i * 0.3) * 0.004)),
      C: fromReturns(base.map((r, i) => Math.cos(i * 1.1) * 0.008)),
    });
    const m = correlationMatrix(aligned);
    for (let i = 0; i < 3; i++) {
      expect(m[i][i]).toBe(1);
      for (let j = 0; j < 3; j++) expect(m[i][j]).toBeCloseTo(m[j][i], 12);
    }
  });

  it('stays inside minus one and one', () => {
    const aligned = alignSeries({
      A: fromReturns(base),
      B: fromReturns(base.map((r) => r * 3)),
    });
    const m = correlationMatrix(aligned);
    expect(m[0][1]).toBeLessThanOrEqual(1);
    expect(m[0][1]).toBeGreaterThanOrEqual(-1);
  });

  it('gives a motionless series zero, not NaN', () => {
    // Dividing by its zero deviation would poison every chart downstream.
    const flat = dates.map((date) => ({ date, close: 100 }));
    const m = correlationMatrix(alignSeries({ A: fromReturns(base), FLAT: flat }));
    expect(Number.isNaN(m[0][1])).toBe(false);
    expect(m[0][1]).toBe(0);
  });
});

describe('per-symbol volatility from one aligned window', () => {
  it('scales with the size of the moves', () => {
    const dates = Array.from({ length: 120 }, (_, i) => isoDay(i));
    const build = (amp: number) => {
      let c = 100;
      return dates.map((date, i) => {
        if (i > 0) c *= Math.exp(i % 2 === 0 ? amp : -amp);
        return { date, close: c };
      });
    };
    const aligned = alignSeries({ CALM: build(0.002), WILD: build(0.02) });
    const [calm, wild] = volatilities(aligned, 252);
    expect(wild / calm).toBeCloseTo(10, 1);
  });
});
