'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Building2, Check, Download, LineChart, Plus } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TickerSearch } from '@/components/builder/ticker-search';
import { CompanyNews } from '@/components/research/company-news';
import { EarningsPanel } from '@/components/research/earnings-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { AXIS_PROPS, ChartFrame, GRID_PROPS } from '@/components/charts/chart-chrome';
import { formatCurrencyCompact, formatPercent } from '@/lib/format';
import { cn, seriesColor, uid } from '@/lib/utils';
import { buildFundamentalsCsv } from '@/lib/export/fundamentals-csv';
import type { Dilution, Valuation, YearRow } from '@/lib/fundamentals/metrics';
import { downloadCsv, safeFilename } from '@/lib/export/csv';
import { useWorkspace } from '@/store/workspace';
import { useActiveTicker, useTickerStore } from '@/store/ticker';
import Link from 'next/link';

interface Response {
  company: { ticker: string; name: string; cik: string };
  rows: YearRow[];
  valuation: Valuation | null;
  dilution: Dilution | null;
  price: { close: number; asOf: string | null } | null;
  priceNote: string | null;
  provenance: {
    financials: string;
    latestFilingDate: string;
    latestFiscalYear: number;
    priceSource: string | null;
    conceptsUsed: Array<{ field: string; concept: string }>;
    estimatesNote: string;
  };
}

