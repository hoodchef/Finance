import { describe, expect, it } from 'vitest';
import { isPartialDecimal, parsePartialDecimal } from '../src/components/builder/holding-row';

/**
 * The allocation and expense fields are `type="text"`, so these two functions
 * are the whole of their input validation. A number input reports `value` as
 * '' for anything it cannot parse, which is why they exist: typing "0." read
 * back as '' and a controlled field wiped it, turning the next keystroke of
 * "0.2" into "2".
 */
describe('what a percentage field accepts while being typed', () => {
  it('accepts every prefix of a decimal, one keystroke at a time', () => {
    // The sequence a person actually produces typing 0.25.
    for (const step of ['', '0', '0.', '0.2', '0.25']) {
      expect(isPartialDecimal(step), `rejected "${step}"`).toBe(true);
    }
  });

  it('accepts a bare leading dot and whole numbers', () => {
    expect(isPartialDecimal('.')).toBe(true);
    expect(isPartialDecimal('.5')).toBe(true);
    expect(isPartialDecimal('10')).toBe(true);
    expect(isPartialDecimal('100')).toBe(true);
  });

  it('rejects anything that cannot become a non-negative decimal', () => {
    // A weight is a percentage; negatives and exponents are not entries a
    // person makes on purpose, and letting them through writes NaN.
    for (const bad of ['abc', '-5', '1e5', '1.2.3', '5%', ' 5', '+1']) {
      expect(isPartialDecimal(bad), `accepted "${bad}"`).toBe(false);
    }
  });
});

describe('what a partial entry is worth', () => {
  it('reads a completed number', () => {
    expect(parsePartialDecimal('0.25')).toBe(0.25);
    expect(parsePartialDecimal('10')).toBe(10);
    expect(parsePartialDecimal('.5')).toBe(0.5);
    // The originally reported bug: a leading zero must not survive into the
    // committed value.
    expect(parsePartialDecimal('010')).toBe(10);
  });

  it('treats a trailing dot as the number so far', () => {
    // "0." must commit 0 rather than NaN, so the field can be left mid-decimal.
    expect(parsePartialDecimal('0.')).toBe(0);
    expect(parsePartialDecimal('12.')).toBe(12);
  });

  it('returns null where there is no number yet', () => {
    expect(parsePartialDecimal('')).toBeNull();
    expect(parsePartialDecimal('.')).toBeNull();
  });
});
