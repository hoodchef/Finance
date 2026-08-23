import type { BacktestWarning, DateRange, IsoDate } from '@/lib/types';
import { diskGet, diskSet, memoryGet, memorySet } from './cache';
import type { PriceSeries } from '@/lib/types';

/**
 * Inflation adjustment.
 * =============================================================================
 * Real returns answer the question nominal returns cannot: did this portfolio
 * buy more at the end than at the start?
 *
 * Two sources, and the difference between them matters:
 *
 *  - `cpi` uses the published US CPI series. It is measured data.
 *  - `constant` uses a rate the user typed. It is an assumption, and the UI
 *    says so wherever a figure derived from it is shown.
 *
 * Nothing here falls back from the first to the second silently. If the CPI
 * series cannot be loaded, the run reports that and stays nominal rather than
 * quietly substituting a guess.
 */

/** The series used: CPI for All Urban Consumers, seasonally adjusted. */
export const CPI_SERIES_ID = 'CPIAUCSL';
const FRED_CSV = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${CPI_SERIES_ID}`;
const CACHE_KEY = `fred:${CPI_SERIES_ID}`;

export interface CpiObservation {
  /** First day of the month the reading refers to. */
  date: IsoDate;
  index: number;
}

export interface InflationSeries {
  observations: CpiObservation[];
  source: string;
  label: string;
  synthetic: boolean;
  fetchedAt: string;
}

export interface InflationProvider {
  readonly id: string;
  readonly label: string;
  readonly synthetic: boolean;
  getSeries(range: DateRange): Promise<InflationSeries>;
}

/**
 * US CPI-U from the St. Louis Fed. A plain CSV endpoint, no key required.
 * Reuses the price cache so a repeated backtest costs nothing.
 */
export class FredInflationProvider implements InflationProvider {
  readonly id = 'fred';
  readonly label = `US CPI-U, seasonally adjusted (FRED ${CPI_SERIES_ID})`;
  readonly synthetic = false;

  async getSeries(range: DateRange): Promise<InflationSeries> {
    const cached = memoryGet(CACHE_KEY) ?? (await diskGet(CACHE_KEY));
    if (cached) return sliceSeries(fromCacheShape(cached), range);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(FRED_CSV, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const observations = parseFredCsv(await res.text());
      if (observations.length < 24) throw new Error('series too short to use');

      const series: InflationSeries = {
        observations,
        source: 'fred',
        label: this.label,
        synthetic: false,
        fetchedAt: new Date().toISOString(),
      };

      const shape = toCacheShape(series);
      memorySet(CACHE_KEY, shape);
      void diskSet(CACHE_KEY, shape);
      return sliceSeries(series, range);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A flat rate the user supplied. It is an assumption about the future or the
 * past, not a measurement, and every figure derived from it is labelled.
 */
export class ConstantInflationProvider implements InflationProvider {
  readonly id = 'constant';
  readonly synthetic = true;
  readonly label: string;

  constructor(private readonly annualPct: number) {
    this.label = `Assumed ${annualPct}% a year`;
  }

  async getSeries(range: DateRange): Promise<InflationSeries> {
    const rate = this.annualPct / 100;
    const observations: CpiObservation[] = [];
    const start = new Date(`${range.start.slice(0, 7)}-01T00:00:00.000Z`);
    const end = new Date(`${range.end.slice(0, 7)}-01T00:00:00.000Z`);

    let level = 100;
    const monthly = Math.pow(1 + rate, 1 / 12);
    for (let d = start; d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
      observations.push({ date: d.toISOString().slice(0, 10), index: level });
      level *= monthly;
    }

    return {
      observations,
      source: 'constant',
      label: this.label,
      synthetic: true,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export function parseFredCsv(csv: string): CpiObservation[] {
  const out: CpiObservation[] = [];
  const lines = csv.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(',');
    if (!date || !raw) continue;
    const index = Number(raw.trim());
    // FRED writes "." for a missing observation.
    if (!Number.isFinite(index) || index <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) continue;
    out.push({ date: date.trim(), index });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function sliceSeries(series: InflationSeries, range: DateRange): InflationSeries {
  // Keep one observation before the window so the first day can be deflated.
  const startMonth = range.start.slice(0, 7);
  const endMonth = range.end.slice(0, 7);
  const kept = series.observations.filter(
    (o) => o.date.slice(0, 7) >= startMonth && o.date.slice(0, 7) <= endMonth,
  );
  const earlier = series.observations.filter((o) => o.date.slice(0, 7) < startMonth).at(-1);
  return { ...series, observations: earlier ? [earlier, ...kept] : kept };
}

/* The cache is typed for price series; these adapt without a second store. */
function toCacheShape(series: InflationSeries): PriceSeries {
  return {
    meta: {
      symbol: CPI_SERIES_ID,
      name: series.label,
      assetClass: 'other',
      currency: 'USD',
    },
    bars: series.observations.map((o) => ({
      date: o.date,
      open: o.index,
      high: o.index,
      low: o.index,
      close: o.index,
      adjClose: o.index,
      volume: 0,
    })),
    dividends: [],
    splits: [],
    adjustment: 'split-adjusted',
    source: series.source,
    synthetic: series.synthetic,
    fetchedAt: series.fetchedAt,
  };
}

function fromCacheShape(shape: PriceSeries): InflationSeries {
  return {
    observations: shape.bars.map((b) => ({ date: b.date, index: b.close })),
    source: shape.source,
    label: shape.meta.name,
    synthetic: shape.synthetic,
    fetchedAt: shape.fetchedAt,
  };
}

/**
 * Expands monthly observations onto a daily calendar.
 *
 * CPI describes a whole month, so every day in a month carries that month's
 * reading — a step function, not an interpolation. Interpolating would invent
 * daily price-level movements that were never measured, and would show up as
 * spurious daily real-return volatility.
 *
 * Returns a deflator relative to the first calendar day: divide a nominal value
 * by it to express that value in first-day dollars.
 */
export function buildDeflator(
  calendar: IsoDate[],
  series: InflationSeries,
): { deflator: number[]; warnings: BacktestWarning[] } {
  const warnings: BacktestWarning[] = [];
  const deflator = new Array<number>(calendar.length).fill(1);
  if (!calendar.length) return { deflator, warnings };

  if (!series.observations.length) {
    // Silently returning a flat deflator would present nominal figures under a
    // "real" heading, which is the one outcome this feature must never produce.
    warnings.push({
      severity: 'warning',
      code: 'inflation-unavailable',
      message:
        'The inflation series returned no observations, so results are shown in nominal terms only.',
    });
    return { deflator, warnings };
  }

  const byMonth = new Map(series.observations.map((o) => [o.date.slice(0, 7), o.index]));

  const levels = new Array<number>(calendar.length).fill(Number.NaN);
  let last = Number.NaN;
  let missingTail = 0;

  for (let i = 0; i < calendar.length; i++) {
    const level = byMonth.get(calendar[i].slice(0, 7));
    if (level != null) {
      last = level;
      levels[i] = level;
    } else if (Number.isFinite(last)) {
      // CPI is published with a lag, so the final weeks of a backtest often
      // have no reading yet. Carrying the last one forward understates recent
      // inflation slightly; inventing one would be worse.
      levels[i] = last;
      missingTail++;
    }
  }

  // Any leading gap: back-fill from the first known reading.
  const firstKnown = levels.findIndex((v) => Number.isFinite(v));
  if (firstKnown < 0) {
    warnings.push({
      severity: 'warning',
      code: 'inflation-unavailable',
      message:
        'No inflation observations overlap this backtest, so results are shown in nominal terms only.',
    });
    return { deflator, warnings };
  }
  for (let i = 0; i < firstKnown; i++) levels[i] = levels[firstKnown];

  const base = levels[0];
  for (let i = 0; i < calendar.length; i++) deflator[i] = levels[i] / base;

  if (missingTail > 25) {
    warnings.push({
      severity: 'info',
      code: 'inflation-lagged',
      message: `The inflation series has no reading for the final ${missingTail} trading days — CPI is published with a lag. The last available month is carried forward, so recent real returns are marginally overstated.`,
    });
  }

  return { deflator, warnings };
}

export function getInflationProvider(
  mode: 'cpi' | 'constant',
  constantPct: number,
): InflationProvider {
  return mode === 'cpi'
    ? new FredInflationProvider()
    : new ConstantInflationProvider(constantPct);
}
