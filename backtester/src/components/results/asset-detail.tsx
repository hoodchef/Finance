'use client';

import * as React from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { AssetAnalysis, BacktestResult } from '@/lib/backtest';
import { daysBetween } from '@/lib/market-data/dates';
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  formatShares,
  formatSignedPercent,
} from '@/lib/format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';
import {
  AXIS_PROPS,
  ChartTooltip,
  GRID_PROPS,
  makeDateTickFormatter,
  makeDateTicks,
  tooltipDate,
} from '@/components/charts/chart-chrome';

/**
 * Per-holding detail. The statistics here describe the asset held on its own
 * over the same window, which is the honest way to ask "was this one any good?"
 * — separate from what it contributed inside the portfolio, shown alongside.
 */
export function AssetDetailDialog({
  result,
  symbol,
  onOpenChange,
}: {
  result: BacktestResult;
  symbol: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const asset = result.assets.find((a) => a.symbol === symbol) ?? null;
  const ledger = result.ledgers.find((l) => l.symbol === symbol) ?? null;

  return (
    <Dialog open={symbol != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {asset ? (
          <AssetDetailBody asset={asset} result={result} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="numeric">{symbol}</DialogTitle>
              <DialogDescription>
                {symbol === 'CASH'
                  ? 'The cash sleeve is not a traded security, so it has no standalone price history.'
                  : 'No standalone analysis is available for this holding.'}
              </DialogDescription>
            </DialogHeader>
            {ledger && (
              <div className="p-5 pt-0">
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <Detail label="Final value" value={formatCurrency(ledger.endingValue)} />
                  <Detail label="Profit and loss" value={formatCurrency(ledger.profitAndLoss)} />
                </dl>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={`numeric mt-0.5 text-sm font-medium ${
          tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function AssetDetailBody({ asset, result }: { asset: AssetAnalysis; result: BacktestResult }) {
  const { metrics } = asset;
  const ledger = asset.ledger;
  const tickFormatter = makeDateTickFormatter(daysBetween(asset.firstDate, asset.lastDate));
  const dateTicks = makeDateTicks(asset.series.map((p) => p.date), 6);

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <DialogTitle className="numeric">{asset.symbol}</DialogTitle>
          {metrics.ratios.beta != null && (
            <Badge variant="outline">β {formatNumber(metrics.ratios.beta)} vs portfolio</Badge>
          )}
        </div>
        <DialogDescription>
          {asset.name} · standalone buy-and-hold, dividends reinvested, no fees,{' '}
          {formatDate(asset.firstDate)} → {formatDate(asset.lastDate)}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Detail
            label="Total return"
            value={formatSignedPercent(metrics.returns.totalReturn, 1)}
            tone={metrics.returns.totalReturn >= 0 ? 'positive' : 'negative'}
          />
          <Detail label="CAGR" value={formatPercent(metrics.returns.cagr)} />
          <Detail label="Volatility" value={formatPercent(metrics.risk.volatility)} />
          <Detail
            label="Max drawdown"
            value={formatPercent(metrics.risk.maxDrawdown, 1)}
            tone="negative"
          />
          <Detail label="Sharpe" value={formatNumber(metrics.ratios.sharpe)} />
          <Detail label="Sortino" value={formatNumber(metrics.ratios.sortino)} />
          <Detail
            label="Best year"
            value={
              metrics.annualSummary.best
                ? `${formatSignedPercent(metrics.annualSummary.best.return, 1)} · ${metrics.annualSummary.best.year}`
                : '—'
            }
          />
          <Detail
            label="Worst year"
            value={
              metrics.annualSummary.worst
                ? `${formatSignedPercent(metrics.annualSummary.worst.return, 1)} · ${metrics.annualSummary.worst.year}`
                : '—'
            }
          />
        </dl>

        <div className="h-44 w-full rounded-md border border-border p-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={asset.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`asset-${asset.symbol}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="date"
                {...AXIS_PROPS}
                ticks={dateTicks}
                tickFormatter={tickFormatter}
                minTickGap={20}
              />
              <YAxis
                {...AXIS_PROPS}
                width={46}
                tickFormatter={(v) => `${Number(v).toFixed(1)}×`}
              />
              <Area
                type="monotone"
                dataKey="index"
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
                fill={`url(#asset-${asset.symbol})`}
                isAnimationActive={false}
                dot={false}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as { index: number; drawdown: number };
                  return (
                    <ChartTooltip
                      title={tooltipDate(label)}
                      rows={[
                        {
                          label: 'Growth',
                          value: `${row.index.toFixed(3)}×`,
                          color: 'hsl(var(--primary))',
                        },
                        { label: 'Drawdown', value: formatPercent(row.drawdown), muted: true },
                      ]}
                    />
                  );
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {ledger && (
          <div className="rounded-md border border-border p-4">
            <h3 className="mb-2 text-xs font-semibold">Inside this portfolio</h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Detail label="Target weight" value={formatPercent(ledger.targetWeight, 1)} />
              <Detail label="Final weight" value={formatPercent(ledger.endWeight, 1)} />
              <Detail label="Final shares" value={formatShares(ledger.endingShares)} />
              <Detail label="Final value" value={formatCurrency(ledger.endingValue)} />
              <Detail label="Dividends received" value={formatCurrency(ledger.dividends)} />
              <Detail
                label="Costs borne"
                value={formatCurrency(ledger.tradingCost + ledger.expenseRatioCost)}
              />
              <Detail
                label="Profit and loss"
                value={formatCurrency(ledger.profitAndLoss)}
                tone={ledger.profitAndLoss >= 0 ? 'positive' : 'negative'}
              />
              <Detail label="Share of total gain" value={formatPercent(ledger.shareOfGain, 1)} />
            </dl>
            {metrics.ratios.correlation != null && (
              <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                Correlation with the whole portfolio was{' '}
                <span className="numeric text-foreground">
                  {formatNumber(metrics.ratios.correlation)}
                </span>
                {metrics.ratios.upCapture != null && metrics.ratios.downCapture != null && (
                  <>
                    , capturing{' '}
                    <span className="numeric text-foreground">
                      {formatPercent(metrics.ratios.upCapture, 0)}
                    </span>{' '}
                    of its up days and{' '}
                    <span className="numeric text-foreground">
                      {formatPercent(metrics.ratios.downCapture, 0)}
                    </span>{' '}
                    of its down days
                  </>
                )}
                .
              </p>
            )}
          </div>
        )}

        {metrics.monthly.length > 0 && (
          <MonthlyHeatmap
            monthly={metrics.monthly}
            annual={metrics.annual}
            title={`${asset.symbol} monthly returns`}
          />
        )}

        <p className="text-2xs text-muted-foreground">
          Prices from {result.dataSource.providerLabel}
          {result.dataSource.synthetic && ' — SYNTHETIC, not real market data'}.
        </p>
      </div>
    </>
  );
}
