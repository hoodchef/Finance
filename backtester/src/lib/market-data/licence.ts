/**
 * Usage terms for each data provider.
 *
 * This lives in the application, not only in documentation, because the
 * distinction it records is easy to lose sight of and expensive to get wrong:
 * **every affordable market-data tier is licensed for personal use only.**
 * Redistribution — showing the data to anyone other than yourself — requires a
 * commercial agreement.
 *
 * A backtester built for personal research and one built as a product are the
 * same code with entirely different licensing obligations. Surfacing the terms
 * next to the data means nobody discovers the problem after launch.
 *
 * Verified August 2026 against each provider's own pricing and terms pages.
 * These change; re-check before relying on them.
 */

export type CommercialStatus =
  /** Explicitly permits showing data to end users, on the stated plan. */
  | 'permitted'
  /** Personal or internal use only; redistribution needs a separate licence. */
  | 'personal-only'
  /** No licence at all — an undocumented endpoint used at your own risk. */
  | 'unlicensed';

export interface ProviderLicence {
  providerId: string;
  label: string;
  commercial: CommercialStatus;
  /** One line the UI can show verbatim. */
  summary: string;
  /** What it would take to use this in a product. */
  commercialPath: string;
  freeTier: string;
  corporateActions: string;
  verifiedOn: string;
}

export const PROVIDER_LICENCES: Record<string, ProviderLicence> = {
  yahoo: {
    providerId: 'yahoo',
    label: 'Yahoo Finance',
    commercial: 'unlicensed',
    summary:
      'Undocumented endpoint, no API agreement, personal use only. It can change or block without notice, and it rate-limits aggressively.',
    commercialPath:
      'Not available. Yahoo does not license this endpoint; a product would need a different provider entirely.',
    freeTier: 'No key required. Unstated throttle — in practice a few hundred requests before a multi-hour block.',
    corporateActions:
      'Split-adjusted closes with separate dividend and split event lists. Verified against recorded live data in tests/market-data.test.ts.',
    verifiedOn: '2026-08-23',
  },
  tiingo: {
    providerId: 'tiingo',
    label: 'Tiingo',
    commercial: 'personal-only',
    summary:
      'Documented, key-authenticated API. Free and $30/month tiers are both internal use only: you may not display or share the data with another person or organization.',
    commercialPath:
      'Contact Tiingo for a redistribution licence, or move to a provider that sells one.',
    freeTier: '50 requests/hour, 1,000/day, 500 unique symbols/month.',
    corporateActions:
      'Raw prices with per-bar divCash and splitFactor. The engine applies splits itself.',
    verifiedOn: '2026-08-23',
  },
  alphavantage: {
    providerId: 'alphavantage',
    label: 'Alpha Vantage',
    commercial: 'personal-only',
    summary:
      'Documented, key-authenticated API. Used here only for Canadian listings, and only at weekly resolution: the daily adjusted endpoint is premium and plain daily is capped at 100 bars.',
    commercialPath:
      'Alpha Vantage sells commercial plans that include the daily adjusted endpoint and lift the request cap. A product would need one; the free tier does not permit redistribution.',
    freeTier:
      '25 requests/day, and the throttle bites on bursts well before that. Everything is cached hard and fetched one symbol at a time.',
    corporateActions:
      'TIME_SERIES_WEEKLY_ADJUSTED carries an adjusted close and per-bar dividends. Splits are already folded into both close and adjusted close, verified against Tiingo across AAPL 2019-2021 (total return 393.5267% vs 393.5270%, agreeing to 6.9e-7).',
    verifiedOn: '2026-08-24',
  },
  alpaca: {
    providerId: 'alpaca',
    label: 'Alpaca',
    commercial: 'personal-only',
    summary:
      'Documented, key-authenticated API serving OPRA option chains with implied volatility and greeks. Data is licensed to the account holder; showing it to anyone else makes you a redistributor, which OPRA requires its own vendor agreement for.',
    commercialPath:
      'An OPRA vendor agreement and the corresponding Alpaca plan. The free tier is 15-minute delayed and internal-use only.',
    freeTier: '15-minute delayed OPRA options and IEX equities, 200 requests/minute.',
    corporateActions:
      'Option contracts carry their own multiplier and deliverable; adjusted contracts are served as-is and must not be assumed to be 100-share.',
    verifiedOn: '2026-08-30',
  },

  demo: {
    providerId: 'demo',
    label: 'Demo (synthetic)',
    commercial: 'permitted',
    summary: 'Generated prices. No licence needed because it is not market data.',
    commercialPath: 'Not applicable — never suitable for any real decision.',
    freeTier: 'Unlimited.',
    corporateActions: 'Simulated quarterly dividends. Not real corporate actions.',
    verifiedOn: '2026-08-23',
  },
};

