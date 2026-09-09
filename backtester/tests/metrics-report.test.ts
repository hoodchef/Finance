import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/lib/metrics';
import { buildReport, type MetricRow } from '../src/lib/metrics/report';
import { probabilisticSharpe } from '../src/lib/metrics/extended';
import type { DailyRecord } from '../src/lib/engine/types';
import { makeCalendar } from './helpers';

/**
 * Assembling the report.
 * =============================================================================
 * The arithmetic is tested in `metrics-extended` and `metrics`; what is checked
 * here is the assembly, which is where a metrics page actually goes wrong:
 * a figure quoted on the wrong scale, a benchmark statistic silently rendered
 * as zero rather than as absent, or an Infinity from a degenerate window landing
 * in a column the reader will sort by.
 */

function records(start: string, returns: number[]): DailyRecord[] {
  const cal = makeCalendar(start, returns.length + 1);
  let index = 1;
  const base = {
    cash: 0,
    positionValues: {},
    positionShares: {},
    dividendIncome: 0,
    feesPaid: 0,
    tradingCost: 0,
    hasStalePrice: false,
    rebalanced: false,
  };
  const out: DailyRecord[] = [
    { ...base, date: cal[0], totalValue: 100, netFlow: 100, twrReturn: 0, index: 1 },
  ];
  returns.forEach((r, i) => {
    index *= 1 + r;
    out.push({
      ...base,
      date: cal[i + 1],
      totalValue: 100 * index,
      netFlow: 0,
      twrReturn: r,
      index,
    });
  });
  return out;
}

/** Deterministic pseudo-returns with a positive drift. */
function wobble(n: number, amplitude: number, phase: number, drift: number): number[] {
  return Array.from(
    { length: n },
    (_, i) => drift + Math.sin(i * 0.7 + phase) * amplitude + Math.sin(i * 0.13 + phase) * amplitude,
  );
}

const PER_YEAR = 252;
const portfolioReturns = wobble(760, 0.006, 0, 0.0004);
const benchmarkReturns = wobble(760, 0.005, 0.8, 0.0003);

function reportFor(opts: { benchmark?: boolean; exposure?: number } = {}) {
  const daily = records('2022-01-03', portfolioReturns);
  const dates = daily.map((d) => d.date);
  const index = daily.map((d) => d.index);

  let benchIndex: number[] | undefined;
  if (opts.benchmark) {
    let v = 1;
    benchIndex = [1, ...benchmarkReturns.map((r) => (v *= 1 + r))];
  }

  const metrics = computeMetrics({
    daily,
    periodsPerYear: PER_YEAR,
    riskFree: new Array(daily.length).fill(0.04),
    benchmarkReturns: opts.benchmark ? [0, ...benchmarkReturns] : undefined,
  });

  return buildReport({
    metrics,
    dates,
    index,
    benchmarkIndex: benchIndex,
    benchmark: opts.benchmark ? { symbol: 'SPY', name: 'S&P 500' } : undefined,
    exposure: opts.exposure,
  });
}

const allRows = (r: ReturnType<typeof reportFor>): MetricRow[] => r.groups.flatMap((g) => g.rows);
const rowFor = (r: ReturnType<typeof reportFor>, key: string) =>
  allRows(r).find((x) => x.key === key)!;

