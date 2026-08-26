/**
 * Records raw Tiingo daily bars as test fixtures.
 *
 * Tiingo returns unadjusted OHLC alongside per-bar `divCash`/`splitFactor` AND
 * its own adjusted columns. That combination is what makes it usable as a
 * parity reference: the engine can be run on the raw side and checked against
 * the vendor's adjusted side, with no shared arithmetic between them.
 *
 * Deliberately slow. The free tier allows 50 symbols/hour and the point of
 * these fixtures is to stop hitting the network from tests, not to race it.
 *
 *   node scripts/record-tiingo-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'fixtures');

/** Reads TIINGO_API_KEY out of .env.local without pulling in a dep. */
function apiKey() {
  if (process.env.TIINGO_API_KEY?.trim()) return process.env.TIINGO_API_KEY.trim();
  const envFile = path.join(ROOT, '.env.local');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*TIINGO_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('TIINGO_API_KEY not set and not found in .env.local');
}

const KEY = apiKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(KEY, '***')}`);
  return res.json();
}

/** One fixture = the metadata and the bars, exactly as returned. */
async function record(symbol, start, end, file) {
  const target = path.join(OUT, file);
  if (fs.existsSync(target)) {
    console.log(`· ${file} already recorded, skipping`);
    return;
  }
  const base = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol)}`;
  const meta = await get(`${base}?token=${KEY}`);
  await sleep(1200);
  const prices = await get(`${base}/prices?startDate=${start}&endDate=${end}&token=${KEY}`);
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error(`${symbol}: no bars returned for ${start}..${end}`);
  }
  const divs = prices.filter((b) => b.divCash > 0).length;
  const splits = prices.filter((b) => b.splitFactor !== 1).length;
  fs.writeFileSync(
    target,
    `${JSON.stringify({ symbol, start, end, recordedAt: new Date().toISOString(), meta, prices }, null, 0)}\n`,
  );
  console.log(`✓ ${file}  bars=${prices.length} dividends=${divs} splits=${splits}`);
}

const TARGETS = [
  ['SPY', '2015-01-02', '2024-12-31', 'tiingo-spy-2015-2024.json'],
  ['BND', '2015-01-02', '2024-12-31', 'tiingo-bnd-2015-2024.json'],
  ['AAPL', '2019-01-02', '2021-12-31', 'tiingo-aapl-split-2020.json'],
];

for (const [symbol, start, end, file] of TARGETS) {
  await record(symbol, start, end, file);
  await sleep(2000);
}
console.log('done');
