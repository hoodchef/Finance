import { describe, expect, it } from 'vitest';
import {
  DEPTH_THRESHOLDS,
  drawdownTopology,
  meanFurtherFall,
} from '../src/lib/desk/drawdown-topology';
import type { Bar } from '../src/lib/desk/models';

/**
 * Drawdown recovery topology, against arithmetic worked by hand.
 * =============================================================================
 * Every expected number below is computed in the comment above it from the
 * closes in the test, not lifted from a run of the code. The cases that matter
 * most are the ones where a lazier implementation would look right:
 *
 *  - measuring from the trough instead of the crossing (which makes every
 *    drawdown look survivable, because nothing goes lower than the low),
 *  - counting one wobbly descent as several separate events,
 *  - treating an unrecovered drawdown as a fast one by leaving it out
 *    silently rather than reporting the censoring,
 *  - calling a bounce off the low a recovery.
 */

/** Bars from closes. Only the close and date matter to this model. */
function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1_000,
  }));
}

const band = (t: ReturnType<typeof drawdownTopology>, threshold: number) =>
  t.bands.find((b) => b.threshold === threshold)!;

describe('drawdown recovery topology', () => {
  it('measures the further fall from the crossing, not from the trough', () => {
    /*
     * 100 → 90 → 70 → 100.
     *   peak 100 throughout; drawdowns 0, −0.10, −0.30, 0.
     * The −5% band is first crossed at bar 1 (close 90, −10%). The trough is
     * bar 2 at 70. So the further fall is 70/90 − 1 = −2/9 = −0.222…, NOT
     * zero, which is what measuring from the trough would give.
     * Recovery is bar 3, so 3 − 1 = 2 bars from the crossing.
     */
    const t = drawdownTopology(bars([100, 90, 70, 100]));
    const b5 = band(t, 0.05);

    expect(b5.episodes).toBe(1);
    expect(b5.crossings[0].depthAtCrossing).toBeCloseTo(-0.1, 12);
    expect(b5.crossings[0].furtherFall).toBeCloseTo(-2 / 9, 12);
    expect(b5.crossings[0].barsToTrough).toBe(1);
    expect(b5.crossings[0].barsToRecover).toBe(2);
    expect(b5.crossings[0].recovered).toBe(true);
    expect(b5.medianFurtherFall).toBeCloseTo(-2 / 9, 12);

    /*
     * The −20% band on the same path is not crossed until bar 2, which IS the
     * trough — so from there the further fall really is zero and recovery is
     * one bar away. The same episode, read at two depths, gives two different
     * conditional answers, which is the entire point of the model.
     */
    const b20 = band(t, 0.2);
    expect(b20.episodes).toBe(1);
    expect(b20.crossings[0].furtherFall).toBeCloseTo(0, 12);
    expect(b20.crossings[0].barsToTrough).toBe(0);
    expect(b20.crossings[0].barsToRecover).toBe(1);
  });

  it('counts one crossing per episode, however often the level is re-crossed', () => {
    /*
     * 100 → 88 → 94 → 86 → 92 → 100.
     * Peak stays 100. Drawdowns: 0, −0.12, −0.06, −0.14, −0.08, 0.
     * The path dips below −10% twice, at bars 1 and 3, without ever making a
     * new high in between — so it is ONE episode and one −10% event.
     * Trough is bar 3 at 86; further fall from the crossing at 88 is
     * 86/88 − 1 = −1/44 = −0.022727…
     */
    const t = drawdownTopology(bars([100, 88, 94, 86, 92, 100]));
    const b10 = band(t, 0.1);

    expect(b10.episodes).toBe(1);
    expect(b10.crossings[0].crossedDate).toBe('2024-01-02');
    expect(b10.crossings[0].furtherFall).toBeCloseTo(-1 / 44, 12);
    expect(b10.crossings[0].barsToTrough).toBe(2);
    expect(b10.crossings[0].barsToRecover).toBe(4);
    expect(t.totalEpisodes).toBe(1);
  });

  it('separates two episodes that were interrupted by a new high', () => {
    /*
     * 100 → 85 → 100 → 105 → 90 → 105.
     * First episode: peak 100, bar 1 at 85 is −15%, recovered at bar 2.
     * Bar 3 sets a new peak of 105.
     * Second episode: bar 4 at 90 is 90/105 − 1 = −0.142857…, recovered at
     * bar 5. Two distinct −10% events, each recovering in one bar.
     */
    const t = drawdownTopology(bars([100, 85, 100, 105, 90, 105]));
    const b10 = band(t, 0.1);

    expect(b10.episodes).toBe(2);
    expect(b10.recovered).toBe(2);
    expect(b10.recoveryRate).toBe(1);
    expect(b10.medianBarsToRecover).toBe(1);
    expect(b10.maxBarsToRecover).toBe(1);
    expect(b10.crossings[1].depthAtCrossing).toBeCloseTo(90 / 105 - 1, 12);
    expect(t.totalEpisodes).toBe(2);
  });

  it('reports an unrecovered drawdown as censored rather than dropping it', () => {
    /*
     * 100 → 80 → 85: still 15% below the old high at the end of the sample.
     * The −10% band has one episode, zero recovered. The median recovery time
     * must be null — NOT "fast" and not zero — and the unrecovered count must
     * make the censoring visible.
     */
    const t = drawdownTopology(bars([100, 80, 85]));
    const b10 = band(t, 0.1);

    expect(b10.episodes).toBe(1);
    expect(b10.recovered).toBe(0);
    expect(b10.unrecovered).toBe(1);
    expect(b10.recoveryRate).toBe(0);
    expect(b10.medianBarsToRecover).toBeNull();
    expect(b10.maxBarsToRecover).toBeNull();
    expect(b10.crossings[0].open).toBe(true);
    expect(b10.crossings[0].barsToRecover).toBeNull();
  });

  it('recovers only at the prior peak, not at a bounce off the low', () => {
    /*
     * 100 → 70 → 99 → 100.
     * The bounce to 99 is a 41% rally off the low and still 1% under water.
     * Recovery is bar 3, so from the crossing at bar 1 that is 2 bars, not 1.
     */
    const t = drawdownTopology(bars([100, 70, 99, 100]));
    const b20 = band(t, 0.2);

    expect(b20.crossings[0].barsToRecover).toBe(2);
    expect(t.totalEpisodes).toBe(1);
  });

  it('describes where the security stands right now without using the future', () => {
    /*
     * 100 → 120 → 90. The peak is 120 at bar 1; the current drawdown is
     * 90/120 − 1 = −0.25 and the gain needed back to 120 is 120/90 − 1 = 1/3.
     * Two bars have been spent under water (bars 1..2 → the episode starts at
     * bar 2, so one bar). Deepest threshold already crossed is −20%.
     */
    const t = drawdownTopology(bars([100, 120, 90]));

    expect(t.current!.drawdown).toBeCloseTo(-0.25, 12);
    expect(t.current!.gainToRecover).toBeCloseTo(1 / 3, 12);
    expect(t.current!.peakDate).toBe('2024-01-02');
    expect(t.current!.barsUnderwater).toBe(1);
    expect(t.current!.deepestThresholdCrossed).toBe(0.2);
  });

  it('reports no open drawdown at a new high', () => {
    const t = drawdownTopology(bars([100, 90, 110]));
    expect(t.current!.drawdown).toBe(0);
    expect(t.current!.barsUnderwater).toBe(0);
    expect(t.current!.gainToRecover).toBeCloseTo(0, 12);
    expect(t.current!.deepestThresholdCrossed).toBeNull();
  });

  it('reports a threshold the security never reached as empty, not as zero', () => {
    /*
     * A 6% dip never crosses −10%. Reporting "0 further fall, 0 days to
     * recover" would put a security that has never had a real drawdown at the
     * top of a table sorted by resilience.
     */
    const t = drawdownTopology(bars([100, 94, 100]));
    const b10 = band(t, 0.1);

    expect(b10.episodes).toBe(0);
    expect(b10.recoveryRate).toBeNull();
    expect(b10.medianFurtherFall).toBeNull();
    expect(b10.worstFurtherFall).toBeNull();
    expect(b10.medianBarsToRecover).toBeNull();
    expect(b10.worstDepth).toBeNull();
  });

  it('measures time under water and the ulcer index over the whole sample', () => {
    /*
     * 100 → 90 → 100 → 100: bar 1 is the only underwater bar of four, so the
     * share is 1/4. The ulcer index is the RMS depth: √((0 + 0.01 + 0 + 0)/4)
     * = √0.0025 = 0.05.
     */
    const t = drawdownTopology(bars([100, 90, 100, 100]));
    expect(t.underwaterShare).toBeCloseTo(0.25, 12);
    expect(t.ulcer).toBeCloseTo(0.05, 12);
  });

  it('summarises episode depths across the record', () => {
    /*
     * Three episodes, troughs at −10%, −20% and −30%. The median depth is
     * −20%. The deep end (5th percentile of a negative series) is at or below
     * the median and no shallower than the worst episode.
     */
    const t = drawdownTopology(bars([100, 90, 100, 80, 100, 70, 100]));
    expect(t.totalEpisodes).toBe(3);
    expect(t.medianEpisodeDepth).toBeCloseTo(-0.2, 12);
    expect(t.p95EpisodeDepth!).toBeLessThanOrEqual(t.medianEpisodeDepth!);
    expect(t.p95EpisodeDepth!).toBeGreaterThanOrEqual(-0.3);
  });

  it('returns an empty topology for a series too short to have one', () => {
    for (const closes of [[], [100]]) {
      const t = drawdownTopology(bars(closes));
      expect(t.current).toBeNull();
      expect(t.underwaterShare).toBeNull();
      expect(t.ulcer).toBeNull();
      expect(t.totalEpisodes).toBe(0);
      expect(t.bands).toHaveLength(DEPTH_THRESHOLDS.length);
      expect(t.bands.every((b) => b.episodes === 0)).toBe(true);
    }
  });

  it('refuses a series containing a non-positive close', () => {
    // A zero or negative print is bad data, not a 100% drawdown, and dividing
    // by it would produce a plausible-looking recovery statistic.
    const t = drawdownTopology(bars([100, 0, 90]));
    expect(t.current).toBeNull();
    expect(t.totalEpisodes).toBe(0);
  });

  it('never returns Infinity from the summary line', () => {
    expect(meanFurtherFall(drawdownTopology(bars([100, 100, 100])))).toBeNull();
    const t = drawdownTopology(bars([100, 90, 70, 100]));
    // Bands −5% and −10% both cross at bar 1 (−2/9); −20% crosses at the
    // trough (0). Mean of (−2/9, −2/9, 0) = −4/27.
    expect(meanFurtherFall(t)).toBeCloseTo(-4 / 27, 12);
  });

  it('honours custom thresholds', () => {
    const t = drawdownTopology(bars([100, 97, 100]), { thresholds: [0.02] });
    expect(t.bands).toHaveLength(1);
    expect(t.bands[0].label).toBe('−2%');
    expect(t.bands[0].episodes).toBe(1);
  });
});
