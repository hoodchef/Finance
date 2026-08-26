# Architecture

How this platform is put together, and why. Read `README.md` first for what it
does and how to run it.

## Shape

```
Dashboard    launchpad — recent runs, saved portfolios, presets. No analysis.
Backtester   the flagship research workspace
Portfolios   the portfolio library
Runs         completed backtests; comparison happens here
Analyzer     one security at a time
Studies      rebalancing, scenarios, rolling periods
Planner      Canadian marginal rate and account allocation
Settings
```

### Why the Backtester is a workspace, not part of the Dashboard

A dashboard is **glanceable**: low density, no state, answers "how are things?"
in three seconds. A backtester is a **research session**: around fifteen
configuration inputs, ten analytical outputs, and state you refine over twenty
minutes. A backtest configuration is a document, not a query.

Putting them on one surface forces a choice between truncating the config into
something that cannot express the product, or a dashboard nobody can scan. They
are separated deliberately.

The failure mode of a dedicated workspace is that it becomes an island. That is
prevented structurally, by the two seams below, rather than by convention.

### Why "Runs" and not "Compare"

Comparison is a *mode*, not a destination. A Compare page you visit to re-select
things you already had selected elsewhere is pure friction. Runs accumulate from
your own work, and comparison happens inside them — there is nothing to
re-select.

## Seam 1 — the analytics view-model

`src/lib/analytics/subject.ts`

Every analytical surface consumes an `AnalyticsSubject`, never a
`BacktestResult`.

`BacktestResult` carries 24 fields describing one simulation: its config, its
transaction ledger, its engine version, its provenance. A drawdown chart needs
four of them. Binding presentation to the whole result made every chart unusable
outside the Backtester — a Portfolio Analyzer examining live holdings has no
config and no transactions, so it could reuse nothing, and each chart would have
to be reimplemented per surface.

A subject is the narrow, origin-agnostic thing they all actually need:

```ts
interface AnalyticsSubject {
  id: string;
  label: string;
  origin: 'backtest' | 'benchmark' | 'asset' | 'live-portfolio' | 'simulation';
  series: SeriesPoint[];
  metrics: PerformanceMetrics;
  meta: { start; end; dataSource?; synthetic?; simulated? };
}
```

A backtest produces one. A benchmark produces one. A single security produces
one. A live portfolio will produce one. A Monte Carlo percentile band will
produce one.

Conversion happens in `analytics/adapters.ts` and **nowhere else**. A new
producer of analytics becomes chartable by adding one function there, with no
change to any chart.

This is a presentation boundary only. It computes nothing; every figure passes
through from the engine and the metrics library unchanged.

## Seam 2 — immutable runs

`src/lib/runs.ts`

A saved run holds a **snapshot** of the portfolio and configuration it executed
under. The snapshot never changes. The portfolio it came from may be edited,
renamed or deleted; the run still reports exactly what it measured.

This fixed a real defect. Comparisons previously held live references to
portfolio ids, so editing a weight silently changed the meaning of every saved
comparison mentioning it — a result quietly becoming wrong about its own inputs,
with nothing on screen to say so.

`runProvenance()` reports `current`, `drifted` or `detached`. Note that
`detached` deliberately does not claim deletion: a run launched from an unsaved
draft is indistinguishable from one whose portfolio was removed, and asserting
deletion would be false in the more common case.

## What is shared, and what is not

**Shared across the platform**

| System | Location | Notes |
|---|---|---|
| Market data | `lib/market-data` | `MarketDataProvider` interface; swap providers by writing one class |
| Backtest engine | `lib/engine` | Pure, no I/O, no React |
| Metrics | `lib/metrics` | Pure functions |
| Canadian tax engine | `lib/canpath` | Ported from CanPath's Python reference |
| Portfolio document | `lib/types` | The object every surface exchanges |
| Analytics view-model | `lib/analytics` | Seam 1 |
| Design system | `components/ui` | 16 primitives, no domain coupling |