describe('the assembled report', () => {
  const report = reportFor({ benchmark: true, exposure: 0.8 });

  it('carries the four families the page is organised around', () => {
    expect(report.groups.map((g) => g.id)).toEqual(['ratios', 'returns', 'risk', 'benchmark']);
  });

  it('gives every row a unique key', () => {
    const keys = allRows(report).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never puts a NaN or an Infinity in a sortable column', () => {
    // The failure this guards: a degenerate window makes one ratio Infinity,
    // it sorts to the top of the table, and it reads as the best result.
    for (const row of allRows(report)) {
      if (row.value === null) continue;
      expect(Number.isFinite(row.value), `${row.key} is ${row.value}`).toBe(true);
    }
  });

  it('explains every figure it could not compute', () => {
    for (const row of allRows(report)) {
      if (row.value === null) {
        expect(row.unavailable, `${row.key} is null with no reason given`).toBeTruthy();
      }
    }
  });

  it('states a convention for every figure', () => {
    // A bare "Sortino: 1.4" is not usable — two libraries print that label for
    // numbers 30% apart depending on the threshold they used.
    for (const row of allRows(report)) {
      expect(row.note.length, `${row.key} has no note`).toBeGreaterThan(20);
    }
  });

  it('reports each requested metric by name', () => {
    const keys = new Set(allRows(report).map((r) => r.key));
    for (const wanted of [
      'sharpe', 'sortino', 'adjustedSortino', 'calmar', 'omega', 'treynor',
      'informationRatio', 'psr', 'smartSharpe', 'smartSortino', 'gainToPain',
      'payoff', 'profitFactor', 'commonSense', 'tailRatio', 'upi', 'serenity', 'rar',
      'totalReturn', 'cagr', 'expectedDaily', 'expectedMonthly', 'expectedYearly',
      'winStreak', 'lossStreak',
      'volatility', 'maxDrawdown', 'longestDrawdown', 'avgDrawdown', 'ulcer',
      'skew', 'kurtosis', 'var95', 'cvar95', 'riskOfRuin', 'recovery', 'kelly',
      'outlierWin', 'outlierLoss',
      'alpha', 'beta', 'rSquared', 'correlation',
    ]) {
      expect(keys.has(wanted), `missing ${wanted}`).toBe(true);
    }
  });
});

describe('the probabilistic Sharpe conversion', () => {
  /**
   * The report's Sharpe is annualised and PSR wants a per-observation figure.
   * Passing the annual one through returns a confidence of essentially 1.0 for
   * almost any strategy, which is a plausible-looking number and completely
   * wrong — exactly the class of bug a metrics page hides best.
   */
  it('un-annualises the Sharpe before asking for a confidence', () => {
    const report = reportFor();
    const sharpe = rowFor(report, 'sharpe').value!;
    const psr = rowFor(report, 'psr').value!;
    const skew = rowFor(report, 'skew').value!;
    const kurt = rowFor(report, 'kurtosis').value!;

    const periodic = sharpe / Math.sqrt(PER_YEAR);
    expect(psr).toBeCloseTo(
      probabilisticSharpe(periodic, report.window.observations, skew, kurt)!,
      9,
    );
    // And the un-converted form would have been a materially different claim.
    const naive = probabilisticSharpe(sharpe, report.window.observations, skew, kurt)!;
    expect(naive).toBeGreaterThan(psr);
  });

  it('reads as a probability', () => {
    const psr = rowFor(reportFor(), 'psr').value!;
    expect(psr).toBeGreaterThanOrEqual(0);
    expect(psr).toBeLessThanOrEqual(1);
  });
});

describe('without a benchmark', () => {
  const report = reportFor();

  it('marks the relative statistics absent rather than zero', () => {
    // A beta of 0.00 asserts the portfolio is uncorrelated with the market.
    // That is a claim, and it is not one an unmeasured figure gets to make.
    for (const key of ['alpha', 'beta', 'rSquared', 'correlation', 'trackingError']) {
      const row = rowFor(report, key);
      expect(row.value, key).toBeNull();
      expect(row.unavailable, key).toMatch(/benchmark/i);
    }
  });

  it('says so in the group blurb too', () => {
    const group = report.groups.find((g) => g.id === 'benchmark')!;
    expect(group.blurb).toMatch(/[Ss]elect a benchmark/);
    expect(report.benchmark).toBeNull();
  });

  it('still computes everything that does not need one', () => {
    for (const key of ['sharpe', 'sortino', 'omega', 'ulcer', 'kelly', 'tailRatio']) {
      expect(rowFor(report, key).value, key).not.toBeNull();
    }
  });
});

