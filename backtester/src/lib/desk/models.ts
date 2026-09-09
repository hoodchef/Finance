import { mean, percentile, stdev } from '@/lib/metrics/stats';

/**
 * Desk models: momentum, flow, volatility and participation.
 * =============================================================================
 * These are the analytics behind `/desk`. They exist because the standard
 * single-number indicators throw away the thing a reader actually needs.
 *
 * RSI is one number. So is "momentum". So is "volatility". Each collapses a
 * structure into a scalar and then leaves you to guess what the structure was:
 * a stock up 2% today and down 15% over the year has the same "momentum" label
 * as one up 2% today and up 40% over the year, and they are not the same
 * situation. Every model here returns the SHAPE — momentum across horizons,
 * volatility across windows, flow across the session — because the shape is
 * where the information is.
 *
 * Everything is a pure function of bars the providers actually returned.
 * Nothing is simulated, and a window the history cannot cover comes back null
 * rather than being quietly computed over whatever data happened to exist.
 */

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A ratio whose denominator was zero has no value, and says so. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) < 1e-12) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ */
/* Momentum term structure                                             */
/* ------------------------------------------------------------------ */

export interface MomentumRung {
  label: string;
  /** Trading days looked back. */
  days: number;
  /** Simple return over the window, or null when the history is too short. */
  ret: number | null;
  /**
   * That return in standard deviations of the SAME horizon's own history.
   *
   * A 1% day and a 1% year are not comparable as returns; as z-scores they
   * are. Without this the short horizons always look quiet and the long ones
   * always look dramatic, whatever actually happened.
   */
  z: number | null;
  /** False when the series is shorter than the window asked for. */
  complete: boolean;
}

export const MOMENTUM_HORIZONS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '1D', days: 1 },
  { label: '1W', days: 5 },
  { label: '1M', days: 21 },
  { label: '3M', days: 63 },
  { label: '6M', days: 126 },
  { label: '1Y', days: 252 },
];

/**
 * Return at every horizon, each scored against its own past.
 *
 * Momentum is not one number. Read as a curve, the SHAPE is the signal: every
 * rung positive is a trend, short rungs negative under positive long ones is a
 * pullback inside one, and the reverse is a rally inside a downtrend. A single
 * figure cannot tell those apart, and they call for opposite things.
 */
export function momentumTermStructure(closes: readonly number[]): MomentumRung[] {
  return MOMENTUM_HORIZONS.map(({ label, days }) => {
    if (closes.length <= days) return { label, days, ret: null, z: null, complete: false };

    const last = closes[closes.length - 1];
    const then = closes[closes.length - 1 - days];
    const ret = ratio(last - then, then);

    // The distribution of this horizon's own overlapping returns. Overlapping
    // windows are not independent, so this is a description of the record and
    // not a significance test — which is all a z-score is being asked for.
    const history: number[] = [];
    for (let i = days; i < closes.length; i++) {
      const r = ratio(closes[i] - closes[i - days], closes[i - days]);
      if (r != null) history.push(r);
    }
    const sd = history.length > 2 ? stdev(history) : 0;
    const z = ret != null && sd > 1e-12 ? (ret - mean(history)) / sd : null;

    return { label, days, ret, z, complete: true };
  });
}

export interface MomentumAgreement {
  /** −1 (every horizon down) to +1 (every horizon up). */
  score: number;
  direction: 'up' | 'down' | 'mixed';
  /** How many horizons could be measured at all. */
  measured: number;
}

/**
 * How much the horizons agree with one another.
 *
 * The interesting reading is the middle: a score near zero is not "no
 * momentum", it is horizons pointing opposite ways, which is what a turn looks
 * like from the inside.
 */
export function momentumAgreement(rungs: readonly MomentumRung[]): MomentumAgreement {
  const signs = rungs.map((r) => r.ret).filter((r): r is number => r != null).map(Math.sign);
  if (!signs.length) return { score: 0, direction: 'mixed', measured: 0 };
  const score = signs.reduce((a, b) => a + b, 0) / signs.length;
  const direction = score >= 0.6 ? 'up' : score <= -0.6 ? 'down' : 'mixed';
  return { score, direction, measured: signs.length };
}

/* ------------------------------------------------------------------ */
/* Flow pressure                                                       */
/* ------------------------------------------------------------------ */

export interface FlowPoint {
  date: string;
  /**
   * Close location value: −1 if the bar closed on its low, +1 on its high.
   *
   * Where a bar CLOSES inside its range says more about who won the session
   * than whether it finished up on the day. A stock that gaps up and then
   * sells off all session closes near its low with a positive daily return,
   * and a close-to-close reading calls that buying.
   */
  clv: number;
  /** Dollar volume, signed by `clv`. */
  signed: number;
  /** Running sum of `signed`. */
  cumulative: number;
}

