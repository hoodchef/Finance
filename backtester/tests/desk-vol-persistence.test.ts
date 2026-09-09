import { describe, expect, it } from 'vitest';
import { volatilityPersistence } from '../src/lib/desk/vol-persistence';

/**
 * Volatility persistence, against arithmetic worked by hand.
 * =============================================================================
 * Two things are pinned exactly here: the autocorrelation of the magnitude
 * series, and the transition matrix, including the quartile cuts it is built
 * on. The cuts are worked out in the comments from the linear-interpolated
 * percentile the codebase uses, because a different percentile convention
 * moves days across bucket boundaries and quietly changes every cell.
 *
 * The matrix cases are chosen so a rigged implementation fails: one series
 * clusters and must show a heavy diagonal, and one cycles and must show an
 * EMPTY diagonal. A model that reports persistence because persistence is the
 * expected answer passes the first and fails the second.
 */

/** Closes whose log returns are exactly `logs`. */
function closesFromLogs(logs: number[], start = 100): number[] {
  const out = [start];
  let acc = 0;
  for (const l of logs) {
    acc += l;
    out.push(start * Math.exp(acc));
  }
  return out;
}

/** `n` log returns cycling through `pattern`. */
const cycle = (pattern: number[], n: number) =>
  Array.from({ length: n }, (_, i) => pattern[i % pattern.length]);

const SMALL = { lags: 3, minRowObservations: 1, minObservations: 8 };

