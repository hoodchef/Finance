import { describe, expect, it } from 'vitest';
import { TiingoProvider } from '../src/lib/market-data/tiingo';
import { getFactorSeries } from '../src/lib/market-data/factors';
import { YahooFinanceProvider } from '../src/lib/market-data/yahoo';
import { checkSeries, reconcileDividends } from '../src/lib/market-data/integrity';
import type { PriceSeries } from '../src/lib/types';
import type { MarketDataProvider } from '../src/lib/market-data/provider';

/**
 * Live data-contract verification.
 * =============================================================================
 * Every provider claims to return prices, dividends and splits. What differs —
 * and what silently corrupts a backtest — is the *convention*: whether closes
 * are split-adjusted, whether dividends are stated in pre- or post-split units,
 * whether the adjusted close reconciles with the dividend feed at all.
 *
 * Yahoo's convention was verified empirically before the engine was allowed to
 * trust it. Any provider added later must clear the same bar, against live
 * data, before it is used for a real backtest. These tests are that bar.
 *
 * They self-skip when no key is present, so the suite stays green offline. Run
 * them deliberately after configuring a provider:
 *
 *   TIINGO_API_KEY=... npm run verify:data
 *
 * A provider that has not passed this is not verified, and the README says so
 * rather than implying otherwise.
 */

/** A known 4:1 split with a dividend in the same quarter. */
const SPLIT_CASE = {
  symbol: 'AAPL',
  range: { start: '2020-06-01', end: '2020-09-30' },
  splitDate: '2020-08-31',
  splitRatio: 4,
};

async function assertContract(provider: MarketDataProvider, series: PriceSeries) {
  // 1. Structure: ascending, positive, non-empty.
  expect(series.bars.length).toBeGreaterThan(20);
  for (let i = 1; i < series.bars.length; i++) {
    expect(series.bars[i].date > series.bars[i - 1].date).toBe(true);
  }
  expect(series.bars.every((b) => b.close > 0 && Number.isFinite(b.close))).toBe(true);

  // 2. The provider states its adjustment convention, and it is one we handle.
  expect(['split-adjusted', 'raw']).toContain(series.adjustment);
  expect(series.synthetic).toBe(false);
  expect(series.source).toBe(provider.id);

  // 3. Dividends must reconcile with the adjusted close. If they do not, the
  //    two feeds disagree and every reinvestment the engine makes is wrong.
  const recon = reconcileDividends(series);
  if (recon.length > 0) {
    const bad = recon.filter((r) => r.relativeError > 0.02);
    expect(
      bad.length,
      `${bad.length}/${recon.length} dividends do not reconcile with the adjusted close`,
    ).toBeLessThanOrEqual(Math.floor(recon.length * 0.1));
  }

  // 4. No integrity errors — in particular no unapplied split masquerading as
  //    a real price move.
  const errors = checkSeries(series).filter((w) => w.severity === 'error');
  expect(errors.map((e) => e.message)).toEqual([]);
}

/** Verifies the split convention matches what the provider declares. */
function assertSplitConvention(series: PriceSeries) {
  const idx = series.bars.findIndex((b) => b.date === SPLIT_CASE.splitDate);
  expect(idx, 'split date missing from the returned range').toBeGreaterThan(0);

  const before = series.bars[idx - 1].close;
  const after = series.bars[idx].close;
  const jump = before / after;

  if (series.adjustment === 'split-adjusted') {
    // Prices are retroactively restated, so there is no discontinuity.
    expect(jump).toBeLessThan(1.5);
    // And the dividend feed must be in the same restated units.
    const div = series.dividends.find((d) => d.date >= '2020-08-01' && d.date <= '2020-08-15');
    if (div) expect(div.amount).toBeLessThan(before * 0.02);
  } else {
    // Raw prices: the discontinuity is real and must match the split ratio,
    // which the engine then applies to share counts.
    expect(jump).toBeGreaterThan(SPLIT_CASE.splitRatio * 0.9);
    const split = series.splits.find((s) => s.date === SPLIT_CASE.splitDate);
    expect(split, 'raw series must report the split as an event').toBeTruthy();
    expect(split!.numerator / split!.denominator).toBeCloseTo(SPLIT_CASE.splitRatio, 1);
  }
}

/**
 * `npm run verify:data` sets VERIFY_DATA=1. Running it deliberately and getting
 * a green skip would be worse than useless, so a missing key is an explicit
 * failure there while remaining a quiet skip in the ordinary suite.
 */
describe('verification preconditions', () => {
  it.runIf(process.env.VERIFY_DATA)('has a provider key to verify against', () => {
    const configured = Boolean(process.env.TIINGO_API_KEY?.trim());
    expect(
      configured,
      'No TIINGO_API_KEY found. Add it to .env.local — nothing was verified.',
    ).toBe(true);
  });
});

describe.runIf(process.env.TIINGO_API_KEY)('Tiingo live contract', () => {
  const provider = new TiingoProvider();

  it('satisfies the data contract', async () => {
    const series = await provider.getHistoricalPrices('SPY', {
      start: '2015-01-01',
      end: '2024-12-31',
    });
    await assertContract(provider, series);
    expect(series.dividends.length).toBeGreaterThan(30);
  }, 60_000);

  it('handles a 4:1 split consistently with its declared convention', async () => {
    const series = await provider.getHistoricalPrices(SPLIT_CASE.symbol, SPLIT_CASE.range);
    assertSplitConvention(series);
  }, 60_000);

  it('has sufficient history for long-horizon backtesting', async () => {
    const series = await provider.getFullHistory('SPY');
    expect(series.bars[0].date < '2000-01-01').toBe(true);
  }, 60_000);
}, 180_000);

