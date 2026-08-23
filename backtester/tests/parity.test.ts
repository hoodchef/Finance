import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { __testing } from '../src/lib/market-data/yahoo';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import type { MarketDataProvider } from '../src/lib/market-data/provider';
import type { DateRange, IsoDate, PriceSeries } from '../src/lib/types';
import { prepareData } from '../src/lib/engine/prepare';
import { runEngine } from '../src/lib/engine/engine';
import { computeMetrics } from '../src/lib/metrics';
import { testConfig } from './helpers';

/**
 * Independent-reference parity.
 * =============================================================================
 * A one-asset, fee-free, dividend-reinvesting backtest has a closed-form
 * answer, so the engine can be checked against arithmetic it did not produce.
 *
 * Two conventions exist for chaining a dividend into a return, and they are not
 * the same number:
 *
 *   exact total return   (C_t + D_t) / C_{t−1} − 1
 *       You hold N shares worth N·C_t and receive N·D_t in cash. Reinvesting
 *       that cash at the ex-date close buys N·D_t/C_t more shares. This is what
 *       the engine does and what a real DRIP does.
 *
 *   back-adjusted price  C_t / (C_{t−1} − D_t) − 1
 *       The vendor convention behind an "adjusted close" column: every price
 *       before the ex-date is scaled by (1 − D_t/C_{t−1}). It implies buying at
 *       the cum-dividend price, which nobody can actually do.
 *
 * They agree to first order and differ by roughly D·ΔC/C² per event — about
 * 6e-5 on a single AAPL dividend, and under half a percent across a decade of
 * monthly bond distributions.
 *
 * The tests below therefore pin the engine to the exact convention to ~1e-9,
 * and separately show that recomputing the vendor's own convention reproduces
 * its adjusted-close column to ~1e-5. That combination proves the remaining gap
 * is a definition, not a defect.
 */

/** Exact total-return index: the reference the engine is held to. */
function exactTotalReturn(
  bars: Array<{ date: IsoDate; close: number }>,
  dividends: Map<IsoDate, number>,
): number {
  let acc = 1;
  for (let i = 1; i < bars.length; i++) {
    acc *= (bars[i].close + (dividends.get(bars[i].date) ?? 0)) / bars[i - 1].close;
  }
  return acc - 1;
}

/** The vendor's own convention, recomputed from raw closes and dividends. */
function backAdjustedTotalReturn(
  bars: Array<{ date: IsoDate; close: number }>,
  dividends: Map<IsoDate, number>,
): number {
  let acc = 1;
  for (let i = 1; i < bars.length; i++) {
    acc *= bars[i].close / (bars[i - 1].close - (dividends.get(bars[i].date) ?? 0));
  }
  return acc - 1;
}

const FIXTURES = path.join(__dirname, 'fixtures');

function fixtureSeries(file: string): PriceSeries {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  return __testing.parseChart(raw.chart.result[0].meta.symbol, raw);
}

/** Serves one in-memory series, so the test never touches the network. */
class StubProvider implements MarketDataProvider {
  readonly id = 'stub';
  readonly label = 'Stub';
  readonly synthetic = false;
  readonly description = 'Recorded fixture';
  constructor(private readonly series: PriceSeries) {}

  private slice(range: DateRange): PriceSeries {
    return {
      ...this.series,
      bars: this.series.bars.filter((b) => b.date >= range.start && b.date <= range.end),
      dividends: this.series.dividends.filter(
        (d) => d.date >= range.start && d.date <= range.end,
      ),
      splits: this.series.splits.filter((s) => s.date >= range.start && s.date <= range.end),
    };
  }
  async getHistoricalPrices(_symbol: string, range: DateRange) {
    return this.slice(range);
  }
  async getCorporateActions(_s: string, range: DateRange) {
    const x = this.slice(range);
    return { dividends: x.dividends, splits: x.splits };
  }
  async getDividends(_s: string, range: DateRange) {
    return this.slice(range).dividends;
  }
  async getTradingCalendar(range: DateRange): Promise<IsoDate[]> {
    return this.slice(range).bars.map((b) => b.date);
  }
  async search() {
    return [];
  }
}

async function buyAndHoldIndex(series: PriceSeries, start: IsoDate, end: IsoDate) {
  const provider = new StubProvider(series);
  const config = testConfig({
    start,
    end,
    initialInvestment: 100_000,
    rebalance: 'never',
    dividends: 'reinvest',
    inceptionPolicy: 'truncate',
  });
  const symbol = series.meta.symbol;
  const data = await prepareData({
    symbols: [{ symbol, weight: 100 }],
    config,
    provider,
  });
  const result = runEngine({
    portfolio: { id: 'p', name: 'P', positions: [{ id: symbol, symbol, weight: 100 }] },
    config,
    data,
  });
  const metrics = computeMetrics({
    daily: result.daily,
    periodsPerYear: result.periodsPerYear,
    riskFree: data.riskFree,
  });
  const bars = data.assets[0].series!.bars;
  const dividends = new Map(data.assets[0].series!.dividends.map((d) => [d.date, d.amount]));
  return {
    result,
    metrics,
    bars,
    dividends,
    exact: exactTotalReturn(bars, dividends),
    backAdjusted: backAdjustedTotalReturn(bars, dividends),
    vendorAdjClose: bars[bars.length - 1].adjClose / bars[0].adjClose - 1,
  };
}

