import { describe, expect, it } from 'vitest';
import {
  LOG_FLOOR_RATIO,
  layoutPanes,
  logTickValues,
  makePriceFormatter,
  makePriceScale,
  makeTimeScale,
  niceStep,
  niceTickValues,
  priceDomain,
  seriesDomain,
  timeTicks,
  visibleRange,
  volumeMax,
} from '../src/components/chart/scales';
import {
  MIN_BARS,
  MOMENTUM_EPSILON,
  clampViewport,
  decayVelocity,
  fitViewport,
  nearestIndex,
  panByPixels,
  panStep,
  panViewport,
  paneAt,
  stepMomentum,
  velocityFromSamples,
  zoomFactorFromPinch,
  zoomFactorFromWheel,
  zoomStep,
  zoomViewport,
} from '../src/components/chart/interactions';
import type { Bar, Viewport } from '../src/components/chart/types';

/**
 * The chart's geometry, tested where it is a function of its inputs.
 * =============================================================================
 * Nothing here renders. That is deliberate: a scale that is off by half a bar
 * and a clamp that lets the viewport walk off the end of the data both look
 * fine in a screenshot, and both are trivially provable as arithmetic.
 *
 * Two properties carry most of the weight:
 *
 *   ROUND TRIP    price → pixel → price must be the identity, in both linear
 *                 and log mode. If it is not, then the crosshair readout, the
 *                 drag of a drawing and the axis labels are each reading a
 *                 different chart from the one that was painted.
 *   CLAMPING      no sequence of gestures, however fast or however compounded,
 *                 may produce a viewport that is not a real slice of the data.
 *                 A user who scrolls into blank space has to reload to escape.
 */

/** Weekday bars on a sine wave — deterministic, and it has real highs/lows. */
function makeBars(n: number, start = '2020-01-01'): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  let i = 0;
  while (out.length < n) {
    const day = new Date(t).getUTCDay();
    t += 86_400_000;
    if (day === 0 || day === 6) continue;
    const base = 100 + Math.sin(i / 9) * 20 + i * 0.05;
    const open = base;
    const close = base + Math.cos(i / 5) * 1.5;
    out.push({
      date: new Date(t - 86_400_000).toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) + 0.8,
      low: Math.min(open, close) - 0.8,
      close,
      volume: 1_000_000 + i * 1000,
    });
    i++;
  }
  return out;
}

const BARS = makeBars(500);

describe('the time scale', () => {
  const scale = makeTimeScale({ start: 30, end: 130 }, 0, 800);

  it('round-trips index → pixel → index', () => {
    for (const index of [30, 42.5, 80, 129.999, 0, 400]) {
      expect(scale.toIndex(scale.toX(index))).toBeCloseTo(index, 9);
    }
  });

  it('puts the viewport edges on the plot edges', () => {
    expect(scale.toX(30)).toBeCloseTo(0, 9);
    expect(scale.toX(130)).toBeCloseTo(800, 9);
    expect(scale.pxPerBar).toBeCloseTo(8, 9);
  });

  it('centres a bar half a pitch after its left edge', () => {
    // Wicks, line vertices and crosshair snapping all use the centre. Half a
    // bar of disagreement between them and the candle bodies reads on screen
    // as a series lagging the price it is drawn over.
    expect(scale.centerX(40) - scale.toX(40)).toBeCloseTo(scale.pxPerBar / 2, 9);
    expect(scale.toIndex(scale.centerX(40))).toBeCloseTo(40.5, 9);
  });

  it('survives a degenerate viewport rather than dividing by zero', () => {
    const flat = makeTimeScale({ start: 5, end: 5 }, 0, 400);
    expect(Number.isFinite(flat.toX(5))).toBe(true);
    expect(Number.isFinite(flat.pxPerBar)).toBe(true);
  });
});

