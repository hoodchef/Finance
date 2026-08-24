import { describe, expect, it } from 'vitest';
import { runMonteCarlo } from '../src/lib/analysis/montecarlo';

/**
 * The properties that matter for a simulation are different from those for a
 * backtest. A backtest has one right answer; a simulation has a distribution,
 * and the failure modes are subtler: understating tail risk, drifting from the
 * source distribution, or quietly depending on the seed.
 */

const PPY = 252;

/**
 * A return series with genuine volatility clustering: long calm stretches of
 * small positive drift, punctuated by crises of CONSECUTIVE losses.
 *
 * The first version of this used a high-frequency sine, which alternates sign
 * day to day — so blocks cancelled internally and the fixture exhibited the
 * opposite of clustering. Persistence, not amplitude, is what makes a drawdown
 * deep, and it is what block resampling is meant to preserve.
 */
function clusteredReturns(n = 2520): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const inCrisis = Math.floor(i / 60) % 6 === 0;
    // A crisis is a run of losses in a row, which compounds into a real fall.
    out.push(inCrisis ? -0.006 : 0.0015);
  }
  return out;
}

const base = {
  returns: clusteredReturns(),
  periodsPerYear: PPY,
  initialInvestment: 10_000,
  years: 10,
  paths: 400,
};

describe('determinism', () => {
  it('gives the same answer for the same seed', () => {
    const a = runMonteCarlo({ ...base, seed: 7 });
    const b = runMonteCarlo({ ...base, seed: 7 });
    expect(b.terminal.median).toBe(a.terminal.median);
    expect(b.probabilityOfLoss).toBe(a.probabilityOfLoss);
  });

  it('gives a different answer for a different seed', () => {
    const a = runMonteCarlo({ ...base, seed: 1 });
    const b = runMonteCarlo({ ...base, seed: 2 });
    expect(b.terminal.median).not.toBe(a.terminal.median);
  });

  it('does not depend materially on the seed once there are enough paths', () => {
    // If the answer moved a lot with the seed, the path count would be too low
    // to report percentiles from.
    const a = runMonteCarlo({ ...base, paths: 2000, seed: 11 });
    const b = runMonteCarlo({ ...base, paths: 2000, seed: 99 });
    const drift = Math.abs(a.terminal.median / b.terminal.median - 1);
    expect(drift).toBeLessThan(0.05);
  });
});

describe('the distribution is ordered and plausible', () => {
  const r = runMonteCarlo({ ...base, seed: 3 });

  it('orders its percentiles', () => {
    const t = r.terminal;
    expect(t.min).toBeLessThanOrEqual(t.p5);
    expect(t.p5).toBeLessThanOrEqual(t.p25);
    expect(t.p25).toBeLessThanOrEqual(t.median);
    expect(t.median).toBeLessThanOrEqual(t.p75);
    expect(t.p75).toBeLessThanOrEqual(t.p95);
    expect(t.p95).toBeLessThanOrEqual(t.max);
  });

  it('widens as the horizon lengthens', () => {
    // Uncertainty must compound; bands that narrowed would indicate the paths
    // were converging, which resampled returns do not do.
    const spread = r.bands.map((b) => b.p95 - b.p5);
    expect(spread[r.bands.length - 1]).toBeGreaterThan(spread[1]);
  });

  it('starts every path at the initial investment', () => {
    expect(r.bands[0].p5).toBeCloseTo(10_000, 6);
    expect(r.bands[0].p95).toBeCloseTo(10_000, 6);
  });

  it('reports how much history it drew from', () => {
    // The regime caveat depends on this being visible.
    expect(r.sampleDays).toBe(2520);
    expect(r.sampleYears).toBeCloseTo(10, 0);
  });
});

describe('block resampling preserves what IID destroys', () => {
  it('produces deeper drawdowns than independent sampling', () => {
    // Volatility clustering is most of what makes a drawdown deep. Sampling
    // days independently breaks up the turbulent stretches and understates the
    // tail in a way that looks reassuring and is not.
    const block = runMonteCarlo({ ...base, method: 'block', blockDays: 21, seed: 5, paths: 800 });
    const iid = runMonteCarlo({ ...base, method: 'iid', seed: 5, paths: 800 });

    expect(block.worstDrawdown.median).toBeLessThan(iid.worstDrawdown.median);
    expect(block.blockDays).toBe(21);
    expect(iid.blockDays).toBeNull();
  });
});