describe('with a benchmark', () => {
  const report = reportFor({ benchmark: true });

  it('computes the relative statistics', () => {
    for (const key of ['alpha', 'beta', 'rSquared', 'correlation']) {
      const row = rowFor(report, key);
      expect(row.value, key).not.toBeNull();
      expect(row.unavailable, key).toBeUndefined();
    }
  });

  it('names the benchmark in the group blurb', () => {
    const group = report.groups.find((g) => g.id === 'benchmark')!;
    expect(group.blurb).toContain('SPY');
  });

  it('adds a rolling beta the unbenchmarked report cannot have', () => {
    expect(report.rolling.every((r) => r.beta !== null)).toBe(true);
    expect(reportFor().rolling.every((r) => r.beta === null)).toBe(true);
  });
});

/**
 * The engine-side half of the flat-benchmark story, kept beside the report's
 * half so the two are read together.
 */
describe('a contribution-funded portfolio still gets a benchmark', () => {
  it('funds the comparison run when the config starts from nothing', async () => {
    // A portfolio built entirely from contributions has initialInvestment 0.
    // The relative-statistics run strips contributions to get a clean price
    // series, which used to leave it holding nothing: its index never moved,
    // and beta came back as exactly 0.00 rather than as unmeasured.
    const { runBacktest } = await import('../src/lib/backtest');
    const { defaultConfig } = await import('../src/lib/defaults');
    // The DEMO provider, not the live chain. What this test checks is engine
    // plumbing — that the benchmark run gets funded when the portfolio starts
    // from nothing — and that is independent of what the prices actually were.
    // Reaching for real data made the test need an API key and a network, so
    // it failed on a fresh clone for a reason that had nothing to do with the
    // behaviour under test. The walk is seeded, so beta is stable run to run.
    const { getDemoProvider } = await import('../src/lib/market-data');

    const result = await runBacktest({
      portfolio: {
        id: 'p',
        name: 'p',
        positions: [
          { id: 'a', symbol: 'SPY', weight: 60 },
          { id: 'b', symbol: 'BND', weight: 40 },
        ],
      },
      config: {
        ...defaultConfig(),
        start: '2018-01-02',
        end: '2024-12-31',
        benchmarks: ['SPY'],
        initialInvestment: 0,
        contributionAmount: 20_000,
        contributionFrequency: 'annual',
      } as never,
      provider: getDemoProvider(),
      includeAssetAnalysis: false,
      includeDailyObservations: true,
    });

    const bench = result.dailyObservations?.benchmarkIndex;
    expect(bench).not.toBeNull();
    expect(new Set(bench!.map((v) => v.toFixed(10))).size).toBeGreaterThan(100);
    // 60% SPY against SPY itself: a beta near 0.6, and emphatically not zero.
    expect(result.metrics.ratios.beta!).toBeGreaterThan(0.4);
  }, 180_000);
});

describe('a benchmark that priced flat', () => {
  /**
   * The failure this guards was seen live: the benchmark run came back with a
   * motionless index, and the page reported "Measured against SPY" over a beta
   * of 0.00, an R² of 0.00% and a correlation of 0.00 — while the two capture
   * ratios, which have no zero to fall back on, showed blank. Four confident
   * zeros beside two honest blanks, all from the same missing data.
   */
  const daily = records('2022-01-03', portfolioReturns);
  const flat = new Array(daily.length).fill(1);
  const report = buildReport({
    metrics: computeMetrics({
      daily,
      periodsPerYear: PER_YEAR,
      riskFree: new Array(daily.length).fill(0.04),
      benchmarkReturns: new Array(daily.length).fill(0),
    }),
    dates: daily.map((d) => d.date),
    index: daily.map((d) => d.index),
    benchmarkIndex: flat,
    benchmark: { symbol: 'SPY', name: 'S&P 500' },
  });

  it('reports no relative statistic rather than a zero', () => {
    for (const key of ['alpha', 'beta', 'rSquared', 'correlation', 'trackingError']) {
      expect(rowFor(report, key).value, key).toBeNull();
    }
  });

  it('says the benchmark did not load, not that it did not move', () => {
    expect(report.notes.join(' ')).toMatch(/priced flat/);
    expect(report.notes.join(' ')).toMatch(/did not load/);
    expect(report.benchmark).toBeNull();
  });

  it('leaves the portfolio-only statistics alone', () => {
    expect(rowFor(report, 'sharpe').value).not.toBeNull();
    expect(rowFor(report, 'cagr').value).not.toBeNull();
  });
});

