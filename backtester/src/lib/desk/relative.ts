import { MOMENTUM_HORIZONS } from './models';

/**
 * What the security is doing RELATIVE to something else.
 * =============================================================================
 * Everything else on the desk describes one security in isolation, which is
 * half an answer. A stock up 8% over the quarter in a market up 12% is a
 * laggard; the same 8% in a market down 4% is leadership. The absolute number
 * is identical and the two situations call for opposite things, so the desk
 * cannot tell them apart without a second series to measure against.
 *
 * Two comparisons live here, and they answer different questions:
 *
 *   - Against a BENCHMARK: how much of this security's movement is the market
 *     happening to it (beta, correlation, R²), and how much is its own.
 *   - Against its PEERS: whether it is leading or lagging the companies it
 *     actually competes with, which is where a sector-wide move gets separated
 *     from a company-specific one.
 *
 * Everything here is a pure function of bars a provider returned. Nothing is
 * simulated, and any window the overlapping history cannot cover comes back
 * null rather than being computed over whatever data happened to line up.
 */

/** The only two fields any comparison here needs. `Bar` satisfies it. */
export interface DatedClose {
  date: string;
  close: number;
}

/* ------------------------------------------------------------------ */
/* Alignment                                                           */
/* ------------------------------------------------------------------ */

export interface AlignedPair {
  dates: string[];
  a: number[];
  b: number[];
}

/**
 * Two series reduced to the sessions BOTH of them printed.
 *
 * This is the whole correctness story for everything below it, and getting it
 * wrong is invisible. Two series of daily closes are not two parallel arrays:
 * a foreign listing, a halted session, a vendor gap, or simply one series
 * starting later means index `i` is a different date in each. Zipping them and
 * differencing produces a beta computed from Monday against Tuesday, which
 * looks like a perfectly ordinary number.
 *
 * Aligning on the DATE and only then differencing means every return pair
 * spans the same calendar interval. A gap in one series therefore lengthens
 * that interval for both legs rather than shifting one of them — which is the
 * honest treatment, because it is the same elapsed market time for each.
 *
 * Duplicate dates keep the LAST occurrence: providers occasionally repeat a
 * bar when a session is restated, and the restated one is the correct one.
 */
export function alignOnDate(
  a: readonly DatedClose[],
  b: readonly DatedClose[],
): AlignedPair {
  const byDate = new Map<string, number>();
  for (const bar of b) {
    if (Number.isFinite(bar.close) && bar.close > 0) byDate.set(bar.date, bar.close);
  }

  const seen = new Map<string, number>();
  for (const bar of a) {
    if (Number.isFinite(bar.close) && bar.close > 0 && byDate.has(bar.date)) {
      seen.set(bar.date, bar.close);
    }
  }

  const dates = [...seen.keys()].sort();
  return {
    dates,
    a: dates.map((d) => seen.get(d)!),
    b: dates.map((d) => byDate.get(d)!),
  };
}

/** Simple returns from a close series. Length is `closes.length - 1`. */
function simpleReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0 && Number.isFinite(closes[i])) out.push((closes[i] - prev) / prev);
  }
  return out;
}

/**
 * Mean, variance and covariance that refuse to answer rather than return zero.
 *
 * `metrics/stats.ts` has all three and they return 0 on degenerate input,
 * which is right where they are used: the optimiser needs a number for every
 * cell of a covariance matrix and cannot carry a hole. Here the opposite is
 * true. A correlation of 0.00 on this screen is a claim — "this security moves
 * independently of the market" — and reporting it because there were two
 * observations would be a fabricated finding, not a rounding choice.
 */
function meanOf(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  const m = s / xs.length;
  return Number.isFinite(m) ? m : null;
}

interface Moments {
  varA: number;
  varB: number;
  cov: number;
  n: number;
}

