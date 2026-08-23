import { describe, expect, it } from 'vitest';
import {
  annualReturns,
  chain,
  computeMetrics,
  drawdownEpisodes,
  maxDrawdown,
  monthlyReturns,
  percentile,
  stdev,
  summarise,
  xirr,
} from '../src/lib/metrics';
import type { DailyRecord } from '../src/lib/engine/types';
import { makeCalendar } from './helpers';

/** Builds a daily record series from a list of period returns. */
function seriesFromReturns(start: string, returns: number[]): DailyRecord[] {
  const cal = makeCalendar(start, returns.length + 1);
  let index = 1;
  const out: DailyRecord[] = [
    {
      date: cal[0],
      totalValue: 100,
      cash: 0,
      positionValues: {},
      positionShares: {},
      netFlow: 100,
      dividendIncome: 0,
      feesPaid: 0,
      tradingCost: 0,
      twrReturn: 0,
      index: 1,
      hasStalePrice: false,
      rebalanced: false,
    },
  ];
  returns.forEach((r, i) => {
    index *= 1 + r;
    out.push({
      date: cal[i + 1],
      totalValue: 100 * index,
      cash: 0,
      positionValues: {},
      positionShares: {},
      netFlow: 0,
      dividendIncome: 0,
      feesPaid: 0,
      tradingCost: 0,
      twrReturn: r,
      index,
      hasStalePrice: false,
      rebalanced: false,
    });
  });
  return out;
}

describe('primitives', () => {
  it('computes a sample standard deviation', () => {
    // Population variance of [2,4,4,4,5,5,7,9] is 4; sample stdev is √(32/7).
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBeCloseTo(3, 12);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBeCloseTo(1, 12);
    expect(percentile([0, 10], 0.25)).toBeCloseTo(2.5, 12);
  });

  it('chains returns geometrically, not arithmetically', () => {
    // +50% then −50% is −25%, not 0%.
    expect(chain([0.5, -0.5])).toBeCloseTo(-0.25, 12);
  });
});

describe('drawdowns', () => {
  const index = [1, 1.2, 0.9, 1.0, 1.3, 1.1];
  const dates = makeCalendar('2020-01-01', index.length);

  it('finds the deepest peak-to-trough loss', () => {
    // 0.9 / 1.2 − 1 = −25%.
    expect(maxDrawdown(index)).toBeCloseTo(-0.25, 12);
  });

  it('identifies peak, trough and recovery dates', () => {
    const eps = drawdownEpisodes(dates, index);
    const worst = eps[0];
    expect(worst.depth).toBeCloseTo(-0.25, 12);
    expect(worst.peakDate).toBe(dates[1]);
    expect(worst.troughDate).toBe(dates[2]);
    expect(worst.recoveryDate).toBe(dates[4]); // First close back above 1.2.
    expect(worst.recovered).toBe(true);
  });

  it('reports an unrecovered drawdown as ongoing', () => {
    const eps = drawdownEpisodes(dates, index);
    const ongoing = eps.find((e) => !e.recovered)!;
    expect(ongoing.peakDate).toBe(dates[4]);
    expect(ongoing.recoveryDate).toBeNull();
    expect(ongoing.depth).toBeCloseTo(1.1 / 1.3 - 1, 12);
  });
});

