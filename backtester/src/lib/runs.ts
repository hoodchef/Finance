import type { BacktestConfig, Portfolio, Position } from '@/lib/types';
import type { BacktestResult } from '@/lib/backtest';

/**
 * Immutable run records.
 * =============================================================================
 * A research platform must be able to say what a saved result actually
 * measured, months later.
 *
 * Before this existed, comparisons held LIVE references to portfolio ids: edit
 * a portfolio's weights and every saved comparison silently changed meaning,
 * with no indication that the thing on screen was no longer the thing that had
 * been run. That is not a cosmetic problem — it is a result quietly becoming
 * wrong about its own inputs.
 *
 * A run therefore captures a SNAPSHOT of the portfolio and the configuration at
 * the moment it executed. The snapshot never changes. The portfolio it came
 * from may be edited, renamed or deleted; the run still reports exactly what it
 * measured.
 */

export interface PortfolioSnapshot {
  /** Id of the portfolio this came from. It may no longer exist. */
  sourceId: string;
  /** Name at the time of the run, which may since have changed. */
  name: string;
  positions: Position[];
  /** Identity of the holdings, so identical portfolios can be recognised. */
  fingerprint: string;
}

export interface RunSummary {
  start: string;
  end: string;
  finalValue: number;
  totalReturn: number;
  cagr: number;
  volatility: number;
  maxDrawdown: number;
  sharpe: number;
  /** True when the run used generated rather than observed prices. */
  synthetic: boolean;
}

export interface SavedRun {
  runId: string;
  /** User-facing label; defaults to the portfolio name at run time. */
  label: string;
  savedAt: string;
  snapshot: PortfolioSnapshot;
  config: BacktestConfig;
  summary: RunSummary;
  /** Engine version, so a stale run is never silently re-read under new maths. */
  engineVersion: string;
}

/**
 * A stable identity for a set of holdings.
 *
 * Order-independent and weight-sensitive: reordering rows in the builder is not
 * a different portfolio, but changing a weight is.
 */
export function fingerprintPositions(positions: Position[]): string {
  return positions
    .filter((p) => p.symbol.trim())
    .map((p) => `${p.symbol.trim().toUpperCase()}:${Number(p.weight) || 0}:${p.expenseRatio ?? ''}`)
    .sort()
    .join('|');
}

export function snapshotPortfolio(
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>,
): PortfolioSnapshot {
  return {
    sourceId: portfolio.id,
    name: portfolio.name,
    // Deep-copied: the snapshot must not alias the live portfolio's array.
    positions: portfolio.positions.map((p) => ({ ...p })),
    fingerprint: fingerprintPositions(portfolio.positions),
  };
}

export function summariseRun(result: BacktestResult): RunSummary {
  return {
    start: result.effectiveStart,
    end: result.effectiveEnd,
    finalValue: result.totals.finalValue,
    totalReturn: result.metrics.returns.totalReturn,
    cagr: result.metrics.returns.cagr,
    volatility: result.metrics.risk.volatility,
    maxDrawdown: result.metrics.risk.maxDrawdown,
    sharpe: result.metrics.ratios.sharpe,
    synthetic: result.dataSource.synthetic,
  };
}

export function createRun(result: BacktestResult, label?: string): SavedRun {
  const snapshot = snapshotPortfolio(result.portfolio);
  return {
    runId: `run_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
    label: label ?? snapshot.name ?? 'Untitled run',
    savedAt: new Date().toISOString(),
    snapshot,
    // Deep-copied for the same reason as the positions.
    config: JSON.parse(JSON.stringify(result.config)) as BacktestConfig,
    summary: summariseRun(result),
    engineVersion: result.engineVersion,
  };
}

/**
 * How a saved run relates to the portfolio library today.
 *
 * - `current`  — the source portfolio still holds exactly these positions.
 * - `drifted`  — it exists but has been edited since the run.
 * - `detached` — no saved portfolio has this id.
 *
 * `detached` deliberately does NOT claim the portfolio was deleted. A run
 * launched from an unsaved draft is indistinguishable from one whose portfolio
 * was later removed, and asserting deletion for a portfolio that never existed
 * would be a plain falsehood in the more common of the two cases.
 *
 * None of these invalidate the run — it measured what it measured.
 */
export type RunProvenance = 'current' | 'drifted' | 'detached';

export function runProvenance(run: SavedRun, portfolios: Portfolio[]): RunProvenance {
  const source = portfolios.find((p) => p.id === run.snapshot.sourceId);
  if (!source) return 'detached';
  return fingerprintPositions(source.positions) === run.snapshot.fingerprint
    ? 'current'
    : 'drifted';
}

/** Runs that measured exactly the same holdings, regardless of origin. */
export function groupByFingerprint(runs: SavedRun[]): Map<string, SavedRun[]> {
  const out = new Map<string, SavedRun[]>();
  for (const r of runs) {
    const list = out.get(r.snapshot.fingerprint) ?? [];
    list.push(r);
    out.set(r.snapshot.fingerprint, list);
  }
  return out;
}

/**
 * Whether a stored run's own numbers agree with each other.
 *
 * Runs are snapshots held in browser storage, which means they outlive the
 * code that produced them. A run recorded before a bug was fixed, or written by
 * an older version, still deserializes cleanly and renders as a result — a
 * zero-length window reporting a positive CAGR against a final value of zero,
 * for instance, which is what prompted this.
 *
 * The engine refuses to PRODUCE such a run today. This catches the ones already
 * on disk, so nothing incoherent is offered for comparison as though it were a
 * measurement.
 */
export function runIncoherence(run: SavedRun): string | null {
  const s = run.summary;
  if (!s) return 'This run has no summary.';
  if (!(s.start < s.end)) return 'Its window starts and ends on the same day.';
  for (const [name, value] of Object.entries({
    finalValue: s.finalValue,
    cagr: s.cagr,
    totalReturn: s.totalReturn,
    volatility: s.volatility,
    maxDrawdown: s.maxDrawdown,
  })) {
    if (!Number.isFinite(value)) return `Its ${name} is not a number.`;
  }
  // A final value of zero means everything was lost, which is a CAGR of -100%.
  // Any other rate contradicts it — including 0%, which claims the money neither
  // grew nor shrank while also being gone. Catching only positive rates missed
  // exactly that case.
  if (s.finalValue <= 0 && s.cagr > -0.99) {
    return 'It ends with nothing while reporting a return other than a total loss.';
  }
  if (s.volatility < 0) return 'Its volatility is negative.';
  if (s.maxDrawdown > 0) return 'Its maximum drawdown is positive.';
  return null;
}