/** Sample (n − 1) moments of a pair, or null below two observations. */
function moments(xs: readonly number[], ys: readonly number[]): Moments | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = meanOf(xs.slice(0, n));
  const my = meanOf(ys.slice(0, n));
  if (mx == null || my == null) return null;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { varA: sxx / (n - 1), varB: syy / (n - 1), cov: sxy / (n - 1), n };
}

/* ------------------------------------------------------------------ */
/* Benchmark relation                                                  */
/* ------------------------------------------------------------------ */

export interface RelationWindow {
  /** Trading days of overlapping history the estimate was taken over. */
  window: number;
  label: string;
  /**
   * Slope of the security's returns on the benchmark's.
   *
   * Estimated over the aligned window only. Not annualised and not shrunk
   * towards 1 — this is the observed slope over this window, and a reader
   * comparing two windows should be seeing the difference, not a smoothing.
   */
  beta: number | null;
  correlation: number | null;
  /** Correlation squared: the share of variance the benchmark explains. */
  r2: number | null;
  /**
   * Annualised standard deviation of the residual — the part of the move the
   * benchmark does NOT explain. Daily bars, so √252.
   */
  idiosyncraticVol: number | null;
  /** Return pairs actually used. Fewer than `window` means a shorter overlap. */
  observations: number;
}

export const RELATION_WINDOWS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '21D', days: 21 },
  { label: '63D', days: 63 },
  { label: '126D', days: 126 },
  { label: '252D', days: 252 },
];

export interface RelativeRung {
  label: string;
  days: number;
  /** The security's simple return over the window, from the ALIGNED closes. */
  subject: number | null;
  benchmark: number | null;
  /**
   * `subject − benchmark`, in simple return terms.
   *
   * Arithmetic difference rather than a ratio of growth factors. Over the
   * horizons here the two agree to within a few basis points, and a difference
   * of returns is the figure a reader can check against the two numbers
   * printed beside it.
   */
  excess: number | null;
}

export interface RelativeStrengthPoint {
  date: string;
  /** Subject ÷ benchmark, rebased to 1 at the start of the series shown. */
  ratio: number;
}

export interface BenchmarkRelation {
  /** The symbol actually used, so a substituted benchmark is never silent. */
  benchmark: string;
  /** Sessions both series printed, after alignment. */
  overlap: number;
  from: string | null;
  to: string | null;
  windows: RelationWindow[];
  relative: RelativeRung[];
  /**
   * The relative-strength line: one point per aligned session, most recent
   * `line` sessions, rebased to 1 at its own first point.
   *
   * Rebased rather than left as a raw price ratio because the level of a price
   * ratio is an accident of two share counts and means nothing; only its slope
   * carries information.
   */
  line: RelativeStrengthPoint[];
}

/** Annualiser for daily bars. Stated once so no caller has to guess. */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * How this security relates to a benchmark, across several windows.
 *
 * Several windows rather than one because beta is not a constant and reporting
 * it as a single figure hides the thing worth knowing. A stock whose 252-day
 * beta is 1.0 and whose 21-day beta is 1.9 has re-coupled to the market
 * recently, and a one-number beta says nothing has changed.
 *
 * Returns null when there is no usable overlap at all — a benchmark that could
 * not be fetched, or a security that has never traded on a day the benchmark
 * did — rather than an object full of nulls that reads as a measurement.
 */
