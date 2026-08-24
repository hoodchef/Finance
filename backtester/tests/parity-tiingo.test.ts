import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { __testing } from '../src/lib/market-data/tiingo';
import type { MarketDataProvider } from '../src/lib/market-data/provider';
import type { DateRange, IsoDate, PriceSeries } from '../src/lib/types';
import { prepareData } from '../src/lib/engine/prepare';
import { runEngine } from '../src/lib/engine/engine';
import { computeMetrics } from '../src/lib/metrics';
import { testConfig } from './helpers';

/**
 * Independent-reference parity, second vendor.
 * =============================================================================
 * `tests/parity.test.ts` checks the engine against Yahoo. Yahoo back-adjusts:
 * its adjusted close implies C_t / (C_{t−1} − D_t), a return nobody can trade,
 * so the engine can only be shown to agree with it to ~1e-5.
 *
 * Tiingo is a genuinely independent check, and a sharper one. Its adjusted
 * columns are derived by scaling every bar before an ex-date by
 * C_ex / (C_ex + D), which telescopes to
 *
 *     adjC_t / adjC_{t−1}  =  (C_t + D_t) / C_{t−1}
 *
 * — the exact total-return convention, the same one the engine implements. So
 * where Yahoo can only bound the disagreement, Tiingo should agree to floating
 * point.
 *
 * That convention was not taken from documentation; it was derived from the
 * data. `derives the vendor's adjustment convention from the bars themselves`
 * below re-derives it on every run, so if Tiingo ever changes how it adjusts,
 * this suite fails loudly rather than quietly re-baselining.
 *
 * Fixtures are raw recorded responses (`scripts/record-tiingo-fixtures.mjs`).
 * The engine sees only `close`/`divCash`/`splitFactor`; the reference uses only
 * `adjClose`. Nothing is shared between the two sides but the recording.
 */

const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Tiingo's licence is personal-use only, so the recordings are gitignored and
 * absent on a fresh clone. Skipping is the right default — but a suite that
 * silently disappears is how a parity anchor rots unnoticed, so
 * `REQUIRE_FIXTURES=1` (what `npm run test:parity` sets) turns absence into a
 * failure. Regenerate with `npm run record:fixtures`.
 */
const REQUIRED = process.env.REQUIRE_FIXTURES === '1';

const has = (file: string) => {
  const present = fs.existsSync(path.join(FIXTURES, file));
  if (!present && REQUIRED) {
    throw new Error(
      `REQUIRE_FIXTURES=1 but tests/fixtures/${file} is missing. ` +
        'Run `npm run record:fixtures` with TIINGO_API_KEY set.',
    );
  }
  return present;
};

/** Fixtures hold whatever `parse` takes, so the two cannot drift apart. */
type ParseArgs = Parameters<typeof __testing.parse>;

interface Fixture {
  symbol: string;
  meta: ParseArgs[1];
  prices: ParseArgs[2];
}

function fixture(file: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')) as Fixture;
}

function fixtureSeries(file: string): PriceSeries {
  const raw = fixture(file);
  return __testing.parse(raw.symbol, raw.meta, raw.prices);
}

/** Exact total return, chained from raw closes and cash dividends. */
function exactTotalReturn(
  bars: Array<{ date: IsoDate; close: number }>,
  dividends: Map<IsoDate, number>,
  splitFactor: Map<IsoDate, number>,
): number {
  let acc = 1;
  for (let i = 1; i < bars.length; i++) {
    // A split multiplies the share count and divides the price; the holding's
    // value is unchanged, so the raw close must be put back on the prior bar's
    // footing before the ratio means anything.
    const s = splitFactor.get(bars[i].date) ?? 1;
    const close = bars[i].close * s;
    acc *= (close + (dividends.get(bars[i].date) ?? 0) * s) / bars[i - 1].close;
  }
  return acc - 1;
}

/** Serves one in-memory series, so the test never touches the network. */
class StubProvider implements MarketDataProvider {
  readonly id = 'stub';
  readonly label = 'Stub';
  readonly synthetic = false;
  readonly description = 'Recorded Tiingo fixture';
  constructor(private readonly series: PriceSeries) {}

