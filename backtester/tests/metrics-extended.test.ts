import { describe, expect, it } from 'vitest';
import {
  adjustedSortino,
  commonSenseRatio,
  conditionalValueAtRisk,
  expectedReturns,
  extremes,
  gainToPain,
  kellyCriterion,
  omega,
  outlierLossRatio,
  outlierWinRatio,
  payoffRatio,
  probabilisticSharpe,
  profitFactor,
  recoveryFactor,
  riskAdjustedReturn,
  riskOfRuin,
  serenityIndex,
  smartFactor,
  smartRatio,
  streaks,
  tailRatio,
  trailingReturns,
  ulcerIndex,
  ulcerPerformanceIndex,
  valueAtRisk,
  winRate,
} from '../src/lib/metrics/extended';
import type { PeriodReturn } from '../src/lib/metrics/periods';

/**
 * Extended metrics, against arithmetic worked by hand.
 * =============================================================================
 * Almost every ratio here has more than one definition in circulation, so a
 * test that only pinned recorded output would lock in whichever one happened
 * to get written. These check the arithmetic itself on series small enough to
 * compute on paper, and check the degenerate cases — which is where these
 * functions actually break, by returning Infinity into a sortable column.
 */

const p = (key: string, ret: number): PeriodReturn =>
  ({ key, year: Number(key.slice(0, 4)) || 0, return: ret, startDate: '2024-01-01',
     endDate: '2024-12-31', partial: false }) as PeriodReturn;

describe('gain and loss ratios', () => {
  // +3, +1, −2, −2: gains 4, losses 4.
  const rs = [0.03, 0.01, -0.02, -0.02];

  it('computes omega as excess gains over excess losses', () => {
    expect(omega(rs, 0)).toBeCloseTo(4 / 4, 12);
    // Lifting the threshold to 1% moves 1 unit from the gain side to the loss
    // side and shrinks the other gain: gains 2, losses 3+1+... worked by hand.
    const gains = 0.03 - 0.01;
    const pains = 0.01 - -0.02 + (0.01 - -0.02);
    expect(omega(rs, 0.01)).toBeCloseTo(gains / pains, 12);
  });

  it('computes gain-to-pain and profit factor identically', () => {
    expect(gainToPain(rs)).toBeCloseTo(1, 12);
    expect(profitFactor(rs)).toBe(gainToPain(rs));
  });

  it('separates payoff ratio from profit factor', () => {
    // Rare huge wins: totals equal, averages very different.
    const rare = [0.12, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02];
    expect(profitFactor(rare)).toBeCloseTo(0.12 / 0.12, 12);
    // One win of 12% against an average loss of 2%.
    expect(payoffRatio(rare)).toBeCloseTo(0.12 / 0.02, 12);
  });

  it('returns null rather than Infinity when there are no losses', () => {
    // Sorted into a table, an Infinity ranks first forever.
    expect(omega([0.01, 0.02])).toBeNull();
    expect(gainToPain([0.01, 0.02])).toBeNull();
    expect(payoffRatio([0.01, 0.02])).toBeNull();
    expect(kellyCriterion([0.01, 0.02])).toBeNull();
  });

  it('measures the tail ratio as right against left', () => {
    const symmetric = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(tailRatio(symmetric)!).toBeCloseTo(1, 6);

    // A fat right tail must score above one. Enough of them to actually move
    // the 95th percentile — three in a hundred leaves it in the left half.
    const rightFat = [
      ...Array.from({ length: 90 }, () => -0.01),
      ...Array.from({ length: 10 }, () => 0.2),
    ];
    expect(tailRatio(rightFat)!).toBeGreaterThan(1);
  });

  it('multiplies profit factor by tail ratio for the common sense ratio', () => {
    const rs2 = [0.05, 0.02, -0.01, -0.03, 0.04, -0.02, 0.01, -0.01];
    const expected = profitFactor(rs2)! * tailRatio(rs2)!;
    expect(commonSenseRatio(rs2)).toBeCloseTo(expected, 12);
  });

  it('flags an average carried by a few outliers', () => {
    const lumpy = [...Array.from({ length: 60 }, () => 0.001), 0.4];
    // The 99th percentile win is far above the mean win.
    expect(outlierWinRatio(lumpy)!).toBeGreaterThan(5);
    const even = Array.from({ length: 60 }, () => 0.01);
    expect(outlierWinRatio(even)!).toBeCloseTo(1, 6);
  });

  it('measures outlier losses on the same basis', () => {
    const lumpy = [...Array.from({ length: 60 }, () => -0.001), -0.4];
    expect(outlierLossRatio(lumpy)!).toBeGreaterThan(5);
  });
});