**Isolated to the Backtester** — the configuration panel, run orchestration and
run pinning. These are meaningless outside a simulation context.

## Portfolio flow

```
Build in Backtester ─▶ Run ─▶ Run recorded (immutable snapshot)
        │                          │
        ▼                          ▼
   Save portfolio            Compare in Runs
        │
        ▼
   Available in Portfolios, Analyzer, Studies
```

A portfolio is mutable and lives in the library. A run is immutable and
references a snapshot, not the library entry.

## Seam 3 — strategies

`src/lib/engine/strategy.ts`

Target weights were computed **once, before the day loop**, from static position
weights. That made momentum, factor tilts, glidepaths and optimisation
inexpressible: every one needs weights to be a function of date and portfolio
state.

A `TargetWeightStrategy` is now asked for weights at each rebalance:

```ts
interface StrategyContext {
  date; index; progress;          // where we are
  declaredWeights;                // the baseline to tilt from
  totalValue;
  priceAt(symbol, daysAgo);       // clamped — cannot read the future
  trailingReturn(symbol, days);   // null when the window is not yet available
}
```

Three ship: `fixedWeights` (the default, behaviourally identical to before —
all 497 pre-existing tests pass unchanged), `glidepath`, and `momentum`.

**Look-ahead is structurally prevented**, not merely avoided by convention.
`priceAt` clamps a negative lookback to today, and `trailingReturn` returns null
rather than a shortened window, since ranking holdings over unequal periods is
its own quiet bias. The decisive test runs one strategy against two datasets
that agree up to day 60 and diverge violently after, and requires identical
records through day 60.

Anything a strategy leaves unallocated stays in cash, and a strategy asking for
more than 100% is scaled back rather than silently levering the account.

**Still out of scope:** options, which need an instrument model with expiry,
strike and assignment. That is a different engine, not an extension of this one.

## Seam 4 — provider failover

`src/lib/market-data/failover.ts`

No single free provider covers everything: Tiingo has the better quota and an
explicit corporate-actions model but does not carry `XEQT.TO`; Yahoo carries the
Canadian listings but throttles without warning. `FailoverProvider` tries each
in order **per symbol**, so one portfolio can hold both.

Two properties matter more than the mechanism:

- It **refuses to be constructed** with a synthetic provider. Generated prices
  silently filling one leg of a portfolio is the worst possible place for them,
  so it is blocked at construction rather than at call time.
- It only reports a symbol as unknown when **every** provider agreed it is. A
  live run exposed the alternative: Tiingo did not list `XEQT.TO`, Yahoo was
  throttled, and the chain said "unknown symbol" — which would send someone
  hunting a typo that was not there.

## The Planner bridge

`src/lib/plan-bridge.ts`

The Planner sizes one year's contributions; the Backtester projects them
forward. Connecting them means the extrapolation is large, so the assumptions
travel with the config and are rendered above the result rather than folded
silently into a number:

- repeating one year assumes income and contribution room hold steady
- including the government boost assumes the refund is reinvested, not spent,
  and that it arrives in the year that earned it (it arrives the next spring)
- account-level tax treatment is not modelled

## Deliberately not built yet

**No database.** `prisma/schema.prisma` exists but nothing imports it and the
dependency is not installed. Persistence is browser `localStorage` via zustand.
This is a real choice: the product works with no account, no server round-trip
and no data leaving the machine. `lib/storage.ts` is the seam a Postgres
implementation slots into.

**No authentication.** Nothing to authenticate yet.

Both are seams left open rather than infrastructure built speculatively.

## What was deliberately not reorganised

The engine, metrics and market-data layers were already well-factored and were
left alone. Only the presentation boundary was wrong, and only that was changed.
No engine arithmetic was touched by any of this work, and the parity suites that
pin it — 235 CanPath fixtures and the vendor-adjusted-close check — passed
unchanged throughout.
