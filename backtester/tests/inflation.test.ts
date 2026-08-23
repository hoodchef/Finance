import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ConstantInflationProvider,
  buildDeflator,
  parseFredCsv,
  type InflationSeries,
} from '../src/lib/market-data/inflation';
import { makeCalendar } from './helpers';

/**
 * Deflation is arithmetic, so these are exact. The behaviour that matters most
 * is what happens when data is missing: the deflator must degrade to 1 and warn
 * rather than invent a price path.
 */

const series = (points: Array<[string, number]>): InflationSeries => ({
  observations: points.map(([date, index]) => ({ date, index })),
  source: 'test',
  label: 'Test CPI',
  synthetic: false,
  fetchedAt: '2024-01-01T00:00:00.000Z',
});

describe('FRED CSV parsing', () => {
  it('reads observations and skips missing readings', () => {
    const parsed = parseFredCsv(
      [
        'observation_date,CPIAUCSL',
        '2020-01-01,257.971',
        '2020-02-01,.',
        '2020-03-01,258.115',
        'garbage line',
        '',
      ].join('\n'),
    );
    expect(parsed).toEqual([
      { date: '2020-01-01', index: 257.971 },
      { date: '2020-03-01', index: 258.115 },
    ]);
  });

  it('returns nothing for an empty or malformed file', () => {
    expect(parseFredCsv('observation_date,CPIAUCSL')).toEqual([]);
    expect(parseFredCsv('')).toEqual([]);
  });
});

describe('deflator', () => {
  it('is 1.0 on the first day and tracks the price level thereafter', () => {
    const cal = ['2020-01-02', '2020-01-31', '2020-02-03', '2020-03-02'];
    const { deflator } = buildDeflator(
      cal,
      series([
        ['2020-01-01', 100],
        ['2020-02-01', 110],
        ['2020-03-01', 121],
      ]),
    );
    expect(deflator[0]).toBeCloseTo(1, 12);
    expect(deflator[1]).toBeCloseTo(1, 12); // Same month, same reading.
    expect(deflator[2]).toBeCloseTo(1.1, 12);
    expect(deflator[3]).toBeCloseTo(1.21, 12);
  });

  it('holds a month flat rather than interpolating between readings', () => {
    // Interpolating would invent daily price-level moves nobody measured and
    // would show up as spurious daily real-return volatility.
    const cal = ['2020-01-02', '2020-01-15', '2020-01-31', '2020-02-03'];
    const { deflator } = buildDeflator(
      cal,
      series([
        ['2020-01-01', 100],
        ['2020-02-01', 200],
      ]),
    );
    expect(deflator[0]).toBeCloseTo(1, 12);
    expect(deflator[1]).toBeCloseTo(1, 12);
    expect(deflator[2]).toBeCloseTo(1, 12);
    expect(deflator[3]).toBeCloseTo(2, 12);
  });

  it('carries the last reading forward across the publication lag and says so', () => {
    const cal = makeCalendar('2020-01-01', 60); // Runs into March.
    const { deflator, warnings } = buildDeflator(
      cal,
      series([['2020-01-01', 100]]),
    );
    expect(deflator.every((d) => d === 1)).toBe(true);
    expect(warnings.some((w) => w.code === 'inflation-lagged')).toBe(true);
  });

  it('stays nominal and warns when nothing overlaps', () => {
    const cal = ['2020-01-02', '2020-02-03'];
    const { deflator, warnings } = buildDeflator(cal, series([]));
    expect(deflator).toEqual([1, 1]);
    expect(warnings.some((w) => w.code === 'inflation-unavailable')).toBe(true);
  });
});

describe('constant-rate provider', () => {
  it('compounds the assumed rate monthly and declares itself an assumption', async () => {
    const p = new ConstantInflationProvider(3);
    expect(p.synthetic).toBe(true);
    expect(p.label).toContain('Assumed');

    const s = await p.getSeries({ start: '2020-01-01', end: '2022-12-31' });
    const first = s.observations[0].index;
    const twelveMonthsLater = s.observations[12].index;
    expect(twelveMonthsLater / first).toBeCloseTo(1.03, 8);
  });

  it('produces a deflator matching the stated rate over a year', async () => {
    const cal = makeCalendar('2020-01-01', 300);
    const s = await new ConstantInflationProvider(5).getSeries({
      start: cal[0],
      end: cal[cal.length - 1],
    });
    const { deflator } = buildDeflator(cal, s);
    const oneYearIn = cal.findIndex((d) => d >= '2021-01-01');
    expect(deflator[oneYearIn]).toBeCloseTo(1.05, 4);
  });
});