describe('drawdown-based measures', () => {
  const dd = (v: number) => ({ date: '2024-01-01', drawdown: v, underwater: v < 0 }) as never;

  it('computes the ulcer index as a root mean square', () => {
    // Two periods at −10% and two flat: sqrt(mean(0.01,0.01,0,0)) = 0.0707.
    const series = [dd(-0.1), dd(-0.1), dd(0), dd(0)];
    expect(ulcerIndex(series)).toBeCloseTo(Math.sqrt(0.02 / 4), 12);
  });

  it('penalises one deep hole more than steady chop of equal mean depth', () => {
    // Squaring is the point: 40% once hurts more than 10% four times, even
    // though the average depth is the same.
    const deep = [dd(-0.4), dd(0), dd(0), dd(0)];
    const chop = [dd(-0.1), dd(-0.1), dd(-0.1), dd(-0.1)];
    expect(ulcerIndex(deep)).toBeGreaterThan(ulcerIndex(chop));
  });

  it('is zero when never under water', () => {
    expect(ulcerIndex([dd(0), dd(0)])).toBe(0);
    expect(ulcerIndex([])).toBe(0);
  });

  it('computes the ulcer performance index as excess return over ulcer', () => {
    expect(ulcerPerformanceIndex(0.12, 0.02, 0.05)).toBeCloseTo(2, 12);
    // No ulcer means no ratio, not an infinite one.
    expect(ulcerPerformanceIndex(0.12, 0.02, 0)).toBeNull();
  });

  it('puts serenity below UPI when the left tail is fat', () => {
    // Ordinary dispersion plus a severe tail. The series needs a real spread
    // or the 5th percentile sits above zero and cVaR collapses onto the mean.
    const fatTail = [
      ...Array.from({ length: 96 }, (_, i) => Math.sin(i * 2.399) * 0.01),
      -0.25,
      -0.3,
      -0.35,
      -0.4,
    ];
    const s = serenityIndex(0.1, 0.02, 0.05, fatTail);
    const upi = ulcerPerformanceIndex(0.1, 0.02, 0.05)!;
    expect(s).not.toBeNull();
    expect(s!).toBeLessThan(upi);
  });

  it('computes the recovery factor and refuses a zero drawdown', () => {
    expect(recoveryFactor(0.5, -0.25)).toBeCloseTo(2, 12);
    expect(recoveryFactor(0.5, 0)).toBeNull();
  });

  it('divides return by exposure for risk-adjusted return', () => {
    // Half the time in the market for the same growth is a different result.
    expect(riskAdjustedReturn(0.08, 0.5)).toBeCloseTo(0.16, 12);
    expect(riskAdjustedReturn(0.08, 0)).toBeNull();
  });
});

describe('value at risk', () => {
  // 100 returns: −0.05 through 0.94 in 1% steps, so percentiles are exact.
  const rs = Array.from({ length: 100 }, (_, i) => (i - 5) / 100);

  it('reads VaR from the historical distribution', () => {
    const v = valueAtRisk(rs, 0.95);
    expect(v).toBeLessThan(0);
    // Roughly the 5th percentile of the sample.
    expect(v).toBeCloseTo(-0.005, 2);
  });

  it('makes cVaR the average beyond VaR, not the threshold', () => {
    // The distinction is the whole point: cVaR must be the worse number.
    const v = valueAtRisk(rs, 0.95);
    const c = conditionalValueAtRisk(rs, 0.95);
    expect(c).toBeLessThanOrEqual(v);
  });

  it('returns zero for an empty series rather than NaN', () => {
    expect(valueAtRisk([], 0.95)).toBe(0);
    expect(conditionalValueAtRisk([], 0.95)).toBe(0);
  });
});

