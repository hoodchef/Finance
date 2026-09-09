import { correlation, mean, median, percentile, stdev } from '@/lib/metrics/stats';
import type { Bar } from './models';

/**
 * Session split: which half of the day this security's return actually comes from.
 * =============================================================================
 * A close-to-close return is two different markets glued together. One is the
 * continuous auction between the opening and closing bells, where a desk can
 * actually work an order. The other is everything else — the overnight gap,
 * which absorbs earnings, guidance, downgrades, macro prints and the whole of
 * another continent's trading session, and which is only accessible at the
 * open, in a thin book, at a price already reflecting the news.
 *
 * These two are not interchangeable and for many securities they are not even
 * the same sign. An index fund has historically earned most of its drift
 * overnight while spending the session going nowhere; a high-beta single name
 * frequently does the reverse. The distinction decides whether a position can
 * be held flat overnight without giving up the return, which is one of the few
 * genuinely actionable things on this page.
 *
 * CONVENTIONS, each of which has a competing definition in circulation.
 *
 *  - OVERNIGHT is open(t) / close(t−1) − 1. It covers the close, the after
 *    hours, the whole non-session period and the opening auction: everything
 *    between the two continuous sessions, not merely "the gap at 09:30".
 *  - INTRADAY is close(t) / open(t) − 1: the regular session only.
 *  - The two COMPOUND, they do not add. (1 + on)(1 + id) = close(t)/close(t−1)
 *    exactly. `growth` is therefore the compounded product minus one, and the
 *    two legs' growths multiply back to `totalGrowth` to the last decimal.
 *  - The SHARE of the move is computed in LOGS, because only logs decompose
 *    additively — sum of log legs equals log of the total, exactly. A share
 *    quoted from arithmetic returns does not reconcile, and the discrepancy
 *    grows with the size of the move. When the total move is near zero the
 *    share is undefined rather than enormous, and comes back null.
 *  - VOLATILITY is the standard deviation of that leg's log returns, one
 *    observation per session, annualised by √`periodsPerYear`. This treats an
 *    overnight and a session as one period each, which they are in count; it
 *    is emphatically NOT volatility per unit of clock time, and comparing the
 *    two legs' figures compares per-event risk, not per-hour risk.
 *
 * DIVIDENDS, which is where this model is most easily made wrong. The price
 * series is split-adjusted but NOT dividend-adjusted, so on an ex-dividend
 * date the price drops by the dividend between the previous close and the
 * open — landing the entire distribution on the overnight leg as a loss that
 * the holder did not suffer. Left uncorrected, that biases the overnight leg
 * down by the security's whole dividend yield and would show a REIT giving up
 * six percent a year overnight. Ex-dividend sessions are therefore dropped
 * when the caller supplies the dates, and the count of dropped sessions is
 * reported so the reader can see the correction happened. Given no dates the
 * model still computes, and `exDividendSessionsExcluded` is zero — which for a
 * paying security means the overnight leg is understated.
 *
 * WHAT THIS IS NOT. The leg statistics are a description of a record. The gap
 * buckets, unusually for this page, condition on something observable at the
 * time — the overnight return is known at the opening print, before the
 * session it is paired with — so the conditional intraday figures are at least
 * honestly timed. They are still a historical frequency and not a forecast,
 * the buckets are defined using the whole sample's own quantiles (which a
 * trader standing in the past would not have had), and the sample sizes are
 * small enough at the extremes to be read as anecdote.
 */

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) < 1e-12) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

export interface SessionLeg {
  /** Compounded growth of this leg alone. The two legs multiply to the total. */
  growth: number | null;
  /** Sum of log(1 + r). The two legs' log sums ADD to the total's. */
  logSum: number | null;
  /** This leg's share of the total log move. Null when the total is ~flat. */
  share: number | null;
  /** Arithmetic mean of the per-session returns. */
  meanReturn: number | null;
  /** Median per-session return — far more representative under fat tails. */
  medianReturn: number | null;
  /** Annualised standard deviation of this leg's log returns. */
  volatility: number | null;
  /** Share of sessions in which this leg was positive. */
  positiveShare: number | null;
  /** Largest single-session gain and loss on this leg. */
  best: number | null;
  worst: number | null;
}

export interface GapBucket {
  /** 1 (largest gaps down) to 5 (largest gaps up). */
  rank: number;
  label: string;
  /** Overnight-return bounds of the bucket. Null at the open ends. */
  lower: number | null;
  upper: number | null;
  sessions: number;
  meanOvernight: number | null;
  /** Mean session return that FOLLOWED a gap of this size. */
  meanIntraday: number | null;
  medianIntraday: number | null;
  /** Share where the session went the same way as the gap. */
  continuationShare: number | null;
}

export interface SessionSplit {
  /** Sessions with a usable prior close, open and close. */
  sessions: number;
  overnight: SessionLeg;
  intraday: SessionLeg;
  buckets: GapBucket[];
  /** Overall share of sessions where both legs had the same sign. */
  continuationShare: number | null;
  /**
   * Correlation between the overnight leg and the session that followed it.
   *
   * Negative is the gap fading — the classic open-to-close reversal. Positive
   * is the gap being extended. Near zero means the open reprices the security
   * and the session then does its own thing, which is the common case.
   */
  gapFollowThrough: number | null;
  /**
   * Compounded close-to-close growth over exactly the sessions included here.
   *
   * Not the security's actual total return when sessions were excluded; it is
   * the reconciliation target the two legs multiply back to.
   */
  totalGrowth: number | null;
  exDividendSessionsExcluded: number;
  /** Sessions dropped for a non-positive or non-finite open, close or prior close. */
  unusableSessions: number;
  /**
   * Sessions whose open was EXACTLY the prior close.
   *
   * A vendor that does not really carry opens stamps them from the prior close
   * and produces a perfectly flat overnight leg. A large count here means the
   * split is an artefact of the feed rather than a fact about the security.
   */
  identicalOpenSessions: number;
  periodsPerYear: number;
}

