import type {
  CorporateActions,
  DateRange,
  DividendEvent,
  IsoDate,
  PriceBar,
  PriceSeries,
  SecurityMeta,
  SplitEvent,
} from '@/lib/types';
import type { MarketDataProvider } from './provider';
import { addDays, fromIso, toIso, todayIso } from './dates';

/**
 * Deterministic synthetic market data, used when the live provider is
 * unreachable or when someone wants a reproducible demo.
 *
 * THIS IS NOT MARKET DATA. Every number here is generated from a seeded
 * random walk. `synthetic: true` propagates all the way to the results page,
 * which refuses to render without a prominent banner saying so — a backtest on
 * invented prices that *looks* like a real one is worse than no backtest.
 */

/** mulberry32 — small, fast, fully deterministic from a 32-bit seed. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSymbol(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Box–Muller, so the walk is genuinely normal rather than uniform-ish. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number): IsoDate {
  const first = new Date(Date.UTC(y, m, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toIso(new Date(Date.UTC(y, m, 1 + offset + (n - 1) * 7)));
}

function lastWeekdayOfMonth(y: number, m: number, weekday: number): IsoDate {
  const last = new Date(Date.UTC(y, m + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return toIso(new Date(Date.UTC(y, m + 1, 0 - offset)));
}

/** Weekend-observed shifting, matching NYSE convention. */
function observed(iso: IsoDate): IsoDate {
  const day = fromIso(iso).getUTCDay();
  if (day === 6) return addDays(iso, -1);
  if (day === 0) return addDays(iso, 1);
  return iso;
}

function holidaysFor(y: number): Set<IsoDate> {
  const h = new Set<IsoDate>();
  h.add(observed(`${y}-01-01`));
  h.add(nthWeekdayOfMonth(y, 0, 1, 3)); // MLK Day
  h.add(nthWeekdayOfMonth(y, 1, 1, 3)); // Presidents' Day
  h.add(lastWeekdayOfMonth(y, 4, 1)); // Memorial Day
  if (y >= 2022) h.add(observed(`${y}-06-19`)); // Juneteenth
  h.add(observed(`${y}-07-04`));
  h.add(nthWeekdayOfMonth(y, 8, 1, 1)); // Labor Day
  h.add(nthWeekdayOfMonth(y, 10, 4, 4)); // Thanksgiving
  h.add(observed(`${y}-12-25`));
  return h;
}

const calendarCache = new Map<string, IsoDate[]>();

function tradingDays(start: IsoDate, end: IsoDate): IsoDate[] {
  const key = `${start}:${end}`;
  const cached = calendarCache.get(key);
  if (cached) return cached;

  const days: IsoDate[] = [];
  const holidays = new Map<number, Set<IsoDate>>();
  for (let t = fromIso(start); toIso(t) <= end; t = new Date(t.getTime() + 86_400_000)) {
    const iso = toIso(t);
    const dow = t.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const y = t.getUTCFullYear();
    if (!holidays.has(y)) holidays.set(y, holidaysFor(y));
    if (holidays.get(y)!.has(iso)) continue;
    days.push(iso);
  }
  calendarCache.set(key, days);
  return days;
}

/**
 * Per-symbol walk parameters. Drift/vol/yield vary by symbol hash so different
 * tickers do not produce identical curves, but the same ticker always produces
 * the same curve.
 */
interface WalkParams {
  drift: number;
  vol: number;
  dividendYield: number;
  startPrice: number;
  inception: IsoDate;
  assetClass: SecurityMeta['assetClass'];
}

const DEMO_UNIVERSE: Record<string, Partial<WalkParams> & { name: string }> = {
  SPY: { name: 'Demo Large-Cap Equity Fund', drift: 0.09, vol: 0.16, dividendYield: 0.015, assetClass: 'etf' },
  QQQ: { name: 'Demo Growth Equity Fund', drift: 0.12, vol: 0.23, dividendYield: 0.006, assetClass: 'etf' },
  VTI: { name: 'Demo Total Market Fund', drift: 0.089, vol: 0.165, dividendYield: 0.014, assetClass: 'etf' },
  VXUS: { name: 'Demo International Equity Fund', drift: 0.055, vol: 0.18, dividendYield: 0.028, assetClass: 'etf' },
  BND: { name: 'Demo Aggregate Bond Fund', drift: 0.03, vol: 0.05, dividendYield: 0.03, assetClass: 'etf' },
  GLD: { name: 'Demo Gold Trust', drift: 0.05, vol: 0.15, dividendYield: 0, assetClass: 'etf' },
  CASH: { name: 'Cash', drift: 0, vol: 0, dividendYield: 0, assetClass: 'cash' },
};

function paramsFor(symbol: string): WalkParams {
  const seeded = DEMO_UNIVERSE[symbol.toUpperCase()];
  const rng = makeRng(hashSymbol(symbol.toUpperCase()));
  return {
    drift: seeded?.drift ?? 0.04 + rng() * 0.1,
    vol: seeded?.vol ?? 0.12 + rng() * 0.2,
    dividendYield: seeded?.dividendYield ?? rng() * 0.03,
    startPrice: seeded?.startPrice ?? 20 + rng() * 180,
    inception: seeded?.inception ?? '1995-01-03',
    assetClass: seeded?.assetClass ?? 'equity',
  };
}

const DEMO_START: IsoDate = '1995-01-03';

