import { estimateMoments } from './correlated';
import {
  efficientFrontier,
  maximumSharpe,
  minimumVariance,
  riskParity,
  type OptimisedPortfolio,
} from './optimise';

/**
 * Sharpe-ratio portfolio construction, and how much of it survives.
 * =============================================================================
 * Maximum-Sharpe optimisation is the most overfit-prone thing in portfolio
 * construction, and the reason is structural rather than a matter of care.
 * The optimiser is handed estimated returns and an estimated covariance, and
 * it seeks out precisely the assets whose estimates were most flattered by
 * luck — an asset that happened to run in the sample looks like a high return
 * with low variance, which is exactly what a Sharpe maximiser is built to
 * overweight. The reported in-sample Sharpe is therefore not a forecast; it is
 * a measure of how well the optimiser fit the noise it was given.
 *
 * So this module does not just optimise. It SPLITS: weights are solved on the
 * first part of the history and then scored on the part the solver never saw.
 * The gap between those two numbers is the honest output — usually most of the
 * apparent edge — and it is what the page leads with.
 *
 * Minimum variance and risk parity are computed alongside deliberately.
 * Neither uses an expected-return estimate, which is the noisiest input of the
 * three, and both routinely beat maximum Sharpe out of sample. Showing them
 * together makes that comparison unavoidable rather than optional.
 */

export interface Candidate {
  id: string;
  label: string;
  /** What the method is, and what it costs. */
  description: string;
  weights: number[];
  /** Annualised, measured on the window the weights were solved on. */
  inSample: PortfolioStats;
  /** Measured on the window the solver never saw. Null when not split. */
  outOfSample: PortfolioStats | null;
}

export interface PortfolioStats {
  expectedReturn: number;
  volatility: number;
  sharpe: number;
}

/** Annualised statistics of a fixed weighting over a return window. */
export function scoreWeights(
  weights: readonly number[],
  returns: readonly number[][],
  periodsPerYear: number,
  riskFree = 0,
): PortfolioStats {
  const T = Math.min(...returns.map((r) => r.length));
  if (T < 2) return { expectedReturn: 0, volatility: 0, sharpe: 0 };

  // The portfolio's own return series, rebalanced each period to the weights.
  const series: number[] = [];
  for (let t = 0; t < T; t++) {
    let r = 0;
    for (let i = 0; i < returns.length; i++) r += (weights[i] ?? 0) * returns[i][t];
    series.push(r);
  }

  const mean = series.reduce((a, b) => a + b, 0) / T;
  const variance = series.reduce((a, r) => a + (r - mean) ** 2, 0) / (T - 1);
  const vol = Math.sqrt(variance * periodsPerYear);
  const annual = mean * periodsPerYear;
  return {
    expectedReturn: annual,
    volatility: vol,
    // Zero volatility with a positive return is not an infinite Sharpe, it is
    // a degenerate window; reporting Infinity would rank it first forever.
    sharpe: vol > 1e-9 ? (annual - riskFree) / vol : 0,
  };
}

export interface LabOptions {
  symbols: string[];
  /** Log returns per symbol, already aligned to one calendar. */
  returns: number[][];
  periodsPerYear: number;
  riskFree?: number;
  /** Ceiling per holding, so a solution cannot be one asset. */
  maxWeight?: number;
  /** Fraction of history used to solve; the rest scores. 0 disables the split. */
  trainFraction?: number;
  /** Current weights, to score alongside the suggestions. */
  current?: number[];
  shrink?: boolean;
}

export interface LabResult {
  symbols: string[];
  candidates: Candidate[];
  /** Frontier solved on the training window, for the chart. */
  frontier: OptimisedPortfolio[];
  observations: number;
  trainObservations: number;
  testObservations: number;
  /** Stated beside the numbers rather than left to be inferred. */
  caveat: string;
}

/**
 * Solves several allocations and scores each on held-out history.
 *
 * The split is chronological, never random. Shuffling returns and holding some
 * out would leak the future into the training window — the very thing the
 * split exists to prevent — because a portfolio's risk comes from how returns
 * cluster in time, and shuffling destroys exactly that structure.
 */
