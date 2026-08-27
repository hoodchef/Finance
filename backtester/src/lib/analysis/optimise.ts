import { CorrelatedError, type AssetMoments } from './correlated';
import { invert } from './regression';

/**
 * Mean–variance portfolio construction.
 * =============================================================================
 * Built on the same estimated moments the simulator uses, deliberately: an
 * optimiser and a simulator that disagree about how assets move together will
 * recommend a portfolio and then model a different one.
 *
 * **Optimisation amplifies estimation error.** That is the central fact about
 * this technique and the reason it is often disappointing in practice. The
 * optimiser is drawn to whatever the sample says has high return and low
 * correlation, and the assets it likes most are the ones whose statistics are
 * most flattered by luck. Expected returns are the worst offenders — they need
 * decades of data to estimate to any useful precision, where covariance needs
 * years.
 *
 * Three things follow, all of them implemented here rather than left to the
 * caller:
 *
 *  - Everything runs on the SHRUNK covariance by default, for the reasons in
 *    `shrinkCovariance`.
 *  - Every result reports the concentration it produced, so a solution that
 *    put 90% in one holding cannot look like a diversified answer.
 *  - Minimum variance and risk parity, which ignore expected returns entirely,
 *    are offered alongside maximum Sharpe — because for most portfolios they
 *    are the more trustworthy answers.
 *
 * Long-only throughout. Unconstrained mean–variance solutions routinely want
 * large short positions, which is not what this product is for.
 */

export interface OptimisedPortfolio {
  weights: number[];
  /** Annualised expected return implied by the estimate. */
  expectedReturn: number;
  /** Annualised volatility. */
  volatility: number;
  /** (return − risk-free) / volatility. */
  sharpe: number;
  /**
   * Herfindahl concentration: 1/n for equal weights, 1 for everything in one
   * holding. The single most useful sanity check on an optimiser's output.
   */
  concentration: number;
  /** Holdings receiving a materially non-zero weight. */
  effectiveHoldings: number;
}

/**
 * Inverts the covariance, reporting failure in the optimiser's own terms.
 *
 * A singular matrix here means two holdings are effectively the same asset,
 * which is a portfolio problem the user can act on — not a linear-algebra
 * error from a module they never called.
 */
function safeInverse(cov: number[][]): number[][] {
  try {
    return invert(cov);
  } catch {
    throw new CorrelatedError(
      'These holdings are too alike to optimise between — two or more move almost identically, ' +
        'so there is no single best split. Remove one, or widen the date range.',
    );
  }
}

/** Portfolio variance for a weight vector, per period. */
function variance(weights: number[], cov: number[][]): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) acc += weights[i] * weights[j] * cov[i][j];
  }
  return Math.max(0, acc);
}

/** Scales to sum 1, clipping negatives away. */
function normaliseLongOnly(weights: number[]): number[] {
  const clipped = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = clipped.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return weights.map(() => 1 / weights.length);
  return clipped.map((w) => w / total);
}

function describe(
  weights: number[],
  moments: AssetMoments,
  periodsPerYear: number,
  riskFree: number,
): OptimisedPortfolio {
  const perPeriodVar = variance(weights, moments.cov);
  const volatility = Math.sqrt(perPeriodVar * periodsPerYear);
  // Arithmetic annual return per asset, from the fitted lognormal.
  const assetReturn = moments.mu.map(
    (m, i) => Math.exp(periodsPerYear * (m + moments.cov[i][i] / 2)) - 1,
  );
  const expectedReturn = weights.reduce((s, w, i) => s + w * assetReturn[i], 0);
  const concentration = weights.reduce((s, w) => s + w * w, 0);
  return {
    weights,
    expectedReturn,
    volatility,
    sharpe: volatility > 0 ? (expectedReturn - riskFree) / volatility : 0,
    concentration,
    effectiveHoldings: weights.filter((w) => w > 0.005).length,
  };
}

export interface OptimiseOptions {
  moments: AssetMoments;
  periodsPerYear: number;
  /** Annual risk-free rate, for Sharpe. */
  riskFree?: number;
  /** Upper bound per holding, so a solution cannot be one asset. */
  maxWeight?: number;
}

/**
 * Minimum-variance portfolio, long-only.
 *
 * The analytic solution is w ∝ Σ⁻¹1, which is unconstrained and frequently
 * wants shorts. Projecting it onto the simplex and iterating converges quickly
 * for the handful of assets a retail portfolio holds, and needs no solver.
 *
 * Uses no expected returns at all, which is exactly why it tends to survive
 * out of sample better than maximum Sharpe.
 */