function buildSeries(symbol: string): PriceSeries {
  const upper = symbol.toUpperCase();
  const p = paramsFor(upper);
  const end = todayIso();
  const days = tradingDays(p.inception > DEMO_START ? p.inception : DEMO_START, end);
  const rng = makeRng(hashSymbol(upper) ^ 0x9e3779b9);

  const dtDaily = 1 / 252;
  const bars: PriceBar[] = [];
  const dividends: DividendEvent[] = [];
  const splits: SplitEvent[] = [];

  let price = p.startPrice;
  let lastDivQuarter = '';

  for (const date of days) {
    const shock = gaussian(rng) * p.vol * Math.sqrt(dtDaily);
    const growth = (p.drift - 0.5 * p.vol * p.vol) * dtDaily;
    price = Math.max(0.01, price * Math.exp(growth + shock));

    // Quarterly dividend on the first trading day of Mar/Jun/Sep/Dec.
    const month = Number(date.slice(5, 7));
    const quarter = `${date.slice(0, 4)}Q${Math.ceil(month / 3)}`;
    if (
      p.dividendYield > 0 &&
      [3, 6, 9, 12].includes(month) &&
      quarter !== lastDivQuarter
    ) {
      lastDivQuarter = quarter;
      const amount = Math.round(price * (p.dividendYield / 4) * 10000) / 10000;
      if (amount > 0) dividends.push({ date, amount });
    }

    const intradayRange = price * (0.002 + Math.abs(gaussian(rng)) * 0.004);
    bars.push({
      date,
      open: Math.max(0.01, price - intradayRange / 2 + gaussian(rng) * intradayRange * 0.2),
      high: price + intradayRange / 2,
      low: Math.max(0.01, price - intradayRange / 2),
      close: price,
      adjClose: price, // Overwritten by the adjustment pass below.
      volume: Math.round(1e6 + rng() * 5e7),
    });
  }

  // Build the adjusted close the way a vendor does. On an ex-dividend date the
  // reinvestment factor steps by 1 / (1 − D / C_prev), using the price *before*
  // the drop. It is then rebased so the final bar has adjClose === close, since
  // adjustments look backwards from today.
  const divByDate = new Map(dividends.map((d) => [d.date, d.amount]));
  const factors = new Array<number>(bars.length).fill(1);
  let running = 1;
  for (let i = 0; i < bars.length; i++) {
    const div = divByDate.get(bars[i].date);
    if (div && i > 0) {
      const prevClose = bars[i - 1].close;
      running /= 1 - div / prevClose;
    }
    factors[i] = running;
  }
  const finalFactor = factors[factors.length - 1] || 1;
  for (let i = 0; i < bars.length; i++) {
    bars[i].adjClose = (bars[i].close * factors[i]) / finalFactor;
  }

  const meta: SecurityMeta = {
    symbol: upper,
    name: DEMO_UNIVERSE[upper]?.name ?? `Demo Synthetic Security (${upper})`,
    assetClass: p.assetClass,
    currency: 'USD',
    exchange: 'DEMO',
    firstTradeDate: bars[0]?.date,
    lastTradeDate: bars[bars.length - 1]?.date,
  };

  return {
    meta,
    bars,
    dividends,
    splits,
    adjustment: 'split-adjusted',
    source: 'demo',
    synthetic: true,
    fetchedAt: new Date().toISOString(),
  };
}

const seriesCache = new Map<string, PriceSeries>();

export class DemoDataProvider implements MarketDataProvider {
  readonly id = 'demo';
  readonly label = 'Demo (synthetic)';
  readonly synthetic = true;
  readonly description =
    'SYNTHETIC DATA — a seeded geometric random walk, not observed market prices. Use it to explore the product, never to evaluate a strategy.';

  private load(symbol: string): PriceSeries {
    const key = symbol.toUpperCase();
    let s = seriesCache.get(key);
    if (!s) {
      s = buildSeries(key);
      seriesCache.set(key, s);
    }
    return s;
  }

  async getHistoricalPrices(symbol: string, range: DateRange): Promise<PriceSeries> {
    const full = this.load(symbol);
    return {
      ...full,
      bars: full.bars.filter((b) => b.date >= range.start && b.date <= range.end),
      dividends: full.dividends.filter((d) => d.date >= range.start && d.date <= range.end),
      splits: full.splits.filter((s) => s.date >= range.start && s.date <= range.end),
    };
  }

  async getFullHistory(symbol: string): Promise<PriceSeries> {
    return this.load(symbol);
  }

  async getCorporateActions(symbol: string, range: DateRange): Promise<CorporateActions> {
    const s = await this.getHistoricalPrices(symbol, range);
    return { dividends: s.dividends, splits: s.splits };
  }

  async getDividends(symbol: string, range: DateRange): Promise<DividendEvent[]> {
    return (await this.getHistoricalPrices(symbol, range)).dividends;
  }

  async getTradingCalendar(range: DateRange): Promise<IsoDate[]> {
    return tradingDays(range.start, range.end);
  }

  async search(query: string): Promise<SecurityMeta[]> {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return Object.keys(DEMO_UNIVERSE)
      .filter((s) => s.includes(q) || DEMO_UNIVERSE[s].name.toUpperCase().includes(q))
      .map((s) => this.load(s).meta);
  }
}

export const __testing = { makeRng, tradingDays, holidaysFor };
export type { SplitEvent };