describe('recorded CPI series', () => {
  const file = path.join(__dirname, 'fixtures', 'cpiaucsl.csv');

  it('parses the real FRED file into a monotonic price level', () => {
    const parsed = parseFredCsv(fs.readFileSync(file, 'utf8'));
    expect(parsed.length).toBeGreaterThan(900);
    expect(parsed[0].date).toBe('1947-01-01');
    // Every reading is a positive index and dates ascend without duplicates.
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i].index).toBeGreaterThan(0);
      expect(parsed[i].date > parsed[i - 1].date).toBe(true);
    }
  });

  it('reproduces known US inflation over a quarter century', () => {
    const parsed = parseFredCsv(fs.readFileSync(file, 'utf8'));
    const at = (month: string) => parsed.find((o) => o.date.startsWith(month))!.index;

    // The US price level roughly doubled between 1990 and 2020.
    const ratio1990to2020 = at('2020-01') / at('1990-01');
    expect(ratio1990to2020).toBeGreaterThan(1.8);
    expect(ratio1990to2020).toBeLessThan(2.2);

    // 2000 to 2023 annualises to the mid-2s, which is what the series shows.
    const ratio = at('2023-12') / at('2000-01');
    const annual = Math.pow(ratio, 1 / 24) - 1;
    expect(annual).toBeGreaterThan(0.02);
    expect(annual).toBeLessThan(0.03);
  });

  it('deflates a calendar without warnings when the series covers it', () => {
    const parsed = parseFredCsv(fs.readFileSync(file, 'utf8'));
    const cal = makeCalendar('2010-01-04', 2600);
    const { deflator, warnings } = buildDeflator(cal, {
      observations: parsed,
      source: 'fred',
      label: 'CPI',
      synthetic: false,
      fetchedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(deflator[0]).toBeCloseTo(1, 12);
    expect(deflator[deflator.length - 1]).toBeGreaterThan(1);
    expect(warnings.filter((w) => w.severity === 'warning')).toHaveLength(0);
  });
});

describe('real metrics through the engine', () => {
  it('satisfies the Fisher relation and deepens the real drawdown', async () => {
    const { runBacktest } = await import('../src/lib/backtest');
    const { DemoDataProvider } = await import('../src/lib/market-data/demo');
    const { testConfig } = await import('./helpers');

    const r = await runBacktest({
      portfolio: {
        id: 'p',
        name: 'P',
        positions: [
          { id: '1', symbol: 'SPY', weight: 60 },
          { id: '2', symbol: 'BND', weight: 40 },
        ],
      },
      config: testConfig({
        start: '2005-01-03',
        end: '2020-12-31',
        benchmarks: [],
        // A fixed rate keeps the expected value exact and offline.
        inflation: { mode: 'constant', constantPct: 3, adjustContributions: false },
      }),
      provider: new DemoDataProvider(),
    });

    expect(r.inflation).not.toBeNull();
    expect(r.realMetrics).not.toBeNull();
    const nominal = r.metrics.returns.cagr;
    const real = r.realMetrics!.returns.cagr;
    const inflationRate = r.inflation!.annualisedInflation;

    // (1 + nominal) = (1 + real)(1 + inflation), exactly — not nominal − inflation.
    expect((1 + nominal) / (1 + inflationRate) - 1).toBeCloseTo(real, 8);
    expect(real).toBeLessThan(nominal);

    // A real drawdown is deeper: prices kept rising while the portfolio fell.
    expect(r.realMetrics!.risk.maxDrawdown).toBeLessThan(r.metrics.risk.maxDrawdown);

    // Deflating shifts the level of returns, not their spread.
    expect(r.realMetrics!.risk.volatility).toBeCloseTo(r.metrics.risk.volatility, 2);

    // The series carries both, and they diverge over time.
    const last = r.series[r.series.length - 1];
    expect(last.realValue).toBeLessThan(last.value);
    expect(r.series[0].realValue).toBeCloseTo(r.series[0].value, 6);
  }, 20000);

  it('leaves everything nominal when adjustment is off', async () => {
    const { runBacktest } = await import('../src/lib/backtest');
    const { DemoDataProvider } = await import('../src/lib/market-data/demo');
    const { testConfig } = await import('./helpers');

    const r = await runBacktest({
      portfolio: { id: 'p', name: 'P', positions: [{ id: '1', symbol: 'SPY', weight: 100 }] },
      config: testConfig({ start: '2015-01-05', end: '2020-12-31', benchmarks: [] }),
      provider: new DemoDataProvider(),
    });

    expect(r.inflation).toBeNull();
    expect(r.realMetrics).toBeNull();
    // realValue mirrors value exactly rather than being silently deflated.
    for (const p of r.series) expect(p.realValue).toBeCloseTo(p.value, 10);
  }, 20000);

  it('grows contributions with the price level when asked', async () => {
    const { runEngine } = await import('../src/lib/engine/engine');
    const { buildPrepared, flat, makeCalendar, testConfig } = await import('./helpers');

    const cal = makeCalendar('2020-01-01', 800);
    // A 10% per-year price path, so the effect is unmistakable.
    const deflator = cal.map((_, i) => Math.pow(1.1, i / 261));
    const spec = [{ symbol: 'A', prices: flat(100, cal.length), weight: 100 }];
    const portfolio = { id: 'p', name: 'P', positions: [{ id: 'A', symbol: 'A', weight: 100 }] };

    const run = (adjust: boolean) =>
      runEngine({
        portfolio,
        config: testConfig({
          initialInvestment: 0,
          contributionAmount: 1_000,
          contributionFrequency: 'monthly',
          inflation: { mode: 'constant', constantPct: 10, adjustContributions: adjust },
        }),
        data: buildPrepared(cal, spec, 0, deflator),
      });

    const flatContrib = run(false);
    const grown = run(true);

    expect(grown.totals.totalContributions).toBeGreaterThan(
      flatContrib.totals.totalContributions,
    );
    // A flat market means the balance is exactly what was paid in, either way.
    expect(grown.totals.finalValue).toBeCloseTo(grown.totals.totalContributions, 4);
  });
});
