import type { ChartBar } from './bars';
import { exchangeDate } from './bars';

/**
 * Technical indicators, computed locally from bars.
 * =============================================================================
 *
 * WHY LOCALLY, WHEN POLYGON SERVES THESE
 *
 * Polygon has /v1/indicators/{sma,ema,macd,rsi} and the key is entitled to
 * them. They are not used. On the free tier the budget is roughly five
 * requests a minute, and a chart with four overlays would spend the whole
 * minute on arithmetic that costs microseconds here. The bars have already
 * been paid for; deriving from them is free, offline, and testable.
 *
 * THE ALIGNMENT CONTRACT
 *
 * Every function returns an array the same length as its input, with `null`
 * wherever the indicator is not yet defined. Nulls are not zeros and are not
 * back-filled: a 200-day moving average genuinely does not exist on day 3, and
 * an array that starts at index 199 would silently shift every point in a
 * chart that indexes by position. `null` is the honest value, and it plots as
 * a break rather than as a line through zero.
 *
 * All of these are pure. No clock, no network, no module state.
 */

export type IndicatorSeries = Array<number | null>;

/** Population standard deviation — the Bollinger convention, not the sample one. */
function stdev(values: readonly number[], from: number, to: number, mean: number): number {
  let sum = 0;
  for (let i = from; i <= to; i++) {
    const d = values[i] - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / (to - from + 1));
}

function validPeriod(period: number, name: string): number {
  const p = Math.floor(period);
  if (!Number.isFinite(p) || p < 1) {
    throw new RangeError(`${name} period must be a positive whole number, got ${period}.`);
  }
  return p;
}

/**
 * Simple moving average.
 *
 * The window is summed directly on each step rather than maintained as a
 * rolling total. A rolling total is O(n) instead of O(n·p), but repeated
 * add-then-subtract accumulates floating-point drift over a long series, and
 * two charts of the same data computed over different ranges would then
 * disagree in the last decimals. At chart sizes the direct sum is immaterial.
 */
