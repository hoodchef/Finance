import type { DateRange, IsoDate } from '@/lib/types';
import { MarketDataError } from './provider';
import { diskGetEntry, diskSet } from './cache';

/**
 * Foreign-exchange rates.
 * =============================================================================
 * A portfolio holding both a US and a Canadian listing cannot be valued without
 * these: summing USD and CAD prices adds incompatible units. Before this
 * existed the engine refused such portfolios, which was correct but limiting
 * for anyone in Canada holding both.
 *
 * DIRECTION MATTERS AND IS EASY TO INVERT
 *
 * A rate here is always "units of QUOTE per one unit of BASE". `USDCAD = 1.38`
 * means one US dollar buys 1.38 Canadian dollars, so a USD price is converted
 * to CAD by MULTIPLYING. Getting this backwards produces a portfolio that looks
 * plausible and is wrong by the square of the rate, so the direction is asserted
 * in tests against a known published value rather than trusted to reading.
 *
 * SOURCES, IN ORDER
 *
 *  1. Bank of Canada Valet — the official source for Canadian rates, free and
 *     keyless. Its published series begin in 2017, when the Bank replaced noon
 *     rates with indicative rates.
 *  2. Yahoo `<PAIR>=X` — deeper history, same caveats as the price feed.
 *
 * Where the requested window predates the available rates, the window is
 * truncated and the user told, exactly as for a security whose listing began
 * mid-backtest. Extrapolating a rate backwards would be inventing data.
 */

export interface FxSeries {
  base: string;
  quote: string;
  /** Rate by date: units of `quote` per one unit of `base`. */
  rates: Map<IsoDate, number>;
  earliest: IsoDate;
  latest: IsoDate;
  source: string;
  sourceLabel: string;
  fetchedAt: string;
}

const BOC_BASE = 'https://www.bankofcanada.ca/valet/observations';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function pairKey(base: string, quote: string): string {
  return `${base.toUpperCase()}${quote.toUpperCase()}`;
}

/** Bank of Canada publishes `FX<BASE>CAD` and `FXCAD<QUOTE>` style series. */
function bocSeriesFor(base: string, quote: string): string | null {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (q === 'CAD') return `FX${b}CAD`;
  if (b === 'CAD') return `FXCAD${q}`;
  return null; // Cross rates are not published directly.
}