describe('visibleRange', () => {
  it('covers the viewport with one bar of bleed on each side', () => {
    const r = visibleRange({ start: 10.4, end: 20.6 }, 500);
    expect(r.from).toBeLessThanOrEqual(10);
    expect(r.to).toBeGreaterThanOrEqual(21);
  });

  it('clips to the data and reports an empty range for no data', () => {
    expect(visibleRange({ start: -50, end: 20 }, 500).from).toBe(0);
    expect(visibleRange({ start: 480, end: 600 }, 500).to).toBe(499);
    expect(visibleRange({ start: 0, end: 10 }, 0).to).toBeLessThan(0);
  });
});

describe('the price scale', () => {
  it('round-trips price → pixel → price on a linear axis', () => {
    const scale = makePriceScale({ min: 80, max: 120 }, 10, 400, 'linear');
    for (const price of [80, 91.37, 100, 119.999, 120]) {
      expect(scale.toPrice(scale.toY(price))).toBeCloseTo(price, 9);
    }
    expect(scale.toY(120)).toBeCloseTo(10, 9);
    expect(scale.toY(80)).toBeCloseTo(410, 9);
  });

  it('round-trips price → pixel → price on a log axis', () => {
    const scale = makePriceScale({ min: 1, max: 1000 }, 0, 300, 'log');
    for (const price of [1, 2.5, 37, 999.5, 1000]) {
      expect(scale.toPrice(scale.toY(price))).toBeCloseTo(price, 6);
    }
  });

  it('gives equal percentage moves equal height on a log axis', () => {
    // This is the entire reason log mode exists: a 100% gain in 1995 and a
    // 100% gain in 2024 must occupy the same vertical distance, or a long
    // history compresses its early years into a flat line.
    const scale = makePriceScale({ min: 1, max: 1000 }, 0, 300, 'log');
    const near = scale.toY(10) - scale.toY(20);
    const far = scale.toY(100) - scale.toY(200);
    expect(near).toBeCloseTo(far, 6);

    const linear = makePriceScale({ min: 1, max: 1000 }, 0, 300, 'linear');
    expect(linear.toY(10) - linear.toY(20)).not.toBeCloseTo(
      linear.toY(100) - linear.toY(200),
      3,
    );
  });

  it('falls back to linear when a log domain reaches zero', () => {
    // A domain containing zero has no logarithm. Silently clamping it would
    // misplace every point on the chart instead of admitting the mismatch.
    const scale = makePriceScale({ min: -5, max: 20 }, 0, 200, 'log');
    expect(scale.mode).toBe('linear');
    expect(scale.toPrice(scale.toY(-3))).toBeCloseTo(-3, 9);
  });

  it('floors a log domain far below any real price', () => {
    const scale = makePriceScale({ min: 1e-30, max: 100 }, 0, 200, 'log');
    expect(scale.mode).toBe('log');
    expect(scale.min).toBeCloseTo(100 * LOG_FLOOR_RATIO, 12);
    expect(scale.toPrice(scale.toY(50))).toBeCloseTo(50, 6);
  });

  it('gives a flat series a scale with height', () => {
    const scale = makePriceScale({ min: 42, max: 42 }, 0, 200, 'linear');
    expect(scale.max).toBeGreaterThan(scale.min);
    expect(Number.isFinite(scale.toY(42))).toBe(true);
    expect(scale.toY(42)).toBeCloseTo(100, 6);
  });

  it('accepts an inverted domain', () => {
    const scale = makePriceScale({ min: 120, max: 80 }, 0, 100, 'linear');
    expect(scale.toY(120)).toBeCloseTo(0, 9);
    expect(scale.toY(80)).toBeCloseTo(100, 9);
  });
});