export interface FlowResult {
  points: FlowPoint[];
  /** Signed dollar volume over the whole window. */
  net: number;
  /**
   * Net flow as a share of total dollar volume, −1 to +1.
   *
   * Scale-free, so a mega-cap and a small-cap can sit in the same column.
   */
  pressure: number | null;
  /** Share of bars that closed in the upper half of their range. */
  upBarShare: number | null;
}

/**
 * Accumulation and distribution, from where bars close inside their range.
 *
 * The weighting is dollar volume rather than share volume, because a hundred
 * thousand shares of a $400 stock and of a $4 stock are not the same flow, and
 * a desk sizing a position cares about the dollars.
 */
export function flowPressure(bars: readonly Bar[]): FlowResult {
  const points: FlowPoint[] = [];
  let cumulative = 0;
  let net = 0;
  let gross = 0;
  let upBars = 0;
  let measured = 0;

  for (const b of bars) {
    const range = b.high - b.low;
    // A bar with no range — a limit-locked or untraded print — has no location
    // to read. Zero is the honest weight, not a coin flip.
    const clv = range > 1e-12 ? ((b.close - b.low) - (b.high - b.close)) / range : 0;
    const dollars = b.close * b.volume;
    const signed = clv * dollars;

    cumulative += signed;
    net += signed;
    gross += Math.abs(dollars);
    if (range > 1e-12) {
      measured++;
      if (clv > 0) upBars++;
    }
    points.push({ date: b.date, clv, signed, cumulative });
  }

  return {
    points,
    net,
    pressure: ratio(net, gross),
    upBarShare: measured > 0 ? upBars / measured : null,
  };
}

/* ------------------------------------------------------------------ */
/* Volatility cone                                                     */
/* ------------------------------------------------------------------ */

export interface VolRung {
  window: number;
  label: string;
  /** Annualised realised volatility over the most recent window. */
  current: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** Where `current` sits in this window's own history, 0–1. */
  rank: number | null;
}

export const VOL_WINDOWS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '5D', days: 5 },
  { label: '10D', days: 10 },
  { label: '21D', days: 21 },
  { label: '63D', days: 63 },
  { label: '126D', days: 126 },
  { label: '252D', days: 252 },
];

/**
 * Realised volatility at several windows, each against its own history.
 *
 * "Volatility is 24%" is unreadable without knowing what 24% has meant for
 * this security. The cone answers the question actually being asked — is it
 * high or low FOR THIS NAME, at this horizon — and the two ends usually
 * disagree, which is the part a single figure hides: a quiet month inside a
 * violent year is a different setup from a violent month inside a quiet one.
 *
 * `periodsPerYear` is required rather than assumed. Annualising weekly data by
 * √252 overstates volatility by more than a factor of two, and the mistake
 * produces a plausible number rather than an obvious one.
 */