export function benchmarkRelation(
  subject: readonly DatedClose[],
  benchmark: readonly DatedClose[],
  benchmarkSymbol: string,
  options: { windows?: ReadonlyArray<{ label: string; days: number }>; line?: number } = {},
): BenchmarkRelation | null {
  const windows = options.windows ?? RELATION_WINDOWS;
  const lineLength = options.line ?? TRADING_DAYS_PER_YEAR;

  const aligned = alignOnDate(subject, benchmark);
  if (aligned.dates.length < 2) return null;

  const subjectReturns = simpleReturns(aligned.a);
  const benchmarkReturns = simpleReturns(aligned.b);

  const relationWindows: RelationWindow[] = windows.map(({ label, days }) => {
    // A window the overlap cannot cover is not estimated over what happened to
    // be there. Twenty days of overlap asked for a 252-day beta would produce
    // a number that answers a different question than its label claims.
    if (subjectReturns.length < days) {
      return {
        window: days,
        label,
        beta: null,
        correlation: null,
        r2: null,
        idiosyncraticVol: null,
        observations: subjectReturns.length,
      };
    }

    const s = subjectReturns.slice(-days);
    const b = benchmarkReturns.slice(-days);
    const m = moments(s, b);
    if (!m) {
      return {
        window: days,
        label,
        beta: null,
        correlation: null,
        r2: null,
        idiosyncraticVol: null,
        observations: s.length,
      };
    }

    // A benchmark that did not move over the window cannot support a slope:
    // every dividing line through a vertical scatter fits equally well.
    const beta = m.varB > 1e-18 ? m.cov / m.varB : null;
    const denom = Math.sqrt(m.varA * m.varB);
    const correlation = denom > 1e-18 ? m.cov / denom : null;
    const r2 = correlation != null ? correlation * correlation : null;

    // Residual variance of the regression: var(subject) · (1 − R²). Clamped at
    // zero because floating point can push a perfect fit fractionally negative.
    const idiosyncraticVol =
      r2 != null
        ? Math.sqrt(Math.max(0, m.varA * (1 - r2)) * TRADING_DAYS_PER_YEAR)
        : null;

    return { window: days, label, beta, correlation, r2, idiosyncraticVol, observations: m.n };
  });

  const relative: RelativeRung[] = MOMENTUM_HORIZONS.map(({ label, days }) => {
    // Measured on the ALIGNED closes so both legs span the same sessions. The
    // subject's own series would give a slightly different figure whenever the
    // two listings disagree about a trading day, and a reader subtracting the
    // two printed numbers would not get the printed difference.
    if (aligned.dates.length <= days) {
      return { label, days, subject: null, benchmark: null, excess: null };
    }
    const i = aligned.dates.length - 1;
    const j = i - days;
    const sThen = aligned.a[j];
    const bThen = aligned.b[j];
    const s = sThen > 0 ? (aligned.a[i] - sThen) / sThen : null;
    const b = bThen > 0 ? (aligned.b[i] - bThen) / bThen : null;
    return { label, days, subject: s, benchmark: b, excess: s != null && b != null ? s - b : null };
  });

  const tail = Math.max(2, Math.min(lineLength, aligned.dates.length));
  const start = aligned.dates.length - tail;
  const base = aligned.a[start] / aligned.b[start];
  const line: RelativeStrengthPoint[] =
    Number.isFinite(base) && base > 0
      ? aligned.dates.slice(start).map((date, k) => ({
          date,
          ratio: aligned.a[start + k] / aligned.b[start + k] / base,
        }))
      : [];

  return {
    benchmark: benchmarkSymbol,
    overlap: aligned.dates.length,
    from: aligned.dates[0] ?? null,
    to: aligned.dates[aligned.dates.length - 1] ?? null,
    windows: relationWindows,
    relative,
    line,
  };
}

/* ------------------------------------------------------------------ */
/* Peer relative strength                                              */
/* ------------------------------------------------------------------ */

export interface PeerLeg {
  symbol: string;
  /** Sessions the peer and the subject both printed within the horizon. */
  alignedBars: number;
  /**
   * Both legs are reported, because both are measured on the SAME aligned
   * dates as each other. The subject's figure here can differ by a basis point
   * from the one in `relative` above when a peer's calendar differs, and
   * printing it removes the temptation to reconcile two numbers that were
   * never measured over the same days.
   */
  subjectReturn: number | null;
  peerReturn: number | null;
  excess: number | null;
}

