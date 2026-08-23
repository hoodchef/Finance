import type { IsoDate } from '@/lib/types';
import type { PerformanceMetrics } from '@/lib/metrics';
import type { SeriesPoint } from '@/lib/backtest';

/**
 * The analytics view-model.
 * =============================================================================
 * Every analytical surface in the platform — growth chart, drawdown chart,
 * KPI strip, risk table, period returns, comparison table — consumes an
 * `AnalyticsSubject` rather than a `BacktestResult`.
 *
 * WHY THIS EXISTS
 *
 * `BacktestResult` carries 24 fields describing one simulation: its config, its
 * transaction ledger, its engine version, its data provenance. A drawdown chart
 * needs four of them. Binding presentation to the full result made every chart
 * unusable outside the Backtester — a Portfolio Analyzer examining live
 * holdings has no config and no transactions, so it could not reuse a single
 * component, and the only way forward would have been to reimplement each chart
 * per surface.
 *
 * A subject is the narrow, origin-agnostic thing all of them actually need: a
 * labelled value series with metrics attached. A backtest produces one. A live
 * portfolio produces one. A single security produces one. A benchmark produces
 * one. A Monte Carlo percentile band will produce one.
 *
 * This is a presentation boundary only. It computes nothing, and no figure in
 * it is derived here — every number is passed through from the engine and the
 * metrics library unchanged.
 */

/** Where a subject's numbers came from, so a chart can label them honestly. */
export type SubjectOrigin =
  | 'backtest'
  | 'benchmark'
  | 'asset'
  | 'live-portfolio'
  | 'simulation';

export interface SubjectMeta {
  /** First and last date the series actually covers. */
  start: IsoDate;
  end: IsoDate;
  /** Provider label, shown under results for transparency. */
  dataSource?: string;
  /** True when the underlying prices are generated rather than observed. */
  synthetic?: boolean;
  /**
   * True when the figures are modelled rather than historical. Simulated
   * results must never render identically to observed ones.
   */
  simulated?: boolean;
}

export interface AnalyticsSubject {
  /** Stable identity, used for series keys, colours and toggle state. */
  id: string;
  /** What to call it on a chart legend or table header. */
  label: string;
  origin: SubjectOrigin;
  series: SeriesPoint[];
  metrics: PerformanceMetrics;
  meta: SubjectMeta;
  /**
   * Terminal account value, where the subject has one. A benchmark run and a
   * backtest do; a normalised index series may not.
   */
  finalValue?: number;
  /** Marks the subject a comparison is measured against. */
  isPrimary?: boolean;
}

/** A group of subjects rendered together: one primary, zero or more comparisons. */
export interface SubjectSet {
  primary: AnalyticsSubject;
  comparisons: AnalyticsSubject[];
}

export function allSubjects(set: SubjectSet): AnalyticsSubject[] {
  return [set.primary, ...set.comparisons];
}

/** True when any subject in the set rests on generated prices. */
export function hasSyntheticData(set: SubjectSet): boolean {
  return allSubjects(set).some((s) => s.meta.synthetic);
}

/** True when any subject is modelled rather than observed. */
export function hasSimulatedData(set: SubjectSet): boolean {
  return allSubjects(set).some((s) => s.meta.simulated);
}

/**
 * The widest window every subject covers.
 *
 * Comparing subjects over different windows is the most common way to produce
 * a misleading chart, so the overlap is computed explicitly and surfaced rather
 * than left implicit in whatever the chart happens to render.
 */
export function commonWindow(set: SubjectSet): { start: IsoDate; end: IsoDate } | null {
  const subjects = allSubjects(set).filter((s) => s.series.length > 0);
  if (!subjects.length) return null;
  const start = subjects.reduce((a, s) => (s.meta.start > a ? s.meta.start : a), subjects[0].meta.start);
  const end = subjects.reduce((a, s) => (s.meta.end < a ? s.meta.end : a), subjects[0].meta.end);
  return start <= end ? { start, end } : null;
}

/** True when the subjects do not all span the same dates. */
export function windowsDiffer(set: SubjectSet): boolean {
  const subjects = allSubjects(set).filter((s) => s.series.length > 0);
  if (subjects.length < 2) return false;
  const { start, end } = subjects[0].meta;
  return subjects.some((s) => s.meta.start !== start || s.meta.end !== end);
}
