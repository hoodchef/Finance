'use client';

import * as React from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Database,
  Download,
  FlaskConical,
  Info,
  Lightbulb,
} from 'lucide-react';
import type { BacktestResult } from '@/lib/backtest';
import type { BacktestWarning } from '@/lib/types';
import { buildCsv, downloadCsv, safeFilename, type ExportKind } from '@/lib/export/csv';
import { formatCurrency, formatDate, formatPercent } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Synthetic-data banner                                               */
/* ------------------------------------------------------------------ */

/**
 * Deliberately loud and not dismissible. A backtest on generated prices that
 * looks like a real one is worse than no backtest at all.
 */
export function SyntheticDataBanner({ result }: { result: BacktestResult }) {
  if (!result.dataSource.synthetic) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border-2 border-[hsl(var(--warning))] bg-[hsl(var(--warning))]/10 p-4"
    >
      <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--warning))]" />
      <div className="space-y-1">
        <p className="text-sm font-semibold">These results use synthetic data.</p>
        <p className="text-xs leading-relaxed">
          Every price below comes from a seeded random walk, not from any market. The numbers are
          internally consistent and reproducible, which makes them useful for exploring the product
          — and meaningless for evaluating a strategy. Switch the data provider in Settings to run
          against real history.
        </p>
      </div>
    </div>
  );
}

/**
 * A compact, always-visible statement of where the numbers came from and how
 * current they are. Provenance belongs next to the result, not only in a
 * methodology block further down the page that nobody scrolls to.
 */