const money = (v: number | null) => (v == null ? '—' : formatCurrencyCompact(v));
const pct = (v: number | null, d = 1) => (v == null ? '—' : formatPercent(v, d));
const mult = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}×`);

/**
 * Company fundamentals, from the filings.
 *
 * Every figure on this page is an XBRL fact a company tagged in its own 10-K,
 * or arithmetic over those facts. Nothing is estimated and nothing is filled
 * in: where a company did not report something, the cell is a dash rather than
 * a zero, because a fundamentals page that substitutes zero for missing debt
 * reports a flattering EV/EBITDA and looks entirely normal doing it.
 *
 * The financials and the price come from different sources with different
 * staleness, so they are labelled separately rather than under one "as of".
 */
export function ResearchView() {
  const [input, setInput] = React.useState('');
  const [data, setData] = React.useState<Response | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /*
   * Ticker context: adopt once on mount so arriving from the chart or the
   * options page lands on the same company, and publish whatever is looked up
   * here so leaving carries it onward. One-directional at any instant.
   */
  const activeFocus = useActiveTicker();
  const publishTicker = useTickerStore((s) => s.setTicker);

  /*
   * Adopted on the FIRST non-null focus, not on mount.
   *
   * `useActiveTicker` gates on hydration and returns null during the first
   * client paint, so a mount-only effect runs before the persisted symbol
   * exists and adopts nothing — which is exactly what happened: arriving here
   * with KO in focus still showed an empty page. The ref makes it once-only
   * without tying it to a render that is too early to be useful.
   */
  const adopted = React.useRef(false);

  React.useEffect(() => {
    if (adopted.current || !activeFocus?.symbol) return;
    adopted.current = true;
    void look(activeFocus.symbol);
    // `look` is stable for this purpose and the ref makes this run once; adding
    // it would re-run the lookup on every render that redefines it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFocus]);

  React.useEffect(() => {
    if (data?.company?.ticker) publishTicker(data.company.ticker, data.company.name);
  }, [data?.company?.ticker, data?.company?.name, publishTicker]);

  async function look(ticker: string) {
    const clean = ticker.trim().toUpperCase();
    if (!clean || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/fundamentals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: clean }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load that company.');
      setData(json as Response);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Could not load that company.');
    } finally {
      setPending(false);
    }
  }

  // Memoised off `data` rather than a fresh array each render, which would
  // make every downstream memo recompute on every keystroke in the ticker box.
  const rows = React.useMemo(() => data?.rows ?? [], [data]);
  const recent = React.useMemo(() => rows.slice(-12), [rows]);
  const v = data?.valuation ?? null;
  const last = rows[rows.length - 1];

  /**
   * Research was a dead end: it told you what a company reported and left you
   * to retype the ticker somewhere else to do anything with it. The same shape
   * as the optimiser before it could apply an allocation.
   *
   * Adding is deliberately additive and weightless — a new holding lands at 0%
   * so nothing already in the portfolio is silently rescaled. Equal-weighting
   * or setting a number is a decision for the builder, not a side effect of
   * looking a company up.
   */
  const draft = useWorkspace((s) => s.draft);
  const addPosition = useWorkspace((s) => s.addPosition);
  const [added, setAdded] = React.useState<string | null>(null);

  const alreadyHeld =
    data != null &&
    draft.positions.some(
      (p) => p.symbol.trim().toUpperCase() === data.company.ticker.toUpperCase(),
    );

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `${safeFilename(data.company.ticker)}-fundamentals.csv`,
      buildFundamentalsCsv(data),
    );
  }

  function addToPortfolio() {
    if (!data || alreadyHeld) return;
    addPosition({
      id: uid('pos'),
      symbol: data.company.ticker,
      name: data.company.name,
      weight: 0,
    });
    setAdded(data.company.ticker);
    window.setTimeout(() => setAdded(null), 2500);
  }


  const chartData = React.useMemo(
    () =>
      recent.map((r) => ({
        fy: String(r.fiscalYear),
        revenue: r.revenue,
        growth: r.revenueGrowth != null ? r.revenueGrowth * 100 : null,
        gross: r.grossMargin != null ? r.grossMargin * 100 : null,
        operating: r.operatingMargin != null ? r.operatingMargin * 100 : null,
        net: r.netMargin != null ? r.netMargin * 100 : null,
        fcf: r.freeCashFlow,
        ocf: r.operatingCashFlow,
        eps: r.epsDiluted,
        shares: r.sharesDiluted,
      })),
    [recent],
  );

  return (
    <>
      <PageHeader
        title="Research"
        description="What a company actually reported, straight from its SEC filings."
      />

      <PageBody className="space-y-4">
        {/*
          The search is the page.
          It was in the header's action slot: small, right-aligned, competing
          with the title — while the empty state below said "Enter a ticker"
          with no input under it. The instruction and the affordance were in
          different places, and the only thing this page does was the least
          prominent thing on it.
        */}
        <div className={cn('mx-auto w-full', data ? 'max-w-xl' : 'max-w-2xl pt-8')}>
          {!data && (
            <div className="mb-4 text-center">
              <h2 className="text-xl font-semibold">Look up a company</h2>
              <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
                Reads XBRL facts from SEC EDGAR &mdash; the filings themselves, not a vendor&rsquo;s
                copy. US filers only: a TSX-only listing files with SEDAR and is not covered.
              </p>
            </div>
          )}
          <TickerSearch
            autoFocus={!data}
            placeholder="Ticker or company name — AAPL, Microsoft, NVDA…"
            onSelect={(meta) => {
              setInput(meta.symbol);
              void look(meta.symbol);
            }}
            className={cn(!data && 'text-base')}
          />
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">
            {['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'KO', 'JPM', 'XOM'].map((t) => (
              <Button
                key={t}
                size="sm"
                variant={data?.company.ticker === t ? 'default' : 'outline'}
                onClick={() => {
                  setInput(t);
                  void look(t);
                }}
              >
                {t}
              </Button>
            ))}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="leading-relaxed">{error}</p>
          </div>
        )}

        {pending && !data && <Skeleton className="h-96 w-full" />}

        {data && last && (
          <div className={cn('space-y-4', pending && 'opacity-60')}>
            {/* Identity and provenance, together. */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-lg font-semibold">{data.company.name}</h2>
              <Badge variant="outline">{data.company.ticker}</Badge>
              <span className="text-xs text-muted-foreground">
                Fiscal {last.fiscalYear}, ended {last.end}
              </span>
              {data.price?.asOf && (
                <span className="text-xs text-muted-foreground">
                  · price ${data.price.close.toFixed(2)} on {data.price.asOf}
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={exportCsv}>
                  <Download className="h-3 w-3" />
                  CSV
                </Button>
                {alreadyHeld ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link href="/backtest">
                      <LineChart className="h-3 w-3" />
                      Already in {draft.name || 'your portfolio'}
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={addToPortfolio}>
                    {added === data.company.ticker ? (
                      <>
                        <Check className="h-3 w-3" />
                        Added at 0%
                      </>
                    ) : (
                      <>
                        <Plus className="h-3 w-3" />
                        Add to portfolio
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {/* Valuation */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Valuation
                  {v && <span className="ml-2 text-2xs font-normal text-muted-foreground">on {v.basis}</span>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {v ? (
                  <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4 lg:grid-cols-8">
                    {/* Eight, not seven: an odd count leaves a bordered empty
                        cell, and on a page where a blank means "the company did
                        not report this" that reads as missing data. Enterprise
                        value is worth showing beside market cap anyway. */}
                    <Stat className="bg-card" label="Market cap" value={money(v.marketCap)} />
                    <Stat
                      className="bg-card"
                      label="Enterprise value"
                      value={money(v.enterpriseValue)}
                      hint="Market cap plus debt, less cash — what it would cost to buy the whole business outright."
                    />
                    <Stat className="bg-card" label="P/E" value={mult(v.peRatio)} />
                    <Stat className="bg-card" label="P/S" value={mult(v.psRatio)} />
                    <Stat className="bg-card" label="P/B" value={mult(v.pbRatio)} />
                    <Stat className="bg-card" label="EV/EBITDA" value={mult(v.evToEbitda)} />
                    <Stat className="bg-card" label="FCF yield" value={pct(v.fcfYield)} />
                    <Stat className="bg-card" label="Dividend yield" value={pct(v.dividendYield, 2)} />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {data.priceNote ?? 'No price available, so valuation ratios cannot be computed.'}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Profitability. Titled, like the valuation strip above it: two
                unlabelled eight-tile rows read as one sixteen-tile block, and
                nothing said that the second row is one fiscal year while the
                first is priced off today's market. */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Profitability and returns
                  <span className="ml-2 text-2xs font-normal text-muted-foreground">
                    fiscal {last.fiscalYear}, as reported
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4 lg:grid-cols-8">
                  <Stat className="bg-card" label="Revenue" value={money(last.revenue)} sub={pct(last.revenueGrowth)} />
                  <Stat className="bg-card" label="Net income" value={money(last.netIncome)} sub={`EPS ${last.epsDiluted?.toFixed(2) ?? '—'}`} />
                  <Stat className="bg-card" label="Gross margin" value={pct(last.grossMargin)} />
                  <Stat className="bg-card" label="Operating margin" value={pct(last.operatingMargin)} />
                  <Stat className="bg-card" label="Net margin" value={pct(last.netMargin)} />
                  <Stat className="bg-card" label="ROE" value={pct(last.roe)} hint="Net income over shareholders' equity. Very high figures usually mean equity shrunk through buybacks, not that returns improved." />
                  <Stat className="bg-card" label="ROIC" value={pct(last.roic)} hint="Operating income over equity plus debt — the capital the business actually employs." />
                  <Stat
                    className="bg-card"
                    label="Free cash flow"
                    value={money(last.freeCashFlow)}
                    sub={last.fcfMargin != null ? `${pct(last.fcfMargin)} of revenue` : undefined}
                    hint="Operating cash flow less capital expenditure — what the business generated after paying to keep itself running."
                  />
                </div>
              </CardContent>
            </Card>

            <ChartFrame
              title="Revenue and growth"
              description="Bars are revenue; the line is year-over-year growth on the right-hand reading."
            >
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...AXIS_PROPS} dataKey="fy" />
                  <YAxis {...AXIS_PROPS} yAxisId="l" tickFormatter={(x) => formatCurrencyCompact(Number(x))} />
                  <YAxis {...AXIS_PROPS} yAxisId="r" orientation="right" tickFormatter={(x) => `${Number(x).toFixed(0)}%`} />
                  <Bar yAxisId="l" dataKey="revenue" fill={seriesColor('revenue', 0)} isAnimationActive={false} />
                  {/* Not the red slot. Growth is a neutral series, and in the Bloomberg
                      palette red means a fall — a rising line drawn in it reads as
                      the opposite of what it shows. */}
                  <Line yAxisId="r" dataKey="growth" stroke={seriesColor('growth', 1)} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Margins over time"
              description="Gross, operating and net. Widening gaps between them show where the money goes."
            >
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...AXIS_PROPS} dataKey="fy" />
                  <YAxis {...AXIS_PROPS} tickFormatter={(x) => `${Number(x).toFixed(0)}%`} />
                  {(['gross', 'operating', 'net'] as const).map((k, i) => (
                    <Line key={k} dataKey={k} name={k} stroke={seriesColor(k, i)} strokeWidth={2} dot={false} isAnimationActive={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Cash generation"
              description="Operating cash flow against free cash flow. The gap is capital expenditure."
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis {...AXIS_PROPS} dataKey="fy" />
                  <YAxis {...AXIS_PROPS} tickFormatter={(x) => formatCurrencyCompact(Number(x))} />
                  <Bar dataKey="ocf" name="Operating" fill={seriesColor('ocf', 5)} isAnimationActive={false} />
                  <Bar dataKey="fcf" name="Free" fill={seriesColor('fcf', 2)} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            {/* Balance sheet and shares */}
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Balance sheet</CardTitle>
                </CardHeader>
                <CardContent>
                  {/* Net cash is the derived figure, not a sixth line item.
                      Sitting in the run of rows it read as another input; it
                      is what the other five are read to find out. */}
                  <table className="w-full text-xs">
                    <tbody>
                      {([
                        ['Total assets', last.assets],
                        ['Total liabilities', last.liabilities],
                        ["Shareholders' equity", last.equity],
                        ['Cash and equivalents', last.cash],
                        ['Total debt', last.totalDebt],
                      ] as const).map(([label, value]) => (
                        <tr key={label} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 text-muted-foreground">{label}</td>
                          <td className="numeric py-1.5 text-right">{money(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-3 border-t border-border pt-3">
                    <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      Net cash
                    </div>
                    <div className="numeric text-lg font-medium">
                      {money(
                        last.cash != null && last.totalDebt != null
                          ? last.cash - last.totalDebt
                          : null,
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Cash and equivalents less total debt. Negative is net debt.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Shares and dilution</CardTitle>
                </CardHeader>
                <CardContent className="text-xs">
                  {/* The direction of the share count is the answer here, and
                      it was a percentage inside a sentence, at the same weight
                      as the sentence. Lifted above the inputs that produced it. */}
                  {data.dilution && (
                    <div className="mb-3 border-b border-border pb-3">
                      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                        Share count, {data.dilution.years}-year change
                      </div>
                      <div
                        className={cn(
                          'numeric text-lg font-medium',
                          (data.dilution.changePct ?? 0) < 0
                            ? 'text-[hsl(var(--positive))]'
                            : 'text-[hsl(var(--warning))]',
                        )}
                      >
                        {pct(data.dilution.changePct)}
                      </div>
                      <p className="leading-relaxed text-muted-foreground">
                        {(data.dilution.changePct ?? 0) < 0
                          ? 'A buyback, so each remaining share owns more of the company.'
                          : 'Dilution, so each existing share owns less.'}
                      </p>
                    </div>
                  )}
                  <table className="w-full">
                    <tbody>
                      <tr className="border-b border-border/50">
                        <td className="py-1.5 text-muted-foreground">Diluted shares</td>
                        <td className="numeric py-1.5 text-right">
                          {last.sharesDiluted ? `${(last.sharesDiluted / 1e9).toFixed(2)}B` : '—'}
                        </td>
                      </tr>
                      <tr className="border-b border-border/50">
                        <td className="py-1.5 text-muted-foreground">Dividends paid</td>
                        <td className="numeric py-1.5 text-right">{money(last.dividendsPaid)}</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 text-muted-foreground">Payout ratio</td>
                        <td className="numeric py-1.5 text-right">{pct(v?.payoutRatio ?? null)}</td>
                      </tr>
                    </tbody>
                  </table>
                  {data.dilution?.splitNote && (
                    <p className="mt-3 rounded-md border border-border bg-muted/40 p-2.5 leading-relaxed text-[hsl(var(--warning))]">
                      {data.dilution.splitNote}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* History */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Reported history</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {/*
                  Nine columns, not ten, and 46rem rather than 52 — tied for the
                  widest table in the product, and wide enough to scroll
                  sideways on a narrow window or a split screen.

                  Net margin was the column that did not earn its place: it is
                  net income over revenue and both are columns in the same row,
                  it is plotted in full above, and it stays in the CSV export
                  and in the stat strip. The two margins left are grouped under
                  a header, because "Gross" and "Operating" standing alone read
                  as gross profit and operating income.
                */}
                <table className="w-full min-w-[46rem] text-xs">
                  <thead>
                    <tr className="text-2xs uppercase tracking-wide text-muted-foreground">
                      <td colSpan={5} />
                      <th scope="colgroup" colSpan={2} className="pb-1 pr-3 text-right font-medium">
                        Margin
                      </th>
                      <td colSpan={2} />
                    </tr>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">FY</th>
                      <th className="py-2 pr-3 text-right font-medium">Revenue</th>
                      <th className="py-2 pr-3 text-right font-medium">Growth</th>
                      <th className="py-2 pr-3 text-right font-medium">Net income</th>
                      <th className="py-2 pr-3 text-right font-medium">EPS</th>
                      <th className="py-2 pr-3 text-right font-medium">Gross</th>
                      <th className="py-2 pr-3 text-right font-medium">Operating</th>
                      <th className="py-2 pr-3 text-right font-medium">FCF</th>
                      <th className="py-2 text-right font-medium">ROE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...recent].reverse().map((r) => (
                      <tr key={r.end} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-3 font-medium">{r.fiscalYear}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{money(r.revenue)}</td>
                        <td
                          className={cn(
                            'numeric py-1.5 pr-3 text-right',
                            (r.revenueGrowth ?? 0) < 0 && 'text-[hsl(var(--negative))]',
                          )}
                        >
                          {pct(r.revenueGrowth)}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">{money(r.netIncome)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">
                          {r.epsDiluted?.toFixed(2) ?? '—'}
                        </td>
                        <td className="numeric py-1.5 pr-3 text-right">{pct(r.grossMargin, 0)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{pct(r.operatingMargin, 0)}</td>
                        <td className="numeric py-1.5 pr-3 text-right">{money(r.freeCashFlow)}</td>
                        <td className="numeric py-1.5 text-right">{pct(r.roe, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Earnings. Before the news, because the next reporting date is
                the thing most often being looked for. */}
            <EarningsPanel key={`e-${data.company.ticker}`} ticker={data.company.ticker} />

            {/* News. Keyed on the ticker so switching companies remounts it
                rather than showing the previous company's headlines while the
                new ones load. */}
            <CompanyNews key={data.company.ticker} ticker={data.company.ticker} />

            {/* Provenance */}
            {/* Provenance. The tag list was a comma-run of XBRL concept names
                inside a paragraph — the least readable text on the page and the
                hardest to scan for one field. Same content, one chip per tag,
                and the count of the ones the list does not show. */}
            <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Source.</span>{' '}
                {data.provenance.financials}. CIK {data.company.cik}, most recent annual period
                ended {data.provenance.latestFilingDate}.
                {data.provenance.priceSource && ` Price from ${data.provenance.priceSource}.`}
              </p>
              <p className="mt-1.5">
                <span className="font-medium text-foreground">Estimates.</span>{' '}
                {data.provenance.estimatesNote}
              </p>
              <p className="mt-1.5">
                <span className="font-medium text-foreground">Tags read.</span> Filers do not tag
                the same thing the same way, so which concept supplied each figure is recorded
                rather than assumed.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {data.provenance.conceptsUsed.slice(0, 6).map((c) => (
                  <Badge key={c.field} variant="outline" className="font-normal">
                    <span className="text-foreground">{c.field}</span>
                    <span aria-hidden>=</span>
                    <span>{c.concept}</span>
                  </Badge>
                ))}
                {data.provenance.conceptsUsed.length > 6 && (
                  <span className="self-center text-2xs">
                    and {data.provenance.conceptsUsed.length - 6} more, in the CSV
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