export function volatilityCone(
  closes: readonly number[],
  periodsPerYear: number,
  windows: ReadonlyArray<{ label: string; days: number }> = VOL_WINDOWS,
): VolRung[] {
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const root = Math.sqrt(periodsPerYear);

  return windows.map(({ label, days }) => {
    if (logReturns.length < days + 2) {
      return { window: days, label, current: null, p10: null, p50: null, p90: null, rank: null };
    }
    // Every overlapping window of this length, so the percentiles describe the
    // whole record rather than a handful of calendar anniversaries.
    const rolled: number[] = [];
    for (let end = days; end <= logReturns.length; end++) {
      rolled.push(stdev(logReturns.slice(end - days, end)) * root);
    }
    const current = rolled[rolled.length - 1];
    const below = rolled.filter((v) => v <= current).length;
    return {
      window: days,
      label,
      current,
      p10: percentile(rolled, 0.1),
      p50: percentile(rolled, 0.5),
      p90: percentile(rolled, 0.9),
      rank: rolled.length > 1 ? below / rolled.length : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Intraday participation                                              */
/* ------------------------------------------------------------------ */

export interface SessionBucket {
  /** Minutes from midnight, UTC-naive as the vendor stamps them. */
  minute: number;
  label: string;
  /** Share of the day's volume in this bucket, averaged over prior sessions. */
  typical: number;
  /** Share in the most recent session. */
  today: number | null;
}

export interface ParticipationResult {
  buckets: SessionBucket[];
  /** Sessions the typical profile was averaged over. */
  sessions: number;
  /**
   * How far the latest session departs from the usual shape, 0 upward.
   *
   * Total variation distance between the two distributions: 0 is an ordinary
   * day, and a large figure means the volume arrived at unusual times — which
   * is often the first visible sign of something before it reaches the price.
   */
  divergence: number | null;
}

/**
 * When during the session the volume actually arrives.
 *
 * Volume is famously U-shaped — heavy at the open and the close, thin in the
 * middle — and that shape is so reliable that departures from it carry
 * information. A day whose volume lands mid-session is not the same day as one
 * whose volume lands at the bell, even at identical totals.
 *
 * Needs intraday bars. Given daily ones there is one bucket per day and the
 * question is meaningless, so it reports no sessions rather than a flat line.
 */
export function participationProfile(bars: readonly Bar[], bucketMinutes = 30): ParticipationResult {
  const byDay = new Map<string, Map<number, number>>();
  for (const b of bars) {
    const [day, time] = String(b.date).split('T');
    if (!time) continue; // Daily bars carry no time; nothing to profile.
    const [h, m] = time.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const bucket = Math.floor((h * 60 + m) / bucketMinutes) * bucketMinutes;
    const day$ = byDay.get(day) ?? new Map<number, number>();
    day$.set(bucket, (day$.get(bucket) ?? 0) + b.volume);
    byDay.set(day, day$);
  }

  const days = [...byDay.keys()].sort();
  if (days.length === 0) return { buckets: [], sessions: 0, divergence: null };

  const allBuckets = [...new Set([...byDay.values()].flatMap((m) => [...m.keys()]))].sort(
    (a, b) => a - b,
  );

  /** One session as shares of its own total, so heavy days do not dominate. */
  const shares = (day: string): Map<number, number> => {
    const m = byDay.get(day)!;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const out = new Map<number, number>();
    for (const k of allBuckets) out.set(k, total > 0 ? (m.get(k) ?? 0) / total : 0);
    return out;
  };

  const latest = days[days.length - 1];
  const priorDays = days.slice(0, -1);
  const priorShares = priorDays.map(shares);
  const todayShares = days.length > 0 ? shares(latest) : null;

  const buckets: SessionBucket[] = allBuckets.map((minute) => ({
    minute,
    label: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
    typical: priorShares.length
      ? mean(priorShares.map((s) => s.get(minute) ?? 0))
      : (todayShares?.get(minute) ?? 0),
    today: todayShares?.get(minute) ?? null,
  }));

  // Total variation distance: half the summed absolute difference between two
  // distributions that each sum to one.
  let divergence: number | null = null;
  if (priorShares.length && todayShares) {
    divergence =
      buckets.reduce((a, b) => a + Math.abs((b.today ?? 0) - b.typical), 0) / 2;
  }

  return { buckets, sessions: priorDays.length, divergence };
}

/* ------------------------------------------------------------------ */
/* Range state                                                         */
/* ------------------------------------------------------------------ */

export interface RangeState {
  /** Average true range over `window`, as a share of price. */
  atrPct: number | null;
  /** Where that sits in its own history, 0–1. */
  atrRank: number | null;
  /** Consecutive most-recent bars whose range sat inside the prior bar's. */
  insideRun: number;
  /** Where the last close sits in the window's high-low range, 0–1. */
  positionInRange: number | null;
}

/**
 * Whether the security is coiling or expanding, and where it sits in its range.
 *
 * True range rather than high-low, so an overnight gap counts as the movement
 * it was. A run of inside bars is compression — the range narrowing inside the
 * previous one, repeatedly — which is the state that precedes expansion often
 * enough to be worth counting, though not reliably enough to trade alone.
 */
export function rangeState(bars: readonly Bar[], window = 21): RangeState {
  if (bars.length < 2) {
    return { atrPct: null, atrRank: null, insideRun: 0, positionInRange: null };
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    trueRanges.push(
      Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)),
    );
  }

  const atrOf = (end: number): number | null => {
    if (end < window) return null;
    const slice = trueRanges.slice(end - window, end);
    const price = bars[end].close;
    return price > 0 ? mean(slice) / price : null;
  };

  const history: number[] = [];
  for (let end = window; end < bars.length; end++) {
    const v = atrOf(end);
    if (v != null) history.push(v);
  }
  const atrPct = history.length ? history[history.length - 1] : null;
  const atrRank =
    atrPct != null && history.length > 1
      ? history.filter((v) => v <= atrPct).length / history.length
      : null;

  let insideRun = 0;
  for (let i = bars.length - 1; i > 0; i--) {
    const b = bars[i];
    const p = bars[i - 1];
    if (b.high <= p.high && b.low >= p.low) insideRun++;
    else break;
  }

  const recent = bars.slice(-window);
  const hi = Math.max(...recent.map((b) => b.high));
  const lo = Math.min(...recent.map((b) => b.low));
  const positionInRange = ratio(bars[bars.length - 1].close - lo, hi - lo);

  return { atrPct, atrRank, insideRun, positionInRange };
}