export function DataFreshness({ dataSource }: { dataSource: BacktestResult['dataSource'] }) {
  const stale = dataSource.dataAgeDays != null && dataSource.dataAgeDays > 5;
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-x-1.5 text-2xs',
        stale ? 'text-[hsl(var(--warning))]' : 'text-muted-foreground',
      )}
    >
      <Database className="h-3 w-3" />
      <span>{dataSource.providerLabel}</span>
      {dataSource.latestSessionDate && (
        <>
          <span aria-hidden>·</span>
          <span>data to {formatDate(dataSource.latestSessionDate)}</span>
        </>
      )}
      {stale && (
        <span>
          ({dataSource.dataAgeDays} days behind — the market may have moved since)
        </span>
      )}
      {dataSource.retrievedAt && (
        <>
          <span aria-hidden>·</span>
          <span title={new Date(dataSource.retrievedAt).toLocaleString()}>
            retrieved {new Date(dataSource.retrievedAt).toLocaleDateString()}
          </span>
        </>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Warnings                                                            */
/* ------------------------------------------------------------------ */

const SEVERITY_STYLE: Record<
  BacktestWarning['severity'],
  { icon: typeof Info; className: string; label: string }
> = {
  error: {
    icon: AlertOctagon,
    className: 'border-destructive/40 bg-destructive/8 text-negative',
    label: 'Error',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8',
    label: 'Warning',
  },
  info: { icon: Info, className: 'border-border bg-muted/40', label: 'Note' },
};

export function WarningsPanel({ warnings }: { warnings: BacktestWarning[] }) {
  // Declared before the early return: a run with no warnings followed by one
  // with warnings would otherwise change the hook count between renders.
  const [expanded, setExpanded] = React.useState(false);

  const errors = warnings.filter((w) => w.severity === 'error');
  const rest = warnings.filter((w) => w.severity !== 'error');
  const visible = expanded ? rest : rest.slice(0, 3);

  if (!warnings.length) return null;

  return (
    <div className="space-y-2">
      {errors.map((w, i) => (
        <WarningRow key={`e-${i}`} warning={w} />
      ))}
      {visible.map((w, i) => (
        <WarningRow key={`w-${i}`} warning={w} />
      ))}
      {rest.length > 3 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted-foreground"
        >
          {expanded ? 'Show fewer' : `Show ${rest.length - 3} more note${rest.length - 3 === 1 ? '' : 's'}`}
        </Button>
      )}
    </div>
  );
}

function WarningRow({ warning }: { warning: BacktestWarning }) {
  const style = SEVERITY_STYLE[warning.severity];
  const Icon = style.icon;
  return (
    <div
      role={warning.severity === 'error' ? 'alert' : undefined}
      className={cn('flex items-start gap-2.5 rounded-md border p-3 text-xs', style.className)}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-0.5">
        {warning.symbol && (
          <span className="numeric mr-1.5 font-semibold">{warning.symbol}</span>
        )}
        <span className="leading-relaxed">{warning.message}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Insights                                                            */
/* ------------------------------------------------------------------ */

export function InsightsPanel({ result }: { result: BacktestResult }) {
  if (!result.insights.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" />
          Portfolio insights
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Observations derived from the figures on this page. Descriptive only — nothing here is a
          recommendation to buy, sell or hold anything.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {result.insights.map((insight) => (
          <div
            key={insight.id}
            className="rounded-md border border-border bg-background/40 p-3"
          >
            <div className="mb-1 flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  insight.tone === 'positive' && 'bg-[hsl(var(--positive))]',
                  insight.tone === 'negative' && 'bg-[hsl(var(--negative))]',
                  insight.tone === 'neutral' && 'bg-muted-foreground/50',
                )}
              />
              <h3 className="text-xs font-semibold">{insight.title}</h3>
              <Badge variant="outline" className="ml-auto capitalize">
                {insight.kind}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{insight.body}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Methodology                                                         */
/* ------------------------------------------------------------------ */

export function MethodologyPanel({ result }: { result: BacktestResult }) {
  const { config, dataSource, totals, metrics } = result;

  const items: Array<[string, React.ReactNode]> = [
    ['Data source', `${dataSource.providerLabel}${dataSource.synthetic ? ' — SYNTHETIC' : ''}`],
    [
      'Data retrieved',
      dataSource.retrievedAt
        ? `${new Date(dataSource.retrievedAt).toLocaleString()}${
            dataSource.symbols.length > 1 ? ' (oldest of the series used)' : ''
          }`
        : 'Not recorded',
    ],
    [
      'Latest session covered',
      dataSource.latestSessionDate
        ? `${formatDate(dataSource.latestSessionDate)}${
            dataSource.dataAgeDays != null && dataSource.dataAgeDays > 0
              ? ` — ${dataSource.dataAgeDays} day${dataSource.dataAgeDays === 1 ? '' : 's'} before today`
              : ''
          }`
        : 'Unknown',
    ],
    ['Data frequency', 'Daily closing prices'],
    ['Price adjustment', 'Split-adjusted closes with dividends applied as separate cash events'],
    [
      'Backtest period',
      `${formatDate(result.effectiveStart)} → ${formatDate(result.effectiveEnd)} (${metrics.returns.years.toFixed(2)} years, ${metrics.periodsPerYear.toFixed(0)} periods a year)`,
    ],
    [
      'Requested period',
      config.start === result.effectiveStart && config.end === result.effectiveEnd
        ? 'Matched in full'
        : `${formatDate(config.start)} → ${formatDate(config.end)}, narrowed to fit available history`,
    ],
    ['Dividends included', 'Yes — every cash dividend the provider reports'],
    [
      'Dividend treatment',
      config.dividends === 'reinvest'
        ? 'Reinvested in the paying security at the closing price on the ex-dividend date, with no commission (modelled as a DRIP)'
        : 'Credited to cash and left uninvested',
    ],
    [
      'Return convention',
      'Total return chained as (close + dividend) ÷ prior close. This is the economically exact figure and differs slightly from a vendor "adjusted close" column, which back-adjusts prior prices instead.',
    ],
    [
      'Return measure',
      'Time-weighted. External cash flows are removed from each daily return, so contributions never appear as performance.',
    ],
    [
      'Rebalancing',
      config.rebalance === 'never'
        ? 'None — positions were left to drift'
        : config.rebalance === 'threshold'
          ? `Whenever any weight drifted more than ${config.rebalanceThresholdPct} percentage points from target (${totals.rebalanceCount} times)`
          : `${config.rebalance}, at the close of the first trading day of each period (${totals.rebalanceCount} times)`,
    ],
    [
      'Fees applied',
      [
        config.fees.managementFeePct > 0 && `${config.fees.managementFeePct}%/yr management fee accrued daily and charged monthly`,
        config.fees.tradingCostBps > 0 && `${config.fees.tradingCostBps} bps per trade`,
        config.fees.commissionPerTrade > 0 && `${formatCurrency(config.fees.commissionPerTrade, true)} commission per trade`,
        `fund expense ratios as set per holding (${formatCurrency(totals.totalExpenseRatioCost)} total)`,
      ]
        .filter(Boolean)
        .join('; ') || 'None',
    ],
    [
      'Cash',
      config.cashYieldPct > 0
        ? `Idle cash earned ${config.cashYieldPct}%/yr, accrued on calendar days`
        : 'Idle cash earned nothing (no rate assumed)',
    ],
    [
      'Risk-free rate',
      config.riskFree.source === 'tbill'
        ? `13-week US Treasury bill (^IRX), averaging ${formatPercent(metrics.averageRiskFree)} over the period`
        : config.riskFree.source === 'constant'
          ? `Fixed at ${config.riskFree.constantPct}%/yr`
          : 'Zero',
    ],
    [
      'Benchmarks',
      config.benchmarks.length
        ? `${config.benchmarks.join(', ')} — same dates and contributions, dividends reinvested, no fees`
        : 'None',
    ],
    [
      'Missing prices',
      'A security that does not trade on a market day carries its previous close forward, and the day is flagged. A security whose history ends mid-backtest is sold at its final close and held as cash.',
    ],
    [
      'Inflation',
      result.inflation
        ? `${result.inflation.label} — prices rose ${formatPercent(
            result.inflation.totalInflation,
            1,
          )} over the period (${formatPercent(
            result.inflation.annualisedInflation,
          )} a year).${
            result.inflation.synthetic
              ? ' This is an assumed flat rate you entered, not measured inflation.'
              : ''
          }`
        : 'Not applied — all figures are nominal',
    ],
    ['Engine', `v${result.engineVersion}, computed in ${result.computeMs} ms`],
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Methodology</CardTitle>
        <p className="text-xs text-muted-foreground">
          Exactly what was assumed to produce the figures above.
        </p>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border text-xs">
          {items.map(([label, value]) => (
            <div key={label} className="grid gap-1 py-2 sm:grid-cols-[13rem_1fr] sm:gap-4">
              <dt className="font-medium text-muted-foreground">{label}</dt>
              <dd className="leading-relaxed">{value}</dd>
            </div>
          ))}
        </dl>
        {dataSource.symbols.length > 0 && (
          <p className="mt-3 border-t border-border pt-3 text-2xs text-muted-foreground">
            Series loaded:{' '}
            {dataSource.symbols
              .map(
                (s) =>
                  `${s.symbol} (${s.source}${s.synthetic ? ', synthetic' : ''}${
                    s.lastBarDate ? `, to ${s.lastBarDate}` : ''
                  })`,
              )
              .join(' · ')}
          </p>
        )}
        <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
          Past performance does not predict future results. A backtest applies today&rsquo;s choice
          of assets to yesterday&rsquo;s prices, which no investor could have made at the time.
        </p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const EXPORTS: Array<{ kind: ExportKind; label: string; description: string }> = [
  { kind: 'summary', label: 'Performance summary', description: 'Headline metrics vs benchmarks' },
  { kind: 'annual', label: 'Annual returns', description: 'Calendar-year returns' },
  { kind: 'monthly', label: 'Monthly returns', description: 'Month-by-year grid' },
  { kind: 'holdings', label: 'Holdings', description: 'Per-position attribution' },
  { kind: 'transactions', label: 'Transaction history', description: 'Every trade, dividend and fee' },
  { kind: 'gains', label: 'Realised gains', description: 'Taxable events by year and holding' },
  { kind: 'timeseries', label: 'Daily time series', description: 'Value, index and drawdown' },
  { kind: 'config', label: 'Portfolio configuration', description: 'Every setting used' },
];

export function ExportMenu({ result }: { result: BacktestResult }) {
  function run(kind: ExportKind) {
    const name = safeFilename(result.portfolio.name);
    downloadCsv(`${name}-${kind}-${result.effectiveEnd}.csv`, buildCsv(result, kind));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Download as CSV</DropdownMenuLabel>
        {EXPORTS.map((e) => (
          <DropdownMenuItem
            key={e.kind}
            onSelect={() => run(e.kind)}
            className="flex-col items-start gap-0.5 py-1.5"
          >
            <span className="text-xs font-medium">{e.label}</span>
            <span className="text-2xs text-muted-foreground">{e.description}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            for (const e of EXPORTS) run(e.kind);
          }}
        >
          <span className="text-xs">Download every file</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
