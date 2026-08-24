import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { IsoDate } from '@/lib/types';
import { MarketDataError } from './provider';

/**
 * Fama–French research factors, from the Kenneth R. French Data Library.
 * =============================================================================
 * The canonical source. The factors are constructed from CRSP by the people who
 * defined them, published free, and updated monthly — which is also the
 * constraint that shapes this module.
 *
 * **The data lags.** French publishes through the end of a recent month, and
 * that month is typically one to two months behind today. A regression
 * therefore cannot cover the most recent weeks of a backtest, and pretending
 * otherwise would silently change what the answer is about. Every result
 * reports the window it actually covered, and `alignToFactors` returns the
 * truncation explicitly rather than absorbing it.
 *
 * Attribution: Fama, E. F. and French, K. R., data from the Kenneth R. French
 * Data Library at Dartmouth. Free for research use; not redistributed here —
 * the files are fetched at runtime and cached locally.
 */

const BASE = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp';

export const FACTOR_SETS = {
  ff3: {
    id: 'ff3',
    label: 'Fama–French 3-factor',
    file: 'F-F_Research_Data_Factors_daily_CSV.zip',
    factors: ['Mkt-RF', 'SMB', 'HML'],
    description: 'Market, size, and value. The 1993 model.',
  },
  ff5: {
    id: 'ff5',
    label: 'Fama–French 5-factor',
    file: 'F-F_Research_Data_5_Factors_2x3_daily_CSV.zip',
    factors: ['Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA'],
    description: 'Adds profitability and investment. Starts 1963-07-01.',
  },
  mom: {
    id: 'mom',
    label: 'Momentum',
    file: 'F-F_Momentum_Factor_daily_CSV.zip',
    factors: ['Mom'],
    description: 'Carhart momentum, added to either model above.',
  },
} as const;

export type FactorSetId = keyof typeof FACTOR_SETS;

export interface FactorSeries {
  /** Ascending trading days, as they appear in the source. */
  dates: IsoDate[];
  /** Factor name → daily return as a DECIMAL (the source is in percent). */
  factors: Record<string, number[]>;
  /** Daily risk-free rate, decimal. Absent from the momentum file. */
  riskFree?: number[];
  source: string;
  /** Last date the library actually publishes, which is not today. */
  lastAvailable: IsoDate;
  fetchedAt: string;
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extracts the single entry from a ZIP archive.
 *
 * Reads the central directory rather than the local header: when a server
 * streams an archive it may set the streaming flag and leave the local header's
 * sizes zero, with the real values in a trailing data descriptor. The central
 * directory always carries them.
 */
function unzipSingle(buf: Buffer): { name: string; data: Buffer } {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  // The EOCD is at the end, after a comment of up to 65535 bytes.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new MarketDataError('Not a ZIP archive: no end-of-central-directory record.');

  const entries = buf.readUInt16LE(eocd + 10);
  if (entries < 1) throw new MarketDataError('ZIP archive is empty.');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) {
    throw new MarketDataError('ZIP central directory is malformed.');
  }

  const method = buf.readUInt16LE(cdOffset + 10);
  const crcExpected = buf.readUInt32LE(cdOffset + 16);
  const compressedSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const extraLen = buf.readUInt16LE(cdOffset + 30);
  const commentLen = buf.readUInt16LE(cdOffset + 32);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
  void extraLen;
  void commentLen;

  if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new MarketDataError('ZIP local file header is malformed.');
  }
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(start, start + compressedSize);

  let data: Buffer;
  if (method === 0) data = Buffer.from(raw);
  else if (method === 8) data = zlib.inflateRawSync(raw);
  else throw new MarketDataError(`ZIP compression method ${method} is not supported.`);

  // The archive carries a checksum; a truncated download is a wrong answer, not
  // a parse error, so it is worth the cost of verifying.
  const crcActual = zlib.crc32(data) >>> 0;
  if (crcActual !== crcExpected) {
    throw new MarketDataError(
      'The factor archive failed its checksum, so the download was corrupt or truncated.',
    );
  }
  return { name, data };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parses one of French's daily CSVs.
 *
 * The layout is a prose preamble of varying length, a header row whose first
 * cell is empty, YYYYMMDD rows, then a blank line and a copyright notice. The
 * header is located by shape rather than by line number, because the preamble
 * length differs between files and has changed over time.
 */
