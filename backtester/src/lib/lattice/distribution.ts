import { normCdf, normInv } from '@/lib/options/pricing';

/**
 * The distribution lab.
 * =============================================================================
 * Three views of the same fact: a price is a random walk, and everything a
 * model says about risk follows from the shape that walk leaves behind.
 *
 * They are deliberately the same arithmetic seen three ways.
 *
 *  - A Galton board IS the binomial option model. A ball choosing left or
 *    right at each peg is a price stepping up or down at each node, and the
 *    pile it lands in is the terminal distribution the Cox-Ross-Rubinstein
 *    tree prices against. Using the tree's own risk-neutral probability makes
 *    that identity visible rather than asserted.
 *  - The ridge is the same distribution at successive horizons, which is where
 *    the square-root-of-time law stops being a formula and becomes a shape.
 *  - The graph is the correlation matrix, which decides whether those
 *    distributions add up or cancel out.
 *
 * Everything here is a pure function of its inputs and seeded where it is
 * random, so a picture can be reproduced exactly. Nothing fetches, and nothing
 * is a market quote — these are model output, and the page says so.
 */

/** Deterministic generator, so a board can be replayed exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* The lattice                                                         */
/* ------------------------------------------------------------------ */

export interface LatticeInputs {
  /** Rows of pegs. Each row is one time step of the binomial tree. */
  levels: number;
  /** Balls dropped. */
  trials: number;
  /** Probability of stepping right (up) at each peg. */
  pUp: number;
  seed?: number;
}

export interface LatticeResult {
  /** Count landing in each of `levels + 1` bins, left to right. */
  bins: number[];
  /** The exact binomial probability for each bin, for comparison. */
  expected: number[];
  /** Per-ball path as a list of 0/1 steps, for animating a few of them. */
  samplePaths: number[][];
  trials: number;
  levels: number;
}

/** n choose k, computed multiplicatively to stay exact for the sizes here. */
export function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 0; i < kk; i++) out = (out * (n - i)) / (i + 1);
  return out;
}

