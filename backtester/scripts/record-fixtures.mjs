/**
 * Records real provider responses to tests/fixtures so the test suite is
 * deterministic and runs offline. Re-run when the data contract needs
 * re-verifying against the live source:  node scripts/record-fixtures.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TARGETS = [
  // A 4:1 split plus quarterly dividends — proves the adjustment contract.
  { symbol: 'AAPL', start: '2019-01-01', end: '2021-12-31', file: 'aapl-2019-2021.json' },
  // Dense dividend history for the reinvestment parity test.
  { symbol: 'SPY', start: '2015-01-01', end: '2024-12-31', file: 'spy-2015-2024.json' },
  // A bond fund: different vol regime, monthly distributions.
  { symbol: 'BND', start: '2015-01-01', end: '2024-12-31', file: 'bnd-2015-2024.json' },
];

const toUnix = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yahoo rate-limits aggressively; back off and alternate hosts. */
async function fetchWithRetry(symbol, qs) {
  const hosts = ['query1', 'query2'];
  let wait = 3000;
  for (let attempt = 0; attempt < 8; attempt++) {
    const host = hosts[attempt % hosts.length];
    const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?${qs}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status !== 503) {
      throw new Error(`${symbol}: HTTP ${res.status}`);
    }
    process.stdout.write(`  ${symbol}: HTTP ${res.status}, retrying in ${wait / 1000}s\n`);
    await sleep(wait);
    wait = Math.min(wait * 1.8, 30000);
  }
  throw new Error(`${symbol}: exhausted retries`);
}

// The CPI series used for inflation adjustment. Plain CSV, no key required.
{
  const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL', {
    headers: { 'User-Agent': UA },
  });
  if (res.ok) {
    const text = await res.text();
    await fs.writeFile(path.join('tests', 'fixtures', 'cpiaucsl.csv'), text, 'utf8');
    console.log(`CPI    → tests/fixtures/cpiaucsl.csv  ${text.trim().split('\n').length - 1} observations`);
  } else {
    console.log(`CPI    ! HTTP ${res.status}`);
  }
  await sleep(2000);
}

for (const { symbol, start, end, file } of TARGETS) {
  const qs = new URLSearchParams({
    period1: String(toUnix(start)),
    period2: String(toUnix(end) + 86400),
    interval: '1d',
    events: 'div,split',
    includeAdjustedClose: 'true',
  });
  const json = await fetchWithRetry(symbol, qs);
  const out = path.join('tests', 'fixtures', file);
  await fs.writeFile(out, JSON.stringify(json), 'utf8');
  const bars = json.chart.result[0].timestamp?.length ?? 0;
  const divs = Object.keys(json.chart.result[0].events?.dividends ?? {}).length;
  const splits = Object.keys(json.chart.result[0].events?.splits ?? {}).length;
  console.log(`${symbol.padEnd(6)} → ${out}  ${bars} bars, ${divs} dividends, ${splits} splits`);
  await sleep(2500);
}
