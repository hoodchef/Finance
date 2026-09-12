/**
 * Live market inputs, measured the way the delivered snapshot was.
 *
 * The model's price, beta and volatility are an IBKR snapshot taken on
 * 10-Sep-2026. The page shows today's quote beside them, and re-estimates the
 * same statistics from the app's own provider with the same method: weekly
 * closes dated by the week's first trading day, the latest (possibly partial)
 * week excluded from the regression, Blume-adjusted.
 *
 * The re-estimate is a DIAGNOSTIC, not a silent replacement. A valuation's
 * beta is a reviewed number (R-01), and one that moved every day would move
 * the value every day for reasons unrelated to the business. The page values
 * on the snapshot beta by default and says what the live one would change.
 *
 * Before any live statistic is shown, the live weekly closes are reconciled
 * against the snapshot over the weeks they share. Two feeds that disagree on
 * past closes would make every comparison between them meaningless, so the
 * disagreement is measured and reported rather than assumed away.
 */
import { marketStats, type MarketStats } from './engine';

export interface DailyClose {
  date: string;
  close: number;
}
export interface WeeklyBar {
  /** Monday of the ISO week — the key two feeds can be matched on. */
  week: string;
  /** First trading day of the week — how IBKR dates a weekly bar. */
  start: string;
  close: number;
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Weekly bars from daily closes: close of the last trading day, dated by the first. Input must be ascending. */
export function resampleWeekly(daily: readonly DailyClose[]): WeeklyBar[] {
  const out: WeeklyBar[] = [];
  for (const b of daily) {
    if (!Number.isFinite(b.close) || b.close <= 0) continue;
    const week = mondayOf(b.date);
    const last = out[out.length - 1];
    if (last && last.week === week) last.close = b.close;
    else out.push({ week, start: b.date, close: b.close });
  }
  return out;
}

export interface Reconciliation {
  weeksCompared: number;
  maxAbsPctDiff: number;
  meanAbsPctDiff: number;
  worst: { week: string; snapshot: number; live: number } | null;
}

/**
 * Compare two weekly series on the weeks they share, excluding each series'
 * final bar: the snapshot's last week was partial when it was taken, and so
 * may the live one be.
 */
export function reconcile(
  snapshotTime: readonly string[],
  snapshotClose: readonly number[],
  live: readonly WeeklyBar[],
): Reconciliation {
  const liveByWeek = new Map(live.slice(0, -1).map((b) => [b.week, b.close]));
  let n = 0;
  let sum = 0;
  let max = 0;
  let worst: Reconciliation['worst'] = null;
  for (let i = 0; i < snapshotTime.length - 1; i++) {
    const week = mondayOf(snapshotTime[i]);
    const l = liveByWeek.get(week);
    if (l == null) continue;
    const d = Math.abs(l / snapshotClose[i] - 1);
    n++;
    sum += d;
    if (d > max) {
      max = d;
      worst = { week, snapshot: snapshotClose[i], live: l };
    }
  }
  return { weeksCompared: n, maxAbsPctDiff: max, meanAbsPctDiff: n ? sum / n : Number.NaN, worst };
}

/** Align two weekly series on their shared weeks and keep the most recent `count`. */
export function alignWeeks(a: readonly WeeklyBar[], b: readonly WeeklyBar[], count: number) {
  const bByWeek = new Map(b.map((x) => [x.week, x.close]));
  const rows = a.filter((x) => bByWeek.has(x.week)).map((x) => ({ ...x, bench: bByWeek.get(x.week) as number }));
  return rows.slice(-count);
}

export interface LiveMarket {
  asOf: string;
  source: string;
  price: number;
  stats: MarketStats;
  weeks: number;
  window: { from: string; to: string };
  reconciliation: { asts: Reconciliation; spy: Reconciliation };
}

/** The same 105-week window as the snapshot, so the two estimates are comparable. */
export const LIVE_WEEKS = 105;

export function liveMarketFrom(
  asts: readonly DailyClose[],
  spy: readonly DailyClose[],
  blumeW: number,
  snapshot: { time: readonly string[]; asts: readonly number[]; spy: readonly number[] },
  source: string,
): LiveMarket | null {
  const wa = resampleWeekly(asts);
  const ws = resampleWeekly(spy);
  const rows = alignWeeks(wa, ws, LIVE_WEEKS);
  if (rows.length < 60) return null;
  const closes = rows.map((r) => r.close);
  const bench = rows.map((r) => r.bench);
  return {
    asOf: asts[asts.length - 1].date,
    source,
    price: asts[asts.length - 1].close,
    stats: marketStats(closes, bench, blumeW),
    weeks: rows.length,
    window: { from: rows[0].start, to: rows[rows.length - 1].start },
    reconciliation: {
      asts: reconcile(snapshot.time, snapshot.asts, wa),
      spy: reconcile(snapshot.time, snapshot.spy, ws),
    },
  };
}
