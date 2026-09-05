import type { IsoDate } from '@/lib/types';

/**
 * Polygon aggregate bars, normalised.
 * =============================================================================
 *
 * Polygon returns aggregates as a flat array of single-letter keys with a
 * millisecond epoch timestamp. Two things about that shape are easy to get
 * wrong, and both are wrong in ways that look right on a chart:
 *
 * 1. THE TIMESTAMP IS NOT UTC MIDNIGHT. A daily bar is stamped at midnight
 *    America/New_York — 04:00Z in summer, 05:00Z in winter. Slicing the UTC
 *    ISO string happens to give the correct date for daily bars, but only by
 *    accident of the offset being negative. For minute and hour bars it is
 *    plainly wrong: the 20:00 ET bar of one session lands on the next calendar
 *    day in UTC. Every timestamp here is therefore formatted in exchange time.
 *
 * 2. AN ABSENT INTERVAL IS NOT A ZERO. Polygon omits a bar entirely when no
 *    qualifying trade occurred in that interval. The gap is the observation —
 *    it means the security did not trade — and filling it with a zero-volume
 *    flat bar invents a print that never happened, while carrying the previous
 *    close forward invents a liquidity that was not there. Nothing in this
 *    module fabricates a missing interval. `findGaps` reports them so a chart
 *    can draw the discontinuity honestly, and that is the whole treatment.
 */

export type ChartTimespan = 'minute' | 'hour' | 'day' | 'week' | 'month';

export const CHART_TIMESPANS: readonly ChartTimespan[] = [
  'minute',
  'hour',
  'day',
  'week',
  'month',
] as const;

/** True for timespans finer than a session, where bars carry a clock time. */
export function isIntraday(timespan: ChartTimespan): boolean {
  return timespan === 'minute' || timespan === 'hour';
}

/** Raw Polygon aggregate row, as returned by /v2/aggs. */
export interface PolygonAggregate {
  /** Bar start, milliseconds since epoch. */
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  /** Volume. Fractional on Polygon's recent bars; not rounded here. */
  v?: number;
  /** Volume-weighted average price for the interval. */
  vw?: number;
  /** Number of transactions in the interval. */
  n?: number;
}

export interface ChartBar {
  /**
   * `YYYY-MM-DD` for day/week/month bars, `YYYY-MM-DDTHH:mm` for minute and
   * hour bars. Always in exchange time (America/New_York), never UTC.
   */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** The interval's own VWAP as reported by the venue. Null when absent. */
  vwap: number | null;
  /** Transaction count in the interval. Null when absent. */
  trades: number | null;
  /** Bar start in milliseconds since epoch, preserved for exact ordering. */
  timestamp: number;
}

const EXCHANGE_TZ = 'America/New_York';

/**
 * Built once. `Intl.DateTimeFormat` construction dominates the cost of
 * normalising a 50,000-bar minute series if done per row.
 */
const dayParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: EXCHANGE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const minuteParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: EXCHANGE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** The exchange-local calendar date of a bar timestamp. */
export function exchangeDate(ms: number): IsoDate {
  const p = dayParts.formatToParts(new Date(ms));
  return `${part(p, 'year')}-${part(p, 'month')}-${part(p, 'day')}`;
}

/** The exchange-local `YYYY-MM-DDTHH:mm` of a bar timestamp. */
export function exchangeDateTime(ms: number): string {
  const p = minuteParts.formatToParts(new Date(ms));
  // `hour12: false` yields "24" for midnight in some ICU versions.
  const hour = part(p, 'hour') === '24' ? '00' : part(p, 'hour');
  return `${part(p, 'year')}-${part(p, 'month')}-${part(p, 'day')}T${hour}:${part(p, 'minute')}`;
}

