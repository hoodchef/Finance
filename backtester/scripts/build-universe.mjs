/**
 * Builds the tradable-symbol universe from the official exchange directories.
 *
 *   node scripts/build-universe.mjs
 *
 * Source: Nasdaq Trader's Symbol Directory, which is the authoritative listing
 * published by the exchanges themselves and refreshed every trading day. It
 * needs no API key and carries an explicit ETF flag, which is what lets the
 * app distinguish funds from equities without guessing from the name.
 *
 *   nasdaqlisted.txt  — Nasdaq-listed securities
 *   otherlisted.txt   — NYSE, NYSE American, NYSE Arca, BATS, IEX
 *
 * Test issues are excluded: they are exchange plumbing, not tradable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCES = {
  nasdaq: 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
  other: 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'portfolio-backtester/1.0' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Splits a pipe-delimited directory file into records keyed by its header. */
function parsePipe(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('File Creation Time'));
  const header = lines[0].split('|').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split('|');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

/**
 * Exchange directories use a dot for share classes (BRK.B); most price APIs,
 * Yahoo included, use a hyphen (BRK-B). Both forms are recorded so a user can
 * type either and the provider still receives one it understands.
 */
function providerSymbol(exchangeSymbol) {
  return exchangeSymbol.replace(/\./g, '-');
}

const [nasdaqText, otherText] = await Promise.all([
  fetchText(SOURCES.nasdaq),
  fetchText(SOURCES.other),
]);

const seen = new Map();

for (const r of parsePipe(nasdaqText)) {
  if (r['Test Issue'] === 'Y') continue;
  const symbol = r.Symbol;
  if (!symbol) continue;
  seen.set(symbol, {
    s: providerSymbol(symbol),
    n: r['Security Name'] ?? symbol,
    e: r.ETF === 'Y' ? 1 : 0,
    x: 'NASDAQ',
  });
}

for (const r of parsePipe(otherText)) {
  if (r['Test Issue'] === 'Y') continue;
  const symbol = r['ACT Symbol'] || r['NASDAQ Symbol'];
  if (!symbol || seen.has(symbol)) continue;
  const EXCHANGES = { A: 'NYSE American', N: 'NYSE', P: 'NYSE Arca', Z: 'BATS', V: 'IEX' };
  seen.set(symbol, {
    s: providerSymbol(symbol),
    n: r['Security Name'] ?? symbol,
    e: r.ETF === 'Y' ? 1 : 0,
    x: EXCHANGES[r.Exchange] ?? r.Exchange ?? '',
  });
}

// Names in these files carry a lot of boilerplate; trimming it keeps the
// bundle small and the autocomplete readable.
const CRUFT = /\s*[-–]\s*(Common Stock|Class [A-Z] Common Stock|Ordinary Shares.*|Common Shares.*|American Depositary Shares.*)$/i;

const rows = [...seen.values()]
  .map((r) => ({ ...r, n: r.n.replace(CRUFT, '').trim().slice(0, 80) }))
  .sort((a, b) => (a.s < b.s ? -1 : 1));

const out = {
  source: 'Nasdaq Trader Symbol Directory (nasdaqlisted.txt, otherlisted.txt)',
  sourceUrl: 'https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs',
  builtAt: new Date().toISOString(),
  count: rows.length,
  etfCount: rows.filter((r) => r.e === 1).length,
  // Compact tuples: [symbol, name, isEtf, exchange]
  rows: rows.map((r) => [r.s, r.n, r.e, r.x]),
};

const dest = path.join('src', 'lib', 'market-data', 'universe.generated.json');
await fs.writeFile(dest, JSON.stringify(out), 'utf8');

const bytes = (await fs.stat(dest)).size;
console.log(`${out.count} symbols (${out.etfCount} ETFs, ${out.count - out.etfCount} equities)`);
console.log(`→ ${dest}  ${(bytes / 1024).toFixed(0)} KB`);