/** P(X = k) for X ~ Binomial(n, p). */
export function binomialPmf(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  return binomialCoefficient(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

/**
 * Drops balls through a lattice of pegs.
 *
 * The simulated pile and the exact binomial are both returned so the picture
 * can show the second drawn over the first: the point of the board is that a
 * few thousand independent coin flips reproduce a curve nobody put there.
 */
export function runLattice(inputs: LatticeInputs): LatticeResult {
  const levels = Math.max(1, Math.round(inputs.levels));
  const trials = Math.max(1, Math.round(inputs.trials));
  const p = Math.min(1, Math.max(0, inputs.pUp));
  const rand = mulberry32(inputs.seed ?? 1);

  const bins = new Array<number>(levels + 1).fill(0);
  const samplePaths: number[][] = [];
  const sampleCount = Math.min(24, trials);

  for (let t = 0; t < trials; t++) {
    let rights = 0;
    const path: number[] = [];
    for (let l = 0; l < levels; l++) {
      const right = rand() < p ? 1 : 0;
      rights += right;
      if (t < sampleCount) path.push(right);
    }
    bins[rights]++;
    if (t < sampleCount) samplePaths.push(path);
  }

  const expected = Array.from({ length: levels + 1 }, (_, k) =>
    binomialPmf(levels, k, p) * trials,
  );

  return { bins, expected, samplePaths, trials, levels };
}

/**
 * The risk-neutral up-probability a CRR tree uses.
 *
 * Exposed so the board can be driven by the same number that prices an option
 * rather than by a fair coin: with a positive drift the pile leans, and the
 * lean is exactly the drift the model charges for.
 */
export function riskNeutralUpProbability(options: {
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  years: number;
  steps: number;
}): number {
  const dt = options.years / Math.max(1, options.steps);
  const u = Math.exp(options.volatility * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp((options.riskFreeRate - options.dividendYield) * dt) - d) / (u - d);
  // Outside [0,1] the lattice would admit arbitrage; clamp for display and let
  // the pricing engine be the place that refuses such a tree.
  return Math.min(1, Math.max(0, p));
}

/** The price a bin corresponds to, under the same tree. */
export function binPrice(options: {
  spot: number;
  volatility: number;
  years: number;
  steps: number;
  upMoves: number;
}): number {
  const dt = options.years / Math.max(1, options.steps);
  const u = Math.exp(options.volatility * Math.sqrt(dt));
  const d = 1 / u;
  return options.spot * Math.pow(u, options.upMoves) * Math.pow(d, options.steps - options.upMoves);
}

/* ------------------------------------------------------------------ */
/* The ridge                                                           */
/* ------------------------------------------------------------------ */

export interface RidgeBand {
  /** Horizon in years. */
  years: number;
  label: string;
  /** Density sampled across the shared price grid. */
  density: number[];
  /** Probability of finishing above the reference level. */
  probabilityAbove: number;
  /** The one-standard-deviation move at this horizon. */
  oneSigma: number;
}

export interface Ridge {
  /** Shared price grid every band is sampled on. */
  grid: number[];
  bands: RidgeBand[];
  reference: number;
}

/**
 * Terminal lognormal densities at a series of horizons.
 *
 * Sampled on ONE shared price grid so the bands are directly comparable —
 * each drawn on its own axis, the far horizons would look no wider than the
 * near ones, which is the opposite of the thing being shown.
 */
export function buildRidge(options: {
  spot: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield: number;
  horizons: Array<{ years: number; label: string }>;
  /** Level to measure the finishing probability against. Defaults to spot. */
  reference?: number;
  points?: number;
}): Ridge {
  const { spot, volatility: sigma, riskFreeRate: r, dividendYield: q } = options;
  const points = Math.max(32, options.points ?? 160);
  const reference = options.reference ?? spot;
  const longest = options.horizons.reduce((a, h) => Math.max(a, h.years), 0);

  // Two and a half standard deviations of the LONGEST horizon. Four fits every
  // tail but leaves the near bands as a sliver in the middle of a mostly empty
  // axis; this keeps them readable while still showing the far ones spreading.
  const span = sigma * Math.sqrt(Math.max(longest, 1e-6)) * 2.5;
  const lo = Math.max(spot * 0.01, spot * Math.exp(-span));
  const hi = spot * Math.exp(span);
  const grid = Array.from({ length: points }, (_, i) => lo + ((hi - lo) * i) / (points - 1));

  const bands = options.horizons.map(({ years, label }) => {
    const t = Math.max(years, 1e-6);
    const sd = sigma * Math.sqrt(t);
    const mu = Math.log(spot) + (r - q - 0.5 * sigma * sigma) * t;
    const density = grid.map((s) => {
      if (s <= 0) return 0;
      const z = (Math.log(s) - mu) / sd;
      // Lognormal density: the normal density in log space, divided by s.
      return Math.exp(-0.5 * z * z) / (s * sd * Math.sqrt(2 * Math.PI));
    });
    const d2 = (Math.log(spot / reference) + (r - q - 0.5 * sigma * sigma) * t) / sd;
    return {
      years,
      label,
      density,
      probabilityAbove: normCdf(d2),
      oneSigma: spot * sigma * Math.sqrt(t),
    };
  });

  return { grid, bands, reference };
}

/* ------------------------------------------------------------------ */
/* The relationship graph                                              */
/* ------------------------------------------------------------------ */

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  /** Average absolute correlation to everything else: how central it is. */
  centrality: number;
}

export interface GraphEdge {
  a: string;
  b: string;
  correlation: number;
}

export interface RelationshipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Lays out a correlation matrix as a graph.
 *
 * A deterministic force simulation — fixed iterations, seeded start — because
 * a layout that moves every time it is opened cannot be discussed, and one
 * that cannot be reproduced cannot be tested. Correlated holdings pull
 * together, so a cluster on screen is a cluster of things that move as one:
 * exactly the concentration a portfolio of "different" holdings can hide.
 */
export function layoutRelationshipGraph(options: {
  symbols: string[];
  /** Square correlation matrix aligned to `symbols`. */
  correlation: number[][];
  /** Edges below this absolute correlation are not drawn. */
  threshold?: number;
  iterations?: number;
  seed?: number;
}): RelationshipGraph {
  const { symbols, correlation } = options;
  const n = symbols.length;
  const threshold = options.threshold ?? 0.3;
  const iterations = options.iterations ?? 220;
  const rand = mulberry32(options.seed ?? 7);

  if (n === 0) return { nodes: [], edges: [] };

  // Start on a circle rather than at random: a symmetric start makes the
  // result depend on the correlations rather than on the seed.
  const nodes: GraphNode[] = symbols.map((id, i) => {
    const angle = (2 * Math.PI * i) / n;
    return {
      id,
      x: Math.cos(angle) * 0.8 + (rand() - 0.5) * 0.02,
      y: Math.sin(angle) * 0.8 + (rand() - 0.5) * 0.02,
      centrality: 0,
    };
  });

  const edges: GraphEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = correlation[i]?.[j] ?? 0;
      if (Math.abs(c) >= threshold) edges.push({ a: symbols[i], b: symbols[j], correlation: c });
    }
  }

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations;
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);

    // Every pair repels, so nodes do not stack.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          dx = 1e-3;
          dy = 0;
          d2 = 1e-6;
        }
        const rep = 0.02 / d2;
        const d = Math.sqrt(d2);
        fx[i] += (dx / d) * rep;
        fy[i] += (dy / d) * rep;
        fx[j] -= (dx / d) * rep;
        fy[j] -= (dy / d) * rep;
      }
    }

    // Correlated pairs attract, in proportion to how correlated they are.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const c = correlation[i]?.[j] ?? 0;
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const pull = Math.abs(c) * 0.05;
        fx[i] += dx * pull;
        fy[i] += dy * pull;
        fx[j] -= dx * pull;
        fy[j] -= dy * pull;
      }
    }

    for (let i = 0; i < n; i++) {
      nodes[i].x += fx[i] * cooling;
      nodes[i].y += fy[i] * cooling;
      // Keep everything inside the unit disc.
      const r = Math.hypot(nodes[i].x, nodes[i].y);
      if (r > 1) {
        nodes[i].x /= r;
        nodes[i].y /= r;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) if (i !== j) sum += Math.abs(correlation[i]?.[j] ?? 0);
    nodes[i].centrality = n > 1 ? sum / (n - 1) : 0;
  }

  return { nodes, edges };
}

/** Percentile of a sorted-on-demand sample. Used for the summary strip. */
export function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

/** Terminal prices implied by the lattice, for the summary figures. */
export function latticeOutcomes(
  result: LatticeResult,
  options: { spot: number; volatility: number; years: number },
): number[] {
  const out: number[] = [];
  result.bins.forEach((count, k) => {
    const price = binPrice({ ...options, steps: result.levels, upMoves: k });
    for (let i = 0; i < count; i++) out.push(price);
  });
  return out;
}

/** The z-score a probability corresponds to, for annotating the ridge. */
export function zOf(p: number): number {
  return normInv(Math.min(0.999999, Math.max(0.000001, p)));
}
