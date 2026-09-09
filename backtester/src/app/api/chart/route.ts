import { NextResponse } from 'next/server';
import { getProvider } from '@/lib/market-data';
import type { PriceBar } from '@/lib/types';
import {
  fetchAggregates,
  fetchDividends,
  fetchSplits,
  fetchTickerDetail,
  fetchTickerEvents,
  polygonConfigured,
} from '@/lib/market-data/polygon';
import { normaliseAggregates, type ChartTimespan } from '@/lib/charting/bars';
// The EOD fallbacks below return RAW prices with a separate split list. Without
// this the chart drew AAPL stepping from $499 to $129 overnight. See adjust.ts.
import { backAdjustForSplits } from '@/lib/market-data/adjust';
import { computeIndicators, parseIndicatorSpec } from '@/lib/charting/indicators';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Price history, indicators and corporate events for one security.
 *
 * Corporate actions are fetched alongside the bars because a chart without
 * them misleads: a 4-for-1 split reads as a 75% crash, and a dividend explains
 * a gap that otherwise looks like a data error. They are requested in parallel
 * and each is allowed to fail on its own — the price series is the thing the
 * page cannot do without.
 */

const SPANS: ChartTimespan[] = ['minute', 'hour', 'day', 'week', 'month'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const ticker = String(body.ticker ?? '').trim().toUpperCase().slice(0, 24);
    if (!/^[A-Z0-9.:\-]{1,24}$/.test(ticker)) {
      return NextResponse.json({ error: 'Enter a ticker.', kind: 'request' }, { status: 400 });
    }
    if (!polygonConfigured()) {
      return NextResponse.json(
        {
          error:
            'No Polygon API key is configured, so no price history can be loaded. ' +
            'Set POLYGON_API_KEY in .env.local to enable charting.',
          kind: 'configuration',
        },
        { status: 503 },
      );
    }

    const timespan: ChartTimespan = SPANS.includes(body.timespan) ? body.timespan : 'day';
    const multiplier = Number.isFinite(body.multiplier)
      ? Math.max(1, Math.min(60, Math.round(body.multiplier)))
      : 1;
    const to = ISO.test(body.to) ? body.to : new Date().toISOString().slice(0, 10);
    const from = ISO.test(body.from)
      ? body.from
      : new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

    /*
     * Polygon first, then the rest of the chain.
     *
     * Polygon is asked first because it is the only source here that serves
     * crypto and option contracts, and because its aggregates carry the
     * coverage information the truncation check needs. But its free plan
     * allows about five requests a minute, and wiring the chart to it alone
     * made that one ceiling the whole application's — a five-symbol
     * optimisation stopped on it.
     *
     * Falling through to `getProvider()` puts Tiingo's separate hourly budget
     * behind it, so the allowances add up rather than compete, and a symbol
     * Polygon will not serve is still answered.
     */
    let bars: Awaited<ReturnType<typeof normaliseAggregates>>['bars'] = [];
    let dropped = 0;
    let coverage: Awaited<ReturnType<typeof fetchAggregates>>['coverage'] | null = null;
    let servedBy = 'polygon';
    let fallbackNote: string | null = null;

    try {
      const primary = await fetchAggregates(ticker, timespan, from, to, multiplier);
      coverage = primary.coverage;
      // normaliseAggregates reports what it discarded; a bar the vendor sent
      // that could not be parsed is a gap worth surfacing, not a silent
      // omission.
      const normalised = normaliseAggregates(primary.bars, timespan);
      bars = normalised.bars;
      dropped = normalised.dropped;

      /*
       * A truncated answer is not a successful one.
       * =====================================================================
       * `fetchAggregates` already detects that this Polygon plan returns two
       * years and stops, whatever was asked for — it sets `coverage.truncated`
       * and writes the note. Nothing acted on it here, because the request did
       * not THROW: a five-year chart and a twenty-year chart both came back
       * with the same 501 bars and both rendered as if that were the history.
       *
       * The end-of-day providers carry the full record — the backtest engine
       * runs on decades of it — so a truncated daily request is retried there
       * and the deeper answer wins. Only for daily bars: no EOD vendor can
       * serve a minute, and week and month would have to be re-aggregated
       * from days before they could be compared.
       */
      if (timespan === 'day' && coverage?.truncated) {
        const deeper = await getProvider()
          .getHistoricalPrices(ticker, { start: from, end: to })
          .catch(() => null);
        if (deeper && deeper.bars.length > bars.length) {
          bars = backAdjustForSplits(deeper.bars, deeper.splits, deeper.adjustment).map((b: PriceBar) => ({
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            vwap: null,
            trades: null,
            timestamp: Date.parse(`${b.date}T00:00:00Z`),
          }));
          servedBy = deeper.source;
          coverage = null;
          fallbackNote =
            `Polygon returned only ${normalised.bars.length} bars for this range, so the ` +
            `history came from ${deeper.source} instead.`;
        }
      }
    } catch (primaryError) {
      const series = await getProvider()
        .getHistoricalPrices(ticker, { start: from, end: to })
        .catch(() => null);
      if (!series || series.bars.length === 0) throw primaryError;

      bars = backAdjustForSplits(series.bars, series.splits, series.adjustment).map((b: PriceBar) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        // The other providers report neither, and null is the honest value —
        // zero would render as a real VWAP of nothing.
        vwap: null,
        trades: null,
        timestamp: Date.parse(`${b.date}T00:00:00Z`),
      }));
      servedBy = series.source;
      fallbackNote =
        `Polygon could not serve this request, so it came from ${series.source}. ` +
        (primaryError instanceof Error ? primaryError.message : '');
    }

    // Everything below is additive. A failure here must not lose the prices.
    const [detail, dividends, splits, tickerEvents] = await Promise.all([
      fetchTickerDetail(ticker).catch(() => null),
      fetchDividends(ticker).catch(() => []),
      fetchSplits(ticker).catch(() => []),
      fetchTickerEvents(ticker).catch(() => []),
    ]);

    const inWindow = (d?: string) => Boolean(d && d >= from && d <= to);
    const events = [
      ...dividends
        .filter((d) => inWindow(d.ex_dividend_date))
        .map((d) => ({
          date: d.ex_dividend_date!,
          kind: 'dividend' as const,
          label: d.cash_amount != null ? `Dividend $${d.cash_amount.toFixed(2)}` : 'Dividend',
        })),
      ...splits
        .filter((s) => inWindow(s.execution_date))
        .map((s) => ({
          date: s.execution_date!,
          kind: 'split' as const,
          label:
            s.split_to && s.split_from
              ? `Split ${s.split_to}-for-${s.split_from}`
              : 'Split',
        })),
      ...tickerEvents
        .filter((e) => inWindow(e.date))
        .map((e) => ({
          date: e.date!,
          kind: 'ticker-change' as const,
          label: `Ticker change${e.ticker_change?.ticker ? ` to ${e.ticker_change.ticker}` : ''}`,
        })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));

    const specs = Array.isArray(body.indicators)
      ? body.indicators.map(parseIndicatorSpec).filter(Boolean)
      : [];
    /*
     * `computeIndicators` returns a map keyed by spec id, where a multi-line
     * study (MACD, Bollinger) is one entry holding several series. The chart
     * consumes a flat list of overlays, each with its own axis. Flattening
     * here rather than in the component keeps the axis decision — which
     * studies belong on the price and which need their own pane — next to the
     * definitions of the studies themselves.
     */
    const computed = specs.length ? computeIndicators(bars, specs) : {};
    const overlays: Array<{
      id: string;
      label: string;
      points: Array<number | null>;
      axis: 'price' | 'separate';
    }> = [];
    for (const [id, value] of Object.entries(computed)) {
      // Oscillators are unbounded relative to price and must not share its axis.
      const separate = id.startsWith('rsi') || id.startsWith('macd');
      const axis = separate ? ('separate' as const) : ('price' as const);
      if (Array.isArray(value)) {
        overlays.push({ id, label: id.toUpperCase(), points: value, axis });
        continue;
      }
      for (const [part, series] of Object.entries(value)) {
        if (!Array.isArray(series)) continue;
        overlays.push({
          id: `${id}:${part}`,
          label: `${id.toUpperCase()} ${part}`,
          points: series as Array<number | null>,
          axis,
        });
      }
    }

    return NextResponse.json({
      ticker,
      name: detail?.name ?? null,
      timespan,
      bars,
      overlays,
      events,
      dropped,
      /*
       * `fallbackNote` was computed on both fallback paths and never returned,
       * so a chart served by a different vendor than the one it named said
       * nothing about it.
       */
      note:
        bars.length === 0
          ? `Polygon returned no bars for ${ticker} in this window. The free tier carries about ` +
            'two years of history and end-of-day data only.'
          : fallbackNote,
      provenance: {
        /*
         * Whoever actually served it.
         *
         * This was hardcoded to Polygon, so a request Polygon could not fill —
         * anything past its two-year ceiling, or any symbol it refused — came
         * back from Tiingo or Yahoo under Polygon's name. The panel that exists
         * to say where a number came from was naming the wrong vendor.
         */
        source: servedBy === 'polygon' ? 'Polygon (Massive)' : servedBy,
        // The free tier is end-of-day. Saying "real time" here would be the
        // kind of quiet inaccuracy someone trades on.
        latency: 'end-of-day, adjusted for splits and dividends',
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