export function minimumVariance(options: OptimiseOptions): OptimisedPortfolio {
  const { moments, periodsPerYear, riskFree = 0, maxWeight = 1 } = options;
  const n = moments.symbols.length;
  if (n === 0) throw new CorrelatedError('No assets to optimise.');
  if (n === 1) return describe([1], moments, periodsPerYear, riskFree);

  // The analytic solution, w proportional to inverse(Sigma) times 1, is EXACT.
  const inv = safeInverse(moments.cov);
  const raw = inv.map((row: number[]) => row.reduce((s: number, v: number) => s + v, 0));
  const total = raw.reduce((sum, v) => sum + v, 0);
  const analytic = total !== 0 ? raw.map((v) => v / total) : null;

  // Iterate ONLY when that exact answer breaks a constraint. Running a
  // projected gradient over an already-feasible optimum does not refine it —
  // it walks away from it. On two uncorrelated assets at 30% and 10% vol the
  // exact answer is 10/90, and descending from it drove the first weight to
  // zero, where clipping pinned it: once a weight hits the boundary the
  // gradient keeps pushing it out and the projection keeps returning zero.
  const feasible =
    analytic != null &&
    analytic.every((x) => x >= -1e-12 && x <= maxWeight + 1e-12) &&
    analytic.every((x) => Number.isFinite(x));
  if (feasible) return describe(normaliseLongOnly(analytic), moments, periodsPerYear, riskFree);

  let w = applyCap(normaliseLongOnly(analytic ?? raw), maxWeight);
  // Scale-invariant step: covariance entries are per-period and tiny, so a
  // step derived from their magnitude has to track it rather than be a
  // constant.
  const scale = Math.max(...moments.cov.map((r, i) => r[i])) || 1;
  for (let iter = 0; iter < 800; iter++) {
    const grad = w.map((_, i) => 2 * w.reduce((s, wj, j) => s + wj * moments.cov[i][j], 0));
    const step = (0.25 / scale) / (1 + iter / 100);
    const next = applyCap(normaliseLongOnly(w.map((wi, i) => wi - step * grad[i])), maxWeight);
    // Keep the step only if it actually lowered variance; the projection can
    // undo an otherwise-good move.
    if (variance(next, moments.cov) > variance(w, moments.cov)) break;
    const moved = next.reduce((sum, v, i) => sum + Math.abs(v - w[i]), 0);
    w = next;
    if (moved < 1e-12) break;
  }
  return describe(w, moments, periodsPerYear, riskFree);
}

/** Caps each weight and redistributes the excess, preserving the sum. */
function applyCap(weights: number[], maxWeight: number): number[] {
  if (maxWeight >= 1) return weights;
  const n = weights.length;
  // A cap below 1/n is unsatisfiable; fall back to equal weight.
  if (maxWeight <= 1 / n) return weights.map(() => 1 / n);
  const w = [...weights];
  for (let pass = 0; pass < 50; pass++) {
    let excess = 0;
    const room: number[] = [];
    for (let i = 0; i < n; i++) {
      if (w[i] > maxWeight) {
        excess += w[i] - maxWeight;
        w[i] = maxWeight;
        room.push(0);
      } else room.push(maxWeight - w[i]);
    }
    if (excess < 1e-12) break;
    const totalRoom = room.reduce((s, v) => s + v, 0);
    if (totalRoom <= 0) break;
    for (let i = 0; i < n; i++) w[i] += (excess * room[i]) / totalRoom;
  }
  return normaliseLongOnly(w);
}

/**
 * Maximum-Sharpe (tangency) portfolio, long-only.
 *
 * The one that depends on expected returns, and therefore the one to treat
 * most sceptically: the input it is most sensitive to is the input estimated
 * least reliably.
 */
