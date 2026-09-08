import { NextResponse } from 'next/server';
import { getProvider } from '@/lib/market-data';
import { errorResponse } from '@/lib/api-errors';
import { parseSymbol } from '@/lib/validate';
import {
  flowPressure,
  momentumAgreement,
  momentumTermStructure,
  participationProfile,
  rangeState,
  volatilityCone,
  type Bar,
} from '@/lib/desk/models';
import { buildTailRidge } from '@/lib/desk/tails';
import { buildRegimeLattice } from '@/lib/desk/regime-lattice';
import { fetchAggregates } from '@/lib/market-data/polygon';
import { normaliseAggregates } from '@/lib/charting/bars';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything the desk shows for one security, from one request.
 * =============================================================================
 * Two series, because the panels ask two different questions. The daily series
 * carries two years of history, which is what momentum across horizons and a
 * volatility cone need. The intraday series carries the last few sessions of
 * five-minute bars, which is what the participation profile needs and which
 * daily bars cannot answer at any length.
 *
 * They are fetched together and fail independently: intraday is the one most
 * likely to be unavailable — a plan without it, a symbol without it, a market
 * that has not opened — and losing it must not cost the reader the rest of the
 * screen. A panel with no data says so; nothing here is filled in.
 */

/*
 * Seven years, not two.
 *
 * The regime lattice spends its first 200 trading days establishing the trend
 * average and classifies nothing until then, so a two-year window left ~348
 * classified days spread over 21 occupied vertices — about twenty overlapping
 * observations each, which is not enough to report a forward return from. The
 * end-of-day chain carries the full record and this is one request, so the
 * lattice gets the history it needs to say anything at all.
 */
const DAILY_LOOKBACK_DAYS = 2600;
const INTRADAY_LOOKBACK_DAYS = 12;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = parseSymbol(url.searchParams.get('symbol') ?? '', 'symbol');
    const to = iso(new Date());

    const [daily, intraday] = await Promise.all([
      loadDaily(symbol, to),
      // Allowed to fail: the desk is still worth showing without it.
      loadIntraday(symbol, to).catch(() => null),
    ]);

    if (!daily.length) {
      return NextResponse.json(
        {
          error:
            `No price history came back for ${symbol}. It may not be a listed symbol, or the ` +
            'provider may be rate-limited — the desk shows nothing rather than a blank chart.',
          kind: 'data',
        },
        { status: 404 },
      );
    }

    const closes = daily.map((b) => b.close);
    const momentum = momentumTermStructure(closes);
    const cone = volatilityCone(closes, 252);

    /*
     * The ridge uses the LONGEST realised-volatility window, not the shortest.
     *
     * The tail comparison sets its threshold from this figure and then counts
     * how often the security's history crossed it, so the two have to be
     * measured over the same period or the ratio conflates two different
     * things. Calibrated to the 21-day figure, SPY's threshold came from a
     * moment at the 4th percentile of its own volatility history and was then
     * compared against seven years that included far wilder regimes — which
     * reported an ×6 fat tail that was mostly just "today is quiet".
     *
     * The one-year window is the most representative of the sample being
     * counted. How volatile the security is RIGHT NOW is the question the
     * cone above answers, and it answers it at six horizons at once.
     */
    const volLong =
      cone.find((r) => r.window === 252)?.current ??
      cone.find((r) => r.window === 126)?.current ??
      cone.find((r) => r.window === 21)?.current ??
      null;
    const tails = volLong != null ? buildTailRidge({ closes, volatility: volLong }) : null;
    const last = daily[daily.length - 1];
    const prev = daily.length > 1 ? daily[daily.length - 2] : null;

    return NextResponse.json({
      symbol,
      asOf: last.date,
      last: {
        close: last.close,
        open: last.open,
        high: last.high,
        low: last.low,
        volume: last.volume,
        change: prev ? last.close - prev.close : null,
        changePct: prev && prev.close > 0 ? (last.close - prev.close) / prev.close : null,
      },
      momentum: { rungs: momentum, agreement: momentumAgreement(momentum) },
      // Flow over the last quarter: long enough for a trend to be visible,
      // short enough that a change of regime is not buried under two years.
      flow: flowPressure(daily.slice(-63)),
      // Daily bars, so √252 is the right annualiser.
      volatility: cone,
      tails,
      lattice: buildRegimeLattice(daily),
      range: rangeState(daily),
      participation: intraday ? participationProfile(intraday, 30) : null,
      intradayAvailable: Boolean(intraday?.length),
      coverage: {
        dailyBars: daily.length,
        from: daily[0].date,
        to: last.date,
        intradayBars: intraday?.length ?? 0,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Daily bars, preferring the end-of-day chain for depth.
 *
 * The aggregate vendor caps this plan at roughly two years whatever is asked
 * for, so the end-of-day providers are tried first here — they carry the full
 * record, and the momentum and volatility panels are the ones that need it.
 */
async function loadDaily(symbol: string, to: string): Promise<Bar[]> {
  const from = daysAgo(DAILY_LOOKBACK_DAYS);
  const series = await getProvider()
    .getHistoricalPrices(symbol, { start: from, end: to })
    .catch(() => null);

  if (series?.bars.length) {
    return series.bars.map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
  }

  const agg = await fetchAggregates(symbol, 'day', from, to, 1);
  return normaliseAggregates(agg.bars, 'day').bars.map((b) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/** Five-minute bars over the last couple of weeks, for the session profile. */
async function loadIntraday(symbol: string, to: string): Promise<Bar[]> {
  const agg = await fetchAggregates(symbol, 'minute', daysAgo(INTRADAY_LOOKBACK_DAYS), to, 5);
  return normaliseAggregates(agg.bars, 'minute').bars.map((b) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}
