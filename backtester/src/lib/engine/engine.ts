import type { BacktestWarning } from '@/lib/types';
import { daysBetween } from '@/lib/market-data/dates';
import { contributionIndices, monthEndIndices, rebalanceIndices } from './schedule';
import { LotBook, summariseByYear, type LotSummary, type RealisedGain } from './lots';
import { legAmount, resolveCashflows } from './cashflows';
import type {
  DailyRecord,
  EngineInput,
  EngineResult,
  PreparedAsset,
  SymbolLedger,
  Transaction,
} from './types';

/**
 * Event-driven daily backtester.
 * =============================================================================
 *
 * The engine walks the master trading calendar one day at a time and maintains
 * an explicit ledger: share counts per holding plus a cash balance. Portfolio
 * value is always `Σ(shares × close) + cash` — it is never derived from a
 * return series, and never from first-price-to-last-price arithmetic.
 *
 * Order of operations within day *i* (all of it uses information available on
 * or before day *i*, so there is no look-ahead):
 *
 *   1. Accrue interest on the cash balance for the elapsed calendar days.
 *   2. Apply stock splits (no-op when the provider returns split-adjusted
 *      prices — see `PriceAdjustment`).
 *   3. Credit cash dividends with an ex-date of today, then either reinvest
 *      them at today's close or leave them in cash.
 *   4. Apply fund expense-ratio drag as a reduction in share count (NAV drag).
 *   5. Accrue the portfolio management fee; charge it in cash at month end.
 *   6. Settle any scheduled contribution or withdrawal.
 *   7. Liquidate holdings whose price history ends today.
 *   8. Rebalance if today is a rebalance date or a drift band was breached.
 *   9. Mark to market and record the day.
 *
 * Returns are time-weighted: `r = (V_today − externalFlow_today) / V_yesterday − 1`.
 * Contributions therefore never masquerade as investment performance, which is
 * the single most common way a naive backtest overstates a strategy.
 *
 * Attribution closes exactly. For every symbol,
 *   P&L = endingValue + salesProceeds + dividends − purchases − tradingCosts
 * and summing that across symbols, plus cash interest, minus the portfolio-level
 * management fee, equals `finalValue − netInvested`. `tests/engine.test.ts`
 * asserts the identity on a run with contributions, rebalancing, dividends,
 * expense ratios, commissions and a cash sleeve all active at once.
 */

const DUST = 0.005; // Trades below half a cent are noise; skip them.

interface Lot {
  shares: number;
  invested: number;
  divested: number;
  dividends: number;
  expenseRatioCost: number;
  tradingCost: number;
  startValue: number;
}

