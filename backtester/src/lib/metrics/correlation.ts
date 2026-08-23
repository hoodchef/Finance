import type { IsoDate } from '@/lib/types';
import { correlation, stdev } from './stats';

/**
 * Correlation and covariance between the things in a portfolio.
 *
 * Correlation is what makes diversification work or fail, and it is the one
 * statistic that cannot be read off any single asset's own history. Two
 * holdings that each look fine can still leave a portfolio undiversified.
 *
 * All pairs are computed from the same aligned daily return series, so every
 * cell of the matrix covers the identical window. An asset that listed later
 * than the others is compared only over the days both actually traded, and the
 * overlap is reported alongside the coefficient so a correlation drawn from six
 * weeks is not read like one drawn from twenty years.
 */

export interface CorrelationEntry {
  a: string;
  b: string;
  correlation: number;
  /** Number of days both series had an observed return. */
  overlap: number;
}

export interface CorrelationMatrix {
  symbols: string[];
  /** `values[i][j]` is the correlation of `symbols[i]` with `symbols[j]`. */
  values: number[][];
  /** Overlapping observation count per pair, same indexing. */
  overlap: number[][];
  /** Annualised volatility per symbol, for the diagonal labels. */
  volatility: number[];
  start: IsoDate | null;
  end: IsoDate | null;
  /** Average of the off-diagonal correlations, weighted equally. */
  averageCorrelation: number;
}

export interface CorrelationInput {
  symbol: string;
  /** Daily returns, aligned to a shared calendar. NaN where not trading. */
  returns: Array<number | null>;
}

export function computeCorrelationMatrix(
  dates: IsoDate[],
  inputs: CorrelationInput[],
  periodsPerYear: number,
): CorrelationMatrix {
  const n = inputs.length;
  const symbols = inputs.map((i) => i.symbol);
  const values: number[][] = Array.from({ length: n }, () => new Array(n).fill(Number.NaN));
  const overlap: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  const volatility = inputs.map((i) => {
    const clean = i.returns.filter((r): r is number => r != null && Number.isFinite(r));
    return clean.length > 1 ? stdev(clean) * Math.sqrt(periodsPerYear) : 0;
  });

  let sum = 0;
  let pairs = 0;

  for (let i = 0; i < n; i++) {
    values[i][i] = 1;
    overlap[i][i] = inputs[i].returns.filter((r) => r != null && Number.isFinite(r)).length;

    for (let j = i + 1; j < n; j++) {
      // Only days where both series traded; pairing a real return against a
      // zero would drag every correlation toward nothing.
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = 0; k < dates.length; k++) {
        const x = inputs[i].returns[k];
        const y = inputs[j].returns[k];
        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        xs.push(x);
        ys.push(y);
      }

      const c = xs.length > 2 ? correlation(xs, ys) : Number.NaN;
      values[i][j] = c;
      values[j][i] = c;
      overlap[i][j] = xs.length;
      overlap[j][i] = xs.length;

      if (Number.isFinite(c)) {
        sum += c;
        pairs++;
      }
    }
  }

  return {
    symbols,
    values,
    overlap,
    volatility,
    start: dates[0] ?? null,
    end: dates[dates.length - 1] ?? null,
    averageCorrelation: pairs > 0 ? sum / pairs : Number.NaN,
  };
}
