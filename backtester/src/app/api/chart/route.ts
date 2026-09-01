import { NextResponse } from 'next/server';
import {
  fetchAggregates,
  fetchDividends,
  fetchSplits,
  fetchTickerDetail,
  fetchTickerEvents,
  polygonConfigured,
} from '@/lib/market-data/polygon';
import { normaliseAggregates, type ChartTimespan } from '@/lib/charting/bars';
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

    const aggregates = await fetchAggregates(ticker, multiplier, timespan, from, to);
    // normaliseAggregates reports what it discarded; a bar Polygon sent that
    // could not be parsed is a gap worth surfacing, not a silent omission.
    const { bars, dropped } = normaliseAggregates(aggregates, timespan);

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
    const overlays = specs.length ? computeIndicators(bars, specs) : [];

    return NextResponse.json({
      ticker,
      name: detail?.name ?? null,
      timespan,
      bars,
      overlays,
      events,
      dropped,
      note:
        bars.length === 0
          ? `Polygon returned no bars for ${ticker} in this window. The free tier carries about ` +
            'two years of history and end-of-day data only.'
          : null,
      provenance: {
        source: 'Polygon (Massive)',
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