describe('domains', () => {
  it('covers every visible high and low', () => {
    const d = priceDomain(BARS, 100, 200, 'linear', 0);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 100; i <= 200; i++) {
      min = Math.min(min, BARS[i].low);
      max = Math.max(max, BARS[i].high);
    }
    expect(d.min).toBeCloseTo(min, 9);
    expect(d.max).toBeCloseTo(max, 9);
  });

  it('pads multiplicatively in log mode so both ends get the same margin', () => {
    const raw = priceDomain(BARS, 0, 100, 'log', 0);
    const padded = priceDomain(BARS, 0, 100, 'log', 0.1);
    expect(padded.min).toBeLessThan(raw.min);
    expect(padded.max).toBeGreaterThan(raw.max);
    expect(padded.max / raw.max).toBeCloseTo(raw.min / padded.min, 6);
  });

  it('ignores nulls in an indicator series', () => {
    const points = [null, null, 5, 9, null, 2];
    const d = seriesDomain(points, 0, 5, 0);
    expect(d).toEqual({ min: 2, max: 9 });
  });

  it('returns a usable domain when a series is entirely null', () => {
    const d = seriesDomain([null, null], 0, 1);
    expect(Number.isFinite(d.min)).toBe(true);
    expect(d.max).toBeGreaterThan(d.min);
  });

  it('reads volume from the visible slice only', () => {
    expect(volumeMax(BARS, 0, 9)).toBe(BARS[9].volume);
    expect(volumeMax(BARS, 0, -1)).toBe(0);
  });
});

describe('ticks', () => {
  it('uses only the 1 / 2 / 2.5 / 5 / 10 ladder', () => {
    for (const rough of [0.0031, 0.7, 3, 17, 230, 8_400]) {
      const step = niceStep(rough);
      const mantissa = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-12));
      // The exponent below is floor(log10(step)), so the mantissa lands in
      // [1, 10) — the ladder itself, not a tenth of it.
      expect([1, 2, 2.5, 5, 10]).toContainEqual(Number(mantissa.toPrecision(3)));
      expect(step).toBeGreaterThanOrEqual(rough / 10);
    }
  });

  it('keeps every tick inside the domain and roughly on target', () => {
    const values = niceTickValues({ min: 87.4, max: 132.9 }, 6);
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values.length).toBeLessThanOrEqual(12);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(87.4);
      expect(v).toBeLessThanOrEqual(132.9);
    }
    // Evenly spaced.
    const gaps = values.slice(1).map((v, i) => v - values[i]);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 9);
  });

  it('terminates on a degenerate domain', () => {
    expect(niceTickValues({ min: 5, max: 5 })).toEqual([5]);
    expect(niceTickValues({ min: 0, max: Infinity }).length).toBeLessThan(600);
  });

  it('walks decades on a log axis', () => {
    const values = logTickValues({ min: 1, max: 1000 }, 12);
    expect(values).toContain(1);
    expect(values).toContain(20);
    expect(values).toContain(500);
  });

  it('falls back to linear ticks when a log range spans no decade', () => {
    // A chart zoomed into a $2 move on a $400 stock would otherwise get one
    // labelled gridline, or none.
    const values = logTickValues({ min: 400, max: 402 }, 5);
    expect(values.length).toBeGreaterThanOrEqual(3);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(400);
      expect(v).toBeLessThanOrEqual(402);
    }
  });
});

