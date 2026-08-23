'use client';

import type { BacktestResult } from '@/lib/backtest';
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  formatSignedPercent,
} from '@/lib/format';
import { Stat, toneOf } from '@/components/ui/stat';

/** The headline row. Nine figures, each with its definition one tap away. */
export function KpiGrid({ result }: { result: BacktestResult }) {
  const { metrics, totals } = result;
  const { returns, risk, ratios, annualSummary } = metrics;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
      <Stat
        className="bg-card"
        size="lg"
        label="Final value"
        value={formatCurrency(totals.finalValue)}
        sub={`from ${formatCurrency(totals.netInvested)} invested`}
        hint="The account balance on the last day of the backtest: holdings marked to market plus any cash."
      />
      <Stat
        className="bg-card"
        size="lg"
        label="Total return"
        tone={toneOf(returns.totalReturn)}
        value={formatSignedPercent(returns.totalReturn, 1)}
        sub="time-weighted"
        hint="The compounded time-weighted return over the whole period. Money paid in or taken out is removed, so this measures the strategy rather than the size of your deposits."
      />
      <Stat
        className="bg-card"
        size="lg"
        label="CAGR"
        tone={toneOf(returns.cagr)}
        value={formatPercent(returns.cagr)}
        sub={`over ${returns.years.toFixed(1)} years`}
        hint="Compound annual growth rate — the constant yearly rate that turns the starting index into the ending one. Computed from the full daily path, not from the first and last price."
      />
      <Stat
        className="bg-card"
        size="lg"
        label="Max drawdown"
        tone={risk.maxDrawdown < 0 ? 'negative' : 'neutral'}
        value={formatPercent(risk.maxDrawdown, 1)}
        sub={
          metrics.drawdowns[0]
            ? `${formatDate(metrics.drawdowns[0].peakDate)} → ${formatDate(metrics.drawdowns[0].troughDate)}`
            : 'no drawdown'
        }
        hint="The largest peak-to-trough fall in the time-weighted index. Measured on the index rather than the balance, so a contribution cannot disguise a loss."
      />
      <Stat
        className="bg-card"
        size="lg"
        label="Volatility"
        value={formatPercent(risk.volatility)}
        sub="annualised"
        hint="Standard deviation of daily returns, annualised by the square root of the observed number of trading periods per year."
      />

      <Stat
        className="bg-card"
        label="Sharpe"
        tone={toneOf(ratios.sharpe)}
        value={formatNumber(ratios.sharpe)}
        sub="return per unit of risk"
        hint="Annualised excess return over the risk-free rate, divided by the volatility of that excess return. Higher is better; below zero means the portfolio underperformed cash."
      />
      <Stat
        className="bg-card"
        label="Sortino"
        tone={toneOf(ratios.sortino)}
        value={formatNumber(ratios.sortino)}
        sub="downside-adjusted"
        hint="Like Sharpe, but the denominator counts only downside deviation. It does not penalise a portfolio for rising sharply."
      />
      <Stat
        className="bg-card"
        label="Calmar"
        value={formatNumber(ratios.calmar)}
        sub="CAGR ÷ max drawdown"
        hint="Annual growth per unit of worst-case loss. A Calmar of 0.5 means the yearly return was half the size of the deepest fall."
      />
      <Stat
        className="bg-card"
        label="Best year"
        tone="positive"
        value={annualSummary.best ? formatSignedPercent(annualSummary.best.return, 1) : '—'}
        sub={annualSummary.best ? String(annualSummary.best.year) : undefined}
      />
      <Stat
        className="bg-card"
        label="Worst year"
        tone="negative"
        value={annualSummary.worst ? formatSignedPercent(annualSummary.worst.return, 1) : '—'}
        sub={annualSummary.worst ? String(annualSummary.worst.year) : undefined}
      />
    </div>
  );
}

/** Contributed capital versus market gain — only shown when money was added. */
export function CapitalBreakdown({ result }: { result: BacktestResult }) {
  const { totals } = result;
  if (totals.totalContributions <= 0 && totals.totalWithdrawals <= 0) return null;

  const contributedShare =
    totals.finalValue > 0 ? Math.max(0, Math.min(1, totals.netInvested / totals.finalValue)) : 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Where the balance came from</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Separating the money you paid in from what the market added to it.
      </p>

      <div
        className="mt-4 flex h-3 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${formatPercent(contributedShare)} contributed capital, ${formatPercent(
          1 - contributedShare,
        )} investment gain`}
      >
        <div
          className="bg-muted-foreground/45"
          style={{ width: `${contributedShare * 100}%` }}
        />
        <div
          className={totals.investmentGain >= 0 ? 'bg-[hsl(var(--positive))]' : 'bg-[hsl(var(--negative))]'}
          style={{ width: `${(1 - contributedShare) * 100}%` }}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Initial</dt>
          <dd className="numeric mt-0.5 text-sm font-medium">
            {formatCurrency(totals.initialInvestment)}
          </dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
            {totals.totalWithdrawals > 0 ? 'Net withdrawn' : 'Contributed'}
          </dt>
          <dd className="numeric mt-0.5 text-sm font-medium">
            {formatCurrency(
              totals.totalWithdrawals > 0 ? -totals.totalWithdrawals : totals.totalContributions,
            )}
          </dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Investment gain</dt>
          <dd
            className={`numeric mt-0.5 text-sm font-medium ${
              totals.investmentGain >= 0 ? 'text-positive' : 'text-negative'
            }`}
          >
            {formatCurrency(totals.investmentGain)}
          </dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Final value</dt>
          <dd className="numeric mt-0.5 text-sm font-semibold">
            {formatCurrency(totals.finalValue)}
          </dd>
        </div>
      </dl>

      {result.metrics.returns.moneyWeightedReturn != null && (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          Because the money arrived over time, the return you actually earned on it — the
          money-weighted return, or IRR — was{' '}
          <span className="numeric font-medium text-foreground">
            {formatPercent(result.metrics.returns.moneyWeightedReturn)}
          </span>{' '}
          a year, against a time-weighted{' '}
          <span className="numeric font-medium text-foreground">
            {formatPercent(result.metrics.returns.cagr)}
          </span>
          .
        </p>
      )}
    </div>
  );
}
