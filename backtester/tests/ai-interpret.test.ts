import { describe, expect, it } from 'vitest';
import { interpretProposal } from '../src/lib/ai/interpret';
import { ValidationError } from '../src/lib/validate';

/**
 * The safety boundary.
 * =============================================================================
 * Above this line a local model produces text. Below it, a request identical
 * to one a person typed. These tests exist to prove the line holds under the
 * things a model actually does wrong — invented tickers, weights that do not
 * sum, numbers as strings, dates as prose, and confident nonsense.
 *
 * The rule being enforced: a model can propose, and it can be wrong, but it
 * cannot produce a portfolio that a typed request could not also produce. Every
 * failure has to surface as a rejection or a visible flag, never as a silently
 * corrected input.
 */

const good = {
  name: 'Balanced',
  positions: [
    { symbol: 'SPY', weight: 60 },
    { symbol: 'BND', weight: 40 },
  ],
  start: '2015-01-02',
  end: '2024-12-31',
  rebalance: 'annual',
  initialInvestment: 10000,
  notes: '',
};

describe('a well-formed proposal', () => {
  it('becomes a validated portfolio and config', () => {
    const out = interpretProposal(good);
    expect(out.name).toBe('Balanced');
    expect(out.positions.map((p) => p.symbol)).toEqual(['SPY', 'BND']);
    expect(out.positions.map((p) => p.weight)).toEqual([60, 40]);
    expect(out.config.start).toBe('2015-01-02');
    expect(out.config.rebalance).toBe('annual');
    expect(out.warnings).toHaveLength(0);
    expect(out.defaulted).toHaveLength(0);
  });

  it('recognises real tickers and names them', () => {
    const out = interpretProposal(good);
    expect(out.symbols.every((s) => !s.unrecognised)).toBe(true);
    expect(out.symbols[0].name).toBeTruthy();
  });
});

describe('what a model actually gets wrong', () => {
  it('flags an invented ticker instead of failing later as an outage', () => {
    // The characteristic failure: a plausible, confident, non-existent symbol.
    // Left unchecked it surfaces as a provider error that reads like the data
    // feed is down.
    const out = interpretProposal({
      ...good,
      positions: [
        { symbol: 'SPY', weight: 50 },
        { symbol: 'ZQXVT', weight: 50 },
      ],
    });
    const invented = out.symbols.find((s) => s.symbol === 'ZQXVT')!;
    expect(invented.unrecognised).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/not in the local symbol list/i);
    expect(out.warnings.join(' ')).toMatch(/invented/i);
  });

  it('reports weights that do not sum rather than normalising them', () => {
    // Silently rescaling would hide that the model misunderstood the request.
    const out = interpretProposal({
      ...good,
      positions: [
        { symbol: 'SPY', weight: 60 },
        { symbol: 'BND', weight: 30 },
      ],
    });
    expect(out.positions.map((p) => p.weight)).toEqual([60, 30]);
    expect(out.warnings.join(' ')).toMatch(/total 90\.0%/);
  });

  it('accepts numbers that arrived as strings', () => {
    const out = interpretProposal({
      ...good,
      positions: [
        { symbol: 'SPY', weight: '60' },
        { symbol: 'BND', weight: '40' },
      ],
      initialInvestment: '$25,000',
    });
    expect(out.positions.map((p) => p.weight)).toEqual([60, 40]);
    expect(out.config.initialInvestment).toBe(25000);
  });

  it('normalises a Canadian ticker the way the providers expect', () => {
    const out = interpretProposal({ ...good, positions: [{ symbol: 'xeqt.to', weight: 100 }] });
    expect(out.positions[0].symbol).toBe('XEQT.TO');
  });

  it('takes an alternative key the model may use for a symbol', () => {
    const out = interpretProposal({ ...good, positions: [{ ticker: 'SPY', weight: 100 }] });
    expect(out.positions[0].symbol).toBe('SPY');
  });
});

describe('nothing is invented on the model’s behalf', () => {
  it('defaults what was not mentioned, and says which', () => {
    const out = interpretProposal({
      name: 'Just holdings',
      positions: [{ symbol: 'VTI', weight: 100 }],
      start: null,
      end: null,
      rebalance: null,
      initialInvestment: null,
      notes: '',
    });
    // The prompt tells the model to return null rather than guess a date. What
    // it did not say must be visibly a default, not a decision.
    expect(out.defaulted.join(' ')).toMatch(/start date/);
    expect(out.defaulted.join(' ')).toMatch(/initial investment/);
    expect(out.config.start).toBeTruthy();
  });

  it('ignores a date that is not a date', () => {
    const out = interpretProposal({ ...good, start: 'the start of 2015', end: 'last year' });
    expect(out.defaulted.join(' ')).toMatch(/start date/);
    expect(out.config.start).not.toBe('the start of 2015');
  });

  it('ignores a rebalancing rule the engine does not have', () => {
    const out = interpretProposal({ ...good, rebalance: 'whenever it drifts a lot' });
    expect(out.defaulted.join(' ')).toMatch(/rebalancing/);
    expect(['never', 'monthly', 'quarterly', 'semiannual', 'annual']).toContain(
      out.config.rebalance,
    );
  });

  it('carries the model’s own uncertainty through', () => {
    const out = interpretProposal({ ...good, notes: 'Unsure whether you meant VFV or VOO.' });
    expect(out.notes).toMatch(/VFV or VOO/);
  });
});

describe('refusals', () => {
  it('rejects a proposal with no holdings', () => {
    expect(() => interpretProposal({ ...good, positions: [] })).toThrow(ValidationError);
    expect(() => interpretProposal({ ...good, positions: undefined })).toThrow(ValidationError);
  });

  it('rejects a proposal whose holdings have no tickers', () => {
    expect(() =>
      interpretProposal({ ...good, positions: [{ weight: 100 }, { symbol: '  ' }] }),
    ).toThrow(ValidationError);
  });

  it('rejects prose where an object was required', () => {
    // A model that ignores the schema entirely must produce an error, not a
    // portfolio assembled from whatever fields happened to survive.
    expect(() =>
      interpretProposal({ positions: 'sixty percent stocks, forty percent bonds' } as never),
    ).toThrow(ValidationError);
  });

  it('applies the same holding limit a typed request gets', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ symbol: `SYM${i}`, weight: 1 }));
    // parsePositions caps at 40; the model gets no special allowance.
    const out = interpretProposal({ ...good, positions: many });
    expect(out.positions.length).toBeLessThanOrEqual(40);
  });

  it('refuses a negative weight rather than treating it as a short', () => {
    expect(() =>
      interpretProposal({
        ...good,
        positions: [
          { symbol: 'SPY', weight: 150 },
          { symbol: 'BND', weight: -50 },
        ],
      }),
    ).toThrow(ValidationError);
  });
});