export function runEngine(input: EngineInput): EngineResult {
  const { portfolio, config, data } = input;
  const applyPortfolioFees = input.applyPortfolioFees ?? true;
  const { calendar, assets, periodsPerYear } = data;

  const warnings: BacktestWarning[] = [];
  const transactions: Transaction[] = [];
  const daily: DailyRecord[] = [];

  if (calendar.length < 2 || !assets.length) {
    return emptyResult(portfolio, config, data, warnings);
  }

  const n = calendar.length;
  const tradeable = assets.filter((a) => !a.isCash);
  const cashSleeveWeight = assets
    .filter((a) => a.isCash)
    .reduce((s, a) => s + a.targetWeight, 0);

  const declaredWeight =
    assets.reduce((s, a) => s + a.targetWeight, 0) || 1;

  /** Target weights as fractions summing to 1 across everything declared. */
  const normWeight = new Map<string, number>();
  for (const a of assets) normWeight.set(a.symbol, a.targetWeight / declaredWeight);
  const normCashSleeve = cashSleeveWeight / declaredWeight;

  const shares = new Map<string, number>(tradeable.map((a) => [a.symbol, 0]));
  const lots = new Map<string, Lot>(
    tradeable.map((a) => [
      a.symbol,
      {
        shares: 0,
        invested: 0,
        divested: 0,
        dividends: 0,
        expenseRatioCost: 0,
        tradingCost: 0,
        startValue: 0,
      },
    ]),
  );
  const liquidated = new Set<string>();
  const books = new Map<string, LotBook>(
    tradeable.map((a) => [a.symbol, new LotBook(a.symbol, config.costBasisMethod)]),
  );
  const realisedGains: RealisedGain[] = [];
  const dividendsByYear = new Map<number, number>();

  let cash = 0;
  let accruedManagementFee = 0;
  /** True once the account has held value, so a zero start is not a "reset". */
  let hasBeenFunded = false;

  let totalContributions = 0;
  let totalWithdrawals = 0;
  let totalDividends = 0;
  let totalManagementFees = 0;
  let totalExpenseRatioCost = 0;
  let totalTradingCosts = 0;
  let totalCashInterest = 0;
  let rebalanceCount = 0;
  let tradeCount = 0;

  const rebalanceOn = rebalanceIndices(calendar, config.rebalance);
  const contributeOn = contributionIndices(calendar, config.contributionFrequency);
  const monthEnds = monthEndIndices(calendar);

  const bps = config.fees.tradingCostBps / 10_000;
  const commission = config.fees.commissionPerTrade;
  const mgmtRate = applyPortfolioFees ? config.fees.managementFeePct / 100 : 0;
  const cashRate = config.cashYieldPct / 100;
  const baseContribution =
    (config.contributionIsWithdrawal ? -1 : 1) * Math.abs(config.contributionAmount);
  const deflator = data.deflator?.length === calendar.length ? data.deflator : null;
  const growContributions = config.inflation.adjustContributions && deflator != null;

  /**
   * The scheduled flow on day `i`. With inflation adjustment on, the nominal
   * amount grows with the price level so its purchasing power stays constant —
   * which is what someone means by "I save $500 a month".
   */
  const contributionAt = (i: number): number =>
    growContributions ? baseContribution * deflator![i] : baseContribution;

  // Extra legs run alongside the simple contribution rather than replacing it,
  // so an existing config behaves identically and a plan with several streams
  // is expressed as several legs.
  const legSchedule = resolveCashflows(calendar, config.cashflows ?? []);

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const priceAt = (a: PreparedAsset, i: number): number => a.prices[i];

  const isActive = (a: PreparedAsset, i: number): boolean =>
    !liquidated.has(a.symbol) &&
    i >= a.firstIndex &&
    i <= a.lastIndex &&
    Number.isFinite(a.prices[i]) &&
    a.prices[i] > 0;

  const positionValue = (a: PreparedAsset, i: number): number => {
    const q = shares.get(a.symbol) ?? 0;
    if (q === 0) return 0;
    const p = priceAt(a, i);
    return Number.isFinite(p) ? q * p : 0;
  };

  const totalValueAt = (i: number): number =>
    cash + tradeable.reduce((sum, a) => sum + positionValue(a, i), 0);

  /** Executes a share delta, charges costs and updates the ledger. */
  function execute(a: PreparedAsset, i: number, deltaShares: number, tag: 'buy' | 'sell' | 'reinvest' | 'liquidation'): number {
    const price = priceAt(a, i);
    if (!Number.isFinite(price) || price <= 0) return 0;
    const notional = deltaShares * price;
    if (Math.abs(notional) < DUST) return 0;

    // Dividend reinvestment is modelled as a DRIP: no commission, no spread.
    const cost = tag === 'reinvest' ? 0 : Math.abs(notional) * bps + commission;

    const lot = lots.get(a.symbol)!;
    shares.set(a.symbol, (shares.get(a.symbol) ?? 0) + deltaShares);

    if (deltaShares > 0) {
      cash -= notional + cost;
      lot.invested += notional;
    } else {
      cash += -notional - cost;
      lot.divested += -notional;
    }
    lot.tradingCost += cost;
    totalTradingCosts += cost;
    tradeCount++;

    // Basis capitalises purchase costs and nets sale costs out of proceeds,
    // which is both the tax treatment and what makes the realised/unrealised
    // split reconcile with the position's profit and loss.
    const book = books.get(a.symbol)!;
    if (deltaShares > 0) {
      book.buy(calendar[i], deltaShares, price, cost);
    } else {
      const realised = book.sell(calendar[i], -deltaShares, price, cost);
      if (realised) realisedGains.push(realised);
    }

    transactions.push({
      date: calendar[i],
      type:
        tag === 'reinvest'
          ? 'reinvest'
          : tag === 'liquidation'
            ? 'liquidation'
            : deltaShares > 0
              ? 'buy'
              : 'sell',
      symbol: a.symbol,
      shares: deltaShares,
      price,
      amount: -notional - cost,
      note: cost > 0 ? `cost ${cost.toFixed(2)}` : undefined,
    });
    return cost;
  }

  /** Sells pro-rata across live positions to raise `amount` of cash. */
  function raiseCash(i: number, amount: number): void {
    if (amount <= DUST) return;
    const live = tradeable.filter((a) => isActive(a, i) && (shares.get(a.symbol) ?? 0) > 0);
    const investedValue = live.reduce((s, a) => s + positionValue(a, i), 0);
    if (investedValue <= 0) return;
    // Gross up so that the *net* proceeds after cost cover the requirement.
    const gross = Math.min(investedValue, (amount + commission * live.length) / (1 - bps));
    for (const a of live) {
      const share = positionValue(a, i) / investedValue;
      const sellValue = gross * share;
      execute(a, i, -sellValue / priceAt(a, i), 'sell');
    }
  }

  /**
   * Moves the book to target weights. Inactive assets (not yet listed, or
   * delisted) keep their weight in cash rather than having it redistributed,
   * so the portfolio's risk profile is not silently changed.
   */
  function tradeToTargets(i: number, reason: 'initial' | 'rebalance' | 'deploy'): void {
    const total = totalValueAt(i);
    if (total <= 0) return;

    const active = tradeable.filter((a) => isActive(a, i));
    const targets = new Map<string, number>();
    for (const a of active) targets.set(a.symbol, total * (normWeight.get(a.symbol) ?? 0));

    // Sell side first so the proceeds fund the buy side.
    for (const a of active) {
      const current = positionValue(a, i);
      const target = targets.get(a.symbol)!;
      const delta = target - current;
      if (delta < -DUST) execute(a, i, delta / priceAt(a, i), 'sell');
    }

    const buys = active
      .map((a) => ({ a, delta: targets.get(a.symbol)! - positionValue(a, i) }))
      .filter((x) => x.delta > DUST);

    if (buys.length) {
      const notional = buys.reduce((s, b) => s + b.delta, 0);
      const estimatedCost = notional * bps + commission * buys.length;
      // Never let a rebalance overdraw the account.
      const available = Math.max(0, cash);
      const scale = notional + estimatedCost > available
        ? Math.max(0, (available - commission * buys.length) / (notional * (1 + bps)))
        : 1;
      for (const b of buys) {
        const amount = b.delta * scale;
        if (amount > DUST) execute(b.a, i, amount / priceAt(b.a, i), 'buy');
      }
    }

    if (reason === 'rebalance') rebalanceCount++;
  }

  /** Invests new cash at target weights without touching existing positions. */
  function deployCash(i: number, amount: number): void {
    if (amount <= DUST) return;
    const active = tradeable.filter((a) => isActive(a, i));
    const investable = active.reduce((s, a) => s + (normWeight.get(a.symbol) ?? 0), 0);
    if (investable <= 0) return; // Everything is in the cash sleeve.
    const deployable = amount * investable; // The cash-sleeve share stays in cash.
    const budget = Math.max(0, (deployable - commission * active.length) / (1 + bps));
    for (const a of active) {
      const slice = budget * ((normWeight.get(a.symbol) ?? 0) / investable);
      if (slice > DUST) execute(a, i, slice / priceAt(a, i), 'buy');
    }
  }

  function driftBreached(i: number): boolean {
    const total = totalValueAt(i);
    if (total <= 0) return false;
    const band = config.rebalanceThresholdPct / 100;
    for (const a of tradeable) {
      if (!isActive(a, i)) continue;
      const target = normWeight.get(a.symbol) ?? 0;
      const actual = positionValue(a, i) / total;
      if (Math.abs(actual - target) > band) return true;
    }
    if (normCashSleeve > 0 && Math.abs(cash / total - normCashSleeve) > band) return true;
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Day 0 — seed the account                                         */
  /* ---------------------------------------------------------------- */

  cash = config.initialInvestment;
  if (config.initialInvestment !== 0) {
    transactions.push({
      date: calendar[0],
      type: 'contribution',
      amount: config.initialInvestment,
      note: 'Initial investment',
    });
  }

  // A leg with no offset fires on day one. The main loop starts at day two, so
  // that occurrence is settled here — otherwise a twelve-month leg would only
  // ever deposit eleven times.
  let day0Flow = 0;
  for (const { leg, growth } of legSchedule.byIndex.get(0) ?? []) {
    day0Flow += legAmount(leg, growth, deflator?.[0] ?? 1, cash);
  }
  if (day0Flow > 0) {
    cash += day0Flow;
    totalContributions += day0Flow;
    transactions.push({ date: calendar[0], type: 'contribution', amount: day0Flow });
  } else if (day0Flow < 0) {
    const taken = Math.min(-day0Flow, Math.max(0, cash));
    cash -= taken;
    totalWithdrawals += taken;
    transactions.push({ date: calendar[0], type: 'withdrawal', amount: -taken });
    day0Flow = -taken;
  }

  tradeToTargets(0, 'initial');

  for (const a of tradeable) lots.get(a.symbol)!.startValue = positionValue(a, 0);

  const v0 = totalValueAt(0);
  const seeded = config.initialInvestment + day0Flow;
  const index0 = seeded > 0 ? v0 / seeded : 1;
  hasBeenFunded = v0 > 0;

  daily.push({
    date: calendar[0],
    totalValue: v0,
    cash,
    positionValues: snapshotValues(tradeable, shares, 0),
    positionShares: snapshotShares(tradeable, shares),
    netFlow: config.initialInvestment + day0Flow,
    dividendIncome: 0,
    feesPaid: totalTradingCosts,
    tradingCost: totalTradingCosts,
    twrReturn: index0 - 1,
    index: index0,
    hasStalePrice: tradeable.some((a) => a.stale[0]),
    rebalanced: false,
  });

  /* ---------------------------------------------------------------- */
  /* Main loop                                                        */
  /* ---------------------------------------------------------------- */

  for (let i = 1; i < n; i++) {
    const prevValue = daily[i - 1].totalValue;
    const elapsedDays = Math.max(1, daysBetween(calendar[i - 1], calendar[i]));
    const yearFrac = elapsedDays / 365;

    let netFlow = 0;
    let dividendIncome = 0;
    let feesToday = 0;
    const tradingCostBefore = totalTradingCosts;

    /* 1. Cash interest ------------------------------------------------ */
    if (cashRate !== 0 && cash > 0) {
      const interest = cash * cashRate * yearFrac;
      cash += interest;
      totalCashInterest += interest;
      if (interest > DUST) {
        transactions.push({
          date: calendar[i],
          type: 'cash-interest',
          amount: interest,
        });
      }
    }

    /* 2. Splits -------------------------------------------------------- */
    for (const a of tradeable) {
      const factor = a.splitFactors[i];
      if (factor !== 1) {
        const q = shares.get(a.symbol) ?? 0;
        if (q !== 0) shares.set(a.symbol, q * factor);
        books.get(a.symbol)!.applySplit(factor);
      }
    }

    /* 3. Dividends ------------------------------------------------------ */
    for (const a of tradeable) {
      const perShare = a.dividends[i];
      if (!perShare) continue;
      const q = shares.get(a.symbol) ?? 0;
      if (q <= 0) continue;
      const gross = q * perShare;
      cash += gross;
      dividendIncome += gross;
      totalDividends += gross;
      lots.get(a.symbol)!.dividends += gross;
      const year = Number(calendar[i].slice(0, 4));
      dividendsByYear.set(year, (dividendsByYear.get(year) ?? 0) + gross);
      transactions.push({
        date: calendar[i],
        type: 'dividend',
        symbol: a.symbol,
        amount: gross,
        note: `${perShare.toFixed(4)}/share`,
      });
      if (config.dividends === 'reinvest' && isActive(a, i)) {
        execute(a, i, gross / priceAt(a, i), 'reinvest');
      }
    }

    /* 4. Fund expense-ratio drag ---------------------------------------- */
    for (const a of tradeable) {
      const rate = a.expenseRatioPct / 100;
      if (rate <= 0) continue;
      const q = shares.get(a.symbol) ?? 0;
      if (q <= 0 || !isActive(a, i)) continue;
      const before = q * priceAt(a, i);
      const drag = before * rate * yearFrac;
      const retained = 1 - rate * yearFrac;
      shares.set(a.symbol, q * retained);
      books.get(a.symbol)!.applyDrag(retained);
      lots.get(a.symbol)!.expenseRatioCost += drag;
      totalExpenseRatioCost += drag;
      feesToday += drag;
    }

    /* 5. Management fee -------------------------------------------------- */
    if (mgmtRate > 0) {
      accruedManagementFee += totalValueAt(i) * mgmtRate * yearFrac;
      if (monthEnds.has(i) || i === n - 1) {
        const due = accruedManagementFee;
        if (due > DUST) {
          if (cash < due) raiseCash(i, due - cash);
          cash -= due;
          totalManagementFees += due;
          feesToday += due;
          transactions.push({
            date: calendar[i],
            type: 'management-fee',
            amount: -due,
          });
        }
        accruedManagementFee = 0;
      }
    }

    /* 6. Contributions and withdrawals ----------------------------------- */
    let contributedToday = 0;

    // The simple contribution and every leg firing today are summed into one
    // net flow, so a contribution and a withdrawal on the same date net off
    // instead of generating two round trips through the market.
    let scheduledFlow = contributeOn.has(i) ? contributionAt(i) : 0;
    const legsToday = legSchedule.byIndex.get(i);
    if (legsToday?.length) {
      const valueNow = totalValueAt(i);
      for (const { leg, growth } of legsToday) {
        scheduledFlow += legAmount(leg, growth, deflator?.[i] ?? 1, valueNow);
      }
    }

    if (scheduledFlow !== 0) {
      if (scheduledFlow > 0) {
        cash += scheduledFlow;
        contributedToday = scheduledFlow;
        netFlow += scheduledFlow;
        totalContributions += scheduledFlow;
        transactions.push({
          date: calendar[i],
          type: 'contribution',
          amount: scheduledFlow,
        });
      } else {
        const want = -scheduledFlow;
        const available = totalValueAt(i);
        const taken = Math.min(want, Math.max(0, available));
        if (taken < want) {
          warnings.push({
            severity: 'warning',
            code: 'withdrawal-shortfall',
            message: `The scheduled withdrawal on ${calendar[i]} exceeded the portfolio value. Only ${taken.toFixed(2)} could be withdrawn and the account was depleted.`,
          });
        }
        if (cash < taken) raiseCash(i, taken - cash);
        const actual = Math.min(taken, Math.max(0, cash));
        cash -= actual;
        netFlow -= actual;
        totalWithdrawals += actual;
        transactions.push({
          date: calendar[i],
          type: 'withdrawal',
          amount: -actual,
        });
      }
    }

    /* 7. Liquidate securities whose history ends today -------------------- */
    for (const a of tradeable) {
      if (liquidated.has(a.symbol)) continue;
      const isLastBar = i === a.lastIndex && i < n - 1;
      if (!isLastBar) continue;
      const q = shares.get(a.symbol) ?? 0;
      if (q > 0) {
        execute(a, i, -q, 'liquidation');
        warnings.push({
          severity: 'warning',
          code: 'position-liquidated',
          symbol: a.symbol,
          message: `${a.symbol} stopped trading on ${calendar[i]}; the position was sold at its final close and the proceeds held as cash.`,
        });
      }
      liquidated.add(a.symbol);
    }

    /* 8. Rebalance / deploy ------------------------------------------------ */
    const scheduledRebalance =
      rebalanceOn.has(i) ||
      (config.rebalance === 'threshold' && driftBreached(i));

    let rebalancedToday = false;
    if (scheduledRebalance) {
      tradeToTargets(i, 'rebalance');
      rebalancedToday = true;
    } else if (contributedToday > 0) {
      deployCash(i, contributedToday);
    }

    /* 9. Mark to market ---------------------------------------------------- */
    const totalValue = totalValueAt(i);
    const tradingCostToday = totalTradingCosts - tradingCostBefore;
    feesToday += tradingCostToday;

    const twrReturn =
      prevValue > 0 ? (totalValue - netFlow) / prevValue - 1 : 0;
    // An account that was funded and then depleted is worth flagging. One that
    // simply started empty — a contribution-only backtest — is not.
    if (prevValue <= 0 && totalValue > 0 && hasBeenFunded) {
      warnings.push({
        severity: 'info',
        code: 'value-reset',
        message: `Portfolio value reached zero before ${calendar[i]}; time-weighted returns restart from that point.`,
      });
    }
    if (totalValue > 0) hasBeenFunded = true;

    daily.push({
      date: calendar[i],
      totalValue,
      cash,
      positionValues: snapshotValues(tradeable, shares, i),
      positionShares: snapshotShares(tradeable, shares),
      netFlow,
      dividendIncome,
      feesPaid: feesToday,
      tradingCost: tradingCostToday,
      twrReturn,
      index: daily[i - 1].index * (1 + twrReturn),
      hasStalePrice: tradeable.some((a) => isActive(a, i) && a.stale[i]),
      rebalanced: rebalancedToday,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Ledgers and totals                                               */
  /* ---------------------------------------------------------------- */

  const last = n - 1;
  const finalValue = daily[last].totalValue;
  const netInvested =
    config.initialInvestment + totalContributions - totalWithdrawals;
  const investmentGain = finalValue - netInvested;
  const startTotal = daily[0].totalValue || 1;

  const lotSummaries: LotSummary[] = [];

  const ledgers: SymbolLedger[] = tradeable.map((a) => {
    const lot = lots.get(a.symbol)!;
    const endingShares = shares.get(a.symbol) ?? 0;
    const endingValue = positionValue(a, last);

    const book = books.get(a.symbol)!;
    const symbolGains = realisedGains.filter((g) => g.symbol === a.symbol);
    lotSummaries.push({
      symbol: a.symbol,
      openShares: book.shares,
      openCostBasis: book.costBasis,
      unrealisedGain: endingValue - book.costBasis,
      realisedGain: symbolGains.reduce((x, g) => x + g.gain, 0),
      realisedShortTerm: symbolGains
        .filter((g) => g.longTerm === false)
        .reduce((x, g) => x + g.gain, 0),
      realisedLongTerm: symbolGains
        .filter((g) => g.longTerm === true)
        .reduce((x, g) => x + g.gain, 0),
      dividends: lot.dividends,
    });
    // Cash out (ending value + sale proceeds + dividends) minus cash in
    // (purchases) minus the trading costs this position incurred. Fund
    // expense-ratio drag is already reflected in `endingValue`.
    const pnl =
      endingValue + lot.divested + lot.dividends - lot.invested - lot.tradingCost;
    return {
      symbol: a.symbol,
      name: a.name,
      invested: lot.invested,
      divested: lot.divested,
      dividends: lot.dividends,
      expenseRatioCost: lot.expenseRatioCost,
      tradingCost: lot.tradingCost,
      endingShares,
      endingValue,
      profitAndLoss: pnl,
      shareOfGain: investmentGain !== 0 ? pnl / investmentGain : 0,
      startWeight: lot.startValue / startTotal,
      endWeight: finalValue > 0 ? endingValue / finalValue : 0,
      targetWeight: normWeight.get(a.symbol) ?? 0,
    };
  });

  if (cashSleeveWeight > 0 || Math.abs(daily[last].cash) > 1) {
    ledgers.push({
      symbol: 'CASH',
      name: 'Cash',
      invested: 0,
      divested: 0,
      dividends: totalCashInterest,
      expenseRatioCost: 0,
      tradingCost: 0,
      endingShares: daily[last].cash,
      endingValue: daily[last].cash,
      profitAndLoss: totalCashInterest,
      shareOfGain: investmentGain !== 0 ? totalCashInterest / investmentGain : 0,
      startWeight: daily[0].cash / startTotal,
      endWeight: finalValue > 0 ? daily[last].cash / finalValue : 0,
      targetWeight: normCashSleeve,
    });
  }

  return {
    portfolioId: portfolio.id,
    portfolioName: portfolio.name,
    start: calendar[0],
    end: calendar[last],
    daily,
    transactions,
    ledgers,
    warnings: [...data.warnings, ...warnings],
    totals: {
      initialInvestment: config.initialInvestment,
      totalContributions,
      totalWithdrawals,
      netInvested,
      finalValue,
      investmentGain,
      totalDividends,
      totalManagementFees,
      totalExpenseRatioCost,
      totalTradingCosts,
      totalCashInterest,
      rebalanceCount,
      tradeCount,
      totalRealisedGain: realisedGains.reduce((s2, g) => s2 + g.gain, 0),
      totalUnrealisedGain: lotSummaries.reduce((s2, l) => s2 + l.unrealisedGain, 0),
    },
    lots: lotSummaries,
    realisedGains,
    realisedByYear: summariseByYear(realisedGains, dividendsByYear),
    periodsPerYear,
  };
}

function snapshotValues(
  assets: PreparedAsset[],
  shares: Map<string, number>,
  i: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of assets) {
    const q = shares.get(a.symbol) ?? 0;
    const p = a.prices[i];
    out[a.symbol] = q !== 0 && Number.isFinite(p) ? q * p : 0;
  }
  return out;
}

function snapshotShares(
  assets: PreparedAsset[],
  shares: Map<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of assets) out[a.symbol] = shares.get(a.symbol) ?? 0;
  return out;
}

function emptyResult(
  portfolio: EngineInput['portfolio'],
  config: EngineInput['config'],
  data: EngineInput['data'],
  warnings: BacktestWarning[],
): EngineResult {
  return {
    portfolioId: portfolio.id,
    portfolioName: portfolio.name,
    start: config.start,
    end: config.end,
    daily: [],
    transactions: [],
    ledgers: [],
    warnings: [...data.warnings, ...warnings],
    totals: {
      initialInvestment: config.initialInvestment,
      totalContributions: 0,
      totalWithdrawals: 0,
      netInvested: config.initialInvestment,
      finalValue: 0,
      investmentGain: 0,
      totalDividends: 0,
      totalManagementFees: 0,
      totalExpenseRatioCost: 0,
      totalTradingCosts: 0,
      totalCashInterest: 0,
      rebalanceCount: 0,
      tradeCount: 0,
      totalRealisedGain: 0,
      totalUnrealisedGain: 0,
    },
    lots: [],
    realisedGains: [],
    realisedByYear: [],
    periodsPerYear: data.periodsPerYear || 252,
  };
}
