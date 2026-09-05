import shareClasses from './share-classes.generated.json';

/**
 * Symbol normalisation, without the directory behind it.
 * =============================================================================
 * This exists so the BROWSER can normalise a ticker. `universe.ts` holds the
 * full 775 KB listing directory and is server-side; it has no business in a
 * client bundle, and for a long time it was in one anyway — `validate.ts`
 * imported `normaliseSymbol` from it, one client component imported
 * `validate.ts`, and 654 KB of ticker data rode along into the backtest page.
 * That was three quarters of the JavaScript on that route.
 *
 * Normalisation turns out to need almost none of that data. The only question
 * it asks is whether the hyphenated form of a dotted symbol is really listed,
 * and 155 symbols can answer it. So the build writes those 155 out separately
 * and this module is what both sides import.
 *
 * `universe.ts` re-exports this rather than keeping a second copy: two
 * definitions of "what does BRK.B mean" is exactly the kind of split that ends
 * with the client and the server disagreeing about which security was bought.
 */

/** Listed symbols written with a hyphen, from the exchange directories. */
const HYPHENATED = new Set(shareClasses as string[]);

/**
 * Reconciles the two ways a share class gets written.
 *
 * Exchange directories use a dot (BRK.B); price APIs generally use a hyphen
 * (BRK-B). A suffixed foreign listing (XEQT.TO) also uses a dot, but there the
 * separator is an exchange qualifier and rewriting it would break the ticker.
 *
 * A regex cannot reliably tell those apart — `.B` is a share class and `.V` is
 * the TSX Venture exchange, and they look identical. So the decision is made
 * from data rather than a guess: the hyphenated form wins only if it actually
 * exists in the listing directory.
 */
export function normaliseSymbol(input: string): string {
  const s = input.trim().toUpperCase();
  if (!s || s.startsWith('^')) return s;
  if (!s.includes('.')) return s;

  const hyphenated = s.replace(/\./g, '-');
  // Checked against the directory, so BRK.B resolves and XEQT.TO does not.
  if (HYPHENATED.has(hyphenated)) return hyphenated;
  return s;
}

/** How many share classes back the check, for the guard test and diagnostics. */
export function shareClassCount(): number {
  return HYPHENATED.size;
}
