import { describe, expect, it } from 'vitest';
import { TiingoProvider } from '../src/lib/market-data/tiingo';
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
