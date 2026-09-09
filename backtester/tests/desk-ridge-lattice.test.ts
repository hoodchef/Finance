import { describe, expect, it } from 'vitest';
import { buildTailRidge, observedTailFrequency, TAIL_HORIZONS } from '../src/lib/desk/tails';
import {
  AXES,
  DIMENSIONS,
  EDGE_COUNT,
  VERTEX_COUNT,
  buildRegimeLattice,
  describeVertex,
} from '../src/lib/desk/regime-lattice';
import type { Bar } from '../src/lib/desk/models';

/**
 * The tail ridge and the regime lattice.
 * =============================================================================
 * Both of these draw a picture, and a picture is the easiest thing in a
 * codebase to get wrong without anyone noticing — it looks plausible whatever
 * the arithmetic underneath it did. So the tests are about the claims each one
 * makes rather than about the shapes coming out non-empty.
 *
 * For the ridge that claim is the comparison: the lognormal's tail against the
 * frequency the security actually delivered. For the lattice it is that the
 * geometry is a real 5-cube, that vertices mean what the axes say, and that a
 * forward return is withheld when the sample behind it is too small to carry
 * one.
 */

/** A deterministic walk with a controllable per-step volatility. */
function walk(n: number, vol: number, drift = 0, seed = 12345): number[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [100];
  for (let i = 1; i < n; i++) {
    const u = Math.max(1e-12, rand());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    out.push(out[i - 1] * Math.exp(drift + vol * z));
  }
  return out;
}

const asBars = (closes: number[], volume = 1_000_000): Bar[] =>
  closes.map((c, i) => ({
    date: `d${i}`,
    open: c,
    high: c * 1.012,
    low: c * 0.988,
    close: c,
    volume,
  }));

describe('observed tail frequency', () => {
  it('counts the windows that finished beyond the threshold', () => {
    // Rises 1% a day: every 21-day window is far beyond +10%, none below.
    const closes = Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i);
    const f = observedTailFrequency(closes, 21, 0.1);
    expect(f.up).toBe(1);
    expect(f.down).toBe(0);
    expect(f.samples).toBe(120 - 21);
  });

  it('reports nothing when the history is shorter than the window', () => {
    const f = observedTailFrequency([100, 101, 102], 21, 0.1);
    expect(f.up).toBeNull();
    expect(f.down).toBeNull();
    expect(f.samples).toBe(0);
  });

  it('counts a flat series as neither tail', () => {
    const f = observedTailFrequency(new Array(80).fill(100), 21, 0.1);
    expect(f.up).toBe(0);
    expect(f.down).toBe(0);
  });
});

describe('the tail ridge', () => {
  const closes = walk(600, 0.014);
  const built = buildTailRidge({ closes, volatility: 0.28 })!;

  it('draws a band per horizon on one shared grid', () => {
    expect(built.ridge.bands).toHaveLength(TAIL_HORIZONS.length);
    // One grid, or the near horizons would look as wide as the far ones.
    for (const band of built.ridge.bands) {
      expect(band.density).toHaveLength(built.ridge.grid.length);
    }
  });

  it('spreads with time, which is the whole point of the picture', () => {
    const oneSigmas = built.ridge.bands.map((b) => b.oneSigma);
    for (let i = 1; i < oneSigmas.length; i++) {
      expect(oneSigmas[i]).toBeGreaterThan(oneSigmas[i - 1]);
    }
  });

  it('grows the threshold with the horizon', () => {
    // Two sigma of a week is a much smaller move than two sigma of six months.
    const thresholds = built.comparisons.map((c) => c.threshold);
    for (let i = 1; i < thresholds.length; i++) {
      expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
    }
  });

  it('holds the model probability roughly constant, which is the point', () => {
    /*
     * Sigma-scaling exists so the MODEL column barely moves and the OBSERVED
     * column is the only thing that varies — that is what makes the ratio a
     * clean read on tail fatness rather than a restatement of the horizon.
     *
     * A fixed threshold did the opposite: at ±10% the model put a one-week
     * move at 0.0000% and a six-month one at 8%, so the "fat tail multiple"
     * came back as ×5,994,990 for the first row, which is arithmetically
     * correct and communicates nothing.
     *
     * Not exactly constant: the lognormal's drift term pulls the far horizons
     * down slightly, which is real and small.
     */
    const model = built.comparisons.map((c) => c.modelUp + c.modelDown);
    const spread = Math.max(...model) / Math.min(...model);

    /*
     * Within a factor of three, not a factor of one.
     *
     * The lognormal's -0.5σ²t drift pulls the far horizons down — a symmetric
     * ±2σ band in LOG space is not symmetric in price, and the effect grows
     * with t — so the column narrows rather than holding flat. That is real
     * and it is small. Against it, the fixed threshold this replaced varied by
     * six orders of magnitude across the same five rows.
     */
    expect(spread).toBeLessThan(3);

    // And the near end lands where a normal puts two sigma, two-tailed.
    expect(model[0]).toBeGreaterThan(0.02);
    expect(model[0]).toBeLessThan(0.08);
  });

  it('measures the observed frequency over real windows, with the count', () => {
    for (const c of built.comparisons) {
      expect(c.samples).toBe(closes.length - c.days);
      expect(c.observedUp).not.toBeNull();
      expect(c.observedUp! + c.observedDown!).toBeLessThanOrEqual(1);
    }
  });

  it('reports a fat tail when history delivered more than the model allows', () => {
    // A quiet series punctuated by crashes. Fed the QUIET volatility, the
    // lognormal cannot account for the jumps, and the multiple must exceed 1 —
    // this is the correction the panel exists to surface.
    const quiet = walk(500, 0.004, 0, 99);
    const jumpy = quiet.map((c, i) => (i > 0 && i % 60 === 0 ? c * 0.82 : c));
    const rebuilt = buildTailRidge({ closes: jumpy, volatility: 0.004 * Math.sqrt(252) })!;
    const month = rebuilt.comparisons.find((c) => c.label === '1M')!;
    expect(month.fatTailMultiple).not.toBeNull();
    expect(month.fatTailMultiple!).toBeGreaterThan(1);
  });

  it('refuses to draw without a volatility or a history', () => {
    expect(buildTailRidge({ closes, volatility: 0 })).toBeNull();
    expect(buildTailRidge({ closes: [100, 101], volatility: 0.3 })).toBeNull();
  });
});