describe('Kelly and ruin', () => {
  it('computes Kelly as W − (1−W)/R', () => {
    // Six wins of 2%, four losses of 1%: W = 0.6, R = 2, f = 0.6 − 0.4/2 = 0.4.
    const rs = [...Array(6).fill(0.02), ...Array(4).fill(-0.01)];
    expect(kellyCriterion(rs)).toBeCloseTo(0.4, 12);
  });

  it('goes negative when the edge is against you', () => {
    // Three wins of 1%, seven losses of 1%: W = 0.3, R = 1, f = 0.3 − 0.7 = −0.4.
    const rs = [...Array(3).fill(0.01), ...Array(7).fill(-0.01)];
    expect(kellyCriterion(rs)).toBeCloseTo(-0.4, 12);
  });

  it('reports certain ruin without an edge', () => {
    const even = [...Array(5).fill(0.01), ...Array(5).fill(-0.01)];
    expect(riskOfRuin(even)).toBe(1);
  });

  it('falls as the edge grows', () => {
    const weak = [...Array(6).fill(0.01), ...Array(4).fill(-0.01)];
    const strong = [...Array(8).fill(0.01), ...Array(2).fill(-0.01)];
    expect(riskOfRuin(strong)!).toBeLessThan(riskOfRuin(weak)!);
  });
});

describe('the Sharpe family', () => {
  it('puts adjusted Sortino on the Sharpe scale', () => {
    // Sortino uses only downside deviation and is therefore systematically
    // larger; dividing by root two makes the two comparable.
    expect(adjustedSortino(1.414213562)).toBeCloseTo(1, 6);
  });

  it('reads a probabilistic Sharpe as a probability', () => {
    const psr = probabilisticSharpe(1.5, 500, 0, 0);
    expect(psr).not.toBeNull();
    expect(psr!).toBeGreaterThan(0.9);
    expect(psr!).toBeLessThanOrEqual(1);
  });

  it('is less confident about the same Sharpe from fewer observations', () => {
    // The honest reading of a Sharpe ratio: 2.0 from forty points is a weaker
    // claim than 1.2 from a thousand, and the plain figure cannot say so.
    const few = probabilisticSharpe(2, 40, 0, 0)!;
    const many = probabilisticSharpe(1.2, 1000, 0, 0)!;
    expect(many).toBeGreaterThan(few);
  });

  it('is less confident when returns are negatively skewed', () => {
    // A smaller sample, so neither figure saturates at 1 and the effect shows.
    const symmetric = probabilisticSharpe(0.5, 60, 0, 0)!;
    const skewed = probabilisticSharpe(0.5, 60, -1.5, 3)!;
    expect(skewed).toBeLessThan(symmetric);
  });

  it('never rewards autocorrelation', () => {
    // The penalty may make a ratio worse, never better.
    const random = Array.from({ length: 300 }, (_, i) => Math.sin(i * 2.399) * 0.01);
    expect(smartFactor(random)).toBeGreaterThanOrEqual(1);

    const trending = Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.05) * 0.01);
    expect(smartFactor(trending)).toBeGreaterThan(1);
    expect(smartRatio(2, trending)).toBeLessThan(2);
  });

  it('leaves a short series unpenalised rather than guessing', () => {
    expect(smartFactor([0.01, -0.01])).toBe(1);
  });
});