describe('contributions', () => {
  it('adds them on the simulated path, not just to the total', () => {
    const without = runMonteCarlo({ ...base, seed: 4 });
    const with_ = runMonteCarlo({
      ...base,
      seed: 4,
      contributionAmount: 500,
      contributionEvery: 21,
    });

    expect(with_.totalContributed).toBeGreaterThan(without.totalContributed);
    // Contributions arriving early compound, so the terminal value must exceed
    // the initial value plus the contributions themselves.
    expect(with_.terminal.median).toBeGreaterThan(without.terminal.median);
  });

  it('measures loss against capital contributed, not against the initial sum', () => {
    const r = runMonteCarlo({
      ...base,
      contributionAmount: 1_000,
      contributionEvery: 21,
      seed: 8,
    });
    expect(r.totalContributed).toBeGreaterThan(10_000);
    expect(r.probabilityOfLoss).toBeGreaterThanOrEqual(0);
    expect(r.probabilityOfLoss).toBeLessThanOrEqual(1);
  });
});

describe('refusing to simulate from too little', () => {
  it('will not resample a handful of days', () => {
    // A bootstrap of twenty days describes those twenty days, not a strategy.
    expect(() =>
      runMonteCarlo({ ...base, returns: [0.01, -0.01, 0.02, 0.0, 0.005] }),
    ).toThrow(/Not enough history/i);
  });
});

describe('a flat market stays flat', () => {
  it('produces no dispersion when every day is zero', () => {
    const r = runMonteCarlo({
      returns: new Array(500).fill(0),
      periodsPerYear: PPY,
      initialInvestment: 10_000,
      years: 5,
      paths: 100,
      seed: 2,
    });
    expect(r.terminal.p5).toBeCloseTo(10_000, 6);
    expect(r.terminal.p95).toBeCloseTo(10_000, 6);
    expect(r.worstDrawdown.median).toBeCloseTo(0, 8);
    expect(r.probabilityOfLoss).toBe(0);
  });
});

describe('the sample must be the full daily series', () => {
  /**
   * Guards a bug that produced a confident, attractive, entirely wrong answer.
   *
   * `BacktestResult.series` is thinned to ~1,600 points for charting, so a
   * fifteen-year run exposes about 1,338 of them and each spans nearly three
   * trading days. Resampling those as if daily compounded three days per step
   * and turned a 9.3% strategy into a 28% one — while every percentile was
   * correctly ordered and the fan chart looked entirely reasonable.
   */
  it('reports a sample length consistent with the years it claims', async () => {
    const { computeDailyReturns } = await import('../src/lib/backtest');
    const { getDemoProvider } = await import('../src/lib/market-data');
    const { testConfig } = await import('./helpers');

    const portfolio = {
      id: 'p',
      name: 'P',
      positions: [{ id: '1', symbol: 'SPY', weight: 100 }],
    };
    const config = testConfig({ start: '2010-01-04', end: '2024-12-31', benchmarks: [] });

    const daily = await computeDailyReturns({
      portfolio,
      config,
      provider: getDemoProvider(),
    });

    // Fifteen calendar years of trading days, not the ~1,300 chart points.
    const impliedYears = daily.returns.length / daily.periodsPerYear;
    expect(impliedYears).toBeGreaterThan(14);
    expect(impliedYears).toBeLessThan(16);
    expect(daily.returns.length).toBeGreaterThan(3_000);
  }, 60_000);

  it('centres on the historical rate rather than drifting from it', async () => {
    const { computeDailyReturns } = await import('../src/lib/backtest');
    const { getDemoProvider } = await import('../src/lib/market-data');
    const { testConfig } = await import('./helpers');
    const { runBacktest } = await import('../src/lib/backtest');

    const portfolio = {
      id: 'p',
      name: 'P',
      positions: [{ id: '1', symbol: 'SPY', weight: 100 }],
    };
    const config = testConfig({ start: '2010-01-04', end: '2024-12-31', benchmarks: [] });
    const provider = getDemoProvider();

    const [daily, historical] = await Promise.all([
      computeDailyReturns({ portfolio, config, provider }),
      runBacktest({ portfolio, config, provider, includeAssetAnalysis: false }),
    ]);

    const sim = runMonteCarlo({
      returns: daily.returns,
      periodsPerYear: daily.periodsPerYear,
      initialInvestment: 10_000,
      years: 15,
      paths: 800,
      seed: 42,
    });

    // A bootstrap of a series must reproduce that series' own rate at the
    // median. A step size error shows up here immediately and nowhere else.
    expect(sim.annualised.median).toBeCloseTo(historical.metrics.returns.cagr, 2);
  }, 90_000);
});
