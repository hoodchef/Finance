import { describe, expect, it } from 'vitest';
import { buildShareUrl, decodeShareLink, encodeShareLink } from '../src/lib/share';
import { parseConfig, parsePositions, ValidationError } from '../src/lib/validate';
import { defaultConfig } from '../src/lib/defaults';
import { testConfig } from './helpers';

const portfolio = {
  name: '60/40',
  positions: [
    { id: '1', symbol: 'SPY', weight: 60 },
    { id: '2', symbol: 'BND', weight: 40, expenseRatio: 0.03 },
  ],
};

/** The round trip every link must survive: encode → decode → validate. */
function roundTrip(p: typeof portfolio, c = defaultConfig()) {
  const decoded = decodeShareLink(encodeShareLink(p, c))!;
  return { positions: parsePositions(decoded.portfolio.positions), config: parseConfig(decoded.config), decoded };
}

describe('share links', () => {
  it('round-trips holdings including expense ratios', () => {
    const { positions, decoded } = roundTrip(portfolio);
    expect(decoded.portfolio.name).toBe('60/40');
    expect(positions.map((p) => [p.symbol, p.weight, p.expenseRatio])).toEqual([
      ['SPY', 60, undefined],
      ['BND', 40, 0.03],
    ]);
  });

  it('round-trips every non-default setting', () => {
    const custom = testConfig({
      start: '2010-01-04',
      end: '2020-12-31',
      initialInvestment: 25_000,
      contributionAmount: 500,
      contributionFrequency: 'monthly',
      rebalance: 'threshold',
      rebalanceThresholdPct: 7.5,
      dividends: 'cash',
      cashYieldPct: 4,
      costBasisMethod: 'hifo',
      benchmarks: ['QQQ', 'VTI'],
      fees: { managementFeePct: 0.5, tradingCostBps: 12, commissionPerTrade: 1.5, defaultExpenseRatioPct: 0.07 },
      riskFree: { source: 'tbill', constantPct: 3 },
      inflation: { mode: 'cpi', constantPct: 2.5, adjustContributions: true },
    });

    const { config } = roundTrip(portfolio, custom);
    expect(config.start).toBe('2010-01-04');
    expect(config.initialInvestment).toBe(25_000);
    expect(config.contributionFrequency).toBe('monthly');
    expect(config.rebalance).toBe('threshold');
    expect(config.rebalanceThresholdPct).toBe(7.5);
    expect(config.dividends).toBe('cash');
    expect(config.cashYieldPct).toBe(4);
    expect(config.costBasisMethod).toBe('hifo');
    expect(config.benchmarks).toEqual(['QQQ', 'VTI']);
    expect(config.fees).toMatchObject({ managementFeePct: 0.5, tradingCostBps: 12 });
    expect(config.riskFree).toMatchObject({ source: 'tbill' });
    expect(config.inflation).toMatchObject({ mode: 'cpi', adjustContributions: true });
  });

  it('omits defaults so a plain link stays short', () => {
    const plain = encodeShareLink({ name: 'x', positions: [{ id: '1', symbol: 'SPY', weight: 100 }] }, defaultConfig());
    // Only the version, name and one holding survive; nothing else is written.
    expect(plain.length).toBeLessThan(80);
    const decoded = decodeShareLink(plain)!;
    expect(decoded.config).toEqual({});
  });

  it('produces a URL-safe payload', () => {
    const url = buildShareUrl('https://example.com', portfolio, testConfig({ benchmarks: ['^GSPC'] }));
    const encoded = url.split('?s=')[1];
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new URL(url).searchParams.get('s')).toBe(encoded);
  });

  it('rejects malformed, truncated and wrong-version payloads', () => {
    expect(decodeShareLink('')).toBeNull();
    expect(decodeShareLink('not-base64!!')).toBeNull();
    expect(decodeShareLink(encodeShareLink(portfolio, defaultConfig()).slice(0, 12))).toBeNull();
    // A payload from a future format version is refused rather than guessed at.
    const future = Buffer.from(JSON.stringify({ v: 99, h: [['SPY', 100]] })).toString('base64url');
    expect(decodeShareLink(future)).toBeNull();
    // No holdings at all is not a portfolio.
    const empty = Buffer.from(JSON.stringify({ v: 1, h: [] })).toString('base64url');
    expect(decodeShareLink(empty)).toBeNull();
  });

  it('cannot smuggle values past validation', () => {
    // A hand-crafted link carrying a hostile ticker and an absurd fee must be
    // rejected by exactly the same rules a typed request faces.
    const hostile = Buffer.from(
      JSON.stringify({
        v: 1,
        h: [['../../etc/passwd', 100]],
        c: { s: '2020-01-01', e: '2021-01-01' },
        f: [999, 0, 0, 0],
      }),
    ).toString('base64url');

    const decoded = decodeShareLink(hostile)!;
    expect(decoded).not.toBeNull();
    expect(() => parsePositions(decoded.portfolio.positions)).toThrow(ValidationError);
    expect(() => parseConfig(decoded.config)).toThrow(/out of range/);
  });

  it('clamps an over-long shared name', () => {
    const decoded = decodeShareLink(
      encodeShareLink({ name: 'y'.repeat(400), positions: portfolio.positions }, defaultConfig()),
    )!;
    expect(decoded.portfolio.name.length).toBe(120);
  });
});
