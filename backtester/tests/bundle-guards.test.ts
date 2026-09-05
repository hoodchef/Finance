import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseSymbol as clientSide, shareClassCount } from '../src/lib/market-data/symbol';
import { normaliseSymbol as viaUniverse } from '../src/lib/market-data/universe';
import universe from '../src/lib/market-data/universe.generated.json';

/**
 * Guards against server-only data reaching the browser.
 * =============================================================================
 * The failure these prevent already happened once, which is why they exist.
 * `universe.ts` carries the 775 KB exchange listing directory and says in its
 * own doc comment that it "has no business in a client bundle". It was in one
 * anyway: `validate.ts` imported one function from it, `backtest/workspace.tsx`
 * imported `validate.ts`, and 654 KB of ticker data rode three levels down an
 * import chain into the page — three quarters of that route's JavaScript, to
 * answer a question 155 symbols can answer.
 *
 * Nothing failed. No test broke, no type was wrong, no lint rule fired. The
 * page just quietly took 240 kB instead of 55 kB, and the only way to see it
 * was to attribute the bundle module by module.
 *
 * So the invariant is asserted on the IMPORT GRAPH rather than on any one
 * file. A test naming today's client components would pass the moment someone
 * adds tomorrow's.
 */

const SRC = path.join(__dirname, '..', 'src');

function listSource(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Local imports of one file, resolved to absolute paths. */
function importsOf(file: string): string[] {
  const body = fs.readFileSync(file, 'utf8');
  const specs = [...body.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const out: string[] = [];
  for (const spec of specs) {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(file), spec);
    else continue; // A package, not our source.
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        out.push(cand);
        break;
      }
    }
  }
  return out;
}

/** Everything reachable from `entry`, following local imports only. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of importsOf(file)) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

const UNIVERSE = path.join(SRC, 'lib', 'market-data', 'universe.ts');

describe('the listing directory stays on the server', () => {
  const clientEntries = listSource(SRC).filter((f) => {
    const head = fs.readFileSync(f, 'utf8').slice(0, 200);
    return /^['"]use client['"]/m.test(head);
  });

  it('finds client components to check', () => {
    // If this ever reads zero the suite below is vacuously true, which is the
    // way a source-level guard usually dies.
    expect(clientEntries.length).toBeGreaterThan(10);
  });

  it.each(clientEntries.map((f) => [path.relative(SRC, f), f]))(
    '%s does not reach the 775 KB universe',
    (_label, file) => {
      const reachable = reachableFrom(file as string);
      // Name the chain when it breaks; "something imports it" is not actionable.
      const chain = reachable.has(UNIVERSE)
        ? [...reachable].filter((f) => importsOf(f).includes(UNIVERSE)).map((f) => path.relative(SRC, f))
        : [];
      expect(chain, `imported via ${chain.join(', ')}`).toEqual([]);
    },
  );

  it('keeps the client-side share-class index small enough to bundle', () => {
    const bytes = fs.statSync(
      path.join(SRC, 'lib', 'market-data', 'share-classes.generated.json'),
    ).size;
    // The whole point is that this is cheap. If it ever approaches the full
    // directory, the split has stopped paying for itself.
    expect(bytes).toBeLessThan(20_000);
    expect(shareClassCount()).toBeGreaterThan(50);
  });
});

describe('splitting normalisation did not change what it decides', () => {
  // The JSON is inferred as (string | number)[][]; only column 0 is read.
  const symbols = (universe.rows as unknown[][]).map((r) => String(r[0]));

  it('is the same function the universe exports', () => {
    // `universe.ts` re-exports rather than redefining: two answers to "what
    // does BRK.B mean" is how a client and a server end up disagreeing about
    // which security was bought.
    expect(viaUniverse).toBe(clientSide);
  });

  it('agrees with the full directory on every listed symbol', () => {
    // The directory is the authority the original implementation consulted.
    // Rebuilding the same decision from 155 rows has to reach it every time.
    const listed = new Set(symbols);
    const disagreed: string[] = [];
    for (const s of symbols) {
      if (!s.includes('.')) continue;
      const expected = listed.has(s.replace(/\./g, '-')) ? s.replace(/\./g, '-') : s;
      if (clientSide(s) !== expected) disagreed.push(s);
    }
    expect(disagreed).toEqual([]);
  });

  it('rewrites a dotted share class to the hyphen the price APIs want', () => {
    // AKO.A is in the directory as AKO-A, so the dot must be rewritten.
    expect(clientSide('AKO.A')).toBe('AKO-A');
    expect(clientSide('ako.a')).toBe('AKO-A');
  });

  it('leaves an exchange suffix alone', () => {
    // XEQT.TO is a Toronto listing; XEQT-TO is not a symbol, and rewriting it
    // would send the provider a ticker that does not exist.
    expect(clientSide('XEQT.TO')).toBe('XEQT.TO');
    expect(clientSide('SHOP.TO')).toBe('SHOP.TO');
  });

  it('passes through the ordinary cases untouched', () => {
    expect(clientSide('AAPL')).toBe('AAPL');
    expect(clientSide(' spy ')).toBe('SPY');
    expect(clientSide('^GSPC')).toBe('^GSPC');
    expect(clientSide('')).toBe('');
  });
});
