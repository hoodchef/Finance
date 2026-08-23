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
export const EVALUATED_AND_REJECTED = [
  {
    provider: 'Alpha Vantage',
    reason:
      'TIME_SERIES_DAILY_ADJUSTED is a premium endpoint. The free TIME_SERIES_DAILY returns raw OHLCV with no adjusted close, no dividends and no splits — which cannot produce a correct total return. The free tier is also 25 requests/day.',
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
