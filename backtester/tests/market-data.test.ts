import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { __testing } from '../src/lib/market-data/yahoo';
import {
  checkSeries,
  detectUnadjustedSplits,
  reconcileDividends,
} from '../src/lib/market-data/integrity';
import { DemoDataProvider } from '../src/lib/market-data/demo';
import type { PriceSeries } from '../src/lib/types';

const FIXTURES = path.join(__dirname, 'fixtures');

function load(file: string): PriceSeries {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  const symbol = raw.chart.result[0].meta.symbol;
  return __testing.parseChart(symbol, raw);
}

const has = (file: string) => fs.existsSync(path.join(FIXTURES, file));

/**
 * These assertions are the *reason* the engine can ignore splits and trust the
 * dividend feed. They run against a recorded live response, so if the provider
 * ever changes its adjustment convention the suite fails here rather than
 * producing quietly wrong backtests everywhere else.
 */
describe('Yahoo Finance data contract', () => {
  const series = load('aapl-split-2020.json');

  it('parses bars, dividends and splits', () => {
    expect(series.meta.symbol).toBe('AAPL');
    expect(series.bars.length).toBeGreaterThan(50);
    expect(series.adjustment).toBe('split-adjusted');
    expect(series.synthetic).toBe(false);
    expect(series.splits).toHaveLength(1);
    expect(series.splits[0]).toMatchObject({
      date: '2020-08-31',
      numerator: 4,
      denominator: 1,
    });
  });

  it('returns bars in ascending date order with positive prices', () => {
    for (let i = 1; i < series.bars.length; i++) {
      expect(series.bars[i].date > series.bars[i - 1].date).toBe(true);
    }
    expect(series.bars.every((b) => b.close > 0 && Number.isFinite(b.close))).toBe(true);
  });

  it('reports closes already adjusted for the later 4:1 split', () => {
    const before = series.bars.find((b) => b.date === '2020-08-28')!;
    const after = series.bars.find((b) => b.date === '2020-08-31')!;
    // As-traded, AAPL closed near $499 then near $129 — a 4× discontinuity.
    // The reported series shows no such jump, so it is retroactively adjusted.
    expect(before.close).toBeGreaterThan(100);
    expect(before.close).toBeLessThan(200);
    expect(Math.abs(after.close / before.close - 1)).toBeLessThan(0.1);
  });

  it('reports dividend amounts in the same split-adjusted units as prices', () => {
    const div = series.dividends.find((d) => d.date === '2020-08-07')!;
    // The as-paid amount was $0.82; a quarter of that after the 4:1 split.
    expect(div.amount).toBeCloseTo(0.205, 6);
    const priceThen = series.bars.find((b) => b.date === '2020-08-06')!.close;
    // Sanity: a quarterly dividend is a fraction of a percent of the price.
    expect(div.amount / priceThen).toBeLessThan(0.01);
  });

  it('rederives every dividend from the adjusted close to within 1%', () => {
    const recon = reconcileDividends(series);
    expect(recon.length).toBeGreaterThan(0);
    for (const r of recon) {
      expect(r.relativeError).toBeLessThan(0.01);
    }
  });

  it('finds no unapplied split in a correctly adjusted series', () => {
    expect(detectUnadjustedSplits(series)).toHaveLength(0);
    expect(checkSeries(series).filter((w) => w.severity === 'error')).toHaveLength(0);
  });

  it('flags a series that claims adjustment but contains a raw split', () => {
    // Re-inflate the pre-split closes to what actually traded.
    const corrupted: PriceSeries = {
      ...series,
      bars: series.bars.map((b) =>
        b.date < '2020-08-31' ? { ...b, close: b.close * 4 } : b,
      ),
    };
    const warnings = detectUnadjustedSplits(corrupted);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('unadjusted-split');
    expect(warnings[0].severity).toBe('error');
  });
});

describe.runIf(has('spy-2015-2024.json'))('longer recorded history', () => {
  it('reconciles a decade of SPY dividends against the adjusted close', () => {
    const spy = load('spy-2015-2024.json');
    const recon = reconcileDividends(spy);
    expect(recon.length).toBeGreaterThan(30);
    const bad = recon.filter((r) => r.relativeError > 0.01);
    expect(bad).toHaveLength(0);
  });
});

describe('demo provider', () => {
  const provider = new DemoDataProvider();

  it('announces itself as synthetic', async () => {
    expect(provider.synthetic).toBe(true);
    const s = await provider.getHistoricalPrices('SPY', { start: '2020-01-01', end: '2020-12-31' });
    expect(s.synthetic).toBe(true);
    expect(provider.description.toUpperCase()).toContain('SYNTHETIC');
  });

  it('is deterministic across calls and process state', async () => {
    const a = await provider.getHistoricalPrices('QQQ', { start: '2019-01-01', end: '2019-06-30' });
    const b = await new DemoDataProvider().getHistoricalPrices('QQQ', {
      start: '2019-01-01',
      end: '2019-06-30',
    });
    expect(b.bars.map((x) => x.close)).toEqual(a.bars.map((x) => x.close));
  });

  it('skips weekends and US market holidays', async () => {
    const s = await provider.getHistoricalPrices('SPY', { start: '2021-06-25', end: '2021-07-09' });
    const dates = s.bars.map((b) => b.date);
    expect(dates).not.toContain('2021-06-26'); // Saturday.
    expect(dates).not.toContain('2021-07-05'); // Independence Day, observed.
    expect(dates).toContain('2021-07-06');
  });

  it('produces an adjusted close that reconciles with its own dividends', async () => {
    const s = await provider.getHistoricalPrices('SPY', { start: '2015-01-01', end: '2020-12-31' });
    expect(s.dividends.length).toBeGreaterThan(10);
    const recon = reconcileDividends(s);
    for (const r of recon) expect(r.relativeError).toBeLessThan(0.01);
  });
});