describe('parity with the vendor adjusted close', () => {
  it('matches AAPL total return across a 4:1 split and a dividend', async () => {
    const series = fixtureSeries('aapl-split-2020.json');
    const { metrics, exact, backAdjusted, vendorAdjClose, result } =
      await buyAndHoldIndex(series, '2020-06-01', '2020-09-30');

    // The engine reproduces the exact total return to floating-point precision,
    // through a 4:1 split and a cash dividend it actually reinvested.
    expect(metrics.returns.totalReturn).toBeCloseTo(exact, 9);
    expect(result.totals.totalDividends).toBeGreaterThan(0);
    expect(result.transactions.some((t) => t.type === 'reinvest')).toBe(true);

    // The vendor's adjusted-close column is reproduced by the *other*
    // convention, which is why the two numbers are not identical.
    expect(backAdjusted).toBeCloseTo(vendorAdjClose, 6);
    expect(Math.abs(exact - vendorAdjClose)).toBeLessThan(1e-3);
  });

  it('diverges from the adjusted close when dividends are taken as cash', async () => {
    const series = fixtureSeries('aapl-split-2020.json');
    const provider = new StubProvider(series);
    const base = testConfig({
      start: '2020-06-01',
      end: '2020-09-30',
      initialInvestment: 100_000,
      rebalance: 'never',
    });
    const data = await prepareData({
      symbols: [{ symbol: 'AAPL', weight: 100 }],
      config: base,
      provider,
    });
    const p = { id: 'p', name: 'P', positions: [{ id: 'AAPL', symbol: 'AAPL', weight: 100 }] };

    const reinvested = runEngine({ portfolio: p, config: base, data });
    const asCash = runEngine({
      portfolio: p,
      config: { ...base, dividends: 'cash' },
      data,
    });

    // AAPL rose over the window, so cash left uninvested must end up worth less.
    expect(asCash.totals.finalValue).toBeLessThan(reinvested.totals.finalValue);
    expect(asCash.daily[asCash.daily.length - 1].cash).toBeGreaterThan(0);
  });

  it('matches the demo provider\'s own adjusted close over six years', async () => {
    // Long horizon, ~24 dividends: an error in reinvestment timing compounds
    // into a visible gap here even though it hides over a single quarter.
    const demo = new DemoDataProvider();
    const series = await demo.getFullHistory('SPY');
    const { metrics, exact, backAdjusted, vendorAdjClose } = await buyAndHoldIndex(
      series,
      '2015-01-05',
      '2020-12-31',
    );
    expect(metrics.returns.totalReturn).toBeCloseTo(exact, 9);
    expect(backAdjusted).toBeCloseTo(vendorAdjClose, 6);
  });

  it('matches for a high-yield asset where dividends dominate the difference', async () => {
    const demo = new DemoDataProvider();
    const series = await demo.getFullHistory('BND');
    const { metrics, exact, backAdjusted, vendorAdjClose, bars } =
      await buyAndHoldIndex(series, '2010-01-05', '2020-12-31');
    const priceOnlyReturn = bars[bars.length - 1].close / bars[0].close - 1;

    expect(metrics.returns.totalReturn).toBeCloseTo(exact, 8);
    expect(backAdjusted).toBeCloseTo(vendorAdjClose, 5);
    // Confirms the test has teeth: total return and price return really differ.
    expect(Math.abs(exact - priceOnlyReturn)).toBeGreaterThan(0.1);
    // And the two dividend conventions stay within half a percent over 11 years
    // of quarterly distributions.
    expect(Math.abs(exact - vendorAdjClose) / (1 + exact)).toBeLessThan(0.005);
  });
});

describe.runIf(fs.existsSync(path.join(FIXTURES, 'spy-2015-2024.json')))(
  'parity against ten years of recorded SPY',
  () => {
    it('matches the vendor total return over the full decade', async () => {
      const series = fixtureSeries('spy-2015-2024.json');
      const { metrics, exact, backAdjusted, vendorAdjClose, result } =
        await buyAndHoldIndex(series, '2015-01-02', '2024-12-31');
      expect(metrics.returns.totalReturn).toBeCloseTo(exact, 8);
      expect(backAdjusted).toBeCloseTo(vendorAdjClose, 4);
      expect(result.totals.totalDividends).toBeGreaterThan(0);
      expect(Math.abs(exact - vendorAdjClose) / (1 + exact)).toBeLessThan(0.005);
    });
  },
);