describe('streaks and win rates', () => {
  it('counts the longest runs', () => {
    const rs = [0.01, 0.01, 0.01, -0.01, -0.01, 0.01];
    const s = streaks(rs);
    expect(s.longestWin).toBe(3);
    expect(s.longestLoss).toBe(2);
    expect(s.currentWin).toBe(1);
    expect(s.currentLoss).toBe(0);
  });

  it('lets a flat period break both runs', () => {
    // Zero is neither a win nor a loss; counting it as either inflates one.
    const s = streaks([0.01, 0.01, 0, 0.01]);
    expect(s.longestWin).toBe(2);
  });

  it('computes a win rate over periods', () => {
    expect(winRate([p('2024', 0.1), p('2025', -0.1), p('2026', 0.2)])).toBeCloseTo(2 / 3, 12);
    expect(winRate([])).toBeNull();
  });

  it('finds the best and worst period', () => {
    const e = extremes([p('a', 0.1), p('b', -0.3), p('c', 0.25)]);
    expect(e.best?.key).toBe('c');
    expect(e.worst?.key).toBe('b');
    expect(extremes([]).best).toBeNull();
  });
});

describe('trailing returns', () => {
  // Two years of month-ends, compounding 1% a month.
  const dates: string[] = [];
  const index: number[] = [];
  let v = 100;
  for (let i = 0; i < 25; i++) {
    const d = new Date(Date.UTC(2024, i, 1));
    dates.push(d.toISOString().slice(0, 10));
    index.push(v);
    v *= 1.01;
  }

  it('measures each window back from the last date', () => {
    const out = trailingReturns(dates, index);
    const all = out.find((r) => r.label === 'All')!;
    expect(all.value).toBeCloseTo(index[index.length - 1] / index[0] - 1, 9);

    const oneYear = out.find((r) => r.label === '1Y')!;
    // Twelve months of 1% compounding.
    expect(oneYear.value).toBeCloseTo(Math.pow(1.01, 12) - 1, 6);
  });

  it('refuses a window the history cannot cover', () => {
    // Reporting two years of data as a 10Y return overstates a track record.
    const out = trailingReturns(dates, index);
    const tenYear = out.find((r) => r.label === '10Y')!;
    expect(tenYear.complete).toBe(false);
  });

  it('counts a window as covered when its start fell on a non-trading day', () => {
    // The tenth anniversary landing on a Saturday must not report a ten-year
    // record as uncovered — the first observation is three days late because
    // the market was shut, not because the history is short.
    const weekend = ['2016-09-06', '2021-09-07', '2026-09-03'];
    const idx = [100, 150, 260];
    const out = trailingReturns(weekend, idx);
    const ten = out.find((r) => r.label === '10Y')!;
    expect(ten.complete).toBe(true);
    expect(ten.value).toBeCloseTo(260 / 100 - 1, 9);
  });

  it('still refuses a window the history genuinely misses', () => {
    // Two years of data cannot cover ten, and no grace period changes that.
    const short = ['2024-09-03', '2025-09-03', '2026-09-03'];
    const out = trailingReturns(short, [100, 110, 121]);
    expect(out.find((r) => r.label === '10Y')!.complete).toBe(false);
    expect(out.find((r) => r.label === '1Y')!.complete).toBe(true);
  });

  it('returns nothing for an empty or mismatched series', () => {
    expect(trailingReturns([], [])).toEqual([]);
    expect(trailingReturns(['2024-01-01'], [])).toEqual([]);
  });
});

describe('expected returns', () => {
  it('compounds rather than multiplies', () => {
    // A 0.05% daily mean is not 12.6% a year; it is (1.0005^252 − 1) = 13.4%.
    const e = expectedReturns([0.0005], 252);
    expect(e.perPeriod).toBeCloseTo(0.0005, 12);
    expect(e.yearly).toBeCloseTo(Math.pow(1.0005, 252) - 1, 9);
    expect(e.yearly).not.toBeCloseTo(0.0005 * 252, 4);
  });

  it('scales the monthly figure by the period count', () => {
    const e = expectedReturns([0.01], 12);
    expect(e.monthly).toBeCloseTo(0.01, 9);
  });
});
