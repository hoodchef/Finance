import type { StrategyBaseSpec, StrategyOverlaySpec, StrategySpec } from '@/lib/types';
import {
  capOverlay,
  compose,
  equalWeight,
  fixedWeights,
  glidepath,
  inverseVolatility,
  minimumVarianceStrategy,
  momentum,
  riskParityStrategy,
  trendOverlay,
  volatilityTargetOverlay,
  type TargetWeightStrategy,
  type WeightOverlay,
} from './strategy';

/**
 * Turns a stored strategy description into the closure the engine runs.
 *
 * Kept apart from `strategy.ts` so the engine's rules stay free of the
 * product's serialisation format: a rule takes options, and this is the only
 * place that knows those options arrive as JSON from a saved config.
 *
 * Every unknown or malformed spec resolves to the declared weights. A config
 * can arrive from a shared link, an older saved run, or a database row written
 * by a version that had a rule this one does not, and falling back to what the
 * user typed is the only outcome that is both safe and explicable — where
 * throwing would make an old link unopenable, and guessing a nearby rule would
 * silently report a strategy nobody asked for.
 */

const OVERLAY_KINDS = new Set(['trend', 'volatilityTarget', 'cap']);

/**
 * Flattens any accepted spec into a base and its overlays.
 *
 * A bare overlay — which is what a `trend` spec was before composition existed
 * — becomes a fixed base under that overlay. That is not a reinterpretation:
 * the old trend filter read the declared weights and zeroed the holdings below
 * their average, which is precisely a fixed base with a trend overlay, so
 * every config written against the old shape keeps its exact behaviour.
 */
export function normaliseStrategy(spec: StrategySpec | undefined | null): {
  base: StrategyBaseSpec;
  overlays: StrategyOverlaySpec[];
} {
  const fixed: StrategyBaseSpec = { kind: 'fixed' };
  if (!spec || typeof spec !== 'object') return { base: fixed, overlays: [] };

  if (spec.kind === 'composed') {
    const overlays = Array.isArray(spec.overlays)
      ? spec.overlays.filter((o) => o && OVERLAY_KINDS.has(o.kind))
      : [];
    return { base: spec.base ?? fixed, overlays };
  }

  if (OVERLAY_KINDS.has(spec.kind)) {
    return { base: fixed, overlays: [spec as StrategyOverlaySpec] };
  }

  return { base: spec as StrategyBaseSpec, overlays: [] };
}

function buildBase(spec: StrategyBaseSpec, periodsPerYear: number): TargetWeightStrategy {
  switch (spec.kind) {
    case 'fixed':
      return fixedWeights;

    case 'equal':
      return equalWeight;

    case 'glidepath':
      return glidepath({
        growthSymbols: Array.isArray(spec.growthSymbols) ? spec.growthSymbols : [],
        // Percentages at the boundary, fractions inside the engine.
        startGrowth: clampFraction(spec.startGrowthPct / 100),
        endGrowth: clampFraction(spec.endGrowthPct / 100),
      });

    case 'momentum':
      return momentum({
        lookbackDays: positiveInt(spec.lookbackDays, 126),
        holdCount: positiveInt(spec.holdCount, 1),
        // An absent floor means rank everything, rather than a floor of zero.
        minimumReturn: Number.isFinite(spec.minimumReturnPct)
          ? spec.minimumReturnPct / 100
          : undefined,
      });

    case 'inverseVolatility':
      return inverseVolatility({ lookbackDays: positiveInt(spec.lookbackDays, 63) });

    case 'minimumVariance':
      return minimumVarianceStrategy({
        lookbackDays: positiveInt(spec.lookbackDays, 252),
        periodsPerYear,
        shrink: spec.shrink !== false,
        maxWeight: clampFraction((spec.maxWeightPct ?? 100) / 100) || 1,
      });

    case 'riskParity':
      return riskParityStrategy({
        lookbackDays: positiveInt(spec.lookbackDays, 252),
        periodsPerYear,
        shrink: spec.shrink !== false,
        maxWeight: clampFraction((spec.maxWeightPct ?? 100) / 100) || 1,
      });

    default:
      return fixedWeights;
  }
}

function buildOverlay(
  spec: StrategyOverlaySpec,
  periodsPerYear: number,
): WeightOverlay | null {
  switch (spec.kind) {
    case 'trend':
      return trendOverlay({ windowDays: positiveInt(spec.windowDays, 200) });

    case 'volatilityTarget':
      return volatilityTargetOverlay({
        targetVol: Math.max(0, (spec.targetVolPct ?? 10) / 100),
        lookbackDays: positiveInt(spec.lookbackDays, 63),
        periodsPerYear,
      });

    case 'cap':
      return capOverlay(clampFraction((spec.maxWeightPct ?? 100) / 100));

    default:
      return null;
  }
}

export function buildStrategy(
  spec: StrategySpec | undefined | null,
  /** Bars per year on the master calendar, for annualising. Daily by default. */
  periodsPerYear = 252,
): TargetWeightStrategy {
  const { base, overlays } = normaliseStrategy(spec);
  const built = overlays
    .map((o) => buildOverlay(o, periodsPerYear))
    .filter((o): o is WeightOverlay => o != null);
  return compose(buildBase(base, periodsPerYear), built);
}

function clampFraction(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function positiveInt(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

/** One line describing what a spec does, for results and saved runs. */
export function describeStrategy(spec: StrategySpec | undefined | null): string {
  const { base, overlays } = normaliseStrategy(spec);
  const parts = [describeBase(base), ...overlays.map(describeOverlay)];
  return parts.join(', then ');
}

function describeBase(spec: StrategyBaseSpec): string {
  switch (spec.kind) {
    case 'fixed':
      return 'Fixed weights';
    case 'equal':
      return 'Equal weight across every holding';
    case 'glidepath':
      return `Glidepath from ${Math.round(spec.startGrowthPct)}% to ${Math.round(
        spec.endGrowthPct,
      )}% growth${spec.growthSymbols.length ? ` (${spec.growthSymbols.join(', ')})` : ''}`;
    case 'momentum':
      return `hold the strongest ${spec.holdCount} over ${spec.lookbackDays} days`;
    case 'inverseVolatility':
      return `weight inversely to ${spec.lookbackDays}-day volatility`;
    case 'minimumVariance':
      return `minimum variance on ${spec.lookbackDays} days of covariance`;
    case 'riskParity':
      return `risk parity on ${spec.lookbackDays} days of covariance`;
    default:
      return 'Fixed weights';
  }
}

function describeOverlay(spec: StrategyOverlaySpec): string {
  switch (spec.kind) {
    case 'trend':
      return `hold only what is above its ${spec.windowDays}-day average`;
    case 'volatilityTarget':
      return `scale exposure toward ${spec.targetVolPct}% volatility`;
    case 'cap':
      return `cap any holding at ${spec.maxWeightPct}%`;
    default:
      return '';
  }
}
