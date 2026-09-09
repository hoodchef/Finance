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
import { benchmarkRelation, peerRelativeStrength } from '@/lib/desk/relative';
import { liquidityProfile } from '@/lib/desk/liquidity';
import { drawdownTopology } from '@/lib/desk/drawdown-topology';
import { sessionSplit } from '@/lib/desk/session-split';
import { volatilityPersistence } from '@/lib/desk/vol-persistence';
import {
  fetchAggregates,
  fetchRelatedCompanies,
  fetchTickerDetail,
  polygonConfigured,
} from '@/lib/market-data/polygon';
import { isCanadianSymbol } from '@/lib/market-data/alphavantage';
import { normaliseSymbol } from '@/lib/market-data/symbol';
import { normaliseAggregates } from '@/lib/charting/bars';
// Tiingo returns RAW prices and declares `adjustment: 'raw'`. The backtest
// engine reads that declaration and applies the splits; every route that read
// `bars` and ignored `splits` was charting a cliff. See `adjust.ts`.
import { backAdjustForSplits } from '@/lib/market-data/adjust';
// Derived from the median gap between observations, not assumed. One
// definition, shared with the distribution lab.
import { periodsPerYear } from '@/lib/lattice/realized';

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

/*
 * The comparison set, and what it costs.
 * -----------------------------------------------------------------------
 * Three things below are new and each is measured against a REQUEST BUDGET
 * rather than against what would be nice to show. The budget is not
 * theoretical: firing eight Polygon requests in 839ms on this key returned
 * three HTTP 429s (verified 2026-09-09), so the free tier's ~5/minute is a
 * hard ceiling and this route is not the only thing spending it.
 *
 * Polygon is asked for exactly two more things per view — the reference
 * profile and the peer list, one request each, alongside the intraday bars
 * this route already fetched. That leaves headroom inside the minute.
 *
 * Everything else — the benchmark, and every peer's history — goes to the
 * end-of-day chain, which is a separate budget (Tiingo ~50/hour) and which
 * caches full history per symbol for twelve hours. A cold view of a stock
 * therefore costs one benchmark fetch plus one per peer, and the second view
 * of anything in the same cohort costs none of them.
 *
 * PEER_LIMIT is six for that reason and not because six is analytically
 * right. Tiingo's free tier also caps UNIQUE SYMBOLS at 500/month, and an
 * uncapped peer list would spend that budget on names nobody asked to see.
 */
const PEER_LIMIT = 6;

/**
 * Enough calendar days to cover the longest horizon compared (252 sessions)
 * with room for holidays. Peers are only ever measured over that, so asking
 * for the full 2,600-day window would move history nothing reads.
 */
const PEER_LOOKBACK_DAYS = 500;

/**
 * The benchmark, chosen from where the security is LISTED.
 *
 * A CAD-denominated listing measured against SPY does not produce a market
 * beta; it produces a beta contaminated by USDCAD, because one leg is priced
 * in a currency the other is not. The number looks entirely ordinary and is
 * answering a question nobody asked. So a Canadian listing is compared against
 * a Canadian benchmark or against nothing at all.
 *
 * Returns null when the security IS the benchmark. Regressing a series on
 * itself returns beta 1.000 and correlation 1.000 — arithmetically correct,
 * and read as a finding by anyone who glances at it.
 */
function benchmarkFor(symbol: string): string | null {
  const s = normaliseSymbol(symbol);
  const benchmark = isCanadianSymbol(s) ? 'XIC.TO' : 'SPY';
  return normaliseSymbol(benchmark) === s ? null : benchmark;
}

/**
 * Peer tickers, de-duplicated by share class and capped.
 *
 * Polygon's cohort routinely names two classes of one issuer — AAPL's list
 * carries both GOOG and GOOGL, BRK.B's carries BRK.A — and two classes of one
 * company are one comparable, counted twice. Classes written with a separator
 * are detected structurally and collapsed to the first.
 *
 * GOOG against GOOGL is NOT detectable this way: nothing in either string says
 * they share an issuer, and the only field that would (the CIK on the detail
 * endpoint) costs a request per peer, which is the whole budget. They are left
 * in, and the peer list is returned in full so a reader can see it happened.
 */
