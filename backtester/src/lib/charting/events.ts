import type { IsoDate } from '@/lib/types';

/**
 * Corporate actions and ticker history, merged into one dated timeline.
 * =============================================================================
 *
 * Three feeds annotate the same axis: dividends, splits, and Polygon's ticker
 * events (renames, listing changes). They arrive from three endpoints in three
 * shapes, and a chart wants one ordered list.
 *
 * The merge is deliberately lossless in the direction that matters: every
 * event keeps the raw fields it came with, so a tooltip can show the declared,
 * ex, record and pay dates rather than only the one the marker sits on. What
 * it does NOT do is invent a date. An event Polygon dated only by pay date is
 * placed on the pay date and says so, rather than being back-dated to a
 * guessed ex-date — the two differ by days, and a dividend marker in the wrong
 * place is read as a price reaction that never happened.
 */

export type ChartEventKind = 'dividend' | 'split' | 'ticker_change' | 'ticker_event';

/** Raw dividend row from /stocks/v1/dividends. */
export interface PolygonDividend {
  ticker?: string;
  cash_amount?: number;
  split_adjusted_cash_amount?: number;
  historical_adjustment_factor?: number;
  currency?: string;
  ex_dividend_date?: string;
  pay_date?: string;
  record_date?: string;
  declaration_date?: string;
  /** Payments per year: 0 unknown/one-off, 1 annual, 4 quarterly, 12 monthly. */
  frequency?: number;
  distribution_type?: string;
}

/** Raw split row from /stocks/v1/splits. */
export interface PolygonSplit {
  ticker?: string;
  execution_date?: string;
  split_from?: number;
  split_to?: number;
  adjustment_type?: string;
  historical_adjustment_factor?: number;
}

/** Raw entry from /vX/reference/tickers/{t}/events. */
export interface PolygonTickerEvent {
  type?: string;
  date?: string;
  ticker_change?: { ticker?: string };
}

export interface ChartEvent {
  /** The date the marker sits on, in exchange-local terms. */
  date: IsoDate;
  kind: ChartEventKind;
  /** Two or three words for the marker itself. */
  label: string;
  /** One line for a tooltip. */
  detail: string;
  /** Which date field `date` was taken from, so the marker can be justified. */
  dateBasis: string;
  /** Always the provider that observed it. Never derived or assumed. */
  source: string;
  /** Sort tiebreaker within a date: splits before dividends before renames. */
  priority: number;
}

export interface DividendEventDetail extends ChartEvent {
  kind: 'dividend';
  amount: number;
  currency: string | null;
  frequency: number | null;
  exDate: IsoDate | null;
  payDate: IsoDate | null;
  recordDate: IsoDate | null;
  declarationDate: IsoDate | null;
}

export interface SplitEventDetail extends ChartEvent {
  kind: 'split';
  from: number;
  to: number;
  /** `to / from` — above 1 is a forward split. */
  ratio: number;
}

export type TimelineEvent = DividendEventDetail | SplitEventDetail | ChartEvent;

const SOURCE = 'polygon';

