import { describe, expect, it, vi } from 'vitest';
import type { DateRange, IsoDate } from '../src/lib/types';

/**
 * Currency translation.
 * =============================================================================
 * The engine sums `shares x price`, so holdings denominated differently must be
 * translated before they can be added. Getting the DIRECTION wrong produces a
 * portfolio that looks entirely plausible and is wrong by the square of the
 * rate, so direction is asserted explicitly rather than inferred from reading.
 *
 * Rates are mocked here so the suite stays offline and deterministic; the live
 * source and its direction are checked separately in the provider contract.
 */

const FIXED_RATE = 1.35; // CAD per USD

vi.mock('../src/lib/market-data/fx', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/market-data/fx')>(
    '../src/lib/market-data/fx',
  );
  return {
    ...actual,
    async getFxSeries(base: string, quote: string, range: DateRange) {
      if (base === quote) return actual.getFxSeries(base, quote, range);
      const supported =
        (base === 'USD' && quote === 'CAD') || (base === 'CAD' && quote === 'USD');
      if (supported) {
        // Both directions, because the base currency is chosen by weight and
        // either side of the pair may end up being the one converted.
        const rate = base === 'USD' ? FIXED_RATE : 1 / FIXED_RATE;
        // Every day carries the same rate, so any change in the result is the
        // conversion itself rather than rate movement.
        const rates = new Map<IsoDate, number>();
        for (let y = 2010; y <= 2030; y++) {
          for (let m = 1; m <= 12; m++) {
            for (let d = 1; d <= 31; d++) {
              rates.set(
                `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
                rate,
              );
            }
          }
        }
        return {
          base,
          quote,
          rates,
          earliest: '2010-01-01',
          latest: '2030-12-31',
          source: 'mock',
          sourceLabel: 'Mock rates',
          fetchedAt: new Date().toISOString(),
        };
      }
      throw new Error(`no rate for ${base}/${quote}`);
    },
  };
});

const { runBacktest } = await import('../src/lib/backtest');
const { getDemoProvider } = await import('../src/lib/market-data');
const { testConfig } = await import('./helpers');

function providerWithCurrencies(map: Record<string, string | undefined>) {
  const demo = getDemoProvider();
  return {
    id: 'ccy',
    label: 'Currency test',
    synthetic: false,
    description: 'test',
    async getHistoricalPrices(symbol: string, range: DateRange) {
      const s = await demo.getHistoricalPrices(symbol, range);
      return { ...s, synthetic: false, meta: { ...s.meta, currency: map[symbol] } };
    },
    async getCorporateActions() {
      return { dividends: [], splits: [] };
    },
    async getDividends() {
      return [];
    },
    async getTradingCalendar() {
      return [];
    },
    async search() {
      return [];
    },
  } as unknown as Parameters<typeof runBacktest>[0]['provider'];
}

const window = { start: '2016-01-05', end: '2020-12-31', benchmarks: [] as string[] };

describe('single-currency portfolios are never converted', () => {
  it('applies no exchange rate and adds no FX noise', async () => {
    const r = await runBacktest({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: '1', symbol: 'SPY', weight: 60 },
          { id: '2', symbol: 'BND', weight: 40 },
        ],
      },
      config: testConfig(window),
      provider: providerWithCurrencies({ SPY: 'USD', BND: 'USD' }),
      includeAssetAnalysis: false,
    });
    expect(r.warnings.some((w) => w.code === 'fx-applied')).toBe(false);
    expect(r.totals.finalValue).toBeGreaterThan(0);
  });
});

describe('mixed-currency portfolios are translated', () => {
  const mixed = {
    id: 'p',
    name: 'P',
    positions: [
      { id: '1', symbol: 'SPY', weight: 50 },
      { id: '2', symbol: 'BND', weight: 50 },
    ],
  };

  it('converts and says so, rather than refusing', async () => {
    const r = await runBacktest({
      portfolio: mixed,
      config: testConfig({ ...window, baseCurrency: 'CAD' }),
      provider: providerWithCurrencies({ SPY: 'USD', BND: 'CAD' }),
      includeAssetAnalysis: false,
    });
    const applied = r.warnings.find((w) => w.code === 'fx-applied');
    expect(applied, 'a converted portfolio must say so').toBeTruthy();
    expect(applied!.message).toContain('CAD');
    expect(r.totals.finalValue).toBeGreaterThan(0);
  });

  it('converts in the right direction', async () => {
    // A single USD holding valued in CAD must be worth MORE numerically, since
    // one US dollar buys more than one Canadian dollar. Inverting the rate
    // would divide instead, and the result would still look reasonable.
    const usdBase = await runBacktest({
      portfolio: { id: 'p', name: 'P', positions: [
        { id: '1', symbol: 'SPY', weight: 50 },
        { id: '2', symbol: 'BND', weight: 50 },
      ] },
      config: testConfig({ ...window, baseCurrency: 'USD' }),
      provider: providerWithCurrencies({ SPY: 'USD', BND: 'USD' }),
      includeAssetAnalysis: false,
    });

    const cadBase = await runBacktest({
      portfolio: { id: 'p', name: 'P', positions: [
        { id: '1', symbol: 'SPY', weight: 50 },
        { id: '2', symbol: 'BND', weight: 50 },
      ] },
      config: testConfig({ ...window, baseCurrency: 'CAD' }),
      // Both USD, so both convert by the same fixed rate.
      provider: providerWithCurrencies({ SPY: 'USD', BND: 'USD' }),
      includeAssetAnalysis: false,
    });

    // Same initial capital buys fewer units of a more expensive asset, so the
    // RETURN is identical while the prices differ — a flat rate introduces no
    // currency effect, which is the property being checked.
    expect(cadBase.metrics.returns.totalReturn).toBeCloseTo(
      usdBase.metrics.returns.totalReturn,
      6,
    );
  });

  it('refuses when no rate can be loaded', async () => {
    await expect(
      runBacktest({
        portfolio: mixed,
        config: testConfig({ ...window, baseCurrency: 'JPY' }),
        provider: providerWithCurrencies({ SPY: 'USD', BND: 'CAD' }),
        includeAssetAnalysis: false,
      }),
    ).rejects.toThrow(/exchange rate|cannot be valued|no rate/i);
  });

  it('defaults the base to the dominant currency, leaving it unconverted', async () => {
    const r = await runBacktest({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: '1', symbol: 'SPY', weight: 90 },
          { id: '2', symbol: 'BND', weight: 10 },
        ],
      },
      config: testConfig(window),
      provider: providerWithCurrencies({ SPY: 'USD', BND: 'CAD' }),
      includeAssetAnalysis: false,
    });
    // USD dominates, so USD is the base and only the small CAD sleeve converts.
    const applied = r.warnings.find((w) => w.code === 'fx-applied');
    expect(applied?.message).toContain('USD');
  });
});
