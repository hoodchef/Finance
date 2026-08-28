import type { StrategySpec } from '@/lib/types';
import {
  equalWeight,
  fixedWeights,
  glidepath,
  inverseVolatility,
  momentum,
  trendFilter,
  type TargetWeightStrategy,
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
export function buildStrategy(spec: StrategySpec | undefined | null): TargetWeightStrategy {
  if (!spec || typeof spec !== 'object') return fixedWeights;

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
        // Percentage at the boundary, fraction inside the engine. An absent
        // floor means rank everything, rather than a floor of zero percent.
        minimumReturn: Number.isFinite(spec.minimumReturnPct)
          ? spec.minimumReturnPct / 100
          : undefined,
      });

    case 'trend':
      return trendFilter({ windowDays: positiveInt(spec.windowDays, 200) });

    case 'inverseVolatility':
      return inverseVolatility({ lookbackDays: positiveInt(spec.lookbackDays, 63) });

    default:
      return fixedWeights;
  }
}

function clampFraction(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function positiveInt(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

/** One line describing what a spec does, for results and saved runs. */
export function describeStrategy(spec: StrategySpec | undefined | null): string {
  if (!spec) return 'Fixed weights';
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
      return `Hold the strongest ${spec.holdCount} over ${spec.lookbackDays} days${
        Number.isFinite(spec.minimumReturnPct) && spec.minimumReturnPct > Number.NEGATIVE_INFINITY
          ? `, above ${spec.minimumReturnPct}%`
          : ''
      }`;
    case 'trend':
      return `Hold while above the ${spec.windowDays}-day moving average, else cash`;
    case 'inverseVolatility':
      return `Weight inversely to ${spec.lookbackDays}-day volatility`;
    default:
      return 'Fixed weights';
  }
}