export interface SessionSplitOptions {
  /** ISO dates on which the security traded ex-dividend. */
  exDividendDates?: readonly string[];
  /** Sessions per year used to annualise each leg. */
  periodsPerYear?: number;
  /** Below this many usable sessions the model reports nothing. */
  minSessions?: number;
  /** A bucket thinner than this reports counts but no statistics. */
  minBucketSessions?: number;
}

/**
 * Splits a daily bar series into its overnight and intraday halves.
 *
 * Needs only daily OHLC — no intraday bars — which is what lets it run over the
 * full history rather than the last fortnight the minute feed covers.
 */
export function sessionSplit(
  bars: readonly Bar[],
  options: SessionSplitOptions = {},
): SessionSplit | null {
  const {
    exDividendDates = [],
    periodsPerYear = 252,
    minSessions = 40,
    minBucketSessions = 10,
  } = options;

  const exDates = new Set(exDividendDates.map((d) => String(d).slice(0, 10)));

  const overnight: number[] = [];
  const intraday: number[] = [];
  let excluded = 0;
  let unusable = 0;
  let identicalOpens = 0;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const priorClose = bars[i - 1].close;

    if (exDates.has(String(b.date).slice(0, 10))) {
      excluded++;
      continue;
    }
    if (!(priorClose > 0) || !(b.open > 0) || !(b.close > 0)) {
      unusable++;
      continue;
    }

    const on = b.open / priorClose - 1;
    const id = b.close / b.open - 1;
    if (!Number.isFinite(on) || !Number.isFinite(id)) {
      unusable++;
      continue;
    }

    if (b.open === priorClose) identicalOpens++;
    overnight.push(on);
    intraday.push(id);
  }

  if (overnight.length < minSessions) return null;

  const totalLog =
    overnight.reduce((a, r) => a + Math.log1p(r), 0) +
    intraday.reduce((a, r) => a + Math.log1p(r), 0);
  const totalGrowth = Math.expm1(totalLog);

  const leg = (rs: number[]): SessionLeg => {
    const logs = rs.map((r) => Math.log1p(r));
    const logSum = logs.reduce((a, b) => a + b, 0);
    return {
      growth: Math.expm1(logSum),
      logSum,
      // Undefined rather than vast when the security went essentially nowhere:
      // a share of a zero move is not a hundredfold contribution.
      share: Math.abs(totalLog) > 1e-9 ? logSum / totalLog : null,
      meanReturn: mean(rs),
      medianReturn: median(rs),
      volatility: rs.length > 1 ? stdev(logs) * Math.sqrt(periodsPerYear) : null,
      positiveShare: rs.filter((r) => r > 0).length / rs.length,
      best: Math.max(...rs),
      worst: Math.min(...rs),
    };
  };

  // Quintiles of this security's OWN overnight returns, so the buckets mean
  // the same thing for a utility and for a biotech. A fixed ±2% cut would put
  // one of them entirely in the middle bucket and the other entirely outside.
  const cuts = [0.2, 0.4, 0.6, 0.8].map((p) => percentile(overnight, p));
  const grouped: Array<{ on: number[]; id: number[] }> = Array.from({ length: 5 }, () => ({
    on: [],
    id: [],
  }));
  for (let i = 0; i < overnight.length; i++) {
    let b = 0;
    while (b < 4 && overnight[i] > cuts[b]) b++;
    grouped[b].on.push(overnight[i]);
    grouped[b].id.push(intraday[i]);
  }

  const labels = ['1 · gaps down hardest', '2', '3 · flat opens', '4', '5 · gaps up hardest'];
  const buckets: GapBucket[] = grouped.map((g, i) => {
    const thin = g.on.length < minBucketSessions;
    return {
      rank: i + 1,
      label: labels[i],
      lower: i === 0 ? null : cuts[i - 1],
      upper: i === 4 ? null : cuts[i],
      sessions: g.on.length,
      meanOvernight: thin ? null : mean(g.on),
      meanIntraday: thin ? null : mean(g.id),
      medianIntraday: thin ? null : median(g.id),
      continuationShare: thin ? null : continuation(g.on, g.id),
    };
  });

  return {
    sessions: overnight.length,
    overnight: leg(overnight),
    intraday: leg(intraday),
    buckets,
    continuationShare: continuation(overnight, intraday),
    gapFollowThrough: overnight.length > 2 ? correlation(overnight, intraday) : null,
    totalGrowth,
    exDividendSessionsExcluded: excluded,
    unusableSessions: unusable,
    identicalOpenSessions: identicalOpens,
    periodsPerYear,
  };
}

/**
 * Share of paired sessions in which both legs moved the same way.
 *
 * Sessions where either leg was exactly flat are excluded from both the
 * numerator and the denominator: a zero has no direction, and counting it as
 * agreement or disagreement would be inventing one. Null when nothing is left.
 */
function continuation(on: readonly number[], id: readonly number[]): number | null {
  let same = 0;
  let counted = 0;
  for (let i = 0; i < on.length; i++) {
    if (on[i] === 0 || id[i] === 0) continue;
    counted++;
    if (Math.sign(on[i]) === Math.sign(id[i])) same++;
  }
  return ratio(same, counted);
}
