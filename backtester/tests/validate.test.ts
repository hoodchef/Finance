import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  parseConfig,
  parsePortfolio,
  parsePositions,
  parseSymbol,
} from '../src/lib/validate';
import { InMemoryPortfolioRepository } from '../src/lib/storage';

/**
 * The point of these is that a bad input produces a *specific, actionable*
 * message rather than a generic failure or, worse, a silently-corrected value
 * that changes what the user asked for without telling them.
 */

describe('symbols', () => {
  it('normalises case and whitespace', () => {
    expect(parseSymbol(' spy ')).toBe('SPY');
    expect(parseSymbol('brk-b')).toBe('BRK-B');
    expect(parseSymbol('^gspc')).toBe('^GSPC');
    expect(parseSymbol('xeqt.to')).toBe('XEQT.TO');
  });

  it('rejects anything that is not a ticker', () => {
    expect(() => parseSymbol('')).toThrow(ValidationError);
    expect(() => parseSymbol('DROP TABLE users')).toThrow(/not a valid ticker/);
    expect(() => parseSymbol('../../etc/passwd')).toThrow(/not a valid ticker/);
    expect(() => parseSymbol('A'.repeat(30))).toThrow(/not a valid ticker/);
  });
});

describe('positions', () => {
  it('accepts a normal portfolio', () => {
    const p = parsePositions([
      { symbol: 'spy', weight: 60 },
      { symbol: 'BND', weight: 40, expenseRatio: 0.03 },
    ]);
    expect(p.map((x) => x.symbol)).toEqual(['SPY', 'BND']);
    expect(p[1].expenseRatio).toBe(0.03);
  });

  it('rejects an empty portfolio', () => {
    expect(() => parsePositions([])).toThrow(/at least one holding/);
  });

  it('rejects negative weights with a reason', () => {
    expect(() => parsePositions([{ symbol: 'SPY', weight: -10 }])).toThrow(
      /Short positions are not supported/,
    );
  });

  it('rejects an all-zero allocation', () => {
    expect(() =>
      parsePositions([
        { symbol: 'SPY', weight: 0 },
        { symbol: 'BND', weight: 0 },
      ]),
    ).toThrow(/Total allocation is 0%/);
  });

  it('catches an expense ratio entered as a fraction of 100', () => {
    // Someone typing "3" meaning 3 basis points would be charged 3% a year.
    expect(() => parsePositions([{ symbol: 'SPY', weight: 100, expenseRatio: 45 }])).toThrow(
      /Enter it as a percentage/,
    );
  });

  it('caps portfolio size', () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ symbol: `A${i}`, weight: 1 }));
    expect(() => parsePositions(many)).toThrow(/limited to 40 holdings/);
  });

  it('does not silently renormalise weights that miss 100', () => {
    // The engine scales them and reports doing so; validation must not hide it.
    const p = parsePositions([
      { symbol: 'SPY', weight: 70 },
      { symbol: 'BND', weight: 20 },
    ]);
    expect(p.reduce((a, x) => a + x.weight, 0)).toBe(90);
  });
});

describe('config', () => {
  const base = {
    start: '2015-01-01',
    end: '2020-01-01',
    initialInvestment: 10_000,
    benchmarks: ['spy'],
  };

  it('applies defaults for omitted fields', () => {
    const c = parseConfig(base);
    expect(c.rebalance).toBeDefined();
    expect(c.dividends).toBe('reinvest');
    expect(c.benchmarks).toEqual(['SPY']);
  });

  it('rejects an inverted date range', () => {
    expect(() => parseConfig({ ...base, start: '2020-01-01', end: '2015-01-01' })).toThrow(
      /start date must be before the end date/,
    );
  });

  it('clamps an end date in the future to today', () => {
    const c = parseConfig({ ...base, end: '2999-01-01' });
    expect(c.end).toBe(new Date().toISOString().slice(0, 10));
  });

  it('rejects a start date before the supported history floor', () => {
    expect(() => parseConfig({ ...base, start: '1900-01-01' })).toThrow(/earliest supported/);
  });

  it('rejects a run with nothing to invest', () => {
    expect(() =>
      parseConfig({ ...base, initialInvestment: 0, contributionFrequency: 'none' }),
    ).toThrow(/nothing to invest/);
  });

  it('allows a contribution-only run', () => {
    const c = parseConfig({
      ...base,
      initialInvestment: 0,
      contributionAmount: 500,
      contributionFrequency: 'monthly',
    });
    expect(c.initialInvestment).toBe(0);
    expect(c.contributionAmount).toBe(500);
  });

  it('rejects out-of-range fees', () => {
    expect(() => parseConfig({ ...base, fees: { managementFeePct: -1 } })).toThrow(/cannot be negative/);
    expect(() => parseConfig({ ...base, fees: { managementFeePct: 50 } })).toThrow(/out of range/);
    expect(() => parseConfig({ ...base, fees: { tradingCostBps: 5000 } })).toThrow(/out of range/);
  });

  it('rejects an impossible drift band', () => {
    expect(() => parseConfig({ ...base, rebalanceThresholdPct: 0 })).toThrow(/between 0 and 50/);
    expect(() => parseConfig({ ...base, rebalanceThresholdPct: 80 })).toThrow(/between 0 and 50/);
  });

  it('rejects an unknown enum value instead of guessing', () => {
    expect(() => parseConfig({ ...base, rebalance: 'fortnightly' })).toThrow(/must be one of/);
    expect(() => parseConfig({ ...base, dividends: 'burn' })).toThrow(/must be one of/);
  });

  it('de-duplicates and caps benchmarks', () => {
    const c = parseConfig({ ...base, benchmarks: ['SPY', 'spy', 'QQQ', 'VTI', 'VT', 'BND', 'GLD', 'TLT'] });
    expect(c.benchmarks).toHaveLength(6);
    expect(new Set(c.benchmarks).size).toBe(6);
  });

  it('takes the absolute value of a contribution and uses the flag for direction', () => {
    const c = parseConfig({ ...base, contributionAmount: -500, contributionIsWithdrawal: true });
    expect(c.contributionAmount).toBe(500);
    expect(c.contributionIsWithdrawal).toBe(true);
  });
});

describe('portfolio payload', () => {
  it('falls back to a usable name', () => {
    const p = parsePortfolio({ positions: [{ symbol: 'SPY', weight: 100 }] });
    expect(p.name).toBe('Portfolio');
  });

  it('truncates an absurdly long name', () => {
    const p = parsePortfolio({
      name: 'x'.repeat(500),
      positions: [{ symbol: 'SPY', weight: 100 }],
    });
    expect(p.name.length).toBe(120);
  });
});

describe('portfolio repository contract', () => {
  const portfolio = {
    id: 'p1',
    name: 'Test',
    positions: [{ id: 'a', symbol: 'SPY', weight: 100 }],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  it('round-trips and isolates owners', async () => {
    const repo = new InMemoryPortfolioRepository();
    await repo.save('alice', portfolio);

    expect(await repo.get('alice', 'p1')).toMatchObject({ name: 'Test' });
    // Bob must not see Alice's portfolio.
    expect(await repo.get('bob', 'p1')).toBeNull();
    expect(await repo.list('bob')).toEqual([]);

    await repo.delete('alice', 'p1');
    expect(await repo.list('alice')).toEqual([]);
  });

  it('stamps updatedAt on save', async () => {
    const repo = new InMemoryPortfolioRepository();
    const saved = await repo.save('alice', portfolio);
    expect(saved.updatedAt).not.toBe(portfolio.updatedAt);
  });
});