describe('time ticks', () => {
  const dates = BARS.map((b) => b.date);

  it('labels each calendar bucket once, in order', () => {
    const viewport: Viewport = { start: 0, end: 500 };
    const scale = makeTimeScale(viewport, 0, 900);
    const ticks = timeTicks(dates, viewport, scale, 8);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(new Set(ticks.map((t) => t.label)).size).toBe(ticks.length);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].position).toBeGreaterThan(ticks[i - 1].position);
    }
  });

  it('does not label the left edge when it lands mid-bucket', () => {
    // Otherwise a viewport starting in the middle of March gets a "Mar" tick
    // on a bar that is not the start of March.
    const viewport: Viewport = { start: 40, end: 120 };
    const scale = makeTimeScale(viewport, 0, 800);
    const ticks = timeTicks(dates, viewport, scale, 10);
    const firstBucket = dates[40].slice(0, 7);
    const previousBucket = dates[39].slice(0, 7);
    if (firstBucket === previousBucket) {
      expect(ticks.some((t) => t.index === 40)).toBe(false);
    }
  });

  it('switches to year labels over a long span and day labels over a short one', () => {
    const long = makeBars(3000);
    const longDates = long.map((b) => b.date);
    const yearly = timeTicks(longDates, { start: 0, end: 3000 }, makeTimeScale({ start: 0, end: 3000 }, 0, 900));
    expect(yearly.every((t) => /^\d{4}$/.test(t.label))).toBe(true);

    const daily = timeTicks(dates, { start: 0, end: 20 }, makeTimeScale({ start: 0, end: 20 }, 0, 900));
    expect(daily.every((t) => /[A-Z][a-z]{2} \d{1,2}/.test(t.label))).toBe(true);
  });

  it('handles an empty series', () => {
    expect(timeTicks([], { start: 0, end: 1 }, makeTimeScale({ start: 0, end: 1 }, 0, 100))).toEqual([]);
  });
});

describe('pane layout', () => {
  const cases = [
    { width: 360, height: 300, label: 'a phone' },
    { width: 1280, height: 480, label: 'a laptop' },
    { width: 3440, height: 900, label: 'an ultrawide' },
  ];

  for (const c of cases) {
    it(`stacks panes without overlap or overflow on ${c.label}`, () => {
      const layout = layoutPanes({
        width: c.width,
        height: c.height,
        showVolume: true,
        separatePanes: 2,
      });
      const rects = [layout.price, layout.volume!, ...layout.panes];
      for (const r of rects) {
        expect(r.height).toBeGreaterThan(0);
        expect(r.width).toBe(layout.plotWidth);
      }
      for (let i = 1; i < rects.length; i++) {
        expect(rects[i].y).toBeGreaterThanOrEqual(rects[i - 1].y + rects[i - 1].height);
      }
      const last = rects[rects.length - 1];
      expect(last.y + last.height).toBeLessThanOrEqual(layout.timeAxis.y + 0.001);
      expect(layout.timeAxis.y + layout.timeAxis.height).toBeCloseTo(c.height, 6);
      expect(layout.plotWidth).toBeLessThan(c.width);
    });
  }

  it('keeps the price pane dominant however many oscillators are added', () => {
    // Three fixed-height oscillators under a short chart would otherwise leave
    // the price pane — the reason the chart exists — as a sliver.
    const layout = layoutPanes({ width: 900, height: 380, showVolume: true, separatePanes: 3 });
    const lower = [layout.volume!, ...layout.panes].reduce((s, r) => s + r.height, 0);
    expect(layout.price.height).toBeGreaterThan(lower);
    expect(layout.price.height).toBeGreaterThanOrEqual(60);
  });

  it('gives the whole box to price when nothing is stacked below', () => {
    const layout = layoutPanes({ width: 800, height: 400, showVolume: false, separatePanes: 0 });
    expect(layout.volume).toBeNull();
    expect(layout.panes).toEqual([]);
    expect(layout.price.height).toBeCloseTo(400 - layout.timeAxis.height, 6);
  });
});

describe('price formatting', () => {
  it('follows the magnitude and the visible range', () => {
    expect(makePriceFormatter({ min: 0.12, max: 0.48 })(0.1234)).toBe('0.1234');
    expect(makePriceFormatter({ min: 95, max: 105 })(99.456)).toBe('99.46');
    expect(makePriceFormatter({ min: 1200, max: 4800 })(4321.6)).toBe('4322');
  });
});

/* ===================================================== zoom, pan, clamps === */

const COUNT = 500;
const inBounds = (vp: Viewport, count = COUNT) =>
  vp.start >= -1e-9 && vp.end <= count + 1e-9 && vp.end > vp.start;

