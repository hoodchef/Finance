# Backtester

A portfolio backtesting platform. Build an allocation, run it against real
historical market data, and see what actually drove the result.

The engine is a deterministic, event-driven daily simulator that tracks share
counts and cash through time. It is separate from the UI, has no React
dependency, and is covered by 137 tests — including a parity check against an
independently-computed reference.

```bash
cd backtester
npm install
npm run dev          # http://localhost:3100
```

No API key and no database are required.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [The backtesting engine](#the-backtesting-engine)
- [Metric methodology](#metric-methodology)
- [Market data](#market-data)
- [Running it](#running-it)
- [Testing](#testing)
- [Persistence](#persistence)
- [Known limitations](#known-limitations)
- [Recommended next features](#recommended-next-features)

---

## What it does

| Area | Capability |
| --- | --- |
| **Portfolio builder** | Drag-reorder holdings, ticker autocomplete, per-holding expense ratios, cash sleeve, equal-weight and normalise actions, live allocation bar, 10 built-in presets |
| **Configuration** | Date range with presets, initial investment, recurring contributions or withdrawals, five rebalancing rules plus a custom drift band, dividend reinvestment, management fee, trading costs, commissions, cash yield, three risk-free-rate sources, multiple benchmarks |
| **Results** | 10 KPI tiles, growth chart (value / growth-of-$10k, linear / log, zoom, series toggles), drawdown chart and episode table, annual bar chart, monthly heatmap, allocation donut and drift, dollar attribution, full risk table, benchmark comparison |
| **Rolling periods** | Every overlapping 1/3/5/10/15/20-year holding period, charted by start date, with the full distribution of outcomes and a loss rate per length |
| **Scenario analysis** | Crisis periods derived from a reference index's own drawdowns, with the portfolio's decline and downside capture through each |
| **Per holding** | Standalone buy-and-hold statistics, contribution to portfolio gain, correlation and capture ratios against the portfolio, monthly heatmap |
| **Comparison** | Up to six portfolios over one shared window, overlaid chart and side-by-side table |
| **Rebalancing analysis** | All six rules run against one dataset, with turnover and trading costs |
| **Realised gains** | Lot-level cost basis (FIFO, average cost, HIFO), realised vs unrealised split, short/long-term classification, taxable events by year |
| **Export** | Eight CSV files: summary, annual, monthly, holdings, transactions, daily series, realised gains, configuration |
| **Transparency** | A methodology panel under every result, a data-source badge, and warnings for every data problem the engine detects |

---

## Architecture

```
src/
  lib/                        no React, no Next — usable from a script or a test
    types.ts                  core domain types
    market-data/
      provider.ts             MarketDataProvider interface
      yahoo.ts                live provider (no key required)
      demo.ts                 deterministic synthetic provider
      cache.ts                memory + disk cache
      integrity.ts            data-integrity checks
      catalog.ts              offline ticker catalogue
      dates.ts                UTC date arithmetic
    engine/
      prepare.ts              fetch, align to one calendar, resolve inception/delisting
      engine.ts               the daily event loop
      lots.ts                 cost basis, realised gains, holding periods
      schedule.ts             rebalance and contribution dates
    metrics/
      index.ts                return, risk, ratio and relative statistics
      drawdown.ts             drawdown series and episodes
      periods.ts              monthly/annual bucketing
      rolling.ts              overlapping holding-period windows
      stats.ts                mean, stdev, percentile, covariance
    analysis/
      insights.ts             rule-based observations
      scenarios.ts            crisis periods derived from reference drawdowns
    export/csv.ts             CSV serialisation
    backtest.ts               orchestration: data → engine → metrics → insights
    validate.ts               request validation with financial error messages
    storage.ts                PortfolioRepository seam

  app/
    api/{backtest,compare,rebalance-analysis,scenarios,search}/route.ts
    {,backtest,portfolios,compare,analytics,assets,settings}/

  components/{ui,layout,builder,config,charts,results}/
  store/workspace.ts          persisted portfolios and settings
```

**Data flows one way.** `prepareData` turns tickers plus a config into
calendar-aligned arrays. `runEngine` walks those arrays and emits a daily
ledger. `computeMetrics` derives every statistic from that ledger. The UI
renders what it is given and calculates nothing — there is no financial
arithmetic anywhere in `components/`.

---

## The backtesting engine

`src/lib/engine/engine.ts`

The engine maintains explicit state: a share count per holding and a cash
balance. Portfolio value is always `Σ(shares × close) + cash`. It is never
derived from a return series, and never from first-price-to-last-price
arithmetic.

For each trading day, in this order:

1. **Cash interest** accrues on the balance for the elapsed calendar days.
2. **Splits** are applied to share counts — a no-op when the provider returns
   split-adjusted prices (see [Market data](#market-data)).
3. **Dividends** with an ex-date of today are credited as cash, then either
   reinvested at today's close or left in cash.
4. **Fund expense ratios** are applied as a reduction in share count, which is
   how a fund actually charges them: net-asset-value drag, not a cash debit.
5. **The management fee** accrues daily and is charged from cash at month end,
   selling pro-rata if cash is short.
6. **Contributions and withdrawals** settle. A flow scheduled for a weekend or
   an exchange holiday executes on the next trading day — never dropped, never
   executed at a price that does not exist.
7. **Delisted holdings** are sold at their final close and held as cash.
8. **Rebalancing** runs if today is a scheduled date or a drift band was
   breached. Sells execute before buys so proceeds fund the purchases, and buys
   are scaled down rather than overdrawing the account.
9. **Mark to market**, and record the day.

### Why there is no look-ahead bias

Every decision on day *t* uses only `prices[0..t]`. The engine holds no forward
index and cannot address a future bar. `tests/engine.test.ts` proves it
behaviourally: two runs with identical prices through day 3 and wildly
divergent prices afterwards produce bit-identical records for days 0–3.

### Time-weighted returns

```
r_t = (V_t − F_t) / V_{t−1} − 1
```

where `F_t` is the external cash flow settled on day *t*. This is the single
most important line in the engine. Without the `− F_t`, a flat market with
monthly contributions reports a large positive return purely because the
balance grew. There is a test for exactly that case.

Both measures are reported, because they answer different questions:

- **Time-weighted (CAGR)** — how the *strategy* performed, independent of when
  you happened to add money.
- **Money-weighted (IRR/XIRR)** — what *you* actually earned, given your timing.

### Attribution closes exactly

For every holding:

```
P&L = endingValue + salesProceeds + dividends − purchases − tradingCosts
```

Summed across holdings, plus cash interest, minus the management fee, this
equals `finalValue − netInvested` — to floating-point precision. The test
asserts it on a run with contributions, quarterly rebalancing, dividends,
expense ratios, commissions and a cash sleeve all active at once. If the
attribution ever stops closing, something in the accounting has broken.

---

## Metric methodology

`P` is the observed number of trading periods per year, **measured from the
data** rather than assumed to be 252 — so a crypto portfolio annualises on ~365
and a US equity portfolio on ~252.

| Metric | Definition |
| --- | --- |
| Total return | `index_last / index_first − 1` |
| CAGR | `(index_last / index_first)^(1/years) − 1`, years = calendar days / 365.25 |
| Arithmetic annual | `mean(r) × P` |
| Volatility | `stdev(r) × √P`, sample (n−1) |
| Downside deviation | `√(Σ min(0, r − MAR)² / N) × √P` — target semideviation, all N periods in the denominator |
| Sharpe | `mean(r − rf) × P / (stdev(r − rf) × √P)` |
| Sortino | `mean(r − MAR) × P / downside deviation` |
| Calmar | `CAGR / |max drawdown|` |
| Beta | `cov(r − rf, b − rf) / var(b − rf)` |
| Alpha (Jensen) | `(mean(r − rf) − β·mean(b − rf)) × P` |
| Tracking error | `stdev(r − b) × √P` |
| Information ratio | `mean(r − b) × P / tracking error` |
| Historical VaR | the empirical `(1 − c)` quantile of daily returns |
| Expected shortfall | mean of returns at or below that quantile |
| Money-weighted | IRR over external flows plus terminal value, solved by bisection |

Drawdowns are measured on the **time-weighted index**, not the dollar balance —
otherwise a contribution would "heal" a drawdown the market never recovered
from.

### The dividend convention, and why it differs from a vendor's adjusted close

Two conventions exist for chaining a dividend into a return, and they are not
the same number:

| | Formula | Implies |
| --- | --- | --- |
| **Exact total return** (used here) | `(C_t + D_t) / C_{t−1} − 1` | You receive `D_t` in cash and reinvest it at the ex-date close — what a DRIP does |
| **Back-adjusted price** (vendor `adjClose`) | `C_t / (C_{t−1} − D_t) − 1` | Buying at the cum-dividend price, which nobody can do |

They agree to first order and differ by roughly `D·ΔC/C²` per event — about
`6e-5` on a single AAPL dividend, and under half a percent across a decade of
distributions.

`tests/parity.test.ts` pins the engine to the exact convention to ~1e-9, and
*separately* shows that recomputing the vendor's convention reproduces its
`adjClose` column to ~1e-5. That combination proves the remaining gap is a
definition, not a defect.

---

### Cost basis and realised gains

The engine tracks individual purchase lots and matches sales against them under
FIFO, average cost or HIFO. **It computes no tax.** It computes the quantities a
tax calculation would be built from — which gains were realised, when, from what
basis, and how long the shares were held — and those are facts about the
transactions, identical in every jurisdiction. They can be reported honestly
without a single rate table.

The invariant that keeps it correct, asserted per holding on a run with
contributions, rebalancing, dividends, expense ratios, commissions and a cash
sleeve all active:

```
realised + unrealised + dividends === the position's total profit and loss
```

Purchase costs are capitalised into basis and sale costs netted out of proceeds,
which is both the tax treatment and what makes that identity hold. Two subtleties
the invariant caught during development:

- A **split** multiplies share counts without changing total basis, so basis per
  share divides by the same factor.
- A **fund expense ratio** reduces net asset value, not the amount you paid.
  Total basis is therefore held constant and the fee surfaces as a smaller
  unrealised gain. Shrinking basis alongside shares instead leaks the fee out of
  the split, and the reconciliation fails by exactly the amount of the fee —
  which is how the bug was found.

The practical payoff is that rebalancing's tax drag becomes visible: a
buy-and-hold portfolio realises nothing, while the same portfolio rebalanced
quarterly crystallises gains every time it trims a winner.

### Rolling periods

A single CAGR answers "what would one specific entry date have produced?". It
says nothing about how much the answer depended on that date, which is usually
the more useful question — a strategy whose ten-year outcomes span 2% to 14% is
a different proposition from one that spans 6% to 8%, even when both average the
same.

Every overlapping window is evaluated, so the sample is the full set of start
dates the data supports. Windows are measured in **calendar time**, not in a
fixed number of trading days: 252 trading days is only ~0.96 of a calendar year,
and annualising a "1-year" window over that denominator overstates it by roughly
0.8 percentage points. A test asserts this against a constant-growth series.

Because the windows overlap heavily the observations are not independent. That
makes the spread a fair description of history and a poor basis for a confidence
interval, so none is reported — and the chart says so.

### Scenario analysis

Crisis periods are **derived from price data, not hard-coded**. A table of
remembered crash dates is exactly the kind of plausible-looking input that is
wrong in ways nobody notices — off by a few weeks, or quietly describing the S&P
when the reference is the Nasdaq.

Instead the reference index is run through the engine, its drawdown episodes are
computed, and the deepest ones become the scenarios. Switching the reference
genuinely changes which periods appear: a bond investor's bad years are not an
equity investor's.

Common names ("Global financial crisis") are applied only as decoration, and
only when a computed trough falls in the month that name refers to. The dates
always come from prices; an unnamed episode is still shown, labelled by its
range.

The portfolio runs with the user's own rebalancing rule and fees but **without
contributions** — a scheduled deposit landing mid-crash would flatter the
decline.

## Market data

### Provider abstraction

```ts
interface MarketDataProvider {
  id: string;
  label: string;
  synthetic: boolean;
  getHistoricalPrices(symbol, range): Promise<PriceSeries>;
  getCorporateActions(symbol, range): Promise<CorporateActions>;
  getDividends(symbol, range): Promise<DividendEvent[]>;
  getTradingCalendar(range, symbols?): Promise<IsoDate[]>;
  search(query): Promise<SecurityMeta[]>;
}
```

Swapping Yahoo for Polygon, Tiingo or EODHD means writing one class. The engine,
metrics and UI never change.

### Yahoo Finance (default, no key)

The verified data contract, asserted in `tests/market-data.test.ts` against a
recorded live response:

1. `close` is retroactively **split-adjusted**. AAPL's 2020-08-28 close is
   reported as 124.81 — the as-traded 499.23 divided by the later 4:1 split.
2. `dividends[].amount` uses the **same** split-adjusted units: AAPL's August
   2020 dividend is 0.205, i.e. the as-paid 0.82 divided by 4.
3. `adjClose / close` steps only on ex-dividend dates, by exactly
   `1 − D / C_{t−1}`.

(1) and (2) together are why share counts need no split handling. (3) gives a
free integrity check: every dividend is rederived from the adjusted close and
compared to the reported amount.

If the provider ever changes its convention, the suite fails at that assertion
rather than producing quietly wrong backtests everywhere else.

### Demo provider (synthetic)

```bash
npm run dev:demo     # http://localhost:3101
```

A seeded geometric random walk with quarterly dividends and a realistic US
trading calendar. Deterministic: the same ticker always produces the same
series.

**It is not market data**, and the product says so at every level — the provider
declares `synthetic: true`, results carry a non-dismissible banner, and the CSV
config export writes `Synthetic data,YES — NOT REAL MARKET DATA`. A backtest on
invented prices that *looks* real is worse than no backtest.

### Caching

Two tiers: a process-local map, and a JSON file per symbol under
`.cache/market-data`. Full history is cached and sliced on read, so widening a
date range is also a cache hit. Concurrent requests for the same symbol are
de-duplicated into one fetch.

### Data problems are surfaced, never smoothed over

| Situation | Behaviour |
| --- | --- |
| Holding has no history at the start | Window moves forward (default), or that weight is held in cash — your choice, with a warning either way |
| Security stops trading mid-backtest | Sold at its final close, proceeds held as cash, warned |
| Security does not trade on a market day | Previous close carried forward, day flagged, warned after 5+ consecutive days |
| Dividend feed disagrees with adjusted close | Warned with a count |
| Series claims adjustment but contains a raw split | **Error** — results for that asset would be wrong |
| Unknown ticker | Named explicitly, with the reason |

---

## Running it

```bash
npm install
npm run dev          # port 3100, live Yahoo data
npm run dev:demo     # port 3101, synthetic data
npm run build && npm start
npm test             # 104 tests
npm run typecheck
```

`.env.example` documents every environment variable. All are optional.

---

## Testing

```
tests/engine.test.ts       28  share accounting, dividends, splits, rebalancing,
                               fees, cash, delisting, look-ahead, attribution
tests/validate.test.ts     24  input validation and the repository contract
tests/metrics.test.ts      18  hand-verifiable statistics, drawdown episodes, XIRR
tests/schedule.test.ts     12  date arithmetic and period boundaries
tests/market-data.test.ts  12  the provider data contract, against recorded live data
tests/export.test.ts       13  CSV correctness, escaping, chart-series alignment
tests/lots.test.ts         13  FIFO/average/HIFO, splits, fee drag, reconciliation
tests/rolling.test.ts       7  calendar-time windows and outcome distributions
tests/scenarios.test.ts     7  episodes derived from data, coverage handling
tests/parity.test.ts        5  engine vs an independently-computed reference
```

Every expected value is arithmetic a reader can redo by hand, or comes from
outside this codebase. Representative cases:

- 100 shares at $100 → $110 → $121 gives exactly 21%, with the share count
  asserted at each step.
- A flat market with monthly contributions gives exactly 0% time-weighted
  return, despite the balance growing 200%.
- A 4:1 split creates exactly zero value.
- Two runs identical through day 3 produce bit-identical records for days 0–3.
- Per-holding P&L sums exactly to the portfolio's investment gain.
- Engine total return matches the independent reference to ~1e-9 across a real
  4:1 split and a real dividend.
- Every rolling window of a constant-growth series annualises to exactly that
  rate — the test that caught the trading-day/calendar-year mismatch above.
- A bond-heavy sleeve shows lower downside capture than pure equity through the
  same derived crisis periods.
- Realised plus unrealised plus dividends reconstructs each holding's profit and
  loss exactly; HIFO realises strictly less than FIFO on the same trades while
  leaving the portfolio's total gain identical.

To re-verify the live data contract:

```bash
node scripts/record-fixtures.mjs
```

---

## Persistence

Saved portfolios live in **browser local storage**. This is deliberate: the
product works with no database, no account and no server round-trip, and a
user's portfolios never leave their machine. Settings → Export workspace writes
a JSON backup.

`src/lib/storage.ts` defines the `PortfolioRepository` seam and
`prisma/schema.prisma` defines the equivalent Postgres model (User, Portfolio,
Position, BacktestRun). Moving server-side means implementing one interface.

Note what the schema deliberately omits: **no price or dividend tables**. Market
data is cached on disk and is disposable. A warm cache is a performance detail,
never a source of truth — a stale row in a prices table is the easiest way to
produce a wrong backtest that looks right.

---

## Known limitations

**Not implemented, and not faked.** Monte Carlo has a UI placeholder stating what
it would do, what it needs, and why nothing is displayed. No simulated numbers
are shown anywhere.

**Rolling drawdown on very long samples.** The rolling max-drawdown sweep is
skipped above ~120M operations and those windows report `null`, not `0` — the
chart omits the row rather than implying no drawdown occurred.

**Data**
- Yahoo Finance is an unofficial, undocumented endpoint. It rate-limits under
  load; the provider retries with backoff across two hosts, and the UI tells you
  to wait rather than reporting a bad ticker.
- Expense ratios are **user-entered and default to zero**. Yahoo's fund-profile
  endpoint requires session credentials this app does not obtain, and a
  hard-coded table of expense ratios would silently go stale.
- Everything is treated as a single currency. A CAD-listed ETF backtests in its
  own currency with no FX translation.
- Survivorship bias is inherent to any backtest built from tickers that still
  exist today. Choosing assets with hindsight is not something any engine can
  correct for.

**Engine**
- No short positions; negative weights are rejected with an explanation.
- No leverage or margin modelling. A leveraged ETF backtests as its own price
  series, which is correct, but the engine cannot construct leverage itself.
- No intraday, limit or stop orders. All execution is at the daily close.
- No tax calculation. Cost basis, realised gains and holding periods are all
  tracked, so the inputs to one exist — but no rates, brackets, account types or
  jurisdiction rules are implemented, and none are guessed at.
- Dividend reinvestment is modelled as a DRIP: no commission, no spread.
- Withholding tax on foreign dividends is not modelled.

**Product**
- Single user, no accounts, no sharing.
- PDF export is not implemented; `ExportKind` in `src/lib/export/csv.ts` is the
  extension point.

---

## Recommended next features

Roughly in order of value per unit of work.

1. **Tax-aware accounts** — taxable / TFSA / RRSP / FHSA. Lot-level basis,
   realised gains and holding periods are already computed, so what remains is
   the jurisdiction layer: rate tables, account rules and contribution limits.
   That needs real published rates, not remembered ones. It is the feature most
   likely to change someone's actual decision.
2. **Shareable result links** — persist a `BacktestRun` row and rerun
   deterministically from its stored config. The schema is already written.
3. **Monte Carlo** — with the generator choice stated on screen and simulated
   results visually separated from historical ones.
4. **Currency translation** — an FX series in the provider interface and a base
   currency on the config, unlocking non-USD portfolios properly.
5. **Factor regression** — Fama–French three- or five-factor attribution against
   published factor return series.
6. **Web Worker execution** — the engine is pure and has no I/O, so it can move
   off the main thread or into a queue unchanged when portfolios get large.

---

*This tool is for research and education. It is not investment advice. Past
performance does not predict future results, and a backtest applies today's
choice of assets to yesterday's prices — a choice no investor could have made
at the time.*
