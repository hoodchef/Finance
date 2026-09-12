import { NextResponse } from 'next/server';
import { getProvider } from '@/lib/market-data';
import { backAdjustForSplits } from '@/lib/market-data/adjust';
import { secGetJson } from '@/lib/fundamentals/sec';
import { liveMarketFrom, type LiveMarket } from '@/lib/valuation/asts/market-live';
import { assessFilings, type FilingStatus } from '@/lib/valuation/asts/filings';
import { GLOBAL_ROWS, MODEL_META } from '@/lib/valuation/asts/inputs';
import { SNAPSHOT_ASTS, SNAPSHOT_SPY, SNAPSHOT_TIME } from '@/lib/valuation/asts/market-snapshot';

export const dynamic = 'force-dynamic';

/**
 * Live context for the ASTS valuation: today's price and a re-estimate of the
 * snapshot's market statistics, plus what EDGAR has filed since the model.
 *
 * The model itself runs in the browser — it is pure arithmetic on inputs the
 * page already holds — so this route carries only what the browser cannot get:
 * provider data and SEC filings. The two are fetched independently so a
 * provider outage does not hide the filings check, and each failure is reported
 * as the reason, not as an empty panel.
 */

interface Payload {
  market: LiveMarket | null;
  marketNote: string | null;
  filings: FilingStatus | null;
  filingsNote: string | null;
}

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; payload: Payload } | null = null;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

async function loadCloses(symbol: string) {
  const series = await getProvider().getHistoricalPrices(symbol, { start: daysAgo(780), end: today() });
  // Raw prices carry splits as separate events; a series left raw would put a
  // split into the regression as a return that never happened.
  const bars = backAdjustForSplits(
    series.bars.map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    series.splits,
    series.adjustment,
  );
  return { closes: bars.map((b) => ({ date: b.date, close: b.close })), source: series.source, synthetic: series.synthetic };
}

async function market(): Promise<Pick<Payload, 'market' | 'marketNote'>> {
  try {
    const [a, s] = await Promise.all([loadCloses(MODEL_META.ticker), loadCloses('SPY')]);
    if (a.synthetic || s.synthetic) {
      return { market: null, marketNote: 'The app is running on demo data. A live comparison is shown only for observed prices.' };
    }
    const blumeW = GLOBAL_ROWS.find((r) => r.key === 'blume_w')?.value ?? 0.67;
    const live = liveMarketFrom(a.closes, s.closes, blumeW, { time: SNAPSHOT_TIME, asts: SNAPSHOT_ASTS, spy: SNAPSHOT_SPY }, a.source);
    if (!live) return { market: null, marketNote: 'Too little overlapping weekly history to re-estimate beta.' };
    return { market: live, marketNote: null };
  } catch (e) {
    return { market: null, marketNote: `Live prices unavailable: ${e instanceof Error ? e.message : 'provider error'}.` };
  }
}

async function filings(): Promise<Pick<Payload, 'filings' | 'filingsNote'>> {
  try {
    const cik = MODEL_META.cik.padStart(10, '0');
    const sub = await secGetJson<Parameters<typeof assessFilings>[0]>(`https://data.sec.gov/submissions/CIK${cik}.json`);
    return { filings: assessFilings(sub), filingsNote: null };
  } catch (e) {
    return { filings: null, filingsNote: `SEC EDGAR unavailable: ${e instanceof Error ? e.message : 'request failed'}.` };
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.payload);
  const [m, f] = await Promise.all([market(), filings()]);
  const payload: Payload = { ...m, ...f };
  // Cache only a complete answer, so a transient failure is retried on the next load.
  if (payload.market && payload.filings) cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
