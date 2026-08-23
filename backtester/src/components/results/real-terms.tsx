'use client';

import { FlaskConical, TrendingDown } from 'lucide-react';
import type { BacktestResult } from '@/lib/backtest';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { InfoTip } from '@/components/ui/tooltip';
import {
  NumCell,
  NumHead,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableHead,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Nominal versus real, side by side.
 *
 * The two columns are computed by the same metric code over two different index
 * series, so the comparison is like-for-like. When the price path is an
 * assumption rather than a measurement, that is stated on the card rather than
 * buried in the methodology.
 */
export function RealTermsPanel({ result }: { result: BacktestResult }) {
  const { realMetrics, inflation, metrics, totals } = result;
  if (!realMetrics || !inflation) return null;

  const realFinal = result.series[result.series.length - 1]?.realValue ?? totals.finalValue;
  const purchasingPowerLost = totals.finalValue > 0 ? 1 - realFinal / totals.finalValue : 0;

  const rows: Array<{ label: string; nominal: string; real: string; hint?: string }> = [
    {
      label: 'Final value',
      nominal: formatCurrency(totals.finalValue),
      real: formatCurrency(realFinal),
      hint: 'The real column expresses the ending balance in the purchasing power of the first day of the backtest.',
    },
    {
      label: 'Total return',
      nominal: formatSignedPercent(metrics.returns.totalReturn, 1),
      real: formatSignedPercent(realMetrics.returns.totalReturn, 1),
    },
    {
      label: 'CAGR',
      nominal: formatPercent(metrics.returns.cagr),
      real: formatPercent(realMetrics.returns.cagr),
    },
    {
      label: 'Money-weighted return',
      nominal:
        metrics.returns.moneyWeightedReturn == null
          ? '—'
          : formatPercent(metrics.returns.moneyWeightedReturn),
      real:
        realMetrics.returns.moneyWeightedReturn == null
          ? '—'
          : formatPercent(realMetrics.returns.moneyWeightedReturn),
    },
    {
      label: 'Volatility',
      nominal: formatPercent(metrics.risk.volatility),
      real: formatPercent(realMetrics.risk.volatility),
      hint: 'Barely moves: month-to-month inflation is tiny next to market volatility, so deflating changes the level of returns far more than their spread.',
    },
    {
      label: 'Maximum drawdown',
      nominal: formatPercent(metrics.risk.maxDrawdown, 1),
      real: formatPercent(realMetrics.risk.maxDrawdown, 1),
      hint: 'A real drawdown is deeper than a nominal one: prices kept rising while the portfolio fell, so recovering the old balance is not recovering the old purchasing power.',
    },
    {
      label: 'Best year',
      nominal: metrics.annualSummary.best
        ? formatSignedPercent(metrics.annualSummary.best.return, 1)
        : '—',
      real: realMetrics.annualSummary.best
        ? formatSignedPercent(realMetrics.annualSummary.best.return, 1)
        : '—',
    },
    {
      label: 'Worst year',
      nominal: metrics.annualSummary.worst
        ? formatSignedPercent(metrics.annualSummary.worst.return, 1)
        : '—',
      real: realMetrics.annualSummary.worst
        ? formatSignedPercent(realMetrics.annualSummary.worst.return, 1)
        : '—',
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-1.5">
            Nominal versus real
            <InfoTip label="About real returns">
              Real figures are deflated by the price level, so they measure change in purchasing
              power rather than in dollars. A 7% nominal return with 3% inflation is roughly a 3.9%
              real return — not 4%, because the two compound.
            </InfoTip>
          </CardTitle>
          {inflation.synthetic ? (
            <Badge variant="warning" className="gap-1">
              <FlaskConical className="h-3 w-3" />
              Assumed rate
            </Badge>
          ) : (
            <Badge variant="outline">Measured CPI</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{inflation.label}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
          <span className="flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
            Prices rose{' '}
            <span className="numeric font-medium text-foreground">
              {formatPercent(inflation.totalInflation, 1)}
            </span>{' '}
            over the period
          </span>
          <span>
            <span className="numeric font-medium text-foreground">
              {formatPercent(inflation.annualisedInflation)}
            </span>{' '}
            a year
          </span>
          <span className="text-muted-foreground">
            {formatCurrency(totals.finalValue)} at the end buys what{' '}
            <span className="numeric font-medium text-foreground">
              {formatCurrency(realFinal)}
            </span>{' '}
            bought on day one — {formatPercent(purchasingPowerLost, 0)} of the headline balance is
            the price level, not gain.
          </span>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <NumHead>Nominal</NumHead>
              <NumHead>Real</NumHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {r.label}
                    {r.hint && <InfoTip label={`About ${r.label}`}>{r.hint}</InfoTip>}
                  </span>
                </TableCell>
                <NumCell className="text-xs">{r.nominal}</NumCell>
                <NumCell className="text-xs font-medium">{r.real}</NumCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {inflation.synthetic && (
          <p className="rounded-md border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
            The real column here is built on a flat{' '}
            {formatPercent(inflation.annualisedInflation)} a year that you entered, not on measured
            inflation. Actual inflation was not flat over any real period. Switch the inflation
            source to the published CPI series for figures grounded in data.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** One-line real summary for the KPI area. */
export function RealSummaryStrip({ result }: { result: BacktestResult }) {
  const { realMetrics, inflation } = result;
  if (!realMetrics || !inflation) return null;
  const realFinal = result.series[result.series.length - 1]?.realValue ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
      <span className="font-medium">In first-day dollars</span>
      <span className="text-muted-foreground">
        Final{' '}
        <span className="numeric font-medium text-foreground">{formatCurrency(realFinal)}</span>
      </span>
      <span className="text-muted-foreground">
        CAGR{' '}
        <span
          className={cn(
            'numeric font-medium',
            realMetrics.returns.cagr >= 0 ? 'text-positive' : 'text-negative',
          )}
        >
          {formatPercent(realMetrics.returns.cagr)}
        </span>
      </span>
      <span className="text-muted-foreground">
        Max drawdown{' '}
        <span className="numeric font-medium text-negative">
          {formatPercent(realMetrics.risk.maxDrawdown, 1)}
        </span>
      </span>
      {inflation.synthetic && <Badge variant="warning">Assumed rate</Badge>}
    </div>
  );
}
