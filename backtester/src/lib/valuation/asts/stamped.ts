/**
 * The analyst's stamped results at the delivered inputs, for side-by-side
 * comparison on the page. Pinned to reference/asts/analytics.json by
 * tests/valuation-asts-expansion.test.ts, so they cannot drift from it.
 */
export const ANALYST_MC = {
  paths: 20000,
  seed: 20260910,
  mean: 55.23045060117564,
  se: 0.4112366152982589,
  p5: 0,
  p10: 0,
  p50: 41.09518077781949,
  p90: 128.20870791691354,
  pAbove: 0.3456,
  pZero: 0.19045,
  meanNonDistress: 65.09954101977324,
  /** The price the stamped probabilities were computed against. */
  price: 62.42,
} as const;

export const ANALYST_PW = 52.87895367345369;