function isoDate(value: unknown): IsoDate | null {
  if (typeof value !== 'string') return null;
  const s = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function money(amount: number, currency: string | null): string {
  const symbol = !currency || currency.toUpperCase() === 'USD' ? '$' : `${currency.toUpperCase()} `;
  // Dividends are frequently sub-cent once split-adjusted; four places keeps
  // a 0.0946 from rendering as 0.09 and looking like a different payment.
  const shown = Math.abs(amount) < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
  return `${symbol}${shown}`;
}

const FREQUENCY_LABEL: Record<number, string> = {
  1: 'annual',
  2: 'semi-annual',
  4: 'quarterly',
  12: 'monthly',
  52: 'weekly',
};

/**
 * Converts one dividend row.
 *
 * `split_adjusted_cash_amount` is preferred over `cash_amount` because the
 * price series it will be drawn against is split-adjusted. Mixing an
 * unadjusted 2013 dividend of $2.65 onto a chart whose 2013 prices have been
 * restated through 28x of subsequent splits puts the marker two orders of
 * magnitude off the price it relates to. Where Polygon gives no adjusted
 * amount the raw one is used and `dateBasis` records that.
 */
export function toDividendEvent(row: PolygonDividend): DividendEventDetail | null {
  const ex = isoDate(row.ex_dividend_date);
  const pay = isoDate(row.pay_date);
  const date = ex ?? pay;
  if (!date) return null;

  const adjusted =
    typeof row.split_adjusted_cash_amount === 'number' &&
    Number.isFinite(row.split_adjusted_cash_amount)
      ? row.split_adjusted_cash_amount
      : null;
  const raw =
    typeof row.cash_amount === 'number' && Number.isFinite(row.cash_amount) ? row.cash_amount : null;

  const amount = adjusted ?? raw;
  if (amount == null || amount <= 0) return null;

  const currency = typeof row.currency === 'string' ? row.currency.toUpperCase() : null;
  const frequency =
    typeof row.frequency === 'number' && Number.isFinite(row.frequency) ? row.frequency : null;
  const cadence = frequency && FREQUENCY_LABEL[frequency] ? ` ${FREQUENCY_LABEL[frequency]}` : '';

  return {
    date,
    kind: 'dividend',
    label: money(amount, currency),
    detail:
      `${money(amount, currency)} per share${cadence} dividend` +
      (ex ? `, ex ${ex}` : '') +
      (pay ? `, paid ${pay}` : '') +
      (adjusted == null ? ' (not split-adjusted by the provider)' : ''),
    dateBasis: ex ? 'ex_dividend_date' : 'pay_date',
    source: SOURCE,
    priority: 1,
    amount,
    currency,
    frequency,
    exDate: ex,
    payDate: pay,
    recordDate: isoDate(row.record_date),
    declarationDate: isoDate(row.declaration_date),
  };
}

/** Converts one split row. Rows without a usable ratio are dropped, not guessed. */
export function toSplitEvent(row: PolygonSplit): SplitEventDetail | null {
  const date = isoDate(row.execution_date);
  if (!date) return null;

  const from = typeof row.split_from === 'number' ? row.split_from : NaN;
  const to = typeof row.split_to === 'number' ? row.split_to : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;

  const ratio = to / from;
  const reverse = ratio < 1;
  return {
    date,
    kind: 'split',
    label: `${to}:${from}`,
    detail: `${to}-for-${from} ${reverse ? 'reverse split' : 'split'} on ${date}`,
    dateBasis: 'execution_date',
    source: SOURCE,
    priority: 0,
    from,
    to,
    ratio,
  };
}

/** Converts one ticker event. Unknown types are carried through, not dropped. */
export function toTickerEvent(row: PolygonTickerEvent): ChartEvent | null {
  const date = isoDate(row.date);
  if (!date) return null;

  if (row.type === 'ticker_change' && row.ticker_change?.ticker) {
    const ticker = row.ticker_change.ticker.toUpperCase();
    return {
      date,
      kind: 'ticker_change',
      label: ticker,
      detail: `Listed as ${ticker} from ${date}`,
      dateBasis: 'date',
      source: SOURCE,
      priority: 2,
    };
  }

  const type = typeof row.type === 'string' && row.type ? row.type : 'event';
  return {
    date,
    kind: 'ticker_event',
    label: type.replace(/_/g, ' '),
    detail: `${type.replace(/_/g, ' ')} on ${date}`,
    dateBasis: 'date',
    source: SOURCE,
    priority: 3,
  };
}

export interface TimelineInput {
  dividends?: readonly PolygonDividend[];
  splits?: readonly PolygonSplit[];
  tickerEvents?: readonly PolygonTickerEvent[];
}

export interface TimelineOptions {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  from?: IsoDate;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  to?: IsoDate;
}

/**
 * Merges the three feeds into one ascending timeline.
 *
 * Sorted by date, then by kind so that on a date carrying both a split and a
 * dividend the split is read first — that is the order they take effect, and
 * the dividend amount is stated in post-split units.
 */
export function buildEventTimeline(
  input: TimelineInput,
  options: TimelineOptions = {},
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const row of input.splits ?? []) {
    const e = toSplitEvent(row);
    if (e) events.push(e);
  }
  for (const row of input.dividends ?? []) {
    const e = toDividendEvent(row);
    if (e) events.push(e);
  }
  for (const row of input.tickerEvents ?? []) {
    const e = toTickerEvent(row);
    if (e) events.push(e);
  }

  const { from, to } = options;
  const inRange = events.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));

  inRange.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  return inRange;
}

/**
 * Groups a timeline by date, for a chart that draws one marker per day.
 *
 * Two dividends on one date is not a data error — a special distribution
 * alongside the regular one is ordinary — so they are grouped rather than
 * de-duplicated.
 */
export function groupEventsByDate(events: readonly TimelineEvent[]): Array<{
  date: IsoDate;
  events: TimelineEvent[];
}> {
  const byDate = new Map<IsoDate, TimelineEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }
  return [...byDate.entries()]
    .map(([date, list]) => ({ date, events: list }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