async function fetchBoc(base: string, quote: string, range: DateRange): Promise<FxSeries | null> {
  const series = bocSeriesFor(base, quote);
  if (!series) return null;

  const url = `${BOC_BASE}/${series}/json?start_date=${range.start}&end_date=${range.end}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    observations?: Array<Record<string, string | { v: string }>>;
  };
  const rates = new Map<IsoDate, number>();
  for (const obs of json.observations ?? []) {
    const date = obs.d as string;
    const cell = obs[series];
    const value = typeof cell === 'object' && cell ? Number(cell.v) : Number(cell);
    if (date && Number.isFinite(value) && value > 0) rates.set(date, value);
  }
  if (!rates.size) return null;

  const dates = [...rates.keys()].sort();
  return {
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    rates,
    earliest: dates[0],
    latest: dates[dates.length - 1],
    source: 'bank-of-canada',
    sourceLabel: 'Bank of Canada',
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchYahooFx(
  base: string,
  quote: string,
  range: DateRange,
): Promise<FxSeries | null> {
  // Yahoo names a pair `USDCAD=X`, and `CAD=X` for USD-based pairs.
  const symbol = `${base.toUpperCase()}${quote.toUpperCase()}=X`;
  const period1 = Math.floor(Date.parse(`${range.start}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${range.end}T00:00:00Z`) / 1000) + 86_400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators: { quote: Array<{ close?: (number | null)[] }> } }> };
  };
  const r = json.chart?.result?.[0];
  if (!r?.timestamp?.length) return null;

  const closes = r.indicators.quote[0]?.close ?? [];
  const rates = new Map<IsoDate, number>();
  r.timestamp.forEach((t, i) => {
    const v = closes[i];
    if (v != null && Number.isFinite(v) && v > 0) {
      rates.set(new Date(t * 1000).toISOString().slice(0, 10), v);
    }
  });
  if (!rates.size) return null;

  const dates = [...rates.keys()].sort();
  return {
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    rates,
    earliest: dates[0],
    latest: dates[dates.length - 1],
    source: 'yahoo',
    sourceLabel: 'Yahoo Finance',
    fetchedAt: new Date().toISOString(),
  };
}

const memo = new Map<string, FxSeries>();

/**
 * Rates for converting `base` into `quote`, tried against the official source
 * first and a deeper one second.
 */
export async function getFxSeries(
  base: string,
  quote: string,
  range: DateRange,
): Promise<FxSeries> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();

  if (b === q) {
    // Identity: a currency converted to itself is itself, and asking a provider
    // for that would be a request that can only fail.
    return {
      base: b,
      quote: q,
      rates: new Map(),
      earliest: '1900-01-01',
      latest: '2999-12-31',
      source: 'identity',
      sourceLabel: 'No conversion required',
      fetchedAt: new Date().toISOString(),
    };
  }

  const key = `fx:${pairKey(b, q)}:${range.start}:${range.end}`;
  const hot = memo.get(key);
  if (hot) return hot;

  const cached = await diskGetEntry(key);
  if (cached && !cached.expired) {
    const revived = reviveCached(cached.series as unknown as SerialisedFx);
    memo.set(key, revived);
    return revived;
  }

  let series: FxSeries | null = null;
  const errors: string[] = [];

  for (const attempt of [fetchBoc, fetchYahooFx]) {
    try {
      series = await attempt(b, q, range);
      if (series) break;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (!series) {
    if (cached) {
      // Stale real rates beat failing, on the same reasoning as prices.
      const revived = reviveCached(cached.series as unknown as SerialisedFx);
      memo.set(key, revived);
      return revived;
    }
    throw new MarketDataError(
      `No exchange rate could be loaded for ${b}/${q}. This portfolio mixes currencies and cannot be valued without one.${
        errors.length ? ` (${errors.join('; ')})` : ''
      }`,
    );
  }

  memo.set(key, series);
  void diskSet(key, serialise(series) as never);
  return series;
}

/* A Map does not survive JSON, so the cache stores entries and rebuilds it. */
interface SerialisedFx extends Omit<FxSeries, 'rates'> {
  rateEntries: Array<[IsoDate, number]>;
}

function serialise(s: FxSeries): SerialisedFx {
  const { rates, ...rest } = s;
  return { ...rest, rateEntries: [...rates.entries()] };
}

function reviveCached(s: SerialisedFx): FxSeries {
  return { ...s, rates: new Map(s.rateEntries ?? []) };
}

/**
 * Aligns rates to a calendar, carrying the last published rate forward.
 *
 * Rate publication and equity trading calendars do not coincide — the Bank of
 * Canada does not publish on Canadian holidays when US markets are open. Using
 * the previous published rate is what actually happens to a holding on such a
 * day; interpolating would invent a rate that never existed.
 */
export function alignRates(
  series: FxSeries,
  calendar: IsoDate[],
): { rates: number[]; missingBefore: IsoDate | null } {
  if (series.source === 'identity') {
    return { rates: new Array(calendar.length).fill(1), missingBefore: null };
  }

  const out = new Array<number>(calendar.length).fill(Number.NaN);
  let carried = Number.NaN;
  let missingBefore: IsoDate | null = null;

  for (let i = 0; i < calendar.length; i++) {
    const exact = series.rates.get(calendar[i]);
    if (exact != null) carried = exact;
    if (Number.isFinite(carried)) out[i] = carried;
    else missingBefore = calendar[i];
  }

  return { rates: out, missingBefore };
}