/** The label a bar of this timespan carries. */
export function barKey(ms: number, timespan: ChartTimespan): string {
  return isIntraday(timespan) ? exchangeDateTime(ms) : exchangeDate(ms);
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Normalises raw aggregates into bars.
 *
 * A row missing a timestamp or a close cannot be placed or priced, so it is
 * dropped rather than repaired: substituting a neighbouring value would put a
 * price on the chart that the venue never printed. Dropped rows are counted
 * and returned so the caller can say so rather than silently showing fewer
 * bars than the provider sent.
 */
export function normaliseAggregates(
  raw: readonly PolygonAggregate[] | null | undefined,
  timespan: ChartTimespan,
): { bars: ChartBar[]; dropped: number } {
  const bars: ChartBar[] = [];
  let dropped = 0;

  for (const row of raw ?? []) {
    const t = finite(row?.t);
    const close = finite(row?.c);
    // A non-positive close is not a price. Both are treated as unusable rather
    // than clamped, because a clamped price is an invented one.
    if (t === null || close === null || close <= 0) {
      dropped += 1;
      continue;
    }

    // Open/high/low are filled from the close only when genuinely absent, which
    // is what a single-print interval looks like. This is a restatement of the
    // one observed price, not a new one.
    const open = finite(row.o) ?? close;
    const high = finite(row.h) ?? Math.max(open, close);
    const low = finite(row.l) ?? Math.min(open, close);

    bars.push({
      date: barKey(t, timespan),
      open,
      high,
      low,
      close,
      volume: finite(row.v) ?? 0,
      vwap: finite(row.vw),
      trades: finite(row.n),
      timestamp: t,
    });
  }

  bars.sort((a, b) => a.timestamp - b.timestamp);

  // Polygon does not repeat an interval, but a paged fetch that re-reads a
  // boundary can. De-duplicated on the key, keeping the last seen, so a
  // re-read of a settling bar wins over the earlier partial one.
  const deduped: ChartBar[] = [];
  for (const bar of bars) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.date === bar.date) deduped[deduped.length - 1] = bar;
    else deduped.push(bar);
  }

  return { bars: deduped, dropped };
}

export interface BarGap {
  /** Key of the bar before the gap. */
  after: string;
  /** Key of the bar after the gap. */
  before: string;
  /**
   * Intervals with no bar between the two. For daily bars this counts weekdays
   * only, so an ordinary weekend is not a gap; an exchange holiday still
   * counts as one, because from the data alone a holiday and a halt are
   * indistinguishable.
   */
  missing: number;
}

const DAY_MS = 86_400_000;

/** Weekdays strictly between two exchange dates. */
function weekdaysBetween(a: IsoDate, b: IsoDate): number {
  let count = 0;
  // Parsed as UTC midnight purely as a calendar walk; no clock arithmetic.
  for (let t = Date.parse(`${a}T00:00:00Z`) + DAY_MS; t < Date.parse(`${b}T00:00:00Z`); t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

const SPAN_MS: Record<ChartTimespan, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/**
 * Reports intervals the provider omitted.
 *
 * This exists so a gap can be drawn as a gap. It never fills one. For
 * intraday timespans the count includes the overnight and weekend closure —
 * session hours are not knowable from the bars alone — so intraday gaps are
 * useful as "the tape stopped here", not as a count of missed trades.
 */
export function findGaps(
  bars: readonly ChartBar[],
  timespan: ChartTimespan,
  multiplier = 1,
): BarGap[] {
  const gaps: BarGap[] = [];
  const step = SPAN_MS[timespan] * Math.max(1, multiplier);

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];

    const missing =
      timespan === 'day' && multiplier === 1
        ? weekdaysBetween(exchangeDate(prev.timestamp), exchangeDate(curr.timestamp))
        : Math.max(0, Math.round((curr.timestamp - prev.timestamp) / step) - 1);

    if (missing > 0) gaps.push({ after: prev.date, before: curr.date, missing });
  }
  return gaps;
}

/** Closing prices, in bar order. The input to every price-based indicator. */
export function closes(bars: readonly ChartBar[]): number[] {
  return bars.map((b) => b.close);
}

/** Typical price (H+L+C)/3, the standard VWAP input. */
export function typicalPrices(bars: readonly ChartBar[]): number[] {
  return bars.map((b) => (b.high + b.low + b.close) / 3);
}