describe('clamping', () => {
  it('pulls a viewport back onto the data from either side', () => {
    expect(clampViewport({ start: -300, end: -100 }, COUNT).start).toBe(0);
    expect(clampViewport({ start: 900, end: 1200 }, COUNT).end).toBe(COUNT);
    expect(inBounds(clampViewport({ start: -300, end: 900 }, COUNT))).toBe(true);
  });

  it('never shows fewer bars than the minimum or more than exist', () => {
    expect(clampViewport({ start: 100, end: 100.5 }, COUNT).end - clampViewport({ start: 100, end: 100.5 }, COUNT).start)
      .toBeCloseTo(MIN_BARS, 9);
    const wide = clampViewport({ start: -1000, end: 5000 }, COUNT);
    expect(wide).toEqual({ start: 0, end: COUNT });
  });

  it('holds the centre when it has to correct the span', () => {
    const corrected = clampViewport({ start: 200, end: 200.2 }, COUNT);
    expect((corrected.start + corrected.end) / 2).toBeCloseTo(200.1, 6);
  });

  it('survives a series shorter than the minimum viewport', () => {
    const vp = clampViewport({ start: 0, end: 100 }, 3);
    expect(vp).toEqual({ start: 0, end: 3 });
  });

  it('survives non-finite input', () => {
    expect(inBounds(clampViewport({ start: NaN, end: Infinity }, COUNT))).toBe(true);
    expect(inBounds(clampViewport({ start: 0, end: 0 }, COUNT))).toBe(true);
  });

  it('reverses an inverted viewport instead of inverting the chart', () => {
    const vp = clampViewport({ start: 300, end: 100 }, COUNT);
    expect(vp.start).toBeLessThan(vp.end);
  });
});

describe('zoom', () => {
  it('converges on the full range when zoomed out repeatedly, and stops there', () => {
    let vp: Viewport = { start: 200, end: 260 };
    for (let i = 0; i < 200; i++) {
      vp = zoomViewport(vp, COUNT, 1.25, (vp.start + vp.end) / 2);
      expect(inBounds(vp)).toBe(true);
    }
    expect(vp).toEqual({ start: 0, end: COUNT });
    // And one more notch changes nothing at all.
    expect(zoomViewport(vp, COUNT, 1.25, 250)).toEqual({ start: 0, end: COUNT });
  });

  it('stops at the minimum span when zoomed in repeatedly', () => {
    let vp: Viewport = { start: 0, end: COUNT };
    for (let i = 0; i < 200; i++) {
      vp = zoomViewport(vp, COUNT, 0.8, 123);
      expect(inBounds(vp)).toBe(true);
      expect(vp.end - vp.start).toBeGreaterThanOrEqual(MIN_BARS - 1e-9);
    }
    expect(vp.end - vp.start).toBeCloseTo(MIN_BARS, 9);
  });

  it('cannot escape the data when zooming out at the right-hand end', () => {
    // The failure this guards: clamping the edges before the span lets a fast
    // zoom-out at the end of the series walk `start` a little more negative
    // with every notch.
    let vp: Viewport = { start: COUNT - 20, end: COUNT };
    for (let i = 0; i < 60; i++) {
      vp = zoomViewport(vp, COUNT, 1.4, COUNT - 1);
      expect(vp.start).toBeGreaterThanOrEqual(0);
      expect(vp.end).toBeLessThanOrEqual(COUNT);
    }
  });

  it('keeps the anchored bar under the cursor', () => {
    // The bar you point at is the bar you keep — that is what makes wheel zoom
    // feel like pulling the chart rather than replacing it.
    const vp: Viewport = { start: 100, end: 300 };
    const anchor = 160;
    const before = makeTimeScale(vp, 0, 800).centerX(anchor);
    for (const factor of [0.5, 0.75, 1.5, 2]) {
      const next = zoomViewport(vp, COUNT, factor, anchor);
      const after = makeTimeScale(next, 0, 800).centerX(anchor);
      expect(after).toBeCloseTo(before, 6);
    }
  });

  it('normalises the three wheel delta units', () => {
    const pixels = zoomFactorFromWheel(100, 0);
    const lines = zoomFactorFromWheel(100 / 16, 1);
    expect(lines).toBeCloseTo(pixels, 6);
    expect(zoomFactorFromWheel(-100, 0)).toBeLessThan(1);
    expect(zoomFactorFromWheel(100, 0)).toBeGreaterThan(1);
    expect(zoomFactorFromWheel(0, 0)).toBe(1);
    // One flung gesture cannot cross the whole zoom range in a frame.
    expect(zoomFactorFromWheel(100_000, 0)).toBeLessThan(2);
  });

  it('reads a pinch as the ratio of finger separation', () => {
    expect(zoomFactorFromPinch(100, 200)).toBeCloseTo(0.5, 9);
    expect(zoomFactorFromPinch(200, 100)).toBeCloseTo(2, 9);
    expect(zoomFactorFromPinch(0, 100)).toBe(1);
  });

  it('zooms about the centre for the keyboard', () => {
    const vp = { start: 100, end: 200 };
    const zoomedIn = zoomStep(vp, COUNT, 1);
    expect(zoomedIn.end - zoomedIn.start).toBeLessThan(100);
    expect((zoomedIn.start + zoomedIn.end) / 2).toBeCloseTo(150, 6);
  });
});

