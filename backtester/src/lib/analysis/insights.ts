import type { PerformanceMetrics } from '@/lib/metrics';
import type { EngineResult, SymbolLedger } from '@/lib/engine/types';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';

export interface Insight {
  id: string;
  kind: 'performance' | 'risk' | 'attribution' | 'cost' | 'behaviour' | 'data';
  title: string;
  body: string;
  /** `positive`/`negative` only describe the observation, not a recommendation. */
  tone: 'neutral' | 'positive' | 'negative';
}

export interface InsightInput {
  result: EngineResult;
  metrics: PerformanceMetrics;
  benchmarks: Array<{ symbol: string; name: string; metrics: PerformanceMetrics }>;
}

/**
 * Deterministic, rule-based observations computed from the numbers the engine
 * already produced. Nothing here is generated text and nothing here is advice —
 * each sentence is a restatement of a figure shown elsewhere on the page, so
 * anything asserted can be checked against the tables.
 */
export function buildInsights({ result, metrics, benchmarks }: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { totals } = result;

  /* Growth of capital -------------------------------------------------- */
  if (totals.netInvested > 0) {
    const multiple = totals.finalValue / totals.netInvested;
    out.push({
      id: 'growth',
      kind: 'performance',
      tone: multiple >= 1 ? 'positive' : 'negative',
      title: 'Capital growth',
      body: `${formatCurrency(totals.netInvested)} of contributed capital ended at ${formatCurrency(
        totals.finalValue,
      )} — ${multiple.toFixed(2)}× the money put in, a ${formatSignedPercent(
        metrics.returns.totalReturn,
      )} time-weighted return over ${metrics.returns.years.toFixed(1)} years (${formatPercent(
        metrics.returns.cagr,
      )} a year).`,
    });
  }

  /* Contributions vs market gains -------------------------------------- */
  if (totals.totalContributions > 0) {
    const contributedShare = totals.netInvested / totals.finalValue;
    out.push({
      id: 'contribution-mix',
      kind: 'behaviour',
      tone: 'neutral',
      title: 'Contributions did much of the work',
      body: `${formatPercent(contributedShare)} of the final balance is money you put in; ${formatPercent(
        1 - contributedShare,
      )} is investment gain. Because ${formatCurrency(
        totals.totalContributions,
      )} arrived over time rather than up front, the money-weighted return ${
        metrics.returns.moneyWeightedReturn != null
          ? `(${formatPercent(metrics.returns.moneyWeightedReturn)}) is the better measure of what you actually earned`
          : 'differs from the time-weighted return shown above'
      }.`,
    });
  }

  /* Benchmark comparison ------------------------------------------------ */
  for (const bench of benchmarks.slice(0, 2)) {
    const dCagr = metrics.returns.cagr - bench.metrics.returns.cagr;
    const volRatio =
      bench.metrics.risk.volatility > 0
        ? metrics.risk.volatility / bench.metrics.risk.volatility
        : 0;
    out.push({
      id: `benchmark-${bench.symbol}`,
      kind: 'performance',
      tone: dCagr >= 0 ? 'positive' : 'negative',
      title: `Versus ${bench.symbol}`,
      body: `The portfolio ${dCagr >= 0 ? 'outperformed' : 'lagged'} ${bench.symbol} by ${formatPercent(
        Math.abs(dCagr),
      )} a year${
        volRatio > 0
          ? ` while running ${volRatio.toFixed(2)}× its volatility (${formatPercent(
              metrics.risk.volatility,
            )} vs ${formatPercent(bench.metrics.risk.volatility)})`
          : ''
      }. Worst drawdown was ${formatPercent(metrics.risk.maxDrawdown)} against ${formatPercent(
        bench.metrics.risk.maxDrawdown,
      )}.`,
    });
  }

  /* Attribution --------------------------------------------------------- */
  const contributors = result.ledgers
    .filter((l) => l.symbol !== 'CASH')
    .sort((a, b) => b.profitAndLoss - a.profitAndLoss);
  const top = contributors[0];
  const bottom = contributors[contributors.length - 1];

  if (top && totals.investmentGain > 0 && contributors.length > 1) {
    out.push({
      id: 'top-contributor',
      kind: 'attribution',
      tone: 'neutral',
      title: `${top.symbol} drove the result`,
      body: `${top.symbol} produced ${formatCurrency(top.profitAndLoss)} of the ${formatCurrency(
        totals.investmentGain,
      )} total gain — ${formatPercent(top.shareOfGain)} of it — from a ${formatPercent(
        top.targetWeight,
      )} target weight.`,
    });
  }
  if (bottom && bottom !== top && bottom.profitAndLoss < 0) {
    out.push({
      id: 'worst-contributor',
      kind: 'attribution',
      tone: 'negative',
      title: `${bottom.symbol} detracted`,
      body: `${bottom.symbol} lost ${formatCurrency(Math.abs(bottom.profitAndLoss))} over the period, offsetting ${formatPercent(
        totals.investmentGain > 0 ? Math.abs(bottom.profitAndLoss) / totals.investmentGain : 0,
      )} of the gains from everything else.`,
    });
  }

  /* Drift ---------------------------------------------------------------- */
  const drifted = result.ledgers
    .map((l) => ({ l, drift: l.endWeight - l.targetWeight }))
    .filter((x) => Math.abs(x.drift) > 0.05)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))[0];
  if (drifted) {
    out.push({
      id: 'drift',
      kind: 'attribution',
      tone: 'neutral',
      title: 'Allocation drift',
      body: `${drifted.l.symbol} finished at ${formatPercent(
        drifted.l.endWeight,
      )} against a ${formatPercent(drifted.l.targetWeight)} target — a ${formatSignedPercent(
        drifted.drift,
      )} drift. ${
        result.totals.rebalanceCount === 0
          ? 'With rebalancing off, the winners were left to compound and the portfolio became more concentrated than designed.'
          : `${result.totals.rebalanceCount} rebalances took place; drift accumulated between them.`
      }`,
    });
  }

  /* Risk ------------------------------------------------------------------ */
  const worst = metrics.drawdowns[0];
  if (worst) {
    out.push({
      id: 'max-drawdown',
      kind: 'risk',
      tone: 'negative',
      title: 'Deepest drawdown',
      body: `The worst peak-to-trough loss was ${formatPercent(worst.depth)}, from ${
        worst.peakDate
      } to ${worst.troughDate} (${worst.declineDays} days down)${
        worst.recovered
          ? `, recovered by ${worst.recoveryDate} — ${worst.recoveryDays} days back to break-even`
          : ', and it had not returned to its prior high by the end of the period'
      }. The portfolio spent ${formatPercent(metrics.risk.timeUnderwater)} of all trading days below a previous high.`,
    });
  }

  if (metrics.risk.skewness < -0.3 || metrics.risk.kurtosis > 3) {
    out.push({
      id: 'tail-risk',
      kind: 'risk',
      tone: 'negative',
      title: 'Fat left tail',
      body: `Daily returns are ${
        metrics.risk.skewness < -0.3 ? 'negatively skewed' : 'heavily peaked'
      } (skew ${metrics.risk.skewness.toFixed(2)}, excess kurtosis ${metrics.risk.kurtosis.toFixed(
        1,
      )}). The worst 5% of days averaged ${formatPercent(
        metrics.risk.cvar95,
      )}, which is worse than a normal distribution with the same volatility would imply — volatility alone understates the downside here.`,
    });
  }

  /* Costs ------------------------------------------------------------------ */
  const totalCost =
    totals.totalManagementFees + totals.totalExpenseRatioCost + totals.totalTradingCosts;
  if (totalCost > 0) {
    out.push({
      id: 'costs',
      kind: 'cost',
      tone: 'negative',
      title: 'What the costs took',
      body: `${formatCurrency(totalCost)} left the portfolio as costs: ${formatCurrency(
        totals.totalManagementFees,
      )} in management fees, ${formatCurrency(
        totals.totalExpenseRatioCost,
      )} in fund expense ratios and ${formatCurrency(
        totals.totalTradingCosts,
      )} in trading across ${totals.tradeCount} trades. That is ${formatPercent(
        totals.finalValue > 0 ? totalCost / (totals.finalValue + totalCost) : 0,
      )} of the terminal value before costs.`,
    });
  }

  /* Consistency ------------------------------------------------------------ */
  const { annualSummary, monthlySummary } = metrics;
  if (annualSummary.count >= 3 && annualSummary.best && annualSummary.worst) {
    out.push({
      id: 'consistency',
      kind: 'performance',
      tone: 'neutral',
      title: 'Year-to-year spread',
      body: `Best year ${formatSignedPercent(annualSummary.best.return)} (${
        annualSummary.best.year
      }), worst ${formatSignedPercent(annualSummary.worst.return)} (${
        annualSummary.worst.year
      }). ${formatPercent(annualSummary.positiveRate)} of ${
        annualSummary.count
      } calendar years were positive, and ${formatPercent(
        monthlySummary.positiveRate,
      )} of ${monthlySummary.count} months.`,
    });
  }

  /* Data caveats ------------------------------------------------------------ */
  const errors = result.warnings.filter((w) => w.severity === 'error');
  if (errors.length) {
    out.push({
      id: 'data-errors',
      kind: 'data',
      tone: 'negative',
      title: 'Data problems affected this run',
      body: `${errors.length} data error${errors.length === 1 ? '' : 's'} were detected: ${errors
        .map((e) => e.message)
        .join(' ')} Treat these results as unreliable until resolved.`,
    });
  }

  return out;
}

export function sortLedgersByContribution(ledgers: SymbolLedger[]): SymbolLedger[] {
  return [...ledgers].sort((a, b) => b.profitAndLoss - a.profitAndLoss);
}
