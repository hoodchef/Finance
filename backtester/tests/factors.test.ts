import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { MarketDataError } from '../src/lib/market-data/provider';
import {
  __testing,
  alignToFactors,
  parseFrenchCsv,
  type FactorSeries,
} from '../src/lib/market-data/factors';

/**
 * Offline throughout. The live library is exercised by `npm run verify:data`;
 * these pin the parsing and alignment contracts, which is where a silent wrong
 * answer would come from.
 */

/** Builds a single-entry ZIP the way a server would serve one. */
function makeZip(name: string, contents: string, { corrupt = false } = {}): Buffer {
  const data = Buffer.from(contents, 'utf8');
  const deflated = zlib.deflateRawSync(data);
  const crc = corrupt ? 0xdeadbeef : zlib.crc32(data) >>> 0;
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localBlock = Buffer.concat([local, nameBuf, deflated]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralBlock = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

describe('ZIP extraction', () => {
  it('extracts a deflated entry', () => {
    const { name, data } = __testing.unzipSingle(makeZip('f.csv', 'hello,world\n'));
    expect(name).toBe('f.csv');
    expect(data.toString('utf8')).toBe('hello,world\n');
  });

  it('rejects an archive whose checksum does not match', () => {
    // A truncated download is a wrong answer, not a parse error, so the
    // checksum is the only thing standing between it and a plausible-looking
    // regression on partial data.
    expect(() => __testing.unzipSingle(makeZip('f.csv', 'x,y\n', { corrupt: true }))).toThrow(
      /checksum/i,
    );
  });

  it('rejects something that is not a ZIP', () => {
    expect(() => __testing.unzipSingle(Buffer.from('not a zip at all, just text'))).toThrow(
      MarketDataError,
    );
  });
});

/** Mirrors the real layout: prose preamble, header, dailies, blank, copyright. */
const CSV = `This file was created by using the 202606 CRSP database.
The Tbill return is the simple daily rate, which compounds to the 1-month rate.

,Mkt-RF,SMB,HML,RF
19260701,    0.09,   -0.25,   -0.27,    0.01
19260702,    0.45,   -0.33,   -0.06,    0.01
19260706,  -99.99,   -0.10,    0.20,    0.01
19260707,    0.09,   -0.58,    0.02,    0.01

Copyright 2026 Eugene F. Fama and Kenneth R. French
`;

describe('parsing the Data Library CSV', () => {
  const s = parseFrenchCsv(CSV, 'test.csv');

  it('finds the header by shape, not by line number', () => {
    // The preamble length differs between the three files and has changed over
    // the years, so a fixed offset would break silently on an update.
    expect(Object.keys(s.factors)).toEqual(['Mkt-RF', 'SMB', 'HML']);
  });

  it('converts percent to decimal', () => {
    expect(s.factors['Mkt-RF'][0]).toBeCloseTo(0.0009, 12);
    expect(s.factors.HML[0]).toBeCloseTo(-0.0027, 12);
    expect(s.riskFree![0]).toBeCloseTo(0.0001, 12);
  });

  it('drops rows carrying the −99.99 missing sentinel', () => {
    // Letting one through would enter the regression as a −99% day.
    expect(s.dates).toEqual(['1926-07-01', '1926-07-02', '1926-07-07']);
    expect(s.factors['Mkt-RF']).toHaveLength(3);
    expect(Math.min(...s.factors['Mkt-RF'])).toBeGreaterThan(-0.5);
  });

  it('stops at the blank line rather than parsing the copyright', () => {
    expect(s.lastAvailable).toBe('1926-07-07');
  });

  it('separates the risk-free rate from the factors', () => {
    expect(s.factors.RF).toBeUndefined();
    expect(s.riskFree).toHaveLength(3);
  });

  it('fails loudly if the format changes beyond recognition', () => {
    expect(() => parseFrenchCsv('just some prose\nwith no table at all\n', 'x.csv')).toThrow(
      MarketDataError,
    );
  });
});

function series(dates: string[], factors: Record<string, number[]>, rf?: number[]): FactorSeries {
  return {
    dates,
    factors,
    riskFree: rf,
    source: 'test',
    lastAvailable: dates[dates.length - 1],
    fetchedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('aligning a portfolio to the factor calendar', () => {
  const ff = series(
    ['2026-01-02', '2026-01-05', '2026-01-06'],
    { 'Mkt-RF': [0.01, -0.02, 0.005] },
    [0.0001, 0.0001, 0.0001],
  );

  it('subtracts the risk-free rate to form excess returns', () => {
    const a = alignToFactors(['2026-01-02', '2026-01-05'], [0.012, -0.018], [ff]);
    expect(a.excess[0]).toBeCloseTo(0.012 - 0.0001, 12);
    expect(a.excess[1]).toBeCloseTo(-0.018 - 0.0001, 12);
  });

  it('inner-joins rather than forward-filling a missing factor day', () => {
    // Carrying a factor forward would invent a day of market movement that did
    // not happen, biasing every beta toward zero.
    const a = alignToFactors(
      ['2026-01-02', '2026-01-03', '2026-01-05'],
      [0.01, 0.02, 0.03],
      [ff],
    );
    expect(a.dates).toEqual(['2026-01-02', '2026-01-05']);
    expect(a.factors['Mkt-RF']).toEqual([0.01, -0.02]);
    expect(a.excess).toHaveLength(2);
  });

  it('reports truncation when the library lags the portfolio', () => {
    // French publishes one to two months behind. A regression that quietly
    // covered a different window than asked for would be a wrong answer.
    const a = alignToFactors(
      ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'],
      [0.01, 0.02, 0.03, 0.04],
      [ff],
    );
    expect(a.truncated).toBe(true);
    expect(a.portfolioEnd).toBe('2026-01-07');
    expect(a.covered).toBe('2026-01-06');
  });

  it('does not claim truncation when the calendars agree', () => {
    const a = alignToFactors(['2026-01-02', '2026-01-05', '2026-01-06'], [0.01, 0.02, 0.03], [ff]);
    expect(a.truncated).toBe(false);
    expect(a.covered).toBe('2026-01-06');
  });

  it('joins several sets at once, taking the risk-free from whichever has it', () => {
    const mom = series(['2026-01-02', '2026-01-05', '2026-01-06'], { Mom: [0.003, 0.004, 0.005] });
    const a = alignToFactors(['2026-01-02', '2026-01-05'], [0.01, 0.02], [ff, mom]);
    expect(Object.keys(a.factors).sort()).toEqual(['Mkt-RF', 'Mom']);
    expect(a.factors.Mom).toEqual([0.003, 0.004]);
    expect(a.riskFree).toEqual([0.0001, 0.0001]);
  });

  it('refuses when no set supplies a risk-free rate', () => {
    const mom = series(['2026-01-02'], { Mom: [0.003] });
    expect(() => alignToFactors(['2026-01-02'], [0.01], [mom])).toThrow(MarketDataError);
  });

  it('refuses mismatched portfolio inputs', () => {
    expect(() => alignToFactors(['2026-01-02', '2026-01-05'], [0.01], [ff])).toThrow(
      MarketDataError,
    );
  });
});
