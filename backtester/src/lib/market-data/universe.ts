import type { AssetClass, SecurityMeta } from '@/lib/types';
import generated from './universe.generated.json';

/**
 * The tradable-symbol universe.
 *
 * 13,000+ US-listed securities from the exchanges' own directory, rebuilt with
 * `npm run build:universe`. This is a SERVER-SIDE index: at roughly 775 KB it
 * has no business in a client bundle, so search runs behind `/api/search` and
 * the browser receives only the handful of matches it asked for.
 *
 * Having the real universe locally matters for more than autocomplete. It means
 * a mistyped ticker is caught before a request is made, an ETF is known to be
 * an ETF without inferring it from its name, and search works even when the
 * price provider is rate-limited — which is exactly when a user is most likely
 * to be retyping a symbol.
 */

interface UniverseFile {
  source: string;
  sourceUrl: string;
  builtAt: string;
  count: number;
  etfCount: number;
  rows: Array<[string, string, number, string]>;
}

const file = generated as UniverseFile;

export interface UniverseEntry {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
}

const entries: UniverseEntry[] = file.rows.map(([symbol, name, isEtf, exchange]) => ({
  symbol,
  name,
  assetClass: isEtf === 1 ? 'etf' : 'equity',
  exchange,
}));

const bySymbol = new Map(entries.map((e) => [e.symbol, e]));

export function universeInfo() {
  return {
    source: file.source,
    sourceUrl: file.sourceUrl,
    builtAt: file.builtAt,
    count: file.count,
    etfCount: file.etfCount,
    equityCount: file.count - file.etfCount,
  };
}

export function lookupSymbol(symbol: string): UniverseEntry | undefined {
  return bySymbol.get(normaliseSymbol(symbol));
}

export function isKnownSymbol(symbol: string): boolean {
  return bySymbol.has(normaliseSymbol(symbol));
}

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
  if (bySymbol.has(hyphenated)) return hyphenated;
  return s;
}

/**
 * Ranked prefix-then-substring search.
 *
 * Exact ticker first, then ticker prefix, then name — someone typing "VO"
 * wants VOO before "Vanguard Ohio Municipal", and a scan that scored purely on
 * substring position would bury it.
 */
export function searchUniverse(query: string, limit = 20): UniverseEntry[] {
  const raw = query.trim().toUpperCase();
  if (!raw) return [];

  const q = normaliseSymbol(raw);
  // Multi-word queries match on ALL tokens appearing somewhere in the name.
  // "schwab dividend" must find "Schwab US Dividend Equity ETF", which a plain
  // substring test cannot because the words are not adjacent.
  const tokens = raw.split(/\s+/).filter((t) => t.length >= 2);
  const multiWord = tokens.length > 1;

  const exact: UniverseEntry[] = [];
  const symbolPrefix: UniverseEntry[] = [];
  const nameStart: UniverseEntry[] = [];
  const nameContains: UniverseEntry[] = [];

  for (const e of entries) {
    if (e.symbol === q) {
      exact.push(e);
      continue;
    }
    if (!multiWord && e.symbol.startsWith(q)) {
      symbolPrefix.push(e);
      continue;
    }

    if (raw.length >= 3) {
      const upper = e.name.toUpperCase();
      if (multiWord) {
        if (tokens.every((t) => upper.includes(t))) nameContains.push(e);
      } else if (upper.startsWith(raw)) {
        nameStart.push(e);
      } else if (upper.includes(raw)) {
        nameContains.push(e);
      }
    }
  }

  // Shorter tickers first: someone typing "VO" wants VOO before VOOGX.
  symbolPrefix.sort((a, b) => a.symbol.length - b.symbol.length || (a.symbol < b.symbol ? -1 : 1));
  // Among name matches, funds are the usual intent in a portfolio tool.
  const fundsFirst = (a: UniverseEntry, b: UniverseEntry) =>
    (b.assetClass === 'etf' ? 1 : 0) - (a.assetClass === 'etf' ? 1 : 0) ||
    a.name.length - b.name.length;
  nameStart.sort(fundsFirst);
  nameContains.sort(fundsFirst);

  return [...exact, ...symbolPrefix, ...nameStart, ...nameContains].slice(0, limit);
}

export function toSecurityMeta(e: UniverseEntry): SecurityMeta {
  return {
    symbol: e.symbol,
    name: e.name,
    assetClass: e.assetClass,
    currency: 'USD',
    exchange: e.exchange,
  };
}
