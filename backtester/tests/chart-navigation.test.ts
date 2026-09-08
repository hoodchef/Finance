import { describe, expect, it } from 'vitest';
import {
  MIN_BARS,
  clampViewport,
  fitViewport,
  isAtLatest,
  panStep,
  scrollToLatest,
  zoomStep,
} from '../src/components/chart/interactions';

/**
 * Getting back to the newest bar.
 * =============================================================================
 * The chart had exactly one way home: "reset", which fits the whole series. On
 * a chart zoomed into a single session of one-minute bars that means throwing
 * the zoom away in order to find where the data ended, then building it again.
 *
 * `scrollToLatest` is the other move — keep the window, slide it to the right
 * edge — and the property that makes it worth having is that the SPAN survives.
 * That is what these check, because a "go to latest" that quietly zoomed out
 * would look like it worked and be the same problem again.
 */

const CANDLES = 885; // One session of one-minute bars, pre- and post-market.

describe('scrolling to the most recent bar', () => {
  it('keeps the zoom level exactly', () => {
    const zoomedIn = clampViewport({ start: 100, end: 160 }, CANDLES);
    const span = zoomedIn.end - zoomedIn.start;

    const moved = scrollToLatest(zoomedIn, CANDLES);

    expect(moved.end - moved.start).toBeCloseTo(span, 10);
    expect(moved.end).toBe(CANDLES);
    expect(moved.start).toBeCloseTo(CANDLES - span, 10);
  });

  it('differs from a reset, which is the whole reason it exists', () => {
    const zoomedIn = clampViewport({ start: 100, end: 160 }, CANDLES);
    const latest = scrollToLatest(zoomedIn, CANDLES);
    const reset = fitViewport(CANDLES);

    // Both land on the right-hand edge...
    expect(latest.end).toBe(reset.end);
    // ...but only one of them still shows sixty bars.
    expect(latest.end - latest.start).toBeCloseTo(60, 10);
    expect(reset.end - reset.start).toBe(CANDLES);
  });

  it('is a no-op when the view is already at the end', () => {
    const atEnd = fitViewport(CANDLES, 60);
    expect(scrollToLatest(atEnd, CANDLES)).toEqual(atEnd);
  });

  it('never walks off the data, however deep the zoom', () => {
    for (const span of [MIN_BARS, 3, 25, 400, CANDLES]) {
      const vp = clampViewport({ start: 0, end: span }, CANDLES);
      const moved = scrollToLatest(vp, CANDLES);
      expect(moved.start).toBeGreaterThanOrEqual(0);
      expect(moved.end).toBeLessThanOrEqual(CANDLES);
      expect(moved.end).toBeGreaterThan(moved.start);
    }
  });

  it('survives an empty series rather than producing a broken window', () => {
    const moved = scrollToLatest({ start: 0, end: 10 }, 0);
    expect(moved.end).toBeGreaterThan(moved.start);
  });

  it('takes a viewport panned deep into history straight back', () => {
    // The actual complaint: zoomed in, scrolled back, a long way from the end.
    let vp = clampViewport({ start: 400, end: 460 }, CANDLES);
    for (let i = 0; i < 12; i++) vp = panStep(vp, CANDLES, -1);
    expect(isAtLatest(vp, CANDLES)).toBe(false);

    const moved = scrollToLatest(vp, CANDLES);
    expect(isAtLatest(moved, CANDLES)).toBe(true);
    expect(moved.end - moved.start).toBeCloseTo(vp.end - vp.start, 10);
  });
});

describe('knowing whether the newest bar is on screen', () => {
  it('is true at the right edge and false once you leave it', () => {
    const atEnd = fitViewport(CANDLES, 60);
    expect(isAtLatest(atEnd, CANDLES)).toBe(true);
    expect(isAtLatest(panStep(atEnd, CANDLES, -1), CANDLES)).toBe(false);
  });

  it('tolerates a fractional pan that stops just short', () => {
    // Half a bar of slack: without it the affordance offering to take you to
    // the end flickers on while you are already there.
    expect(isAtLatest({ start: CANDLES - 60.4, end: CANDLES - 0.4 }, CANDLES)).toBe(true);
    expect(isAtLatest({ start: CANDLES - 62, end: CANDLES - 2 }, CANDLES)).toBe(false);
  });

  it('says yes for an empty series, so nothing is offered on an empty chart', () => {
    expect(isAtLatest({ start: 0, end: 1 }, 0)).toBe(true);
  });

  it('stays true through a zoom taken at the right-hand edge', () => {
    // Zooming does not move you off the end, so the affordance must not appear
    // just because the span changed.
    let vp = fitViewport(CANDLES, 120);
    for (let i = 0; i < 4; i++) vp = zoomStep(vp, CANDLES, 1);
    expect(isAtLatest(vp, CANDLES)).toBe(true);
  });
});