describe('pan', () => {
  it('stops at both ends of the data', () => {
    expect(panViewport({ start: 0, end: 100 }, COUNT, -500)).toEqual({ start: 0, end: 100 });
    expect(panViewport({ start: 400, end: 500 }, COUNT, 500)).toEqual({ start: 400, end: 500 });
  });

  it('moves the chart with the pointer', () => {
    // Dragging right must reveal EARLIER bars, or the chart feels like it is
    // being pushed away rather than dragged.
    const vp = { start: 100, end: 200 };
    const dragged = panByPixels(vp, COUNT, 80, 800);
    expect(dragged.start).toBeLessThan(vp.start);
    expect(dragged.start).toBeCloseTo(90, 6);
    expect(panByPixels(vp, COUNT, -80, 800).start).toBeCloseTo(110, 6);
  });

  it('pans by a fraction of the span, so a key press means the same at any zoom', () => {
    const wide = panStep({ start: 0, end: 400 }, COUNT, 1);
    const narrow = panStep({ start: 0, end: 40 }, COUNT, 1);
    expect(wide.start / 400).toBeCloseTo(narrow.start / 40, 6);
    expect(panStep({ start: 0, end: 40 }, COUNT, 1, true).start).toBeGreaterThan(narrow.start);
  });

  it('ignores a zero-width plot instead of dividing by it', () => {
    const vp = { start: 10, end: 60 };
    expect(panByPixels(vp, COUNT, 40, 0)).toBe(vp);
  });
});