describe('the regime lattice', () => {
  // Long enough to clear the 200-day trend window with room to classify.
  const bars = asBars(walk(900, 0.013, 0.0004));
  const lattice = buildRegimeLattice(bars);

  it('is a real 5-cube: 32 vertices, 80 edges', () => {
    expect(DIMENSIONS).toBe(5);
    expect(VERTEX_COUNT).toBe(32);
    expect(EDGE_COUNT).toBe(80);
    expect(lattice.vertices).toHaveLength(32);
    expect(lattice.edges).toHaveLength(80);
  });

  it('joins only vertices one condition apart', () => {
    for (const e of lattice.edges) {
      const diff = e.from ^ e.to;
      // Exactly one bit set: a power of two.
      expect(diff & (diff - 1)).toBe(0);
      expect(diff).toBeGreaterThan(0);
    }
  });

  it('names each edge by the condition that flips across it', () => {
    for (const e of lattice.edges) {
      const bit = Math.log2(e.from ^ e.to);
      expect(e.axis).toBe(AXES[bit]);
    }
  });

  it('lists every edge exactly once', () => {
    const keys = lattice.edges.map((e) => `${Math.min(e.from, e.to)}-${Math.max(e.from, e.to)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts every classified day on exactly one vertex', () => {
    const visits = lattice.vertices.reduce((a, v) => a + v.visits, 0);
    expect(visits).toBe(lattice.classified);
    expect(lattice.classified).toBeGreaterThan(0);
  });

  it('decodes a vertex to the conditions that hold there', () => {
    expect(describeVertex(0)).toBe('none');
    expect(describeVertex(1)).toBe('TREND');
    expect(describeVertex(0b11111)).toBe(AXES.join(' · '));
    // Bit 3 is the fourth axis.
    expect(describeVertex(0b01000)).toBe(AXES[3]);
  });

  it('withholds a forward return until the sample can carry one', () => {
    for (const v of lattice.vertices) {
      if (v.samples < 12) {
        expect(v.forward, `vertex ${v.code}`).toBeNull();
        expect(v.forwardSd, `vertex ${v.code}`).toBeNull();
      } else {
        expect(v.forward, `vertex ${v.code}`).not.toBeNull();
      }
    }
  });

  it('never counts a forward return the data cannot supply', () => {
    // The last `horizon` days have no future in the series. Counting them as
    // zero would drag every vertex toward nothing.
    const total = lattice.vertices.reduce((a, v) => a + v.samples, 0);
    expect(total).toBe(Math.max(0, lattice.classified - lattice.horizon));
  });

  it('finds the security in exactly one state today', () => {
    expect(lattice.currentCode).not.toBeNull();
    expect(lattice.vertices.filter((v) => v.current)).toHaveLength(1);
    expect(lattice.vertices.find((v) => v.current)!.code).toBe(lattice.currentCode);
  });

  it('puts a relentless uptrend on the trending face', () => {
    // Rising every day: TREND (bit 0) must hold on the current vertex, and
    // the security cannot be occupying the whole cube.
    const rising = asBars(Array.from({ length: 900 }, (_, i) => 100 * 1.002 ** i));
    const trend = buildRegimeLattice(rising);
    expect(trend.currentCode! & 1).toBe(1);
    expect(trend.occupied).toBeLessThan(VERTEX_COUNT);
  });

  it('projects vertices inside the unit square, with the origin at the centre', () => {
    for (const v of lattice.vertices) {
      expect(Math.abs(v.x)).toBeLessThanOrEqual(1.0000001);
      expect(Math.abs(v.y)).toBeLessThanOrEqual(1.0000001);
    }
    const origin = lattice.vertices.find((v) => v.code === 0)!;
    expect(origin.x).toBeCloseTo(0, 9);
    expect(origin.y).toBeCloseTo(0, 9);
  });

  it('gives the same axis the same direction wherever it is drawn', () => {
    // The point of the projection: an edge for a given axis is one vector, so
    // the eye can follow which condition changed without reading a label.
    const byAxis = new Map<string, Array<{ dx: number; dy: number }>>();
    for (const e of lattice.edges) {
      const a = lattice.vertices[e.from];
      const b = lattice.vertices[e.to];
      const list = byAxis.get(e.axis) ?? [];
      list.push({ dx: b.x - a.x, dy: b.y - a.y });
      byAxis.set(e.axis, list);
    }
    for (const [axis, vectors] of byAxis) {
      const first = vectors[0];
      for (const v of vectors) {
        expect(v.dx, axis).toBeCloseTo(first.dx, 9);
        expect(v.dy, axis).toBeCloseTo(first.dy, 9);
      }
    }
  });

  it('returns an empty lattice rather than a broken one on a short series', () => {
    const short = buildRegimeLattice(asBars(walk(50, 0.01)));
    expect(short.vertices).toEqual([]);
    expect(short.classified).toBe(0);
    expect(short.currentCode).toBeNull();
  });
});