export function runSharpeLab(options: LabOptions): LabResult {
  const {
    symbols,
    returns,
    periodsPerYear,
    riskFree = 0,
    maxWeight = 1,
    trainFraction = 0.7,
    shrink = true,
  } = options;

  const n = symbols.length;
  if (n < 2) throw new Error('At least two holdings are needed to optimise a weighting.');

  const T = Math.min(...returns.map((r) => r.length));
  const split = trainFraction > 0 && trainFraction < 1 ? Math.floor(T * trainFraction) : T;
  const train = returns.map((r) => r.slice(0, split));
  const test = split < T ? returns.map((r) => r.slice(split)) : null;

  // Simple returns for the moment estimator, which logs them itself.
  const asSimple = (rows: number[][]) => rows.map((r) => r.map((x) => Math.expm1(x)));
  const moments = estimateMoments(symbols, asSimple(train), { shrink });
  const opts = { moments, periodsPerYear, riskFree, maxWeight };

  const solved: Array<{ id: string; label: string; description: string; weights: number[] }> = [
    {
      id: 'sharpe',
      label: 'Maximum Sharpe',
      description:
        'Seeks the best return per unit of risk. Uses an expected-return estimate, which is the noisiest input there is, and is therefore the most likely of these to disappoint out of sample.',
      weights: maximumSharpe(opts).weights,
    },
    {
      id: 'minvar',
      label: 'Minimum variance',
      description:
        'Lowest variance available, using no return forecast at all. That omission is why it tends to survive out of sample better than the Sharpe maximiser.',
      weights: minimumVariance(opts).weights,
    },
    {
      id: 'riskparity',
      label: 'Risk parity',
      description:
        'Equalises each holding’s contribution to portfolio risk, using the full covariance rather than volatility alone.',
      weights: riskParity(opts).weights,
    },
    {
      id: 'equal',
      label: 'Equal weight',
      description:
        'No optimisation at all. Hard to beat out of sample precisely because it estimates nothing, and the honest benchmark for every row above it.',
      weights: new Array(n).fill(1 / n),
    },
  ];

  if (options.current && options.current.length === n) {
    const total = options.current.reduce((a, b) => a + b, 0);
    if (total > 0) {
      solved.unshift({
        id: 'current',
        label: 'Your weights',
        description: 'What the portfolio holds today, scored on the same windows.',
        weights: options.current.map((w) => w / total),
      });
    }
  }

  const candidates: Candidate[] = solved.map((s) => ({
    ...s,
    inSample: scoreWeights(s.weights, train, periodsPerYear, riskFree),
    outOfSample: test ? scoreWeights(s.weights, test, periodsPerYear, riskFree) : null,
  }));

  return {
    symbols,
    candidates,
    frontier: efficientFrontier({ ...opts, points: 28 }),
    observations: T,
    trainObservations: split,
    testObservations: test ? T - split : 0,
    caveat:
      `Weights solved on the first ${split} observations and scored on the ${T - split} that ` +
      'follow, which the solver never saw. The in-sample column is not a forecast — an ' +
      'optimiser overweights whichever holdings the sample flattered, so a high figure there ' +
      'measures how well it fit the noise. The out-of-sample column is the one to read.',
  };
}

/**
 * Builds a portfolio from a candidate list rather than re-weighting one.
 *
 * Selection falls out of the optimisation rather than being a separate step:
 * the solvers are long-only, so anything that does not earn a place is given a
 * weight of zero. What comes back is both the chosen holdings and their sizes,
 * and `kept` names the ones that survived.
 */
export function generatePortfolio(options: LabOptions & { minimumWeight?: number }): {
  result: LabResult;
  kept: Array<{ symbol: string; weight: number }>;
} {
  const result = runSharpeLab(options);
  const floor = options.minimumWeight ?? 0.02;
  const best = result.candidates.find((c) => c.id === 'sharpe');
  const kept = (best?.weights ?? [])
    .map((weight, i) => ({ symbol: options.symbols[i], weight }))
    .filter((k) => k.weight >= floor)
    .sort((a, b) => b.weight - a.weight);
  return { result, kept };
}