describe('momentum', () => {
  it('decays by elapsed time, not by frame', () => {
    // Per-frame decay makes the same flick travel twice as far on a 120Hz
    // display as on a 60Hz one.
    const oneStep = decayVelocity(1, 32);
    const twoSteps = decayVelocity(decayVelocity(1, 16), 16);
    expect(twoSteps).toBeCloseTo(oneStep, 12);
  });

  it('finishes when the flick dies', () => {
    let vp: Viewport = { start: 100, end: 200 };
    let velocity = 0.4;
    let frames = 0;
    for (; frames < 600; frames++) {
      const step = stepMomentum(vp, velocity, 16, COUNT);
      vp = step.viewport;
      velocity = step.velocity;
      expect(inBounds(vp)).toBe(true);
      if (step.done) break;
    }
    expect(frames).toBeLessThan(600);
    expect(Math.abs(velocity)).toBeLessThan(1);
  });

  it('finishes immediately when it hits an end, rather than burning frames', () => {
    const step = stepMomentum({ start: 400, end: 500 }, 5, 16, COUNT);
    expect(step.done).toBe(true);
    expect(step.viewport).toEqual({ start: 400, end: 500 });
  });

  it('treats a pause before release as a release, not a flick', () => {
    const samples = [
      { index: 100, time: 0 },
      { index: 60, time: 40 },
      { index: 50, time: 80 },
      { index: 50, time: 600 },
    ];
    expect(Math.abs(velocityFromSamples(samples))).toBeLessThan(MOMENTUM_EPSILON);
    expect(velocityFromSamples([{ index: 1, time: 0 }])).toBe(0);
  });

  it('reads the direction and rate of a genuine flick', () => {
    const v = velocityFromSamples([
      { index: 100, time: 0 },
      { index: 80, time: 20 },
      { index: 60, time: 40 },
    ]);
    expect(v).toBeCloseTo(-1, 6);
  });
});

describe('no gesture sequence can strand the user off the data', () => {
  it('holds under a long random walk of zooms and pans', () => {
    // The clamp is the safety net for everything above it: momentum feeding a
    // pan, a pinch mid-drag, a wheel event during a flick. A property test over
    // the composition catches an interaction the individual cases would not.
    let seed = 20260831;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let vp: Viewport = fitViewport(COUNT);
    for (let i = 0; i < 5000; i++) {
      const roll = random();
      if (roll < 0.4) {
        vp = zoomViewport(vp, COUNT, 0.4 + random() * 3, random() * COUNT * 1.6 - COUNT * 0.3);
      } else if (roll < 0.8) {
        vp = panViewport(vp, COUNT, (random() - 0.5) * COUNT * 2);
      } else {
        vp = panByPixels(vp, COUNT, (random() - 0.5) * 4000, 800);
      }
      expect(vp.start).toBeGreaterThanOrEqual(-1e-9);
      expect(vp.end).toBeLessThanOrEqual(COUNT + 1e-9);
      expect(vp.end - vp.start).toBeGreaterThanOrEqual(MIN_BARS - 1e-9);
      expect(Number.isFinite(vp.start) && Number.isFinite(vp.end)).toBe(true);
    }
  });
});

describe('pointer resolution', () => {
  it('snaps the crosshair to a real bar, and only a real bar', () => {
    const scale = makeTimeScale({ start: 10, end: 110 }, 0, 800);
    expect(nearestIndex(scale.toX(42.3), scale, COUNT)).toBe(42);
    expect(nearestIndex(-9999, scale, COUNT)).toBe(0);
    expect(nearestIndex(9999, scale, COUNT)).toBe(COUNT - 1);
    expect(nearestIndex(100, scale, 0)).toBe(0);
  });

  it('reports which pane a pixel is in', () => {
    const layout = layoutPanes({ width: 900, height: 500, showVolume: true, separatePanes: 1 });
    expect(paneAt(100, layout.price.y + 5, layout)).toBe('price');
    expect(paneAt(100, layout.volume!.y + 2, layout)).toBe('volume');
    expect(paneAt(100, layout.panes[0].y + 2, layout)).toBe('pane-0');
    expect(paneAt(100, layout.timeAxis.y + 2, layout)).toBe('time-axis');
    expect(paneAt(layout.plotWidth + 10, 20, layout)).toBe('gutter');
  });
});

describe('fitViewport', () => {
  it('shows the most recent bars when asked for fewer than exist', () => {
    expect(fitViewport(COUNT, 120)).toEqual({ start: COUNT - 120, end: COUNT });
    expect(fitViewport(COUNT)).toEqual({ start: 0, end: COUNT });
    expect(fitViewport(50, 900)).toEqual({ start: 0, end: 50 });
    expect(inBounds(fitViewport(0), 1)).toBe(true);
  });
});
