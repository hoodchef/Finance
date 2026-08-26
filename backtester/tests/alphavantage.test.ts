import { describe, expect, it } from 'vitest';
import {
  AlphaVantageProvider,
  __testing,
  isCanadianSymbol,
  toAlphaVantageSymbol,
} from '../src/lib/market-data/alphavantage';
import { MarketDataError, UnknownSymbolError } from '../src/lib/market-data/provider';
import type { DateRange, IsoDate, PriceSeries } from '../src/lib/types';
import type { MarketDataProvider } from '../src/lib/market-data/provider';
import { checkSeries } from '../src/lib/market-data/integrity';
import { prepareData } from '../src/lib/engine/prepare';
import { runEngine } from '../src/lib/engine/engine';
import { computeMetrics } from '../src/lib/metrics';
import { testConfig } from './helpers';

/**
 * Offline. The live contract is exercised by `npm run verify:data`; these pin
 * the symbol mapping, the refusal handling and — most importantly — that
 * weekly data annualises as weekly rather than being treated as daily.
 */

describe('Canadian symbol mapping', () => {
  it('maps the common venue suffixes onto Alpha Vantage’s', () => {
    expect(toAlphaVantageSymbol('XEQT.TO')).toBe('XEQT.TRT');
    expect(toAlphaVantageSymbol('SHOP.TO')).toBe('SHOP.TRT');
    expect(toAlphaVantageSymbol('ABC.V')).toBe('ABC.TRV');
    expect(toAlphaVantageSymbol('XYZ.NE')).toBe('XYZ.NEO');
    expect(toAlphaVantageSymbol('QRS.CN')).toBe('QRS.CNQ');
  });

  it('passes an already-native symbol through unchanged', () => {
    expect(toAlphaVantageSymbol('XEQT.TRT')).toBe('XEQT.TRT');
    expect(isCanadianSymbol('XEQT.TRT')).toBe(true);
  });

  it('does not treat a bare ticker as Canadian', () => {
    // SHOP is the US listing and SHOP.TO is the Toronto one. Resolving the
    // first as the second returns a different security in a different currency.
    expect(isCanadianSymbol('SHOP')).toBe(false);
    expect(isCanadianSymbol('SPY')).toBe(false);
    expect(toAlphaVantageSymbol('SPY')).toBe('SPY');
  });

  it('does not claim non-Canadian suffixed listings', () => {
    expect(isCanadianSymbol('BMW.DEX')).toBe(false);
    expect(isCanadianSymbol('307.FRK')).toBe(false);
  });
});

describe('refusals that arrive as HTTP 200', () => {
  /**
   * Alpha Vantage answers 200 for everything, including refusals. Treating one
   * as success yields an empty series a caller believes is real.
   */
  it('turns a premium gate into an error naming it', () => {
    expect(() =>
      __testing.assertPayload(
        { Information: 'the outputsize=full parameter value is a premium feature' },
        'XEQT.TO',
      ),
    ).toThrow(/premium/i);
  });

  it('turns a throttle into an error explaining the quota', () => {
    expect(() =>
      __testing.assertPayload(
        { Note: 'Please consider spreading out your free API requests more sparingly' },
        'XEQT.TO',
      ),
    ).toThrow(/25 requests a day/);
  });

  it('turns an invalid symbol into UnknownSymbolError', () => {
    expect(() =>
      __testing.assertPayload({ 'Error Message': 'Invalid API call' }, 'NOPE.TO'),
    ).toThrow(UnknownSymbolError);
  });

  it('lets a real payload through untouched', () => {
    expect(() => __testing.assertPayload({ 'Weekly Adjusted Time Series': {} }, 'XEQT.TO')).not.toThrow();
  });
});

/** Two weekly bars either side of a dividend, in the shape the API returns. */
const TABLE = {
  '2024-01-05': {
    '1. open': '10.00', '2. high': '10.50', '3. low': '9.90', '4. close': '10.00',
    '5. adjusted close': '9.80', '6. volume': '1000', '7. dividend amount': '0.0000',
  },
  '2024-01-12': {
    '1. open': '10.00', '2. high': '10.60', '3. low': '9.95', '4. close': '10.20',
    '5. adjusted close': '10.20', '6. volume': '1200', '7. dividend amount': '0.2000',
  },
};