export function sma(values: readonly number[], period: number): IndicatorSeries {
  const p = validPeriod(period, 'SMA');
  const out: IndicatorSeries = new Array(values.length).fill(null);
  for (let i = p - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += values[j];
    out[i] = sum / p;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * The seed matters and is not universally agreed: seeding with the first value
 * alone makes the early series depend heavily on one print. The SMA seed is
 * the convention Wilder and every charting package this is likely to be
 * compared against use, and it makes EMA and SMA agree at the seed index.
 */
export function ema(values: readonly number[], period: number): IndicatorSeries {
  const p = validPeriod(period, 'EMA');
  const out: IndicatorSeries = new Array(values.length).fill(null);
  if (values.length < p) return out;

  const k = 2 / (p + 1);
  let sum = 0;
  for (let i = 0; i < p; i++) sum += values[i];
  let prev = sum / p;
  out[p - 1] = prev;

  for (let i = p; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * EMA over a series that may not start at index 0.
 *
 * Needed for the MACD signal line, whose input is itself an indicator and so
 * is null until both of its own EMAs exist. Seeds on the first run of `period`
 * consecutive defined values; a null after that ends the series rather than
 * being interpolated across.
 */
export function emaOfSeries(values: IndicatorSeries, period: number): IndicatorSeries {
  const p = validPeriod(period, 'EMA');
  const out: IndicatorSeries = new Array(values.length).fill(null);

  let start = -1;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run = values[i] == null ? 0 : run + 1;
    if (run === p) {
      start = i;
      break;
    }
  }
  if (start < 0) return out;

  const k = 2 / (p + 1);
  let sum = 0;
  for (let i = start - p + 1; i <= start; i++) sum += values[i] as number;
  let prev = sum / p;
  out[start] = prev;

  for (let i = start + 1; i < values.length; i++) {
    const v = values[i];
    if (v == null) break;
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative strength index, Wilder smoothing.
 *
 * Two degenerate cases are decided explicitly rather than left to produce
 * NaN or Infinity:
 *   - no losses in the window → 100. A series that only rose has no downside
 *     to weigh against, which is what a maximal reading means.
 *   - no gains and no losses → 50. A perfectly flat series has no directional
 *     pressure in either direction, and 0, 100 or NaN would all read as a
 *     signal where there is none.
 */
export function rsi(values: readonly number[], period = 14): IndicatorSeries {
  const p = validPeriod(period, 'RSI');
  const out: IndicatorSeries = new Array(values.length).fill(null);
  if (values.length <= p) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  out[p] = rsiFrom(avgGain, avgLoss);

  for (let i = p + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (p - 1) + up) / p;
    avgLoss = (avgLoss * (p - 1) + down) / p;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdResult {
  macd: IndicatorSeries;
  signal: IndicatorSeries;
  histogram: IndicatorSeries;
}

/** MACD line, its signal EMA, and the histogram between them. */
export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const line: IndicatorSeries = values.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return f == null || s == null ? null : f - s;
  });

  const signal = emaOfSeries(line, signalPeriod);
  const histogram: IndicatorSeries = line.map((m, i) => {
    const s = signal[i];
    return m == null || s == null ? null : m - s;
  });

  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: IndicatorSeries;
  upper: IndicatorSeries;
  lower: IndicatorSeries;
}

/** Bollinger bands: an SMA with population-stdev envelopes. */
export function bollingerBands(
  values: readonly number[],
  period = 20,
  multiplier = 2,
): BollingerResult {
  const p = validPeriod(period, 'Bollinger');
  const middle = sma(values, p);
  const upper: IndicatorSeries = new Array(values.length).fill(null);
  const lower: IndicatorSeries = new Array(values.length).fill(null);

  for (let i = p - 1; i < values.length; i++) {
    const mean = middle[i];
    if (mean == null) continue;
    const sd = stdev(values, i - p + 1, i, mean);
    upper[i] = mean + multiplier * sd;
    lower[i] = mean - multiplier * sd;
  }
  return { middle, upper, lower };
}

export type VwapAnchor = 'session' | 'series';

/**
 * Volume-weighted average price, cumulative from the anchor.
 *
 * VWAP is only meaningful relative to where it started, so the anchor is
 * explicit. `session` restarts at each exchange day, which is what an intraday
 * VWAP means and the only reading a trader would recognise. `series` runs from
 * the first bar, which is the anchored form used on daily and longer charts.
 *
 * A bar in a window whose cumulative volume is still zero yields `null`, not
 * the price: with no volume there is no volume-weighted price, and returning
 * the close would quietly relabel an unweighted number as a weighted one.
 */
export function vwap(bars: readonly ChartBar[], anchor: VwapAnchor = 'session'): IndicatorSeries {
  const out: IndicatorSeries = new Array(bars.length).fill(null);
  let cumPv = 0;
  let cumVol = 0;
  let session = '';

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (anchor === 'session') {
      const day = exchangeDate(bar.timestamp);
      if (day !== session) {
        session = day;
        cumPv = 0;
        cumVol = 0;
      }
    }
    const typical = (bar.high + bar.low + bar.close) / 3;
    cumPv += typical * bar.volume;
    cumVol += bar.volume;
    out[i] = cumVol > 0 ? cumPv / cumVol : null;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Request-side dispatch                                               */
/* ------------------------------------------------------------------ */

export type IndicatorKind = 'sma' | 'ema' | 'rsi' | 'macd' | 'bbands' | 'vwap';

export const INDICATOR_KINDS: readonly IndicatorKind[] = [
  'sma',
  'ema',
  'rsi',
  'macd',
  'bbands',
  'vwap',
] as const;

export interface IndicatorSpec {
  kind: IndicatorKind;
  params: number[];
  /** Canonical form, e.g. `sma:50`. Used as the response key. */
  id: string;
}

const ALIASES: Record<string, IndicatorKind> = {
  sma: 'sma',
  ma: 'sma',
  ema: 'ema',
  rsi: 'rsi',
  macd: 'macd',
  bbands: 'bbands',
  bb: 'bbands',
  bollinger: 'bbands',
  vwap: 'vwap',
};

/** Longest window each kind consumes before it produces its first value. */
const DEFAULTS: Record<IndicatorKind, number[]> = {
  sma: [20],
  ema: [20],
  rsi: [14],
  macd: [12, 26, 9],
  bbands: [20, 2],
  vwap: [],
};

const MAX_PARAM = 5_000;

/**
 * Parses `"sma:50"`, `"macd:12:26:9"`, `"vwap"` or an equivalent object.
 *
 * Rejects rather than defaults on an unknown name: silently substituting an
 * SMA for a misspelt indicator would put a line on the chart labelled as
 * something it is not.
 */
export function parseIndicatorSpec(input: unknown): IndicatorSpec {
  let name: string;
  let params: number[];

  if (typeof input === 'string') {
    const [head, ...rest] = input.trim().toLowerCase().split(':');
    name = head;
    params = rest.map(Number);
  } else if (input && typeof input === 'object') {
    const obj = input as { kind?: unknown; type?: unknown; params?: unknown; period?: unknown };
    name = String(obj.kind ?? obj.type ?? '').trim().toLowerCase();
    params = Array.isArray(obj.params)
      ? obj.params.map(Number)
      : obj.period != null
        ? [Number(obj.period)]
        : [];
  } else {
    throw new RangeError('An indicator must be a name such as "sma:50".');
  }

  const kind = ALIASES[name];
  if (!kind) {
    throw new RangeError(
      `Unknown indicator "${name}". Available: ${INDICATOR_KINDS.join(', ')}.`,
    );
  }

  const resolved = DEFAULTS[kind].map((fallback, i) =>
    params[i] != null && Number.isFinite(params[i]) ? params[i] : fallback,
  );
  for (const p of resolved) {
    if (!(p > 0) || p > MAX_PARAM) {
      throw new RangeError(`Indicator "${kind}" has an out-of-range parameter: ${p}.`);
    }
  }

  return { kind, params: resolved, id: [kind, ...resolved].join(':') };
}

export type IndicatorOutput = IndicatorSeries | MacdResult | BollingerResult;

/**
 * Computes every requested indicator over one set of bars.
 *
 * Deliberately does NOT drop an indicator whose warm-up exceeds the number of
 * bars available. It returns an all-null series instead, so the caller can say
 * "200-day average needs 200 bars and this range has 60" rather than leaving a
 * requested overlay silently missing from the response.
 */
export function computeIndicators(
  bars: readonly ChartBar[],
  specs: readonly IndicatorSpec[],
): Record<string, IndicatorOutput> {
  const price = bars.map((b) => b.close);
  const out: Record<string, IndicatorOutput> = {};

  for (const spec of specs) {
    switch (spec.kind) {
      case 'sma':
        out[spec.id] = sma(price, spec.params[0]);
        break;
      case 'ema':
        out[spec.id] = ema(price, spec.params[0]);
        break;
      case 'rsi':
        out[spec.id] = rsi(price, spec.params[0]);
        break;
      case 'macd':
        out[spec.id] = macd(price, spec.params[0], spec.params[1], spec.params[2]);
        break;
      case 'bbands':
        out[spec.id] = bollingerBands(price, spec.params[0], spec.params[1]);
        break;
      case 'vwap':
        out[spec.id] = vwap(bars, 'session');
        break;
    }
  }
  return out;
}

/** Bars an indicator needs before its first defined value. */
export function warmupBars(spec: IndicatorSpec): number {
  switch (spec.kind) {
    case 'sma':
    case 'ema':
      return spec.params[0];
    case 'rsi':
      return spec.params[0] + 1;
    case 'macd':
      return Math.max(spec.params[0], spec.params[1]) + spec.params[2];
    case 'bbands':
      return spec.params[0];
    case 'vwap':
      return 1;
  }
}
