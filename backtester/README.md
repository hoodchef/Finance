# Backtester

Two halves of one question, in one app.

**The Planner** answers *what is your next dollar actually worth?* — a Canadian
marginal-rate and account-allocation engine that counts benefit clawback, not
just the posted bracket, and then decides which account this year's savings
belong in.

**The Backtester** answers *what would that have become?* — build an allocation,
run it against real historical market data, and see what actually drove the
result.

They are joined: the Planner sizes one year of contributions and hands them to
the Backtester with its assumptions attached, so the projection states what it
excludes rather than quietly absorbing it.

The engine is a deterministic, event-driven daily simulator that tracks share
counts and cash through time. It is separate from the UI, has no React
dependency, and is covered by 621 tests across 29 files — including parity
checks against two independently-computed references.

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
- [The Planner](#the-planner-and-what-it-will-not-guess)
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
| **Planner (Canada)** | Effective marginal rate including benefit withdrawal, the full rate curve across the income range, and a solver that funds employer match / FHSA / RESP / RRSP / TFSA in order, re-scoring after each step |
| **Planner → Backtester** | Carries the plan's contribution schedule into a backtest with its assumptions listed on screen |

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

**Vendors do not agree with each other, either.** Yahoo back-adjusts. Tiingo
does not: it scales every bar before an ex-date by `C_ex / (C_ex + D)`, which
telescopes to

```
adjC_t / adjC_{t−1}  =  (C_t + D_t) / C_{t−1}
```

— the exact convention, the same one the engine implements. So Tiingo is both
an independent reference and a sharper one: where Yahoo can only bound the
disagreement at ~1e-5, Tiingo agrees to floating point.

This was derived from the data, not from documentation. Across 74 dividends on
SPY, AAPL, BND and KO, the implied per-event step matched `1 + D/C_ex` to
~1e-12 and missed Yahoo's `1/(1 − D/C_{t−1})` by up to `1.2e-4`.
`tests/parity-tiingo.test.ts` re-derives it on every run, so if Tiingo ever
changes how it adjusts, the suite fails there first rather than quietly
re-baselining:

| Reference | Symbol | Span | Events | Agreement |
| --- | --- | --- | --- | --- |
| Tiingo `adjClose` | SPY | 2015–2024 | 40 dividends | ~1e-8 |
| Tiingo `adjClose` | BND | 2015–2024 | 120 distributions | ~1e-8 |
| Tiingo `adjClose` | AAPL | 2019–2021 | 12 dividends + 4:1 split | ~1e-8 |
| Yahoo `adjClose` | AAPL | 2020 | 1 dividend + 4:1 split | ~1e-5 (convention gap) |

Both mutants tried against this suite are killed: reinvesting at the prior
close (the back-adjustment assumption) breaks all three parity tests, and
ignoring the split factor breaks both AAPL tests.

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

### Factor regression

Regresses the portfolio's daily excess return on the Fama–French factors, taken
from the [Kenneth R. French Data
Library](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html)
— the canonical source, published free by the people who defined the factors.
Three-factor and five-factor models, with Carhart momentum optional on either.

**Standard errors are Newey–West, not classical.** Daily return residuals are
autocorrelated and heteroskedastic; classical standard errors assume neither and
come out too small, which makes alpha look significant when it is not. Both are
computed and the ratio is shown, so the gap is visible rather than hidden behind
a choice made in the code. The lag length is Newey and West's own rule,
`floor(4·(n/100)^(2/9))`.

The estimator is checked against **statsmodels**, not against arithmetic written
here — coefficients, both sets of standard errors, t-statistics, R² and adjusted
R² all agree to ~1e-9 on a 900-observation design with AR(1) heteroskedastic
residuals, chosen so the two standard errors genuinely differ (~1.7× on alpha).
With iid residuals they coincide and the fixture would pass even if the HAC
sandwich were never implemented.

As a known-answer check, SPY 2015–2024 on the three-factor model returns market
beta **0.976**, SMB **−0.124** (large-cap), HML **+0.018** (neutral), alpha
**0.11%/yr at p = 0.73**, R² **0.995** — every sign and magnitude what theory
predicts of an index fund.

Three things the panel refuses to let slide:

- **Alpha is reported with its p-value beside it**, and in three bands rather
  than two. A p just over 0.05 is a different statement from a p of 0.9, and
  collapsing them lets a borderline result read as a null one.
- **The library lags.** French publishes monthly, one to two months behind. The
  regression covers only the overlap and says so when that is shorter than the
  backtest — a factor return cannot be carried forward without inventing market
  movement that did not happen, so the join is inner and missing days are
  dropped.
- **The archive checksum is verified** before parsing. A truncated download
  inflates into valid-looking CSV and would regress against a silently
  shortened history.

Factor data is fetched at runtime and cached locally; nothing is redistributed.

---

### The Planner, and what it will not guess

The Canadian engine is ported from
[CanPath](https://github.com/hoodchef/CanPath)'s Python reference, which remains
the source of truth. `tests/canpath-parity.test.ts` replays **235 fixtures**
generated by that reference against this port on every run.

What it does that a tax table does not: a posted bracket is not what the next
dollar costs. Once income-tested benefits begin withdrawing, the effective rate
can be far above the bracket, and that gap appears nowhere on a return. The
Planner surfaces it, charts it across the whole income range — the spikes are
real, and they are where a benefit phases out — then answers the question it
raises: given *that* rate, where should this year's savings go?

**The one rule: never invent a Canadian tax parameter.** Every figure comes from
`lib/canpath/data/taxyear_2026.json`, which records provenance per value in
`source_notes`. A fabricated rate would pass every test in this repo and be
invisible in the output, so anything unsourced is marked blocked rather than
estimated. Currently blocked on published data, in descending order of value:
**GIS**, the **territories**, and **Quebec** (which administers its own tax and
benefit system). Those provinces are absent, not approximated.

The Planner is a calculation, not tax advice.

### The Planner bridge

The Planner sizes **one year**. The Backtester projects **many**. Carrying one
into the other means asserting that the year repeats, which is an assumption and
is stated as one: the bridge hands over three caveats — that income and
contribution room are held flat, whether the refund and benefits it generates
are reinvested, and that account-level tax treatment is not modelled — and the
Backtester renders them above the result rather than storing them silently.

---

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

### Provider evaluation (August 2026)

Providers were assessed on the criterion that actually decides whether a
backtest is correct — corporate actions first, because a total return computed
without dividends and splits is not approximately right, it is wrong.

| Provider | Adjusted close, dividends, splits on the free tier | Free limit | Non-US | Commercial use | Verdict |
|---|---|---|---|---|---|
| **Yahoo Finance** | Yes | Unstated, throttles hard | Yes (`.TO`) | **No licence at all** | Default. Research only |
| **Tiingo** | **Yes** — `adjClose`, `divCash`, `splitFactor` | 1,000/day, 500 symbols/mo | Limited | **Personal only, even at $30/mo** | Recommended free upgrade |
| **Alpha Vantage** | **Weekly only** — `adjClose` + dividends free; daily adjusted is premium | 25/day | **Yes — TSX, with currency** | **Personal only** | Used for Canadian listings |
| Financial Modeling Prep | Partial | 250/day | **US only** on free | — | Rejected |
| Nasdaq Data Link | **Discontinued** (WIKI, March 2018) | — | — | — | Rejected for prices |
| EODHD | No on free; yes at $19.99/mo | 20/day | Yes, global | Enterprise plan | Best paid path |
| Stooq | — | — | — | — | Behind a bot check |

**Alpha Vantage's DAILY endpoints were rejected on evidence, not preference.**
`TIME_SERIES_DAILY_ADJUSTED` is a premium function, and plain
`TIME_SERIES_DAILY` returns raw OHLCV with no adjusted close, no dividends and
no splits — capped at 100 bars, since `outputsize=full` is premium too. A
backtest on that would understate equity returns by roughly the dividend yield
every year and produce nonsense at every split.

That was the whole finding at first, and it was incomplete. The **weekly**
adjusted endpoint is free, returns full history, and carries both an adjusted
close and per-bar dividends — which makes Alpha Vantage the only free source
here that covers TSX listings correctly. It is used for exactly that, at weekly
resolution, with the trade stated on screen: see
[Alpha Vantage (Canadian listings, weekly)](#alpha-vantage-canadian-listings-weekly).

### The licensing finding

**No free provider is both corporate-action-complete and commercially
licensable.** That is the structure of the market, not a gap in the search:
market data is licensed, and redistribution costs money.

- Yahoo is an undocumented endpoint with **no API agreement**. Fine for personal
  research; not something to build a business on.
- Tiingo's free *and* $30/month tiers are internal use only — "you may not
  display or share the data with another person or organization."
- EODHD's $19.99/month tier is likewise personal use; commercial needs their
  enterprise plan.

The application states this itself. `src/lib/market-data/licence.ts` records the
terms per provider, Settings shows the active provider's licence and what
commercialising would require, and `EVALUATED_AND_REJECTED` keeps the reasoning
where it will be found rather than re-litigated.

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

### Tiingo (recommended, needs a free key)

```bash
# .env.local
TIINGO_API_KEY=your_key_here
```

Tiingo takes the **opposite** approach to delivery: raw, as-traded prices with
per-bar `divCash` and `splitFactor`, rather than Yahoo's pre-adjusted closes.
The series is declared `adjustment: 'raw'` and the engine applies splits to
share counts itself — a path it already supports and tests. Absorbing that
difference is exactly what the provider abstraction is for.

Tiingo also ships its own adjusted columns, and those use the **exact
total-return** convention rather than Yahoo's back-adjustment (see
[the dividend convention](#the-dividend-convention-and-why-it-differs-from-a-vendors-adjusted-close)).
The engine ignores them at runtime — it works from the raw side — but
`tests/parity-tiingo.test.ts` checks one against the other, which is the
strongest parity anchor in the repo.

### Options data: evaluated, none usable

Surveyed August 2026, and the answer is the price-data finding in sharper
form. A free options feed good enough to build on exists; none of it may be
shown to anyone else.

| Source | What it gives | Why it is not used |
| --- | --- | --- |
| **Cboe delayed-quotes CDN** | The best free data found: 13,288 SPY contracts, 32 expiries to 2028, bid/ask and sizes, IV, open interest, volume, full greeks and a theoretical price. Current to the session close, no key. | Cboe's content policy requires advance written approval and an executed licence before any website data is used. An open endpoint is not a licence. |
| **Alpha Vantage options** | Historical and realtime option chains. | Both premium. `REALTIME_OPTIONS` returns a populated, parseable payload on the free tier that is labelled *in the response* as artificial illustrative data — an integration written against it would invent option chains. |
| **marketdata.app** | 100 credits/day, 24-hour delayed, one year of history. | Free and mid tiers are "Internal Use" only; redistribution is top-plan-only at custom pricing. |

Recorded in `lib/market-data/licence.ts` as `OPTIONS_SOURCES_EVALUATED`, with a
test asserting every entry carries a blocker — so the search is not repeated,
and so nothing gets integrated without the terms being read.

### Describing a portfolio to a local model

Optional, off unless a local Ollama daemon answers on `127.0.0.1:11434`. It
turns *"a 60/40 with a gold sleeve, tested since 2010"* into a proposed
portfolio and configuration.

**Local specifically, not incidentally.** The proposition of this product is
that a user's income, province and net worth never leave their machine.
A hosted model would break the one property nothing else here breaks.

```bash
ollama pull llama3.2        # OLLAMA_MODEL to use another
```

**Input only, and the boundary is the whole safety argument.** The model
chooses tickers and weights; it never produces a figure that reaches a result
and never writes prose about one. Its answer is treated exactly like a shared
link — hostile until parsed — and goes through `parsePositions` and
`parseConfig`, the same functions a typed request uses. A hallucinated
allocation cannot reach the engine by a route a typed one could not.

What it will *not* do is narrate a backtest. Every figure in this application
traces to a computation, and a model writing commentary is a fabrication engine
aimed precisely at that. The failure has a shape already seen here: Alpha
Vantage's free options endpoint returns a populated, parseable payload the
response itself labels artificial. Plausible output with nothing behind it is
the hazard, and no validator catches it — so there is no code path to one.

Three things happen that a form does not need:

- **Every symbol is checked against the local 13,000-symbol universe.** A model
  will confidently invent a plausible ticker, and an invented ticker otherwise
  fails much later as a provider error that reads like an outage. Unrecognised
  symbols are flagged on the review screen instead.
- **Weights that do not sum to 100 are reported, not normalised.** Silently
  rescaling would hide that the request was misread.
- **Nothing is applied.** The proposal is rendered for review, with every
  defaulted field named and the model's own stated uncertainty shown, and the
  user presses Use. A misread request produces a wrong screen, not a wrong
  portfolio.

**The live path is unverified.** Ollama was not installed on the machine this
was written on. Every branch of the client is tested against a stubbed daemon —
absence, a daemon missing the model, a refusal, and the three ways a small
model returns something other than the JSON it was asked for — and the
interpretation boundary is tested against invented tickers, unbalanced weights,
numbers as strings, dates as prose and negative weights. What has not been
confirmed is that a real model produces usable JSON often enough to be pleasant.
A smaller model may not.

### Parity fixtures are not redistributable

The Tiingo recordings that back `tests/parity-tiingo.test.ts` are gitignored.
Tiingo licenses its data for personal use only, so committing ten years of
SPY/BND/AAPL bars would be redistributing a vendor's dataset — a liability for
anything that later becomes commercial. Regenerate them with your own key:

```bash
npm run record:fixtures
```

Without them the suite **skips**, which is the right default but also how a
parity anchor rots unnoticed. `npm run test:parity` sets `REQUIRE_FIXTURES=1`,
which turns a missing fixture into an explicit failure naming the file and the
command that fixes it. Use that form in CI.

### Alpha Vantage (Canadian listings, weekly)

```bash
# .env.local
ALPHA_VANTAGE_API_KEY=your_key_here
```

Tiingo does not carry TSX listings and Yahoo is unreliable, which left Canadian
portfolios unbacktestable. Alpha Vantage fills that gap — **at weekly
resolution**, which is a real trade and is treated as one.

**Why weekly.** On the free tier `TIME_SERIES_DAILY_ADJUSTED` is premium, and
plain `TIME_SERIES_DAILY` is capped at 100 bars with `outputsize=full` also
premium: five months of raw OHLCV, no dividends, no splits. Neither can produce
a correct total return. `TIME_SERIES_WEEKLY_ADJUSTED` is free, returns full
history (RY.TRT goes back to 2005, AAPL to 1999), and carries an adjusted close
plus per-bar dividends.

**Verified against Tiingo, not assumed.** AAPL over 2019–2021, a window
containing the 4:1 split: total return **393.5267%** from Alpha Vantage weekly
against **393.5270%** from Tiingo daily, agreeing to `6.9e-7`, with adjusted
closes identical on shared dates. Splits are already folded into both columns,
so the series is declared `split-adjusted` with an empty split list and the
engine does not apply one again.

**What weekly costs, said out loud.** A drawdown that opens and closes inside
one week is not in the data, so the maximum drawdown reported is a floor rather
than the figure — XEQT.TO over 2020–2024 shows −27.8% where the true daily
figure is nearer −34%. Every run touching a weekly holding raises a
`coarse-interval` warning saying so.

Three things had to change in the engine for this to be honest rather than
merely possible:

- **The master calendar is built at the coarsest interval present.** It was a
  union of every series' bar dates, so a single daily benchmark alongside a
  weekly holding produced a *daily* calendar on which the holding sat stale four
  days in five. Its returns landed on one day a week but were annualised as
  weekly, understating volatility about twofold — live, 7.22% against a true
  15.73% — and its last weekly bar, a few days short of the final calendar day,
  tripped the delisting rule and liquidated a live position to cash. Both
  symptoms are one mismatch. Reverting the fix reproduces all three failures
  (1040-day calendar, 3.3% volatility, spurious liquidation) and all three are
  caught.
- **`periodsPerYear` now tracks the bar interval.** It was floored at 200
  regardless, which is right for a gappy daily calendar and wrong for a weekly
  one: volatility scaled by `√200` instead of `√52` overstates risk about
  twofold. A test pins ~52, and a second pins annualised volatility at 7.2%
  rather than 14.2% on a known series.
- **The dividend reconciliation is skipped for non-daily series.** It derives
  the implied dividend from the previous bar's close, which on weekly bars is a
  week before the ex-date — so it fired on every Canadian backtest. A warning
  that always fires teaches people to ignore the one that matters on daily data.

Alpha Vantage sits **last** in the failover chain and refuses non-Canadian
symbols, so a symbol another provider can serve daily never reaches it and a
transient Tiingo outage cannot quietly coarsen a daily backtest. Its free tier
is 25 requests/day and throttles bursts well before that, so everything is
cached hard and fetched one symbol at a time.

Symbol suffixes are mapped for you: `.TO` → `.TRT`, `.V` → `.TRV`, `.NE` →
`.NEO`, `.CN` → `.CNQ`. A bare ticker is never treated as Canadian — `SHOP` is
the US listing and `SHOP.TO` is the Toronto one, in a different currency.

### Verifying a provider before trusting it

A provider that has not been checked against live data is not verified, however
plausible its documentation. Every provider must clear the bar Yahoo did:

```bash
npm run verify:data
```

This fetches real data and asserts the contract — dividends reconcile with the
adjusted close, the split convention matches what the provider declares, no
unapplied splits, history deep enough for long-horizon work. It self-skips
without a key, so the suite stays green offline.

**Status: Yahoo is verified against recorded live data. Tiingo is implemented
against its documented contract but has not been run against a live key here —
run `npm run verify:data` after adding yours.**

### When a provider is unreachable

Yahoo throttles without warning, so this is routine rather than exceptional.

- Requests retry with exponential backoff across both hosts.
- If that fails and a cached copy exists, **real prices from an expired cache are
  served** rather than failing the backtest — flagged `stale`, surfaced as a
  warning, and shown in the provenance line under every result.
- If no cache exists, the backtest **fails**. It never falls back to synthetic
  data.

### Demo mode (synthetic)

```bash
npm run dev:demo     # http://localhost:3101
```

A seeded random walk for offline exploration. **It is not market data**, and
four separate mechanisms stop it being mistaken for it:

1. The provider is selected **server-side only**. `getProvider()` takes no
   argument, so no request can ask for synthetic data. An unrecognised
   `MARKET_DATA_PROVIDER` falls back to *real* data, never generated.
2. Every synthetic series is stamped `synthetic: true`, propagating to
   `dataSource.synthetic` on every result.
3. Every surface that renders results shows a non-dismissible banner, and the
   CSV config export writes `Synthetic data,YES — NOT REAL MARKET DATA`.
4. `tests/data-integrity-guards.test.ts` enforces all of the above at source
   level, including that a newly added results page cannot omit the banner.
   Each guard was mutation-tested: reintroducing the hole fails a test.

### Symbol universe

13,000+ US-listed securities — 5,637 ETFs and 7,499 equities — from the
exchanges' own **Nasdaq Trader Symbol Directory**, which needs no API key,
refreshes every trading day, and carries an explicit ETF flag so funds are known
to be funds rather than inferred from their names.

```bash
npm run build:universe
```

It is a **server-side** index; at ~775 KB it has no business in a client bundle,
so search runs behind `/api/search` and the browser receives only its matches.
Beyond autocomplete, this means a mistyped ticker is caught before any request
is made, and **search keeps working while the price provider is rate-limited** —
exactly when someone is most likely to be retyping a symbol.

Share-class notation is reconciled against the directory rather than guessed:
`BRK.B` resolves to `BRK-B` because that symbol exists in the listing, while
`XEQT.TO` is left alone because its dot is an exchange qualifier. A regex cannot
tell those apart — `.B` is a share class and `.V` is the TSX Venture exchange.

### Price return vs total return

`dividends: 'ignore'` produces a **price return**. It exists for one honest
purpose: comparing against a price index such as `^GSPC`, which itself excludes
dividends.

It is **not** a data-availability workaround — both providers supply dividends
free — and the cost of using it otherwise is large:

| | 30-year multiple with dividends | price only | result missing |
|---|---|---|---|
| Equity fund (1.8% yield) | 7.61× | 4.58× | 40% |
| Dividend fund (3.5%) | 7.61× | 2.81× | 63% |
| Bond fund (4.2%) | 7.61× | 2.29× | 70% |

So every run that uses it measures the dividends it discarded and reports the
figure, the methodology block states plainly that these are price returns, and
the configuration panel shows the tradeoff at the point of choice.

### Currency

Holdings denominated differently are translated into one reporting currency
before being added, at the published daily rate. Returns then include currency
movement — which is real risk borne by an investor in that currency, not an
artefact to be smoothed away.

The base currency defaults to whichever currency holds the largest share of the
portfolio, so a single-currency portfolio is never converted and never acquires
FX noise it did not experience.

**Direction is the thing that silently breaks.** A rate is always units of quote
per one unit of base: `USDCAD = 1.38` means a USD price is converted to CAD by
*multiplying*. Inverting it produces a portfolio that looks entirely plausible
and is wrong by the square of the rate, so the direction is asserted against a
live published value rather than trusted to careful reading.

Rates come from the **Bank of Canada Valet API** — the official source, free and
keyless — with Yahoo behind it for deeper history. The Bank's published series
begin in **2017**, when it replaced noon rates with indicative rates. Where a
requested window predates the available rates, those days are excluded and the
user told; extrapolating a rate backwards would be inventing the single number
the conversion depends on.

Where no rate can be loaded at all, the run is **refused**. A mixed-currency
total without a rate is not approximately right, it is meaningless.

### Provenance shown with every result

Each result carries where its prices came from, when they were retrieved, and
the last session they cover — the *oldest* retrieval across all series, since a
result is only as current as its stalest input. More than five days behind is
called out explicitly.

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
npm test             # 621 tests across 29 files
npm run typecheck
```

`.env.example` documents every environment variable. All are optional.

---

## Testing

```
canpath-parity          235  every fixture the Python reference generates
data-integrity-guards    46  synthetic data can never render as a real result
engine                   35  share accounting, dividends, splits, rebalancing,
                              fees, cash, delisting, look-ahead, attribution
validate                 27  input validation and the repository contract
alphavantage             25  weekly bars, coarse-interval honesty, mixed frequency
canpath-shapes           19  monotonicity and shape properties of the tax curves
metrics                  18  hand-verifiable statistics, drawdown episodes, XIRR
factors                  16  Data Library parsing, alignment, missing sentinels
cashflows                16  contributions, withdrawals, and their effect on TWR
regression               15  OLS and Newey-West against statsmodels
montecarlo               14  block vs IID resampling, the daily-series guard
inflation                14  real metrics and the Fisher relation
lots                     13  FIFO/average/HIFO, splits, fee drag, reconciliation
export                   13  CSV correctness, escaping, chart-series alignment
schedule                 12  date arithmetic and period boundaries
provider-contract        12  live data contracts, gated behind VERIFY_DATA
market-data              12  the provider data contract, against recorded live data
failover                 11  per-symbol fallback and failure attribution
strategy                 10  glidepath, momentum, and look-ahead refusal
runs                      9  snapshot immutability and provenance
periods-extra             9  period boundary edge cases
share                     7  URL round-tripping of a configuration
scenarios                 7  episodes derived from data, coverage handling
rolling                   7  calendar-time windows and outcome distributions
plan-bridge               7  the Planner-to-Backtester handover and its caveats
weight-input              6  what a percentage field accepts while being typed
parity-tiingo             6  engine vs Tiingo's adjusted close, to floating point
parity                    5  engine vs Yahoo's, bounded by the convention gap
currency                  5  FX translation and base-currency selection
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

## Accounts and server storage

Off by default. With no `DATABASE_URL` the app keeps portfolios in the browser,
needs no account, and nothing leaves the machine. Setting `DATABASE_URL` enables
server-side storage under one local owner; accounts additionally require
`NEXTAUTH_SECRET`. **A database without a secret is not authentication** and the
app treats it as still off, rather than signing sessions with nothing.

Sessions are database-backed, not JWT: a JWT cannot be revoked before it
expires, and for a product holding someone's financial planning, ending a
session server-side is worth the extra query.

```bash
npm run db:generate      # Prisma clients, Postgres and the SQLite mirror
npm run db:migrate       # apply prisma/migrations to DATABASE_URL
npm run db:push:test     # local SQLite, for the repository tests
```

**The migration has not been run against a live Postgres.** It is generated
from the schema by `prisma migrate diff` and checked in, and tests assert it
creates every model, cascades deletes from the owner, carries the uniqueness
Auth.js depends on, and stores weights as `DECIMAL` rather than a float. That is
a weaker claim than "it runs", and is the honest one: no Postgres was reachable
from the machine that wrote it. The repository itself IS exercised against a
real database — SQLite, from a schema generated off the Postgres one so the
models cannot drift.

OAuth providers register only when both halves of a credential pair are present.
No live OAuth flow has been run either.

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

Monte Carlo, currency translation and factor regression have since been built;
see [Metric methodology](#metric-methodology) and [Market data](#market-data).
What remains, roughly in order of value per unit of work:

1. **Tax-aware accounts** — taxable / TFSA / RRSP / FHSA. Lot-level basis,
   realised gains and holding periods are already computed, so what remains is
   the jurisdiction layer: rate tables, account rules and contribution limits.
   That needs real published rates, not remembered ones. It is the feature most
   likely to change someone's actual decision.
2. **Shareable result links** — persist a `BacktestRun` row and rerun
   deterministically from its stored config. The schema is already written.
3. **Rolling factor loadings** — the regression is a single window, so a
   strategy that changed its exposure halfway through reports the average of two
   things it never was. Rolling betas would show the drift.
4. **Web Worker execution** — the engine is pure and has no I/O, so it can move
   off the main thread or into a queue unchanged when portfolios get large.

---

*This tool is for research and education. It is not investment advice. Past
performance does not predict future results, and a backtest applies today's
choice of assets to yesterday's prices — a choice no investor could have made
at the time.*
