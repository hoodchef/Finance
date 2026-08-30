import { MarketDataError } from '@/lib/market-data/provider';

/**
 * Option chains from Alpaca.
 * =============================================================================
 * Alpaca is the best options source surveyed that is documented,
 * key-authenticated and returns a real chain: OPRA snapshots with implied
 * volatility and greeks already computed. Alpha Vantage's options endpoints
 * are premium-only and Cboe's public files require written approval.
 *
 * It is NOT unencumbered, and an earlier version of this comment overstated
 * it. The data is licensed to the account holder; showing an OPRA-derived
 * quote to another person makes you a redistributor, which needs an agreement
 * with OPRA and the matching Alpaca plan. Usable by whoever holds the key,
 * not shippable to users without that. Recorded in `market-data/licence.ts`
 * alongside every other source evaluated.
 *
 * WHAT THIS WILL NOT DO
 *
 * If no key is configured, or Alpaca declines, this reports that and returns
 * nothing. It does not fall back to a synthetic chain, and there is no code
 * path in this file that can produce a strike, a premium or a volatility that
 * did not come from the API. A fabricated chain is worse than no chain: the
 * whole builder downstream would produce confident, precise, meaningless
 * numbers, and nothing on screen would say so.
 *
 * The builder still works without it. Legs can be typed by hand with the
 * user's own premiums, and every model in `pricing.ts` is a pure function that
 * needs no vendor at all.
 */

const DATA_HOST = 'https://data.alpaca.markets';

export interface OptionQuote {
  /** OCC symbol, e.g. AAPL260619C00150000. */
  symbol: string;
  type: 'call' | 'put';
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  /** As supplied by the venue, a decimal. Null where absent. */
  impliedVolatility: number | null;
  greeks: {
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    rho: number | null;
  } | null;
  /** When the quote was stamped by the venue. */
  quotedAt: string | null;
}

export interface OptionChain {
  underlying: string;
  quotes: OptionQuote[];
  expiries: string[];
  /** Provenance, shown beside the data rather than assumed. */
  source: string;
  /** 'realtime' | 'delayed' — Alpaca's free feed is 15-minute delayed. */
  latency: 'realtime' | 'delayed' | 'unknown';
  fetchedAt: string;
}

export class ChainUnavailableError extends Error {
  /** True when the cause is configuration rather than a failure. */
  readonly needsConfiguration: boolean;
  constructor(message: string, needsConfiguration = false) {
    super(message);
    this.name = 'ChainUnavailableError';
    this.needsConfiguration = needsConfiguration;
  }
}

export function chainConfigured(): boolean {
  return Boolean(
    process.env.ALPACA_API_KEY_ID?.trim() && process.env.ALPACA_API_SECRET_KEY?.trim(),
  );
}

/**
 * Parses an OCC option symbol.
 *
 * Root, then YYMMDD, then C or P, then the strike in thousandths padded to
 * eight digits. Parsed rather than trusted from a separate field because the
 * symbol is the contract's identity and any disagreement between it and the
 * metadata means something is wrong with the row.
 */
export function parseOccSymbol(
  symbol: string,
): { root: string; expiry: string; type: 'call' | 'put'; strike: number } | null {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m;
  return {
    root,
    expiry: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: Number(strike) / 1000,
  };
}

interface AlpacaGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

interface AlpacaSnapshot {
  greeks?: AlpacaGreeks;
  impliedVolatility?: number;
  latestQuote?: { bp?: number; ap?: number; t?: string };
  latestTrade?: { p?: number; t?: string };
  dailyBar?: { v?: number };
}

