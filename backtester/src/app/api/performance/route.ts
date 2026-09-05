import { NextResponse } from 'next/server';
import { runBacktest } from '@/lib/backtest';
import { buildReport } from '@/lib/metrics/report';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseConfig, parsePortfolio, ValidationError } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The full statistics table for one portfolio.
 *
 * Runs the same engine the backtest page runs and reports far more of what it
 * produced. Nothing here is a second calculation of a figure the backtest
 * already shows — a page quoting a different Sharpe from the one two clicks
 * away is worse than a page with fewer numbers on it.
 *
 * The benchmark is passed through `config.benchmarks`, because that is what the
 * engine already uses to align a comparison series to the portfolio's own
 * trading calendar. Aligning it here instead would mean two implementations of
 * the same join, which is how alpha and beta come to be computed over
 * different date sets.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const portfolio = parsePortfolio(body.portfolio);
    const base = parseConfig(body.config);

    const benchmark =
      typeof body.benchmark === 'string' && body.benchmark.trim()
        ? body.benchmark.trim().toUpperCase()
        : null;

    // The requested benchmark leads, so it is the one the engine uses for the
    // relative statistics. Any others the config carried are kept for the chart.
    const config = benchmark
      ? { ...base, benchmarks: [benchmark, ...base.benchmarks.filter((b) => b !== benchmark)] }
      : base;

    const result = await runBacktest({
      portfolio,
      config,
      provider: getProvider(),
      includeAssetAnalysis: false,
      // Statistics must not be measured on `result.series`, which is thinned to
      // about 1,600 points for charting. On a ten-year run each of those spans
      // two trading days, and every per-period figure derived from them doubles
      // silently — the expected annual return comes back at twice the CAGR
      // printed two rows above it, and neither number looks wrong.
      includeDailyObservations: true,
    });

    const observed = result.dailyObservations;
    if (!observed || observed.dates.length < 3) {
      throw new ValidationError(
        'Not enough history to compute performance statistics. Widen the date range, or check ' +
          'that the holdings priced over the window you chose.',
        'dates',
      );
    }

    // Share of capital actually at risk, averaged over the window. Risk-adjusted
    // return divides by this; a portfolio that sat half in cash did not take a
    // fully-invested portfolio's risk to earn what it earned.
    const exposure =
      observed.investedShare.reduce((a, b) => a + b, 0) / observed.investedShare.length;

    const primary = result.benchmarks[0] ?? null;
    const report = buildReport({
      metrics: result.metrics,
      dates: observed.dates,
      index: observed.index,
      // Null unless the benchmark ran the identical calendar, so alpha and beta
      // are never computed by pairing days that are not the same day.
      benchmarkIndex: observed.benchmarkIndex ?? undefined,
      benchmark:
        primary && observed.benchmarkIndex
          ? { symbol: primary.symbol, name: primary.name }
          : undefined,
      exposure: Number.isFinite(exposure) ? exposure : undefined,
    });

    return NextResponse.json({
      report,
      portfolio: { id: portfolio.id, name: portfolio.name },
      series: result.series.map((p) => ({
        date: p.date,
        index: p.index,
        drawdown: p.drawdown,
      })),
      benchmarkSeries: primary
        ? primary.series.map((p) => ({ date: p.date, index: p.index, drawdown: p.drawdown }))
        : null,
      monthly: result.metrics.monthly,
      annual: result.metrics.annual,
      drawdowns: result.metrics.drawdowns.slice(0, 12),
      warnings: result.warnings,
      dataSource: result.dataSource ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