export function maximumSharpe(options: OptimiseOptions): OptimisedPortfolio {
  const { moments, periodsPerYear, riskFree = 0, maxWeight = 1 } = options;
  const n = moments.symbols.length;
  if (n === 0) throw new CorrelatedError('No assets to optimise.');
  if (n === 1) return describe([1], moments, periodsPerYear, riskFree);

  const rfPerPeriod = Math.log1p(riskFree) / periodsPerYear;
  const excess = moments.mu.map((m, i) => m + moments.cov[i][i] / 2 - rfPerPeriod);
  const inv = safeInverse(moments.cov);
  const raw = inv.map((row: number[]) =>
    row.reduce((s: number, v: number, j: number) => s + v * excess[j], 0),
  );

  let w = applyCap(normaliseLongOnly(raw), maxWeight);
  // Hill-climb the Sharpe ratio from the analytic start. Clipping the
  // unconstrained solution is not itself optimal under the constraint.
  let best = describe(w, moments, periodsPerYear, riskFree).sharpe;
  for (let iter = 0; iter < 300; iter++) {
    let improved = false;
    const delta = 0.02 / (1 + iter / 50);
    for (let i = 0; i < n; i++) {
      for (const dir of [1, -1]) {
        const trial = applyCap(
          normaliseLongOnly(w.map((v, k) => (k === i ? v + dir * delta : v))),
          maxWeight,
        );
        const s = describe(trial, moments, periodsPerYear, riskFree).sharpe;
        if (s > best + 1e-12) {
          best = s;
          w = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return describe(w, moments, periodsPerYear, riskFree);
}

/**
 * Risk parity: every holding contributes the same share of portfolio risk.
 *
 * Equal weights are not equal risk — a 60/40 portfolio takes roughly 90% of
 * its risk from the equity leg. This solves for the allocation where each
 * asset's marginal contribution times its weight is equal, which is a very
 * different portfolio and uses no expected returns either.
 */
export function riskParity(options: OptimiseOptions): OptimisedPortfolio {
  const { moments, periodsPerYear, riskFree = 0, maxWeight = 1 } = options;
  const n = moments.symbols.length;
  if (n === 0) throw new CorrelatedError('No assets to optimise.');
  if (n === 1) return describe([1], moments, periodsPerYear, riskFree);

  // Inverse-volatility is the exact answer when correlations are equal, and a
  // good starting point when they are not.
  let w = applyCap(normaliseLongOnly(moments.sigma.map((s) => (s > 0 ? 1 / s : 0))), maxWeight);

  for (let iter = 0; iter < 1000; iter++) {
    const port = Math.sqrt(variance(w, moments.cov));
    if (!(port > 0)) break;
    // Contribution of asset i to portfolio risk.
    const contrib = w.map(
      (wi, i) => (wi * w.reduce((s, wj, j) => s + wj * moments.cov[i][j], 0)) / port,
    );
    const target = port / n;
    // Multiplicative update: raise what contributes too little, lower the rest.
    // The cap has to be applied INSIDE the loop, not skipped entirely. Leaving
    // it out let risk parity return a weight above the cap the other methods
    // respected, and the comparison then showed minimum variance with higher
    // risk than another method — which is impossible by definition and was the
    // symptom that surfaced this.
    const next = applyCap(
      normaliseLongOnly(
        w.map((wi, i) => (contrib[i] > 0 ? wi * Math.pow(target / contrib[i], 0.15) : wi)),
      ),
      maxWeight,
    );
    const moved = next.reduce((s, v, i) => s + Math.abs(v - w[i]), 0);
    w = next;
    if (moved < 1e-12) break;
  }
  return describe(w, moments, periodsPerYear, riskFree);
}

/**
 * The efficient frontier, as a set of minimum-variance portfolios at
 * increasing target returns.
 *
 * Presented as a curve because a single "optimal" point invites more
 * confidence than the estimate behind it can support. Seeing how little
 * return is bought by the last chunk of risk is usually the useful output.
 */
export function efficientFrontier(
  options: OptimiseOptions & { points?: number },
): OptimisedPortfolio[] {
  const { moments, periodsPerYear, riskFree = 0, maxWeight = 1, points = 24 } = options;
  const n = moments.symbols.length;
  if (n < 2) return [minimumVariance(options)];

  const assetReturn = moments.mu.map(
    (m, i) => Math.exp(periodsPerYear * (m + moments.cov[i][i] / 2)) - 1,
  );
  const lo = minimumVariance(options).expectedReturn;
  const hi = Math.max(...assetReturn);
  if (!(hi > lo)) return [minimumVariance(options)];

  const out: OptimisedPortfolio[] = [];
  for (let k = 0; k < points; k++) {
    const target = lo + ((hi - lo) * k) / (points - 1);
    // Penalised least squares: minimise variance subject to hitting the target
    // return, with the constraint folded in as a penalty. Enough for a curve
    // that is read as a shape rather than a set of exact allocations.
    let w = normaliseLongOnly(moments.sigma.map((s) => (s > 0 ? 1 / s : 0)));
    const lambda = 40;
    for (let iter = 0; iter < 400; iter++) {
      const shortfall = w.reduce((s, wi, i) => s + wi * assetReturn[i], 0) - target;
      const grad = w.map(
        (_, i) =>
          2 * w.reduce((s, wj, j) => s + wj * moments.cov[i][j], 0) +
          2 * lambda * shortfall * assetReturn[i],
      );
      const step = 0.5 / (1 + iter);
      const next = applyCap(normaliseLongOnly(w.map((wi, i) => wi - step * grad[i])), maxWeight);
      const moved = next.reduce((s, v, i) => s + Math.abs(v - w[i]), 0);
      w = next;
      if (moved < 1e-12) break;
    }
    out.push(describe(w, moments, periodsPerYear, riskFree));
  }
  // Ascending risk, so the curve reads left to right.
  return out.sort((a, b) => a.volatility - b.volatility);
}