export function parseFrenchCsv(text: string, source: string): FactorSeries {
  const lines = text.split(/\r?\n/);

  let headerAt = -1;
  let columns: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    // Header: leading cell empty, at least one named column, and the NEXT
    // non-empty line must be a date row. That pairing is what distinguishes it
    // from a comma in the prose.
    if (cells.length >= 2 && cells[0] === '' && cells.slice(1).every((c) => c.length > 0)) {
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
      if (next && /^\s*\d{8}\s*,/.test(next)) {
        headerAt = i;
        columns = cells.slice(1);
        break;
      }
    }
  }
  if (headerAt < 0) {
    throw new MarketDataError(
      `Could not find the header row in ${source}. The Data Library's format may have changed.`,
    );
  }

  const dates: IsoDate[] = [];
  const cols: Record<string, number[]> = Object.fromEntries(columns.map((c) => [c, []]));

  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break; // The blank line terminates the daily block.
    const cells = line.split(',').map((c) => c.trim());
    if (!/^\d{8}$/.test(cells[0])) break; // Monthly/annual blocks or the copyright.
    if (cells.length !== columns.length + 1) continue;

    const values = cells.slice(1).map(Number);
    // -99.99 and -999 are the library's missing-value sentinels. Letting one
    // through as a -99% daily return would wreck any regression it touched.
    if (values.some((v) => !Number.isFinite(v) || v <= -99)) continue;

    dates.push(`${cells[0].slice(0, 4)}-${cells[0].slice(4, 6)}-${cells[0].slice(6, 8)}`);
    // The source is in percent.
    columns.forEach((c, j) => cols[c].push(values[j] / 100));
  }

  if (dates.length === 0) throw new MarketDataError(`No daily rows parsed from ${source}.`);

  const riskFree = cols.RF;
  delete cols.RF;

  return {
    dates,
    factors: cols,
    riskFree,
    source,
    lastAvailable: dates[dates.length - 1],
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Fetch and cache                                                     */
/* ------------------------------------------------------------------ */

const memory = new Map<string, { series: FactorSeries; expiresAt: number }>();
// French publishes monthly; a day-long TTL is already far more eager than the
// data changes.
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheFile(id: string): string {
  const dir = process.env.MARKET_DATA_CACHE_DIR ?? '.cache/market-data';
  const base = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  return path.join(base, `factors-${id}.json`);
}

export async function getFactorSeries(id: FactorSetId): Promise<FactorSeries> {
  const hit = memory.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.series;

  const file = cacheFile(id);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
      expiresAt: number;
      series: FactorSeries;
    };
    if (parsed.expiresAt > Date.now()) {
      memory.set(id, { series: parsed.series, expiresAt: parsed.expiresAt });
      return parsed.series;
    }
  } catch {
    // A cache miss is not an error.
  }

  const set = FACTOR_SETS[id];
  const url = `${BASE}/${set.file}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let series: FactorSeries;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new MarketDataError(
        `The Kenneth French Data Library returned HTTP ${res.status} for ${set.file}.`,
      );
    }
    const { name, data } = unzipSingle(Buffer.from(await res.arrayBuffer()));
    series = parseFrenchCsv(data.toString('utf8'), name);
  } catch (e) {
    if (e instanceof MarketDataError) throw e;
    throw new MarketDataError(
      `Could not reach the Kenneth French Data Library for ${set.label}. ` +
        'Factor regression needs it; nothing is substituted.',
      undefined,
      e,
    );
  } finally {
    clearTimeout(timer);
  }

  const expiresAt = Date.now() + TTL_MS;
  memory.set(id, { series, expiresAt });
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ expiresAt, series }));
  } catch {
    // A cache write failure must never fail a regression.
  }
  return series;
}

/* ------------------------------------------------------------------ */
/* Alignment                                                           */
/* ------------------------------------------------------------------ */

export interface AlignedFactors {
  dates: IsoDate[];
  /** Factor name → returns on `dates`. */
  factors: Record<string, number[]>;
  riskFree: number[];
  /** True when the factor data ends before the portfolio's own last day. */
  truncated: boolean;
  /** The portfolio's last day, for reporting what was dropped. */
  portfolioEnd: IsoDate;
  /** The last day common to both. */
  covered: IsoDate;
}

/**
 * Intersects a portfolio's trading days with the factor calendar.
 *
 * Inner join, deliberately. A missing factor day cannot be forward-filled: the
 * factors are themselves returns, so carrying one forward invents a day of
 * market movement that did not happen and biases every beta toward zero.
 */
export function alignToFactors(
  portfolioDates: IsoDate[],
  portfolioReturns: number[],
  sets: FactorSeries[],
): AlignedFactors & { excess: number[] } {
  if (portfolioDates.length !== portfolioReturns.length) {
    throw new MarketDataError('Portfolio dates and returns have different lengths.');
  }

  const indexOf = sets.map((s) => new Map(s.dates.map((d, i) => [d, i])));
  // Risk-free comes from whichever set publishes it; the momentum file does not.
  const rfSet = sets.findIndex((s) => s.riskFree && s.riskFree.length > 0);
  if (rfSet < 0) {
    throw new MarketDataError('No factor set in this request publishes a risk-free rate.');
  }

  const dates: IsoDate[] = [];
  const excess: number[] = [];
  const riskFree: number[] = [];
  const factors: Record<string, number[]> = {};
  for (const s of sets) for (const name of Object.keys(s.factors)) factors[name] = [];

  for (let i = 0; i < portfolioDates.length; i++) {
    const d = portfolioDates[i];
    const rows = indexOf.map((m) => m.get(d));
    if (rows.some((r) => r === undefined)) continue;

    const rf = sets[rfSet].riskFree![rows[rfSet]!];
    dates.push(d);
    riskFree.push(rf);
    excess.push(portfolioReturns[i] - rf);
    sets.forEach((s, k) => {
      for (const [name, values] of Object.entries(s.factors)) factors[name].push(values[rows[k]!]);
    });
  }

  const portfolioEnd = portfolioDates[portfolioDates.length - 1] ?? '';
  const factorEnd = sets
    .map((s) => s.lastAvailable)
    .reduce((a, b) => (a < b ? a : b), sets[0].lastAvailable);

  return {
    dates,
    factors,
    riskFree,
    excess,
    truncated: factorEnd < portfolioEnd,
    portfolioEnd,
    covered: dates[dates.length - 1] ?? '',
  };
}

/** Exposed for `tests/factors.test.ts`. */
export const __testing = { unzipSingle };