describe('exposure and risk-adjusted return', () => {
  it('refuses to compute it when exposure is unknown', () => {
    // Assuming 100% invested would silently make RAR equal the CAGR, which
    // reads as a real measurement rather than a missing input.
    const row = rowFor(reportFor(), 'rar');
    expect(row.value).toBeNull();
    expect(row.unavailable).toMatch(/invested/);
  });

  it('scales the return up when capital sat idle', () => {
    const half = reportFor({ exposure: 0.5 });
    const full = reportFor({ exposure: 1 });
    expect(rowFor(half, 'rar').value!).toBeCloseTo(rowFor(full, 'rar').value! * 2, 9);
    expect(rowFor(full, 'rar').value!).toBeCloseTo(rowFor(full, 'cagr').value!, 9);
  });
});

describe('trailing and period breakdowns', () => {
  const report = reportFor();

  it('offers every requested window', () => {
    expect(report.trailing.map((t) => t.label)).toEqual([
      'MTD', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', '10Y', 'All',
    ]);
  });

  it('marks the windows the history cannot cover', () => {
    // Three years of data cannot report a five- or ten-year return.
    const ten = report.trailing.find((t) => t.label === '10Y')!;
    expect(ten.complete).toBe(false);
    const one = report.trailing.find((t) => t.label === '1Y')!;
    expect(one.complete).toBe(true);
    expect(one.value).not.toBeNull();
  });

  it('buckets the same history five ways', () => {
    expect(report.periods.map((p) => p.id)).toEqual([
      'daily', 'weekly', 'monthly', 'quarterly', 'annual',
    ]);
    // Each coarser bucket has fewer of them than the one before.
    for (let i = 1; i < report.periods.length; i++) {
      expect(report.periods[i].count).toBeLessThan(report.periods[i - 1].count);
    }
  });

  it('gives every bucket a win rate and both extremes', () => {
    for (const p of report.periods) {
      expect(p.winRate, p.id).not.toBeNull();
      expect(p.winRate!, p.id).toBeGreaterThanOrEqual(0);
      expect(p.winRate!, p.id).toBeLessThanOrEqual(1);
      expect(p.best, p.id).not.toBeNull();
      expect(p.worst!.return, p.id).toBeLessThanOrEqual(p.best!.return);
    }
  });
});

describe('rolling statistics', () => {
  const report = reportFor({ benchmark: true });

  it('uses half a year of observations', () => {
    expect(report.rollingWindow).toBe(126);
  });

  it('produces one point per window, dated at its last day', () => {
    expect(report.rolling.length).toBe(report.window.observations - report.rollingWindow + 1);
    // Dated at the end: a reader tracing the line to a date is asking what the
    // trailing window looked like as of then, not what was about to happen.
    expect(report.rolling[report.rolling.length - 1].date).toBe(report.window.to);
  });

  it('keeps every value finite', () => {
    for (const r of report.rolling) {
      expect(Number.isFinite(r.sharpe)).toBe(true);
      expect(Number.isFinite(r.sortino)).toBe(true);
      expect(Number.isFinite(r.volatility)).toBe(true);
    }
  });
});

describe('the window it reports on', () => {
  it('states what it measured rather than leaving it to be assumed', () => {
    const report = reportFor();
    expect(report.window.observations).toBe(portfolioReturns.length);
    expect(report.window.periodsPerYear).toBe(PER_YEAR);
    expect(report.window.riskFree).toBeCloseTo(0.04, 6);
    expect(report.window.from < report.window.to).toBe(true);
  });
});