interface AlpacaSnapshotResponse {
  snapshots?: Record<string, AlpacaSnapshot>;
  next_page_token?: string | null;
  message?: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Fetches the chain for an underlying.
 *
 * Paged through in full: Alpaca returns a page token and a liquid name has far
 * more contracts than one page holds. Stopping at the first page would silently
 * hide every strike past the cut-off, which looks like a thin chain rather
 * than like a truncated one.
 */
export async function fetchOptionChain(
  underlying: string,
  options: { expiry?: string; maxPages?: number } = {},
): Promise<OptionChain> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) {
    throw new ChainUnavailableError(
      'No Alpaca credentials are configured, so no option chain can be loaded. ' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY to enable live chains.',
      true,
    );
  }

  const symbol = underlying.trim().toUpperCase();
  const quotes: OptionQuote[] = [];
  let pageToken: string | null = null;
  const maxPages = Math.max(1, options.maxPages ?? 8);

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${DATA_HOST}/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`);
    url.searchParams.set('limit', '1000');
    if (options.expiry) url.searchParams.set('expiration_date', options.expiry);
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25_000);
    let body: AlpacaSnapshotResponse;
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secret,
          Accept: 'application/json',
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw new ChainUnavailableError(
          'Alpaca rejected these credentials, or the account has no options data entitlement.',
        );
      }
      if (res.status === 404) {
        throw new ChainUnavailableError(`Alpaca lists no option chain for ${symbol}.`);
      }
      if (!res.ok) {
        throw new MarketDataError(`Alpaca returned HTTP ${res.status}.`, symbol);
      }
      body = (await res.json()) as AlpacaSnapshotResponse;
    } catch (e) {
      if (e instanceof ChainUnavailableError || e instanceof MarketDataError) throw e;
      throw new MarketDataError('Could not reach Alpaca.', symbol, e);
    } finally {
      clearTimeout(timer);
    }

    const snapshots = body.snapshots ?? {};
    for (const [occ, snap] of Object.entries(snapshots)) {
      const parsed = parseOccSymbol(occ);
      // A row whose symbol will not parse is a row we cannot identify. Dropped
      // rather than guessed at from the metadata.
      if (!parsed) continue;
      const g = snap.greeks;
      quotes.push({
        symbol: occ,
        type: parsed.type,
        strike: parsed.strike,
        expiry: parsed.expiry,
        bid: num(snap.latestQuote?.bp),
        ask: num(snap.latestQuote?.ap),
        last: num(snap.latestTrade?.p),
        volume: num(snap.dailyBar?.v),
        openInterest: null,
        impliedVolatility: num(snap.impliedVolatility),
        greeks: g
          ? {
              delta: num(g.delta),
              gamma: num(g.gamma),
              theta: num(g.theta),
              vega: num(g.vega),
              rho: num(g.rho),
            }
          : null,
        quotedAt: snap.latestQuote?.t ?? snap.latestTrade?.t ?? null,
      });
    }

    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
  }

  if (quotes.length === 0) {
    throw new ChainUnavailableError(
      `Alpaca returned no option contracts for ${symbol}. It may not have listed options.`,
    );
  }

  return {
    underlying: symbol,
    quotes: quotes.sort((a, b) => (a.expiry === b.expiry ? a.strike - b.strike : a.expiry < b.expiry ? -1 : 1)),
    expiries: [...new Set(quotes.map((q) => q.expiry))].sort(),
    source: 'Alpaca (OPRA)',
    // The free data plan is 15-minute delayed. Reported as such rather than
    // implied to be live: a stale quote presented as real-time is how somebody
    // trades on a price that moved twenty minutes ago.
    latency: process.env.ALPACA_DATA_FEED === 'opra' ? 'realtime' : 'delayed',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * At-the-money implied volatility for an expiry, from the chain.
 *
 * Averages the nearest call and put rather than taking one. Put and call IV at
 * the same strike differ in practice — the put usually carries more, because
 * demand for downside protection is asymmetric — and picking whichever comes
 * first in the list would inherit that skew arbitrarily.
 */
export function atmImpliedVolatility(
  chain: OptionChain,
  spot: number,
  expiry: string,
): number | null {
  const forExpiry = chain.quotes.filter(
    (q) => q.expiry === expiry && q.impliedVolatility != null && q.impliedVolatility > 0,
  );
  if (!forExpiry.length) return null;

  const nearest = (type: 'call' | 'put') =>
    forExpiry
      .filter((q) => q.type === type)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];

  const call = nearest('call');
  const put = nearest('put');
  const ivs = [call?.impliedVolatility, put?.impliedVolatility].filter(
    (v): v is number => typeof v === 'number' && v > 0,
  );
  if (!ivs.length) return null;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

/** IV against strike for one expiry — the smile. */
export function volatilitySmile(
  chain: OptionChain,
  expiry: string,
): Array<{ strike: number; callIv: number | null; putIv: number | null }> {
  const strikes = [...new Set(chain.quotes.filter((q) => q.expiry === expiry).map((q) => q.strike))]
    .sort((a, b) => a - b);
  return strikes.map((strike) => {
    const at = (type: 'call' | 'put') =>
      chain.quotes.find((q) => q.expiry === expiry && q.strike === strike && q.type === type)
        ?.impliedVolatility ?? null;
    return { strike, callIv: at('call'), putIv: at('put') };
  });
}

/** ATM IV against expiry — the term structure. */
export function volatilityTermStructure(
  chain: OptionChain,
  spot: number,
): Array<{ expiry: string; atmIv: number | null }> {
  return chain.expiries.map((expiry) => ({
    expiry,
    atmIv: atmImpliedVolatility(chain, spot, expiry),
  }));
}