  private slice(range: DateRange): PriceSeries {
    return {
      ...this.series,
      bars: this.series.bars.filter((b) => b.date >= range.start && b.date <= range.end),
      dividends: this.series.dividends.filter((d) => d.date >= range.start && d.date <= range.end),
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

async function buyAndHold(series: PriceSeries, start: IsoDate, end: IsoDate) {
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
  const data = await prepareData({ symbols: [{ symbol, weight: 100 }], config, provider });
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
  return {
    result,
    metrics,
    bars,
    exact: exactTotalReturn(
      bars,
      new Map(data.assets[0].series!.dividends.map((d) => [d.date, d.amount])),
      new Map(data.assets[0].series!.splits.map((s) => [s.date, s.numerator / s.denominator])),
    ),
    vendorAdjClose: bars[bars.length - 1].adjClose / bars[0].adjClose - 1,
  };
}

describe.runIf(has('tiingo-spy-2015-2024.json'))('Tiingo adjustment convention', () => {
  it('derives the vendor’s adjustment convention from the bars themselves', () => {
    // Re-derives, rather than trusts, how Tiingo adjusts. If this drifts, every
    // tolerance below is invalidated and should fail here first.
    const raw = fixture('tiingo-spy-2015-2024.json').prices;
    let checked = 0;
    let worstTiingo = 0;
    let worstYahoo = 0;
    for (let i = 1; i < raw.length; i++) {
      const b = raw[i];
      const prev = raw[i - 1];
      if (!(b.divCash > 0) || b.splitFactor !== 1) continue;
      checked++;
      // How much the cumulative adjustment factor steps across the ex-date.
      const jump = b.adjClose / b.close / (prev.adjClose / prev.close);
      worstTiingo = Math.max(worstTiingo, Math.abs(jump / (1 + b.divCash / b.close) - 1));
      worstYahoo = Math.max(worstYahoo, Math.abs(jump / (1 / (1 - b.divCash / prev.close)) - 1));
    }
    expect(checked).toBeGreaterThanOrEqual(40);
    // Tiingo scales prior bars by C_ex/(C_ex + D) — exact total return.
    expect(worstTiingo).toBeLessThan(1e-9);
    // And demonstrably NOT Yahoo's back-adjustment, or this suite would be
    // asserting the same convention twice under two names.
    expect(worstYahoo).toBeGreaterThan(1e-6);
  });
});

describe.runIf(has('tiingo-spy-2015-2024.json'))('parity against ten years of SPY', () => {
  it('reproduces the vendor adjusted close to floating point', async () => {
    const { metrics, exact, vendorAdjClose, result } = await buyAndHold(
      fixtureSeries('tiingo-spy-2015-2024.json'),
      '2015-01-02',
      '2024-12-31',
    );
    expect(metrics.returns.totalReturn).toBeCloseTo(exact, 9);
    // Same convention on both sides, so this is far tighter than the ~1e-5 the
    // Yahoo suite can manage.
    expect(exact).toBeCloseTo(vendorAdjClose, 8);
    expect(metrics.returns.totalReturn).toBeCloseTo(vendorAdjClose, 8);
    expect(result.totals.totalDividends).toBeGreaterThan(0);
  });

  it('separates total return from price return by the dividends actually paid', async () => {
    const series = fixtureSeries('tiingo-spy-2015-2024.json');
    const { metrics, bars } = await buyAndHold(series, '2015-01-02', '2024-12-31');
    const priceOnly = bars[bars.length - 1].close / bars[0].close - 1;
    // Confirms the test has teeth: a decade of SPY distributions is worth well
    // over ten points of terminal return.
    expect(metrics.returns.totalReturn - priceOnly).toBeGreaterThan(0.1);
  });
});

describe.runIf(has('tiingo-bnd-2015-2024.json'))('parity across monthly distributions', () => {
  it('chains 120 BND distributions without drift', async () => {
    const series = fixtureSeries('tiingo-bnd-2015-2024.json');
    expect(series.dividends.length).toBeGreaterThanOrEqual(100);
    const { metrics, exact, vendorAdjClose } = await buyAndHold(
      series,
      '2015-01-02',
      '2024-12-31',
    );
    // Ten years of monthly events is where a per-event convention error would
    // compound into something visible. It does not.
    expect(metrics.returns.totalReturn).toBeCloseTo(exact, 9);
    expect(metrics.returns.totalReturn).toBeCloseTo(vendorAdjClose, 8);
  });
});

describe.runIf(has('tiingo-aapl-split-2020.json'))('parity across a 4:1 split', () => {
  it('matches AAPL total return through the split and its dividends', async () => {
    const series = fixtureSeries('tiingo-aapl-split-2020.json');
    expect(series.splits.length).toBe(1);
    expect(series.splits[0].numerator / series.splits[0].denominator).toBeCloseTo(4, 10);
    const { metrics, exact, vendorAdjClose } = await buyAndHold(
      series,
      '2019-01-02',
      '2021-12-31',
    );
    expect(metrics.returns.totalReturn).toBeCloseTo(exact, 9);
    expect(metrics.returns.totalReturn).toBeCloseTo(vendorAdjClose, 8);
  });

  it('holds four times the shares after the split', async () => {
    const series = fixtureSeries('tiingo-aapl-split-2020.json');
    const { result } = await buyAndHold(series, '2020-08-24', '2020-09-04');
    const shares = result.daily.map((d) => d.positionShares.AAPL ?? 0).filter((s) => s > 0);
    // 2020-08-31 was the ex-date; the share count must step by exactly 4.
    expect(Math.max(...shares) / Math.min(...shares)).toBeCloseTo(4, 6);
  });
});