describe('parsing the weekly adjusted feed', () => {
  const s = __testing.parseWeekly('XEQT.TRT', 'XEQT.TO', {
    'Weekly Adjusted Time Series': TABLE,
  });

  it('tags the series as weekly so it cannot be mistaken for daily', () => {
    expect(s.interval).toBe('weekly');
  });

  it('extracts dividends but declares no splits', () => {
    // Splits are already folded into both close and adjusted close, verified
    // against Tiingo across AAPL's 4:1. Applying one again would double-count.
    expect(s.dividends).toEqual([{ date: '2024-01-12', amount: 0.2 }]);
    expect(s.splits).toEqual([]);
    expect(s.adjustment).toBe('split-adjusted');
  });

  it('reports CAD for a Canadian listing rather than leaving it unknown', () => {
    expect(s.meta.currency).toBe('CAD');
  });

  it('does not assert a currency for a listing whose venue it cannot name', () => {
    const us = __testing.parseWeekly('AAPL', 'AAPL', { 'Weekly Adjusted Time Series': TABLE });
    expect(us.meta.currency).toBeUndefined();
  });

  it('refuses an empty table rather than returning an empty series', () => {
    expect(() =>
      __testing.parseWeekly('X.TRT', 'X.TO', { 'Weekly Adjusted Time Series': {} }),
    ).toThrow(UnknownSymbolError);
  });

  it('offers no trading calendar', async () => {
    // Weekly dates as a market calendar would make every daily holding look
    // stale four days in five.
    const provider = new AlphaVantageProvider();
    await expect(
      provider.getTradingCalendar({ start: '2024-01-01', end: '2024-12-31' }),
    ).resolves.toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Weekly data through the engine                                      */
/* ------------------------------------------------------------------ */

/**
 * Weekly bars every 7 days from `start`.
 *
 * `wobble` alternates the weekly return around its mean, giving the series a
 * known, exactly computable dispersion — without it, volatility is zero and any
 * assertion about how it annualises passes whatever the factor.
 */
function weeklySeries(
  symbol: string,
  start: string,
  weeks: number,
  weeklyReturn: number,
  wobble = 0,
) {
  const bars = [];
  let price = 100;
  let t = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < weeks; i++) {
    const date = new Date(t).toISOString().slice(0, 10) as IsoDate;
    bars.push({ date, open: price, high: price, low: price, close: price, adjClose: price, volume: 0 });
    price *= 1 + weeklyReturn + (i % 2 === 0 ? wobble : -wobble);
    t += 7 * 86_400_000;
  }
  return {
    meta: {
      symbol, name: symbol, assetClass: 'other' as const, currency: 'CAD',
      firstTradeDate: bars[0].date, lastTradeDate: bars.at(-1)!.date,
    },
    bars,
    dividends: [],
    splits: [],
    adjustment: 'split-adjusted' as const,
    interval: 'weekly' as const,
    source: 'alphavantage',
    synthetic: false,
    fetchedAt: new Date().toISOString(),
  } satisfies PriceSeries;
}

class StubProvider implements MarketDataProvider {
  readonly id = 'stub';
  readonly label = 'Stub';
  readonly synthetic = false;
  readonly description = 'Weekly fixture';
  constructor(private readonly series: PriceSeries) {}
  private slice(range: DateRange): PriceSeries {
    return {
      ...this.series,
      bars: this.series.bars.filter((b) => b.date >= range.start && b.date <= range.end),
    };
  }
  async getHistoricalPrices(_s: string, range: DateRange) {
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

describe('weekly data annualises as weekly', () => {
  const series = weeklySeries('XEQT.TO', '2020-01-06', 209, 0.002); // 4 years
  const config = testConfig({
    start: '2020-01-06',
    end: '2023-12-31',
    initialInvestment: 10_000,
    rebalance: 'never',
    dividends: 'reinvest',
    inceptionPolicy: 'truncate',
  });

  it('derives about 52 periods a year, not the daily floor of 200', async () => {
    // The floor used to be 200 regardless of interval. Applied to weekly bars
    // that scales volatility by sqrt(200) instead of sqrt(52) — roughly double.
    const data = await prepareData({
      symbols: [{ symbol: 'XEQT.TO', weight: 100 }],
      config,
      provider: new StubProvider(series),
    });
    expect(data.periodsPerYear).toBeGreaterThan(45);
    expect(data.periodsPerYear).toBeLessThan(54);
  });

  it('warns that intra-week drawdowns are invisible', async () => {
    const data = await prepareData({
      symbols: [{ symbol: 'XEQT.TO', weight: 100 }],
      config,
      provider: new StubProvider(series),
    });
    const warning = data.warnings.find((w) => w.code === 'coarse-interval');
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/weekly resolution/);
    expect(warning!.message).toMatch(/floor, not the figure/);
  });

  it('annualises a known weekly return correctly', async () => {
    const data = await prepareData({
      symbols: [{ symbol: 'XEQT.TO', weight: 100 }],
      config,
      provider: new StubProvider(series),
    });
    const result = runEngine({
      portfolio: { id: 'p', name: 'P', positions: [{ id: 'x', symbol: 'XEQT.TO', weight: 100 }] },
      config,
      data,
    });
    const metrics = computeMetrics({
      daily: result.daily,
      periodsPerYear: result.periodsPerYear,
      riskFree: data.riskFree,
    });
    // 0.2% a week compounds to (1.002^52 - 1) = 10.94% a year.
    expect(metrics.returns.cagr).toBeGreaterThan(0.10);
    expect(metrics.returns.cagr).toBeLessThan(0.12);
    // A constant return has no dispersion, so volatility must be ~0 whatever
    // the annualisation factor — this isolates the CAGR check above.
    expect(metrics.risk.volatility).toBeLessThan(0.01);
  });

  it('scales volatility by sqrt(52), not sqrt(252)', async () => {
    // The actual harm of the old floor: risk overstated about twofold. A
    // ±1% alternating weekly return has a per-period standard deviation of
    // 1%, so annualised volatility must be 0.01*sqrt(52) = 7.2%, not
    // 0.01*sqrt(200) = 14.1%.
    const wobbly = weeklySeries('XEQT.TO', '2020-01-06', 209, 0.002, 0.01);
    const data = await prepareData({
      symbols: [{ symbol: 'XEQT.TO', weight: 100 }],
      config,
      provider: new StubProvider(wobbly),
    });
    const result = runEngine({
      portfolio: { id: 'p', name: 'P', positions: [{ id: 'x', symbol: 'XEQT.TO', weight: 100 }] },
      config,
      data,
    });
    const metrics = computeMetrics({
      daily: result.daily,
      periodsPerYear: result.periodsPerYear,
      riskFree: data.riskFree,
    });
    expect(metrics.risk.volatility).toBeGreaterThan(0.06);
    expect(metrics.risk.volatility).toBeLessThan(0.085);
  });
});


describe('integrity checks respect the bar interval', () => {
  /**
   * adjClose equals close on every bar, so the implied dividend works out to
   * zero and every reported dividend mismatches. Three of them clears the
   * check's `> max(1, n*0.1)` threshold.
   */
  function seriesWithDividends(interval: 'daily' | 'weekly'): PriceSeries {
    const dates = ['2024-01-05', '2024-01-12', '2024-01-19', '2024-01-26'] as IsoDate[];
    return {
      meta: {
        symbol: 'XEQT.TO', name: 'XEQT', assetClass: 'etf', currency: 'CAD',
        firstTradeDate: dates[0], lastTradeDate: dates[3],
      },
      bars: dates.map((date, i) => {
        const price = 100 + i;
        return { date, open: price, high: price, low: price, close: price, adjClose: price, volume: 0 };
      }),
      dividends: dates.slice(1).map((date) => ({ date, amount: 0.5 })),
      splits: [],
      adjustment: 'split-adjusted',
      interval: interval === 'weekly' ? 'weekly' : undefined,
      source: 'test',
      synthetic: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  it('still reconciles dividends on a daily series', () => {
    // The control. Without it the weekly assertion below would pass on a
    // fixture that never trips the check at all.
    const warnings = checkSeries(seriesWithDividends('daily'));
    expect(warnings.map((w) => w.code)).toContain('dividend-mismatch');
  });

  it('does not reconcile dividends on a weekly series', () => {
    // Same numbers, declared weekly. The implied dividend comes from the
    // PREVIOUS bar's close — a week before the ex-date rather than the day
    // before — so the comparison is meaningless. A warning that always fires
    // teaches people to ignore the one that matters on daily data.
    const warnings = checkSeries(seriesWithDividends('weekly'));
    expect(warnings.map((w) => w.code)).not.toContain('dividend-mismatch');
  });

  it('does not call a normal seven-day weekly spacing a history gap', () => {
    expect(checkSeries(seriesWithDividends('weekly')).map((w) => w.code)).not.toContain(
      'history-gap',
    );
  });
});


describe('a weekly holding alongside a daily benchmark', () => {
  /**
   * The case the rest of this file missed.
   *
   * The master calendar is a UNION of every series' bar dates, so one daily
   * series made the whole calendar daily while the weekly holding sat stale
   * four days in five. Its returns then landed on one day a week but were
   * annualised as weekly, understating volatility about twofold — and its last
   * weekly bar, a few days short of the final calendar day, tripped the
   * engine's delisting rule and liquidated a live position to cash.
   *
   * Live numbers before the fix: 7.22% volatility and a spurious liquidation.
   * After: 15.73%, matching the weekly-only run.
   */
  const weekly = weeklySeries('XEQT.TO', '2020-01-06', 209, 0.002, 0.01);

  /** Daily bars over the same span, as a benchmark would supply. */
  function dailySeries(symbol: string, start: string, days: number): PriceSeries {
    const bars = [];
    let price = 100;
    let t = Date.parse(`${start}T00:00:00Z`);
    for (let i = 0; i < days; i++) {
      const d = new Date(t);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const date = d.toISOString().slice(0, 10) as IsoDate;
        bars.push({ date, open: price, high: price, low: price, close: price, adjClose: price, volume: 0 });
        price *= 1.0004;
      }
      t += 86_400_000;
    }
    return {
      meta: {
        symbol, name: symbol, assetClass: 'etf', currency: 'USD',
        firstTradeDate: bars[0].date, lastTradeDate: bars.at(-1)!.date,
      },
      bars, dividends: [], splits: [],
      adjustment: 'split-adjusted', source: 'test', synthetic: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Serves a different series per symbol. */
  class MixedProvider implements MarketDataProvider {
    readonly id = 'mixed';
    readonly label = 'Mixed';
    readonly synthetic = false;
    readonly description = 'Weekly holding, daily benchmark';
    constructor(private readonly bySymbol: Record<string, PriceSeries>) {}
    private slice(symbol: string, range: DateRange): PriceSeries {
      const s = this.bySymbol[symbol];
      if (!s) throw new Error(`no series for ${symbol}`);
      return { ...s, bars: s.bars.filter((b) => b.date >= range.start && b.date <= range.end) };
    }
    async getHistoricalPrices(symbol: string, range: DateRange) {
      return this.slice(symbol, range);
    }
    async getCorporateActions(symbol: string, range: DateRange) {
      const x = this.slice(symbol, range);
      return { dividends: x.dividends, splits: x.splits };
    }
    async getDividends(symbol: string, range: DateRange) {
      return this.slice(symbol, range).dividends;
    }
    async getTradingCalendar(range: DateRange): Promise<IsoDate[]> {
      // A DAILY exchange calendar, which is what pulled the run daily before.
      return this.slice('SPY', range).bars.map((b) => b.date);
    }
    async search() {
      return [];
    }
  }

  const provider = new MixedProvider({
    'XEQT.TO': weekly,
    SPY: dailySeries('SPY', '2020-01-06', 209 * 7),
  });
  const config = testConfig({
    start: '2020-01-06', end: '2023-12-31', initialInvestment: 10_000,
    rebalance: 'never', dividends: 'reinvest', inceptionPolicy: 'truncate',
    benchmarks: ['SPY'],
  });
  const load = () =>
    prepareData({ symbols: [{ symbol: 'XEQT.TO', weight: 100 }], config, provider, extraSymbols: ['SPY'] });

  it('builds a weekly calendar, not a daily one', async () => {
    const data = await load();
    // ~209 weeks, not ~1045 weekdays.
    expect(data.calendar.length).toBeLessThan(250);
    expect(data.calendar.length).toBeGreaterThan(180);
  });

  it('keeps periodsPerYear weekly despite the daily benchmark', async () => {
    const data = await load();
    expect(data.periodsPerYear).toBeGreaterThan(45);
    expect(data.periodsPerYear).toBeLessThan(54);
  });

  it('reports the same volatility as the weekly-only run', async () => {
    const data = await load();
    const result = runEngine({
      portfolio: { id: 'p', name: 'P', positions: [{ id: 'x', symbol: 'XEQT.TO', weight: 100 }] },
      config, data,
    });
    const m = computeMetrics({
      daily: result.daily, periodsPerYear: result.periodsPerYear, riskFree: data.riskFree,
    });
    // The bug produced ~7.2% here against ~15.7% weekly-only.
    expect(m.risk.volatility).toBeGreaterThan(0.06);
    expect(m.risk.volatility).toBeLessThan(0.085);
  });

  it('does not liquidate a live position for ending a few days early', async () => {
    const data = await load();
    const result = runEngine({
      portfolio: { id: 'p', name: 'P', positions: [{ id: 'x', symbol: 'XEQT.TO', weight: 100 }] },
      config, data,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain('position-liquidated');
  });
});