describe('return metrics', () => {
  it('annualises a doubling over two years', () => {
    // 504 weekday returns ≈ two years; CAGR from the exact elapsed days.
    const perDay = Math.pow(2, 1 / 504) - 1;
    const daily = seriesFromReturns('2020-01-01', new Array(504).fill(perDay));
    const m = computeMetrics({ daily, periodsPerYear: 252, riskFree: new Array(505).fill(0) });

    expect(m.returns.totalReturn).toBeCloseTo(1, 8);
    const years = m.returns.years;
    expect(Math.pow(1 + m.returns.cagr, years)).toBeCloseTo(2, 6);
    expect(years).toBeGreaterThan(1.9);
    expect(years).toBeLessThan(2.1);
  });

  it('reports zero volatility for a perfectly steady return', () => {
    const daily = seriesFromReturns('2020-01-01', new Array(252).fill(0.0005));
    const m = computeMetrics({ daily, periodsPerYear: 252, riskFree: new Array(253).fill(0) });
    expect(m.risk.volatility).toBeCloseTo(0, 12);
    expect(m.risk.maxDrawdown).toBeCloseTo(0, 12);
    expect(m.ratios.calmar).toBe(0); // Undefined with no drawdown; reported as 0.
  });

  it('annualises volatility by the square root of the observed frequency', () => {
    const rs = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005, 0.015, -0.015];
    const daily = seriesFromReturns('2020-01-01', rs);
    const m = computeMetrics({ daily, periodsPerYear: 252, riskFree: new Array(rs.length + 1).fill(0) });
    expect(m.risk.volatility).toBeCloseTo(stdev(rs) * Math.sqrt(252), 10);
  });

  it('computes Sharpe from excess returns', () => {
    const rs = new Array(252).fill(0).map((_, i) => (i % 2 === 0 ? 0.002 : -0.001));
    const daily = seriesFromReturns('2020-01-01', rs);
    const zero = computeMetrics({ daily, periodsPerYear: 252, riskFree: new Array(253).fill(0) });
    const withRf = computeMetrics({ daily, periodsPerYear: 252, riskFree: new Array(253).fill(0.05) });
    // A positive risk-free rate can only reduce the Sharpe ratio.
    expect(withRf.ratios.sharpe).toBeLessThan(zero.ratios.sharpe);
  });

  it('penalises downside-only volatility in Sortino but not upside', () => {
    const upsideHeavy = new Array(200).fill(0).map((_, i) => (i % 10 === 0 ? 0.05 : 0.0));
    const downsideHeavy = new Array(200).fill(0).map((_, i) => (i % 10 === 0 ? -0.05 : 0.0));
    const rf = new Array(201).fill(0);
    const up = computeMetrics({ daily: seriesFromReturns('2020-01-01', upsideHeavy), periodsPerYear: 252, riskFree: rf });
    const down = computeMetrics({ daily: seriesFromReturns('2020-01-01', downsideHeavy), periodsPerYear: 252, riskFree: rf });

    expect(up.risk.downsideDeviation).toBeCloseTo(0, 12);
    expect(down.risk.downsideDeviation).toBeGreaterThan(0);
    // Both have identical total volatility, so Sortino separates them and
    // Sharpe does not.
    expect(up.risk.volatility).toBeCloseTo(down.risk.volatility, 10);
  });

  it('computes beta and correlation against a benchmark', () => {
    const bench = new Array(200).fill(0).map((_, i) => Math.sin(i) * 0.01);
    const port = bench.map((b) => b * 2); // Exactly twice the benchmark.
    const rf = new Array(201).fill(0);
    const m = computeMetrics({
      daily: seriesFromReturns('2020-01-01', port),
      periodsPerYear: 252,
      riskFree: rf,
      benchmarkReturns: seriesFromReturns('2020-01-01', bench).map((d) => d.twrReturn),
    });
    expect(m.ratios.beta).toBeCloseTo(2, 6);
    expect(m.ratios.correlation).toBeCloseTo(1, 6);
    expect(m.ratios.rSquared).toBeCloseTo(1, 6);
  });
});

describe('period bucketing', () => {
  it('chains daily returns into calendar months', () => {
    // Jan 2021: two trading days at +10% each → 21%.
    const dates = ['2020-12-31', '2021-01-04', '2021-01-05', '2021-02-01'];
    const returns = [0, 0.1, 0.1, 0.05];
    const months = monthlyReturns(dates, returns);
    const jan = months.find((m) => m.key === '2021-01')!;
    expect(jan.return).toBeCloseTo(0.21, 12);
    const feb = months.find((m) => m.key === '2021-02')!;
    expect(feb.return).toBeCloseTo(0.05, 12);
  });

  it('chains daily returns into calendar years and flags partial ones', () => {
    const dates = ['2020-06-01', '2020-07-01', '2021-01-04', '2021-12-31'];
    const returns = [0, 0.1, 0.2, 0.3];
    const years = annualReturns(dates, returns);
    expect(years.find((y) => y.year === 2020)!.return).toBeCloseTo(0.1, 12);
    expect(years.find((y) => y.year === 2020)!.partial).toBe(true);
    expect(years.find((y) => y.year === 2021)!.return).toBeCloseTo(1.2 * 1.3 - 1, 12);
    expect(years.find((y) => y.year === 2021)!.partial).toBe(false);
  });

  it('summarises best, worst, median and hit rate', () => {
    const periods = [0.1, -0.2, 0.3, 0.05].map((r, i) => ({
      key: String(2020 + i),
      year: 2020 + i,
      return: r,
      startDate: '2020-01-01',
      endDate: '2020-12-31',
      partial: false,
    }));
    const s = summarise(periods);
    expect(s.best!.return).toBeCloseTo(0.3, 12);
    expect(s.worst!.return).toBeCloseTo(-0.2, 12);
    expect(s.positiveRate).toBeCloseTo(0.75, 12);
    expect(s.median).toBeCloseTo(0.075, 12);
  });
});

describe('money-weighted return', () => {
  it('solves a single-period IRR', () => {
    const r = xirr([
      { date: '2020-01-01', amount: -1000 },
      { date: '2021-01-01', amount: 1100 },
    ]);
    // 366 days elapsed in 2020, discounted on a 365-day year.
    expect(r).toBeCloseTo(Math.pow(1.1, 365 / 366) - 1, 6);
  });

  it('accounts for the timing of later contributions', () => {
    // Both runs end at the same value, but the second front-loads its money,
    // so its money-weighted return must be lower.
    const early = xirr([
      { date: '2020-01-01', amount: -1000 },
      { date: '2020-02-01', amount: -1000 },
      { date: '2021-01-01', amount: 2400 },
    ])!;
    const late = xirr([
      { date: '2020-01-01', amount: -1000 },
      { date: '2020-11-01', amount: -1000 },
      { date: '2021-01-01', amount: 2400 },
    ])!;
    expect(late).toBeGreaterThan(early);
  });

  it('returns null when the flows never change sign', () => {
    expect(
      xirr([
        { date: '2020-01-01', amount: -100 },
        { date: '2021-01-01', amount: -100 },
      ]),
    ).toBeNull();
  });
});