describe.runIf(process.env.VERIFY_YAHOO_LIVE)('Yahoo live contract', () => {
  const provider = new YahooFinanceProvider();

  it('satisfies the data contract', async () => {
    const series = await provider.getHistoricalPrices('SPY', {
      start: '2015-01-01',
      end: '2024-12-31',
    });
    await assertContract(provider, series);
  }, 60_000);

  it('handles a 4:1 split consistently with its declared convention', async () => {
    const series = await provider.getHistoricalPrices(SPLIT_CASE.symbol, SPLIT_CASE.range);
    assertSplitConvention(series);
  }, 60_000);
}, 180_000);

describe('the contract assertions themselves have teeth', () => {
  it('rejects a series whose dividends do not reconcile', () => {
    // A plausible corruption: dividends reported in pre-split units against
    // post-split prices. This is the exact class of error the check exists for.
    const bars = Array.from({ length: 30 }, (_, i) => ({
      date: `2020-06-${String(i + 1).padStart(2, '0')}`,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      adjClose: 100,
      volume: 1000,
    }));
    const corrupted: PriceSeries = {
      meta: {
        symbol: 'TEST',
        name: 'Test',
        assetClass: 'equity',
        currency: 'USD',
      },
      bars,
      // A $4 dividend that leaves no trace in the adjusted close.
      dividends: [{ date: bars[10].date, amount: 4 }],
      splits: [],
      adjustment: 'split-adjusted',
      source: 'test',
      synthetic: false,
      fetchedAt: new Date().toISOString(),
    };

    const recon = reconcileDividends(corrupted);
    expect(recon).toHaveLength(1);
    // Implied dividend is 0 because adjClose never moved; reported is 4.
    expect(recon[0].relativeError).toBeGreaterThan(0.5);
  });
});

/**
 * The Kenneth French Data Library needs no key, so this runs whenever live
 * verification is asked for. It exists because the library's CSVs carry a prose
 * preamble of varying length and have been reformatted before: a change there
 * would not throw, it would parse into a subtly different table.
 */
describe.runIf(process.env.VERIFY_DATA)('Fama–French factor contract', () => {
  it('serves all three sets with the columns each is supposed to have', async () => {
    const [ff3, ff5, mom] = await Promise.all([
      getFactorSeries('ff3'),
      getFactorSeries('ff5'),
      getFactorSeries('mom'),
    ]);

    expect(Object.keys(ff3.factors).sort()).toEqual(['HML', 'Mkt-RF', 'SMB']);
    expect(Object.keys(ff5.factors).sort()).toEqual(['CMA', 'HML', 'Mkt-RF', 'RMW', 'SMB']);
    expect(Object.keys(mom.factors)).toEqual(['Mom']);

    // Only the research-factor files publish the risk-free rate.
    expect(ff3.riskFree?.length).toBe(ff3.dates.length);
    expect(ff5.riskFree?.length).toBe(ff5.dates.length);
    expect(mom.riskFree ?? []).toHaveLength(0);
  }, 180_000);

  it('returns decimals, not the percent the file is written in', async () => {
    const ff3 = await getFactorSeries('ff3');
    const mkt = ff3.factors['Mkt-RF'];
    const sd = Math.sqrt(mkt.reduce((s, v) => s + v * v, 0) / mkt.length);
    // Daily market volatility is around 1%. If the percent conversion were
    // dropped this would be ~1.0, and every beta would be off by 100x.
    expect(sd).toBeGreaterThan(0.002);
    expect(sd).toBeLessThan(0.03);
    // No day should be beyond -50%/+50%; the missing-value sentinel is -99.99.
    expect(Math.min(...mkt)).toBeGreaterThan(-0.5);
    expect(Math.max(...mkt)).toBeLessThan(0.5);
  }, 180_000);

  it('is dated plausibly and ordered ascending', async () => {
    const ff3 = await getFactorSeries('ff3');
    expect(ff3.dates[0]).toBe('1926-07-01');
    for (let i = 1; i < ff3.dates.length; i++) {
      expect(ff3.dates[i] > ff3.dates[i - 1]).toBe(true);
    }
    // The library publishes monthly and runs one to two months behind. More
    // than a year behind means it has stopped updating, which the app would
    // otherwise absorb silently as a shorter regression window.
    const ageDays =
      (Date.now() - Date.parse(`${ff3.lastAvailable}T00:00:00Z`)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(0);
    expect(ageDays).toBeLessThan(400);
  }, 180_000);

  it('carries a non-negative risk-free rate', async () => {
    const ff3 = await getFactorSeries('ff3');
    // T-bill rates have not gone negative in the US. A sign error here would
    // shift every excess return and therefore every alpha.
    expect(Math.min(...ff3.riskFree!)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ff3.riskFree!)).toBeLessThan(0.001); // <0.1%/day
  }, 180_000);

  it('agrees with itself across files on the shared market factor', async () => {
    const [ff3, ff5] = await Promise.all([getFactorSeries('ff3'), getFactorSeries('ff5')]);
    const byDate = new Map(ff3.dates.map((d, i) => [d, ff3.factors['Mkt-RF'][i]]));
    let compared = 0;
    for (let i = 0; i < ff5.dates.length; i++) {
      const other = byDate.get(ff5.dates[i]);
      if (other === undefined) continue;
      compared++;
      // Same factor, two files. Disagreement means one was parsed wrong.
      expect(Math.abs(other - ff5.factors['Mkt-RF'][i])).toBeLessThan(1e-12);
    }
    expect(compared).toBeGreaterThan(10_000);
  }, 180_000);
});