describe('volatility persistence', () => {
  it('computes the magnitude autocorrelation to hand-worked values', () => {
    /*
     * Log returns [.01, .03] repeated to eight values, all positive — so the
     * magnitude series IS the return series and both ACFs must agree exactly.
     *
     * Mean .02, deviations alternating ±.01, denominator 8 × .0001 = .0008.
     *   lag 1: seven products, each −.0001 → −.0007/.0008 = −0.875
     *   lag 2: six products, each +.0001 → +.0006/.0008 = +0.75
     *   lag 3: five products, each −.0001 → −.0005/.0008 = −0.625
     *
     * The lag-1 figure is −(n−1)/n rather than −1: the estimator divides by
     * all n squared deviations while the numerator has only n − 1 products.
     */
    const p = volatilityPersistence(closesFromLogs(cycle([0.01, 0.03], 8)), SMALL)!;

    expect(p.acf.map((a) => a.lag)).toEqual([1, 2, 3]);
    expect(p.acf[0].absolute).toBeCloseTo(-0.875, 10);
    expect(p.acf[1].absolute).toBeCloseTo(0.75, 10);
    expect(p.acf[2].absolute).toBeCloseTo(-0.625, 10);
    expect(p.rho1).toBeCloseTo(-0.875, 10);

    // Every return positive, so |r| = r and the two curves coincide.
    for (const point of p.acf) expect(point.signed).toBeCloseTo(point.absolute!, 10);
  });

  it('shows a series unpredictable in sign and predictable in magnitude', () => {
    /*
     * Signs strictly alternate while magnitudes arrive in a quiet block then a
     * loud block. The signed ACF must be strongly negative — the direction is
     * anti-persistent — while the absolute ACF is positive. One line cannot
     * show both facts, which is why the pair is drawn together.
     */
    const logs = [0.01, -0.011, 0.012, -0.013, 0.04, -0.041, 0.042, -0.043];
    const p = volatilityPersistence(closesFromLogs(logs), SMALL)!;

    expect(p.acf[0].absolute!).toBeGreaterThan(0);
    expect(p.acf[0].signed!).toBeLessThan(0);
    expect(p.acf[0].absolute!).toBeGreaterThan(p.acf[0].signed!);
  });

  it('builds the transition matrix for a clustered series by hand', () => {
    /*
     * Magnitudes [.01, .011, .012, .013, .04, .041, .042, .043] — a quiet block
     * then a loud one. Sorted they are already in that order, so with n = 8 the
     * linear-interpolated cuts are
     *   p25 at index 7×0.25 = 1.75 → .011 + .75(.012 − .011) = .01175
     *   p50 at index 3.5          → .013 + .50(.040 − .013) = .0265
     *   p75 at index 5.25         → .041 + .25(.042 − .041) = .04125
     * A value goes to the lowest quartile whose upper cut it does not exceed,
     * giving quartiles [1, 1, 2, 2, 3, 3, 4, 4].
     *
     * The seven transitions are (1,1) (1,2) (2,2) (2,3) (3,3) (3,4) (4,4):
     *   row 1: 2 observations → [1/2, 1/2, 0, 0]
     *   row 2: 2 observations → [0, 1/2, 1/2, 0]
     *   row 3: 2 observations → [0, 0, 1/2, 1/2]
     *   row 4: 1 observation  → [0, 0, 0, 1]
     * Diagonal mean (0.5 + 0.5 + 0.5 + 1)/4 = 0.625, so the excess over the
     * 0.25 independence would give is exactly 0.375.
     */
    const logs = [0.01, -0.011, 0.012, -0.013, 0.04, -0.041, 0.042, -0.043];
    const p = volatilityPersistence(closesFromLogs(logs), SMALL)!;

    expect(p.cuts[0]).toBeCloseTo(0.01175, 10);
    expect(p.cuts[1]).toBeCloseTo(0.0265, 10);
    expect(p.cuts[2]).toBeCloseTo(0.04125, 10);

    expect(p.matrix.map((r) => r.observations)).toEqual([2, 2, 2, 1]);
    expect(p.matrix[0].to).toEqual([0.5, 0.5, 0, 0]);
    expect(p.matrix[1].to).toEqual([0, 0.5, 0.5, 0]);
    expect(p.matrix[2].to).toEqual([0, 0, 0.5, 0.5]);
    expect(p.matrix[3].to).toEqual([0, 0, 0, 1]);

    expect(p.quietAfterQuiet).toBeCloseTo(0.5, 12);
    expect(p.stormAfterStorm).toBeCloseTo(1, 12);
    expect(p.excessPersistence).toBeCloseTo(0.375, 12);
    expect(p.currentQuartile).toBe(4);
  });

  it('reports an empty diagonal when the record shows no clustering at all', () => {
    /*
     * Magnitudes cycle [.01, .02, .03, .04] twice. Sorted:
     * [.01,.01,.02,.02,.03,.03,.04,.04], so the cuts are
     *   p25 → .01 + .75(.02 − .01) = .0175
     *   p50 → .02 + .50(.03 − .02) = .025
     *   p75 → .03 + .25(.04 − .03) = .0325
     * giving quartiles [1, 2, 3, 4, 1, 2, 3, 4] and transitions
     * (1,2) (2,3) (3,4) (4,1) (1,2) (2,3) (3,4).
     *
     * Every diagonal cell is zero and the excess persistence is −0.25, the
     * furthest from clustering the measure can go. A model that finds
     * persistence here is finding it in its own construction.
     */
    const p = volatilityPersistence(closesFromLogs(cycle([0.01, -0.02, 0.03, -0.04], 8)), SMALL)!;

    expect(p.cuts[0]).toBeCloseTo(0.0175, 10);
    expect(p.cuts[1]).toBeCloseTo(0.025, 10);
    expect(p.cuts[2]).toBeCloseTo(0.0325, 10);

    expect(p.matrix.map((r) => r.observations)).toEqual([2, 2, 2, 1]);
    expect(p.matrix[0].to).toEqual([0, 1, 0, 0]);
    expect(p.matrix[1].to).toEqual([0, 0, 1, 0]);
    expect(p.matrix[2].to).toEqual([0, 0, 0, 1]);
    expect(p.matrix[3].to).toEqual([1, 0, 0, 0]);

    expect(p.quietAfterQuiet).toBe(0);
    expect(p.stormAfterStorm).toBe(0);
    expect(p.excessPersistence).toBeCloseTo(-0.25, 12);
  });

  it('every matrix row sums to one, or to nothing at all', () => {
    const p = volatilityPersistence(closesFromLogs(cycle([0.01, -0.02, 0.03, -0.04], 40)), {
      ...SMALL,
      minObservations: 8,
      minRowObservations: 1,
    })!;
    for (const row of p.matrix) {
      const cells = row.to.filter((c): c is number => c != null);
      expect(cells).toHaveLength(4);
      expect(cells.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
  });

  it('withholds a row built on too few transitions', () => {
    const logs = [0.01, -0.011, 0.012, -0.013, 0.04, -0.041, 0.042, -0.043];
    const p = volatilityPersistence(closesFromLogs(logs), { ...SMALL, minRowObservations: 3 })!;

    // Counts survive so a reader can see why; the shares do not.
    expect(p.matrix.every((r) => r.observations > 0)).toBe(true);
    expect(p.matrix.every((r) => r.to.every((c) => c === null))).toBe(true);
    expect(p.quietAfterQuiet).toBeNull();
    expect(p.stormAfterStorm).toBeNull();
    // A mean over rows that were withheld is not a statement about the matrix.
    expect(p.excessPersistence).toBeNull();
  });

  it('reads the half-life as the AR(1) the convention says it is', () => {
    /*
     * The stated convention is ln(0.5)/ln(ρ₁), so the reported half-life must
     * satisfy ρ₁ raised to it being exactly one half. Checked against the
     * reported ρ₁ rather than against a recorded number, so it tests the
     * relationship the doc comment promises.
     */
    const logs = [0.01, -0.011, 0.012, -0.013, 0.04, -0.041, 0.042, -0.043];
    const p = volatilityPersistence(closesFromLogs(logs), SMALL)!;

    expect(p.rho1!).toBeGreaterThan(0);
    expect(p.halfLife!).toBeGreaterThan(0);
    expect(Math.pow(p.rho1!, p.halfLife!)).toBeCloseTo(0.5, 10);
  });

  it('has no half-life when the magnitude series does not decay', () => {
    // ρ₁ is negative here, which is not a decay at all. Reporting a number
    // would be reporting the half-life of something that is not halving.
    const p = volatilityPersistence(closesFromLogs(cycle([0.01, 0.03], 8)), SMALL)!;
    expect(p.rho1!).toBeLessThan(0);
    expect(p.halfLife).toBeNull();
  });

  it('has no autocorrelation to report for a constant magnitude series', () => {
    /*
     * Every day moves by exactly the same amount. The magnitude series is flat,
     * so its variance is zero and a correlation is undefined — not zero, which
     * would read as "no persistence" when the truth is "perfectly persistent
     * and unmeasurable by this estimator".
     */
    const p = volatilityPersistence(closesFromLogs(cycle([0.02, -0.02], 20)), SMALL)!;
    expect(p.acf.every((a) => a.absolute === null)).toBe(true);
    expect(p.rho1).toBeNull();
    expect(p.halfLife).toBeNull();
    // The signed series is not flat, so it still has one.
    expect(p.acf[0].signed).not.toBeNull();
  });

  it('skips a pair containing a non-positive close instead of calling it flat', () => {
    // A zero print is missing data. Treating it as a 0% move would make it the
    // quietest day in the sample and drag the whole first quartile onto it.
    const clean = closesFromLogs(cycle([0.01, -0.02, 0.03, -0.04], 40));
    const broken = [...clean];
    broken[20] = 0;

    const a = volatilityPersistence(clean, SMALL)!;
    const b = volatilityPersistence(broken, SMALL)!;
    expect(a.observations).toBe(40);
    expect(b.observations).toBe(38); // Both pairs touching the bad print are gone.
  });

  it('reports nothing below the minimum sample', () => {
    expect(volatilityPersistence([])).toBeNull();
    expect(volatilityPersistence([100, 101])).toBeNull();
    // The default floor is 60 log returns, so 60 closes is one short.
    expect(volatilityPersistence(closesFromLogs(cycle([0.01, -0.02], 59)))).toBeNull();
    expect(volatilityPersistence(closesFromLogs(cycle([0.01, -0.02], 60)))).not.toBeNull();
  });

  it('leaves a lag the sample cannot cover empty rather than guessing', () => {
    const p = volatilityPersistence(closesFromLogs(cycle([0.01, -0.02, 0.03, -0.04], 8)), {
      ...SMALL,
      lags: 10,
    })!;
    expect(p.acf).toHaveLength(10);
    // Eight returns cannot measure lag 8 or beyond.
    expect(p.acf[7].absolute).toBeNull();
    expect(p.acf[9].signed).toBeNull();
    expect(p.acf[6].absolute).not.toBeNull();
  });
});
