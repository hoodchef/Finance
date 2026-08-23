'use client';

import * as React from 'react';
import type { BacktestResult } from '@/lib/backtest';
import {
  formatCurrency,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatShares,
  formatSignedPercent,
} from '@/lib/format';
import {
  NumCell,
  NumHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { TrendingDown } from 'lucide-react';
import { seriesColor } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Drawdowns                                                          */
/* ------------------------------------------------------------------ */

export function DrawdownTable({ result }: { result: BacktestResult }) {
  const episodes = result.metrics.drawdowns.slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Largest drawdowns
          <InfoTip label="About drawdowns">
            A drawdown runs from a high-water mark down to the trough and back. Recovery is the
            first day the index closes at or above the old peak. An unrecovered drawdown was still
            open on the last day of the backtest.
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {episodes.length === 0 ? (
          <EmptyState
            icon={TrendingDown}
            title="No drawdown over 1%"
            description="The portfolio never fell more than one percent below a prior high in this window."
            className="mx-4 mb-4 border-0 py-8"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <NumHead className="text-left">#</NumHead>
                <NumHead>Depth</NumHead>
                <TableHead>Peak</TableHead>
                <TableHead>Trough</TableHead>
                <TableHead>Recovered</TableHead>
                <NumHead>Decline</NumHead>
                <NumHead>Recovery</NumHead>
                <NumHead>Total</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {episodes.map((d, i) => (
                <TableRow key={`${d.peakDate}-${d.troughDate}`}>
                  <NumCell className="text-left text-muted-foreground">{i + 1}</NumCell>
                  <NumCell className="font-medium text-negative">
                    {formatPercent(d.depth, 1)}
                  </NumCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDate(d.peakDate)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDate(d.troughDate)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {d.recovered ? (
                      formatDate(d.recoveryDate!)
                    ) : (
                      <Badge variant="warning">Still underwater</Badge>
                    )}
                  </TableCell>
                  <NumCell className="text-muted-foreground">
                    {formatDuration(d.declineDays)}
                  </NumCell>
                  <NumCell className="text-muted-foreground">
                    {d.recoveryDays == null ? '—' : formatDuration(d.recoveryDays)}
                  </NumCell>
                  <NumCell>{formatDuration(d.totalDays)}</NumCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Risk statistics                                                     */
/* ------------------------------------------------------------------ */

interface MetricRow {
  label: string;
  value: string;
  hint?: string;
}

export function RiskTable({ result }: { result: BacktestResult }) {
  const { risk, ratios, returns, periodsPerYear, averageRiskFree } = result.metrics;
  const primary = result.benchmarks[0];

  const groups: Array<{ title: string; rows: MetricRow[] }> = [
    {
      title: 'Return',
      rows: [
        { label: 'Total return', value: formatSignedPercent(returns.totalReturn) },
        { label: 'CAGR', value: formatPercent(returns.cagr) },
        {
          label: 'Arithmetic annual return',
          value: formatPercent(returns.arithmeticAnnualReturn),
          hint: 'Mean daily return scaled by the number of periods in a year. Always at least as large as CAGR; the gap widens with volatility.',
        },
        {
          label: 'Money-weighted return',
          value:
            returns.moneyWeightedReturn == null
              ? '—'
              : formatPercent(returns.moneyWeightedReturn),
          hint: 'The internal rate of return on your actual cash flows. It differs from CAGR whenever money went in or out during the period.',
        },
        { label: 'Period', value: `${returns.years.toFixed(2)} years` },
      ],
    },
    {
      title: 'Risk',
      rows: [
        { label: 'Volatility (annualised)', value: formatPercent(risk.volatility) },
        {
          label: 'Downside deviation',
          value: formatPercent(risk.downsideDeviation),
          hint: 'Volatility computed only from returns below the minimum acceptable return, using all periods in the denominator.',
        },
        { label: 'Maximum drawdown', value: formatPercent(risk.maxDrawdown) },
        { label: 'Average drawdown', value: formatPercent(risk.averageDrawdown) },
        {
          label: 'Longest drawdown',
          value: formatDuration(risk.longestDrawdownDays),
          hint: 'Peak to full recovery, in calendar days.',
        },
        {
          label: 'Time underwater',
          value: formatPercent(risk.timeUnderwater, 1),
          hint: 'Share of trading days spent below a previous high-water mark.',
        },
        {
          label: 'Daily VaR (95%)',
          value: formatPercent(risk.var95),
          hint: 'On the worst 5% of days historically, the loss was at least this large. This is the empirical quantile of realised returns, not a modelled one.',
        },
        { label: 'Daily VaR (99%)', value: formatPercent(risk.var99) },
        {
          label: 'Expected shortfall (95%)',
          value: formatPercent(risk.cvar95),
          hint: 'Average return across the worst 5% of days — what the tail actually cost, rather than just where it starts.',
        },
        { label: 'Positive days', value: formatPercent(risk.positiveDayRate, 1) },
        {
          label: 'Skewness',
          value: formatNumber(risk.skewness),
          hint: 'Negative means the large moves are more often down than up.',
        },
        {
          label: 'Excess kurtosis',
          value: formatNumber(risk.kurtosis, 1),
          hint: 'Above zero means fatter tails than a normal distribution — extreme days happen more often than volatility alone suggests.',
        },
      ],
    },
    {
      title: 'Risk-adjusted',
      rows: [
        { label: 'Sharpe ratio', value: formatNumber(ratios.sharpe) },
        { label: 'Sortino ratio', value: formatNumber(ratios.sortino) },
        { label: 'Calmar ratio', value: formatNumber(ratios.calmar) },
        {
          label: 'Average risk-free rate',
          value: formatPercent(averageRiskFree),
          hint: 'The mean annual risk-free rate used across the period, from the source chosen in the settings panel.',
        },
      ],
    },
  ];

  if (primary && ratios.beta != null) {
    groups.push({
      title: `Relative to ${primary.symbol}`,
      rows: [
        {
          label: 'Beta',
          value: formatNumber(ratios.beta),
          hint: 'Sensitivity to the benchmark. A beta of 1.3 means the portfolio moved 30% more than the benchmark, on average.',
        },
        {
          label: 'Alpha (annualised)',
          value: formatSignedPercent(ratios.alpha ?? 0),
          hint: 'Return beyond what the benchmark exposure alone would explain.',
        },
        { label: 'Treynor ratio', value: formatNumber(ratios.treynor ?? Number.NaN) },
        { label: 'Correlation', value: formatNumber(ratios.correlation ?? 0) },
        { label: 'R²', value: formatNumber(ratios.rSquared ?? 0) },
        {
          label: 'Tracking error',
          value: formatPercent(ratios.trackingError ?? 0),
          hint: 'Volatility of the difference between portfolio and benchmark returns.',
        },
        {
          label: 'Information ratio',
          value: formatNumber(ratios.informationRatio ?? 0),
          hint: 'Excess return over the benchmark per unit of tracking error.',
        },
        {
          label: 'Upside capture',
          value: ratios.upCapture == null ? '—' : formatPercent(ratios.upCapture, 0),
          hint: 'Share of the benchmark’s average gain captured on days the benchmark rose.',
        },
        {
          label: 'Downside capture',
          value: ratios.downCapture == null ? '—' : formatPercent(ratios.downCapture, 0),
          hint: 'Share of the benchmark’s average loss taken on days the benchmark fell. Lower is better.',
        },
      ],
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Risk and return statistics</CardTitle>
        <p className="text-xs text-muted-foreground">
          Annualised using {periodsPerYear.toFixed(0)} trading periods per year, measured from the
          data rather than assumed.
        </p>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.title}>
            <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.title}
            </h3>
            <dl className="divide-y divide-border">
              {g.rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-3 py-1.5">
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {r.label}
                    {r.hint && <InfoTip label={`About ${r.label}`}>{r.hint}</InfoTip>}
                  </dt>
                  <dd className="numeric text-xs font-medium">{r.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Benchmark comparison                                                */
/* ------------------------------------------------------------------ */

export function BenchmarkTable({ result }: { result: BacktestResult }) {
  if (!result.benchmarks.length) return null;

  const columns = [
    { key: 'portfolio', label: result.portfolio.name || 'Portfolio', metrics: result.metrics, final: result.totals.finalValue },
    ...result.benchmarks.map((b) => ({
      key: b.symbol,
      label: b.symbol,
      metrics: b.metrics,
      final: b.finalValue,
    })),
  ];

  const rows: Array<{ label: string; render: (c: (typeof columns)[number]) => string; better?: 'high' | 'low' }> = [
    { label: 'Final value', render: (c) => formatCurrency(c.final), better: 'high' },
    { label: 'Total return', render: (c) => formatSignedPercent(c.metrics.returns.totalReturn, 1), better: 'high' },
    { label: 'CAGR', render: (c) => formatPercent(c.metrics.returns.cagr), better: 'high' },
    { label: 'Volatility', render: (c) => formatPercent(c.metrics.risk.volatility), better: 'low' },
    { label: 'Max drawdown', render: (c) => formatPercent(c.metrics.risk.maxDrawdown, 1), better: 'high' },
    { label: 'Sharpe', render: (c) => formatNumber(c.metrics.ratios.sharpe), better: 'high' },
    { label: 'Sortino', render: (c) => formatNumber(c.metrics.ratios.sortino), better: 'high' },
    { label: 'Calmar', render: (c) => formatNumber(c.metrics.ratios.calmar), better: 'high' },
    { label: 'Best year', render: (c) => (c.metrics.annualSummary.best ? formatSignedPercent(c.metrics.annualSummary.best.return, 1) : '—') },
    { label: 'Worst year', render: (c) => (c.metrics.annualSummary.worst ? formatSignedPercent(c.metrics.annualSummary.worst.return, 1) : '—') },
  ];

  const numericFor = (label: string, c: (typeof columns)[number]): number => {
    switch (label) {
      case 'Final value': return c.final;
      case 'Total return': return c.metrics.returns.totalReturn;
      case 'CAGR': return c.metrics.returns.cagr;
      case 'Volatility': return c.metrics.risk.volatility;
      case 'Max drawdown': return c.metrics.risk.maxDrawdown;
      case 'Sharpe': return c.metrics.ratios.sharpe;
      case 'Sortino': return c.metrics.ratios.sortino;
      case 'Calmar': return c.metrics.ratios.calmar;
      default: return Number.NaN;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Against benchmarks</CardTitle>
        <p className="text-xs text-muted-foreground">
          Each benchmark runs through the same engine, same dates and same contribution schedule,
          with dividends reinvested and no fees.
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-card">Metric</TableHead>
              {columns.map((c, i) => (
                <NumHead key={c.key}>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-sm"
                      style={{
                        backgroundColor: i === 0 ? 'hsl(var(--primary))' : seriesColor(c.key, i),
                      }}
                    />
                    {c.label}
                  </span>
                </NumHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const values = columns.map((c) => numericFor(r.label, c));
              const valid = values.filter((v) => Number.isFinite(v));
              const best =
                r.better && valid.length > 1
                  ? r.better === 'high'
                    ? Math.max(...valid)
                    : Math.min(...valid)
                  : null;
              return (
                <TableRow key={r.label}>
                  <TableCell className="sticky left-0 whitespace-nowrap bg-card text-xs text-muted-foreground">
                    {r.label}
                  </TableCell>
                  {columns.map((c, i) => {
                    const isBest = best != null && Math.abs(values[i] - best) < 1e-12;
                    return (
                      <NumCell
                        key={c.key}
                        className={isBest ? 'font-semibold text-foreground' : undefined}
                      >
                        {r.render(c)}
                      </NumCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Holdings                                                            */
/* ------------------------------------------------------------------ */

export function HoldingsTable({
  result,
  onSelect,
}: {
  result: BacktestResult;
  onSelect?: (symbol: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Holdings</CardTitle>
        <p className="text-xs text-muted-foreground">
          Profit and loss per position is the exact dollar contribution to the result, after that
          position&rsquo;s trading costs and fund expenses. Select a row for its standalone history.
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <NumHead>Target</NumHead>
              <NumHead>Final weight</NumHead>
              <NumHead>Drift</NumHead>
              <NumHead>Final value</NumHead>
              <NumHead>Dividends</NumHead>
              <NumHead>Costs</NumHead>
              <NumHead>P&amp;L</NumHead>
              <NumHead>Share of gain</NumHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.ledgers.map((l, i) => {
              const drift = l.endWeight - l.targetWeight;
              const costs = l.tradingCost + l.expenseRatioCost;
              return (
                <TableRow
                  key={l.symbol}
                  onClick={onSelect ? () => onSelect(l.symbol) : undefined}
                  className={onSelect ? 'cursor-pointer' : undefined}
                >
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: seriesColor(l.symbol, i) }}
                      />
                      <span className="min-w-0">
                        <span className="numeric block text-xs font-medium">{l.symbol}</span>
                        <span className="block max-w-[14rem] truncate text-2xs text-muted-foreground">
                          {l.name}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <NumCell className="text-xs text-muted-foreground">
                    {formatPercent(l.targetWeight, 1)}
                  </NumCell>
                  <NumCell className="text-xs">{formatPercent(l.endWeight, 1)}</NumCell>
                  <NumCell
                    className={`text-xs ${
                      Math.abs(drift) < 0.005
                        ? 'text-muted-foreground'
                        : drift > 0
                          ? 'text-positive'
                          : 'text-negative'
                    }`}
                  >
                    {formatSignedPercent(drift, 1)}
                  </NumCell>
                  <NumCell className="text-xs">{formatCurrency(l.endingValue)}</NumCell>
                  <NumCell className="text-xs text-muted-foreground">
                    {l.dividends > 0 ? formatCurrency(l.dividends) : '—'}
                  </NumCell>
                  <NumCell className="text-xs text-muted-foreground">
                    {costs > 0.005 ? formatCurrency(costs) : '—'}
                  </NumCell>
                  <NumCell
                    className={`text-xs font-medium ${
                      l.profitAndLoss >= 0 ? 'text-positive' : 'text-negative'
                    }`}
                  >
                    {formatCurrency(l.profitAndLoss)}
                  </NumCell>
                  <NumCell className="text-xs">{formatPercent(l.shareOfGain, 1)}</NumCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="px-4 py-2 text-2xs text-muted-foreground">
          Final share counts: {result.ledgers
            .filter((l) => l.endingShares > 0 && l.symbol !== 'CASH')
            .map((l) => `${l.symbol} ${formatShares(l.endingShares)}`)
            .join(' · ') || '—'}
        </p>
      </CardContent>
    </Card>
  );
}