function selectPeers(related: readonly string[], subject: string): string[] {
  const subjectSymbol = normaliseSymbol(subject);
  const roots = new Set<string>([subjectSymbol.split('-')[0]]);
  const out: string[] = [];

  for (const raw of related) {
    const symbol = normaliseSymbol(raw);
    if (!symbol || symbol === subjectSymbol) continue;
    const root = symbol.split('-')[0];
    if (roots.has(root)) continue;
    roots.add(root);
    out.push(symbol);
    if (out.length >= PEER_LIMIT) break;
  }
  return out;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = parseSymbol(url.searchParams.get('symbol') ?? '', 'symbol');
    const to = iso(new Date());

    const benchmarkSymbol = benchmarkFor(symbol);
    const polygon = polygonConfigured();

    /*
     * Fetched together, and every one of the new legs is allowed to fail.
     *
     * The rule these follow is the one the intraday series already followed:
     * losing a panel must not cost the reader the rest of the screen. What is
     * different about the new ones is that failure has to be REPORTED, not
     * just absorbed — a peer panel that is empty because Polygon named no
     * peers and one that is empty because the request was throttled look
     * identical on screen, and they mean opposite things.
     */
    const [daily, intraday, benchmarkBars, reference, related] = await Promise.all([
      loadDaily(symbol, to),
      // Allowed to fail: the desk is still worth showing without it.
      loadIntraday(symbol, to).catch(() => null),
      benchmarkSymbol
        ? loadComparison(benchmarkSymbol, to).catch(() => null)
        : Promise.resolve(null),
      polygon ? fetchTickerDetail(symbol) : Promise.resolve(null),
      polygon ? fetchRelatedCompanies(symbol) : Promise.resolve([]),
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

    /*
     * The observation frequency is MEASURED, not assumed.
     *
     * Not every listing comes back daily. Canadian tickers are served weekly —
     * Alpha Vantage's daily adjusted endpoint is premium — so XEQT.TO arrives
     * as one bar a week. Annualising that by sqrt(252) instead of sqrt(52)
     * overstates its volatility by a factor of 2.2: the cone reported 25.1%
     * where the truth is about 11.4%, and the tail ridge is drawn from that
     * same figure, so the error propagates into every horizon on it.
     *
     * The backtest engine already gets this right and warns about it. There is
     * no reason for the desk to assume where the engine measures.
     */
    const perYear = periodsPerYear(daily.map((b) => ({ date: b.date, close: b.close })));
    const momentum = momentumTermStructure(closes);
    const cone = volatilityCone(closes, perYear);

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
    const tails =
      volLong != null ? buildTailRidge({ closes, volatility: volLong, periodsPerYear: perYear }) : null;
    const last = daily[daily.length - 1];
    const prev = daily.length > 1 ? daily[daily.length - 2] : null;

    /*
     * The peer cohort, fetched only once Polygon has named one.
     *
     * Sequential after the first batch by necessity — the peer list has to
     * exist before its members can be priced — and the reason the cap is small
     * is that this is the one leg whose cost scales with a vendor's answer
     * rather than with the request.
     */
    const peerSymbols = selectPeers(related, symbol);
    const peerBars = await Promise.all(
      peerSymbols.map(async (peer) => ({
        symbol: peer,
        bars: await loadComparison(peer, to).catch(() => null),
      })),
    );

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
      volatility: cone,
      tails,
      lattice: buildRegimeLattice(daily),
      /*
       * Three more over the same daily series.
       *
       * Recovery topology and the persistence matrix both need depth more than
       * recency, and the seven-year window the lattice already forced is what
       * makes them reportable: two years holds perhaps one -20% drawdown,
       * which is an anecdote rather than a conditional distribution.
       *
       * The session split is NOT given ex-dividend dates here. The data
       * agent's `loadDaily` returns bars alone, so passing none is the honest
       * call — the module's own default. Every distribution therefore lands on
       * the overnight leg, which overstates the overnight loss for a high
       * yielder, and `sessionSplit` says so in its own output rather than
       * being quietly wrong. Wiring the dividend feed through is a follow-up,
       * not something to fake at the call site.
       */
      drawdownTopology: drawdownTopology(daily),
      sessionSplit: sessionSplit(daily),
      volPersistence: volatilityPersistence(closes),
      range: rangeState(daily),
      participation: intraday ? participationProfile(intraday, 30) : null,
      intradayAvailable: Boolean(intraday?.length),
      /**
       * What one bar actually is.
       *
       * The horizon labels above — 1D, 1W, 1M — count BARS, so on a weekly
       * series "1M" is twenty-one weeks rather than twenty-one days. Rather
       * than silently relabel them, the resolution is reported and the page
       * says what it means. Quietly correct arithmetic under a wrong label is
       * the worse of the two failures.
       */
      resolution: {
        periodsPerYear: perYear,
        interval: perYear >= 200 ? 'daily' : perYear >= 40 ? 'weekly' : 'monthly',
        daily: perYear >= 200,
      },
      coverage: {
        dailyBars: daily.length,
        from: daily[0].date,
        to: last.date,
        intradayBars: intraday?.length ?? 0,
      },

      /* ---- Additive from here down. Nothing above changed shape. ---- */

      /**
       * How much of this security's movement is the market, and how much is
       * its own. `unavailable` carries the reason whenever `relation` is null,
       * because "no benchmark" and "benchmark unreachable" are different facts
       * and a blank panel states neither.
       */
      benchmark: buildBenchmarkField(daily, benchmarkBars, benchmarkSymbol),

      /** Leading or lagging the companies the vendor names as comparables. */
      peers: buildPeerField(daily, peerSymbols, peerBars, related, polygon),

      /**
       * Whether the thing is tradable, from the volume already in `daily`.
       * Always present: these are the bars every other panel was computed
       * from, so if the desk can render at all, it can answer this.
       */
      liquidity: liquidityProfile(daily, {
        // The class's own share count, not the issuer's weighted total: the
        // volume being divided is volume in this class. See TickerHit.
        sharesOutstanding: reference?.sharesOutstanding ?? null,
        sharesBasis: reference?.sharesOutstanding
          ? 'polygon:share_class_shares_outstanding'
          : null,
      }),

      /**
       * Reference facts the price feed does not carry, from the same request
       * the share count came from.
       *
       * `industry` is Polygon's SIC description and is labelled as such rather
       * than as a "sector": SIC is a 1987 government classification, not GICS,
       * and the two disagree about where a company belongs often enough that
       * calling one by the other's name would be wrong on screen. ETFs carry
       * no SIC code at all — verified on SPY and XLK — so this is frequently
       * null and that is the vendor's answer, not a gap to fill.
       */
      reference: reference
        ? {
            name: reference.name,
            type: reference.type ?? null,
            industry: reference.sicDescription ?? null,
            sicCode: reference.sicCode ?? null,
            marketCap: reference.marketCap ?? null,
            sharesOutstanding: reference.sharesOutstanding ?? null,
            listDate: reference.listDate ?? null,
            source: 'polygon:reference/tickers',
          }
        : null,
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
    return backAdjustForSplits(
      series.bars.map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
      series.splits,
      series.adjustment,
    );
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

/**
 * Daily bars for something the subject is being COMPARED against.
 *
 * Deliberately not `loadDaily`. Two differences, and both are about not
 * spending the subject's budget on its supporting cast:
 *
 * 1. It never falls through to Polygon aggregates. Six peers falling back
 *    would be six requests against a ceiling empirically measured at five a
 *    minute, which would throttle the intraday series the desk actually
 *    needs. A comparison the end-of-day chain cannot serve is dropped.
 * 2. It asks for 500 days rather than 2,600. Nothing compares over more than
 *    252 sessions, and the extra history would be fetched, parsed and
 *    discarded.
 */
async function loadComparison(symbol: string, to: string): Promise<Bar[] | null> {
  const series = await getProvider()
    .getHistoricalPrices(symbol, { start: daysAgo(PEER_LOOKBACK_DAYS), end: to })
    .catch(() => null);
  if (!series?.bars.length) return null;
  /*
   * Adjusted on the same terms as the subject.
   *
   * A peer or benchmark left raw while the subject is adjusted is worse than
   * both being raw: the correlation and beta are then measured between one
   * real return series and one containing a fabricated 135% day, and the
   * result looks like a number rather than an error.
   */
  return backAdjustForSplits(
    series.bars.map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
    series.splits,
    series.adjustment,
  );
}

/**
 * The benchmark field, including the reason when there is nothing to show.
 *
 * Every null path names itself. A reader looking at an empty relative-strength
 * panel has to be able to tell "this IS the benchmark" from "Yahoo is blocking
 * this IP again", because one is permanent and one clears on its own.
 */
function buildBenchmarkField(
  daily: readonly Bar[],
  benchmarkBars: Bar[] | null,
  benchmarkSymbol: string | null,
) {
  if (!benchmarkSymbol) {
    return {
      symbol: null,
      relation: null,
      unavailable:
        'This security is the benchmark. Measuring it against itself returns a beta of 1.00 ' +
        'and tells you nothing, so no comparison is shown.',
    };
  }
  if (!benchmarkBars?.length) {
    return {
      symbol: benchmarkSymbol,
      relation: null,
      unavailable:
        `No history came back for the benchmark ${benchmarkSymbol}. The end-of-day chain does ` +
        'not carry it, or is rate-limited — nothing is estimated from a benchmark that was ' +
        'never fetched.',
    };
  }

  const relation = benchmarkRelation(daily, benchmarkBars, benchmarkSymbol);
  if (!relation) {
    return {
      symbol: benchmarkSymbol,
      relation: null,
      unavailable:
        `${benchmarkSymbol} and this security have fewer than two sessions in common, which ` +
        'cannot support any comparison.',
    };
  }
  return { symbol: benchmarkSymbol, relation, unavailable: null };
}

/**
 * The peer field, including the reason when there is no cohort.
 *
 * The three empty cases are genuinely different and are reported as such: no
 * Polygon key at all, a key that produced no cohort — which is the ordinary
 * answer for an ETF and for anything Polygon does not cover — and a cohort
 * whose members could not be priced.
 */
function buildPeerField(
  daily: readonly Bar[],
  peerSymbols: readonly string[],
  peerBars: ReadonlyArray<{ symbol: string; bars: Bar[] | null }>,
  related: readonly string[],
  polygonAvailable: boolean,
) {
  if (!polygonAvailable) {
    return {
      cohort: null,
      unavailable:
        'The peer list comes from Polygon and POLYGON_API_KEY is not set. No cohort is ' +
        'assembled from a sector guess.',
    };
  }
  if (!related.length) {
    return {
      cohort: null,
      unavailable:
        'Polygon named no comparable companies for this security. Verified 2026-09-09: the ' +
        'endpoint answers with no result set for ETFs and for tickers it does not cover, and ' +
        'a cohort is not invented to fill the panel.',
    };
  }
  if (!peerSymbols.length) {
    return {
      cohort: null,
      unavailable:
        'Every company Polygon named is another share class of this same issuer, so there is ' +
        'nothing to compare against.',
    };
  }

  return {
    cohort: peerRelativeStrength(daily, peerBars, { source: 'polygon:related-companies' }),
    unavailable: null,
  };
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
