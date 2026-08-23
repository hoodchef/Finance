'use client';

import type { BacktestResult } from '@/lib/backtest';
import { formatCurrency, formatPercent } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { InfoTip } from '@/components/ui/tooltip';
import {
  NumCell,
  NumHead,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const METHOD_LABEL: Record<string, string> = {
  fifo: 'First in, first out',
  average: 'Average cost',
  hifo: 'Highest cost first',
};

/**
 * Realised and unrealised gains.
 *
 * No tax is computed here and none is implied. These are the amounts a tax
 * calculation would be built from — which gains were crystallised, when, and
 * how long the shares were held. Publishing those without a rate table is
 * honest; guessing at brackets would not be.
 */
export function TaxLotsPanel({ result }: { result: BacktestResult }) {
  const { totals, lots, realisedByYear, config } = result;
  if (!lots.length) return null;

  const anyClassified = realisedByYear.some((r) => r.shortTerm !== 0 || r.longTerm !== 0);
  const totalDividends = realisedByYear.reduce((s, r) => s + r.dividends, 0);
  const totalRealised = totals.totalRealisedGain;
  const turnoverDrag =
    totals.investmentGain !== 0 ? totalRealised / totals.investmentGain : 0;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5">
              Realised and unrealised gains
              <InfoTip label="About realised gains">
                A gain is realised when shares are sold — by a rebalance, a withdrawal, or a
                delisting. Until then it is unrealised and, in a taxable account, untaxed. This
                panel reports the amounts; it applies no tax rates of any kind.
              </InfoTip>
            </CardTitle>
            <Badge variant="outline">
              {METHOD_LABEL[config.costBasisMethod] ?? config.costBasisMethod}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            How much of this portfolio&rsquo;s gain was crystallised along the way, and how much is
            still open in the positions held at the end.
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Realised</dt>
              <dd
                className={cn(
                  'numeric mt-0.5 text-lg font-semibold',
                  totalRealised >= 0 ? 'text-positive' : 'text-negative',
                )}
              >
                {formatCurrency(totalRealised)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
                Unrealised
              </dt>
              <dd
                className={cn(
                  'numeric mt-0.5 text-lg font-semibold',
                  totals.totalUnrealisedGain >= 0 ? 'text-positive' : 'text-negative',
                )}
              >
                {formatCurrency(totals.totalUnrealisedGain)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
                Dividend income
              </dt>
              <dd className="numeric mt-0.5 text-lg font-semibold">
                {formatCurrency(totalDividends)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
                Share crystallised
              </dt>
              <dd className="numeric mt-0.5 text-lg font-semibold">
                {totals.investmentGain > 0 ? formatPercent(turnoverDrag, 0) : '—'}
              </dd>
            </div>
          </dl>

          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            {totals.rebalanceCount === 0 && Math.abs(totalRealised) < 1 ? (
              <>
                Nothing was ever sold, so no gain was crystallised. In a taxable account this
                portfolio would have generated no capital gains tax over the period — only the tax
                due on {formatCurrency(totalDividends)} of dividend income.
              </>
            ) : (
              <>
                {formatCurrency(Math.abs(totalRealised))} of gains
                {totalRealised < 0 ? ' (a net loss)' : ''} were crystallised across{' '}
                {totals.rebalanceCount} rebalances and {totals.tradeCount} trades. In a taxable
                account that is the amount a capital gains calculation would apply to; in a
                sheltered account it is not taxed at all. No tax rate is applied anywhere in this
                tool.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {realisedByYear.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Taxable events by year</CardTitle>
            <p className="text-xs text-muted-foreground">
              What a tax return for a taxable account would have needed to report each year.
            </p>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Year</TableHead>
                  <NumHead>Sales</NumHead>
                  {anyClassified && (
                    <>
                      <NumHead>
                        <span className="inline-flex items-center gap-1">
                          Short term
                          <InfoTip label="About short-term gains">
                            Gains on shares held a year or less. Many jurisdictions tax these at a
                            higher rate than long-term gains; this tool reports the split without
                            applying either.
                          </InfoTip>
                        </span>
                      </NumHead>
                      <NumHead>Long term</NumHead>
                    </>
                  )}
                  <NumHead>Realised total</NumHead>
                  <NumHead>Dividends</NumHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {realisedByYear.map((r) => (
                  <TableRow key={r.year}>
                    <TableCell className="numeric text-xs font-medium">{r.year}</TableCell>
                    <NumCell className="text-xs text-muted-foreground">{r.saleCount}</NumCell>
                    {anyClassified && (
                      <>
                        <NumCell
                          className={cn(
                            'text-xs',
                            r.shortTerm < 0 ? 'text-negative' : 'text-muted-foreground',
                          )}
                        >
                          {r.shortTerm === 0 ? '—' : formatCurrency(r.shortTerm)}
                        </NumCell>
                        <NumCell
                          className={cn(
                            'text-xs',
                            r.longTerm < 0 ? 'text-negative' : 'text-muted-foreground',
                          )}
                        >
                          {r.longTerm === 0 ? '—' : formatCurrency(r.longTerm)}
                        </NumCell>
                      </>
                    )}
                    <NumCell
                      className={cn(
                        'text-xs font-medium',
                        r.realisedGain >= 0 ? 'text-positive' : 'text-negative',
                      )}
                    >
                      {formatCurrency(r.realisedGain)}
                    </NumCell>
                    <NumCell className="text-xs text-muted-foreground">
                      {r.dividends > 0 ? formatCurrency(r.dividends) : '—'}
                    </NumCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="text-xs font-semibold">Total</TableCell>
                  <NumCell className="text-xs">
                    {realisedByYear.reduce((s, r) => s + r.saleCount, 0)}
                  </NumCell>
                  {anyClassified && (
                    <>
                      <NumCell className="text-xs">
                        {formatCurrency(realisedByYear.reduce((s, r) => s + r.shortTerm, 0))}
                      </NumCell>
                      <NumCell className="text-xs">
                        {formatCurrency(realisedByYear.reduce((s, r) => s + r.longTerm, 0))}
                      </NumCell>
                    </>
                  )}
                  <NumCell className="text-xs font-semibold">
                    {formatCurrency(totalRealised)}
                  </NumCell>
                  <NumCell className="text-xs">{formatCurrency(totalDividends)}</NumCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Cost basis by holding</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <NumHead>Shares held</NumHead>
                <NumHead>Cost basis</NumHead>
                <NumHead>Market value</NumHead>
                <NumHead>Unrealised</NumHead>
                <NumHead>Realised</NumHead>
                <NumHead>Dividends</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lots.map((l) => {
                const ledger = result.ledgers.find((x) => x.symbol === l.symbol);
                return (
                  <TableRow key={l.symbol}>
                    <TableCell className="numeric text-xs font-medium">{l.symbol}</TableCell>
                    <NumCell className="text-xs text-muted-foreground">
                      {l.openShares.toLocaleString('en-US', { maximumFractionDigits: 3 })}
                    </NumCell>
                    <NumCell className="text-xs">{formatCurrency(l.openCostBasis)}</NumCell>
                    <NumCell className="text-xs">
                      {formatCurrency(ledger?.endingValue ?? 0)}
                    </NumCell>
                    <NumCell
                      className={cn(
                        'text-xs font-medium',
                        l.unrealisedGain >= 0 ? 'text-positive' : 'text-negative',
                      )}
                    >
                      {formatCurrency(l.unrealisedGain)}
                    </NumCell>
                    <NumCell
                      className={cn(
                        'text-xs',
                        l.realisedGain === 0
                          ? 'text-muted-foreground'
                          : l.realisedGain > 0
                            ? 'text-positive'
                            : 'text-negative',
                      )}
                    >
                      {l.realisedGain === 0 ? '—' : formatCurrency(l.realisedGain)}
                    </NumCell>
                    <NumCell className="text-xs text-muted-foreground">
                      {l.dividends > 0 ? formatCurrency(l.dividends) : '—'}
                    </NumCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="px-4 py-3 text-2xs leading-relaxed text-muted-foreground">
            Purchase costs are capitalised into basis and sale costs netted out of proceeds. For
            every holding, realised plus unrealised plus dividends equals its total profit and loss
            — an identity the test suite asserts.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