export interface PeerHorizon {
  label: string;
  days: number;
  /** Median of the peers' returns over this horizon. */
  peerMedian: number | null;
  /** Median of the per-peer excesses. Not `subject − peerMedian`; see below. */
  medianExcess: number | null;
  /**
   * Share of measurable peers the subject out-returned, 0–1.
   *
   * With a handful of peers this is coarse by construction — six peers can
   * only ever produce seven values — and it is reported alongside `measured`
   * so a 1.00 from two peers is not read as a 1.00 from ten.
   */
  rank: number | null;
  measured: number;
  legs: PeerLeg[];
}

export interface PeerCohort {
  /** Where the peer list came from. Never inferred from a name or a sector. */
  source: string;
  peers: string[];
  /** Peers named but not measurable, with the reason, so the gap is visible. */
  skipped: Array<{ symbol: string; reason: string }>;
  horizons: PeerHorizon[];
}

/** Median that refuses an empty sample rather than returning zero. */
function medianOrNull(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The security against the companies a vendor names as its comparables.
 *
 * `medianExcess` is the median of the pairwise differences, NOT the subject's
 * return minus the median peer return. The two are not the same when peers
 * cover different sessions, and only the first is a statement about pairs that
 * were actually measured against one another.
 *
 * A peer whose overlapping history is too short for a horizon is left out of
 * that horizon rather than compared over whatever it had — a peer that listed
 * four months ago has no one-year return, and giving it one by measuring from
 * its IPO would make every long-horizon comparison flattering.
 */
export function peerRelativeStrength(
  subject: readonly DatedClose[],
  peers: ReadonlyArray<{ symbol: string; bars: readonly DatedClose[] | null }>,
  options: {
    source: string;
    horizons?: ReadonlyArray<{ label: string; days: number }>;
  },
): PeerCohort {
  const horizons = options.horizons ?? MOMENTUM_HORIZONS;
  const skipped: Array<{ symbol: string; reason: string }> = [];

  const usable: Array<{ symbol: string; aligned: AlignedPair }> = [];
  for (const peer of peers) {
    if (!peer.bars?.length) {
      skipped.push({ symbol: peer.symbol, reason: 'no price history came back' });
      continue;
    }
    const aligned = alignOnDate(subject, peer.bars);
    if (aligned.dates.length < 2) {
      skipped.push({ symbol: peer.symbol, reason: 'no sessions in common with the subject' });
      continue;
    }
    usable.push({ symbol: peer.symbol, aligned });
  }

  const horizonRows: PeerHorizon[] = horizons.map(({ label, days }) => {
    const legs: PeerLeg[] = usable.map(({ symbol, aligned }) => {
      if (aligned.dates.length <= days) {
        return {
          symbol,
          alignedBars: aligned.dates.length,
          subjectReturn: null,
          peerReturn: null,
          excess: null,
        };
      }
      const i = aligned.dates.length - 1;
      const j = i - days;
      const sThen = aligned.a[j];
      const pThen = aligned.b[j];
      const s = sThen > 0 ? (aligned.a[i] - sThen) / sThen : null;
      const p = pThen > 0 ? (aligned.b[i] - pThen) / pThen : null;
      return {
        symbol,
        alignedBars: aligned.dates.length,
        subjectReturn: s,
        peerReturn: p,
        excess: s != null && p != null ? s - p : null,
      };
    });

    const excesses = legs.map((l) => l.excess).filter((x): x is number => x != null);
    const peerReturns = legs.map((l) => l.peerReturn).filter((x): x is number => x != null);

    return {
      label,
      days,
      peerMedian: medianOrNull(peerReturns),
      medianExcess: medianOrNull(excesses),
      rank: excesses.length ? excesses.filter((x) => x > 0).length / excesses.length : null,
      measured: excesses.length,
      legs,
    };
  });

  return {
    source: options.source,
    peers: peers.map((p) => p.symbol),
    skipped,
    horizons: horizonRows,
  };
}
