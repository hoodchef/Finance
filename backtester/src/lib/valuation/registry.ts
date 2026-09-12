/**
 * Which securities have an intrinsic valuation model.
 *
 * A model is company-specific — ASTS's revenue is a constellation build and a
 * wholesale share of partner subscribers, not something a generic DCF template
 * can express honestly — so pages ask this registry rather than offering a
 * valuation for every ticker and filling the gaps with defaults.
 */
export interface IntrinsicModel {
  ticker: string;
  name: string;
  href: string;
}

export const INTRINSIC_MODELS: readonly IntrinsicModel[] = [
  { ticker: 'ASTS', name: 'AST SpaceMobile', href: '/valuation' },
];

export function intrinsicModelFor(symbol: string | null | undefined): IntrinsicModel | null {
  if (!symbol) return null;
  const s = symbol.trim().toUpperCase();
  return INTRINSIC_MODELS.find((m) => m.ticker === s) ?? null;
}