/** Providers evaluated and rejected, with the reason, so it is not re-litigated. */
/**
 * Options data, evaluated August 2026.
 *
 * The conclusion is the same one the price-data survey reached, only sharper:
 * a free options feed good enough to build on exists, and none of them may be
 * shown to anyone else. Recorded here so the next person does not repeat the
 * search and, worse, does not integrate one without noticing the terms.
 */
export const OPTIONS_SOURCES_EVALUATED = [
  {
    provider: 'Cboe delayed quotes CDN',
    finding:
      'Technically the best free source found. The public CDN returns a complete chain — 13,288 SPY contracts across 32 expiries to 2028, with bid/ask and sizes, IV, open interest, volume and full greeks including rho and a theoretical price — current to the session close, with no API key.',
    blocker:
      'Cboe\'s content policy requires advance written approval and an executed licence agreement to use any data from its websites. The endpoint being open is not a licence. Unusable for anything shown to another person.',
    commercial: 'unlicensed' as const,
  },
  {
    provider: 'Alpha Vantage HISTORICAL_OPTIONS / REALTIME_OPTIONS',
    finding: 'Both are premium endpoints on the free key.',
    blocker:
      'REALTIME_OPTIONS returns a populated response on the free tier that parses cleanly and is labelled, in the payload itself, as artificial illustrative data. An integration written against it would produce plausible option chains from nothing. Treat any 200 from this endpoint as suspect.',
    commercial: 'personal-only' as const,
  },
  {
    provider: 'Alpaca (OPRA options snapshots)',
    finding:
      'The best source found that is documented, key-authenticated and returns a real chain: snapshots carry bid/ask, last trade, implied volatility and greeks, paged, for any listed underlying. Integrated at `lib/options/chain.ts`.',
    blocker:
      'Licensed to the account holder, not for redistribution. Showing an OPRA-derived quote to another person makes you a data vendor, which needs an agreement with OPRA and the matching Alpaca plan — the free tier is 15-minute delayed and internal use only. Usable by the person holding the key; not shippable to users without that agreement.',
    commercial: 'personal-only' as const,
  },
  {
    provider: 'marketdata.app',
    finding:
      'Free tier is 100 credits a day, 24-hour delayed, one year of history — enough to prototype against.',
    blocker:
      'Free and mid-tier plans are "Internal Use" only. Redistribution is permitted solely on the top commercial plan, at custom pricing with an annual commitment.',
    commercial: 'personal-only' as const,
  },
] as const;

export const EVALUATED_AND_REJECTED = [
  {
    provider: 'Alpha Vantage (daily endpoints only)',
    reason:
      'TIME_SERIES_DAILY_ADJUSTED is premium, and plain TIME_SERIES_DAILY is capped at 100 bars with outputsize=full also premium — five months of raw OHLCV, no dividends, no splits. Neither can produce a correct total return. The WEEKLY adjusted endpoint IS free and correct, and is used for Canadian listings; see PROVIDER_LICENCES.alphavantage.',
  },
  {
    provider: 'Nasdaq Data Link',
    reason:
      'The free WIKI equity price dataset was discontinued in March 2018 and Nasdaq advises against using it. Remaining equity price feeds are premium. Still useful for supplemental datasets, not for prices.',
  },
  {
    provider: 'Financial Modeling Prep',
    reason:
      'Free tier is US-only, which excludes the Canadian listings this application needs.',
  },
  {
    provider: 'Stooq',
    reason: 'Both hosts sit behind a proof-of-work bot check. Bypassing it is not appropriate.',
  },
  {
    provider: 'EODHD',
    reason:
      'Free tier is 20 calls/day and excludes splits and dividends. The $19.99/month tier includes them and is the strongest paid option, but is personal use only; commercial needs their enterprise plan.',
  },
] as const;

export function licenceFor(providerId: string): ProviderLicence | undefined {
  return PROVIDER_LICENCES[providerId];
}

/** True when this provider must not be used to serve data to other people. */
export function requiresCommercialLicence(providerId: string): boolean {
  const l = licenceFor(providerId);
  return l ? l.commercial !== 'permitted' : true;
}
