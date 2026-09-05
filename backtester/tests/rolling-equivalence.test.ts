import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeRolling, computeAllRolling, ROLLING_WINDOWS } from '../src/lib/metrics/rolling';
import {
  computeRolling as referenceRolling,
  computeAllRolling as referenceAll,
} from './_rolling-reference';
import { makeCalendar } from './helpers';
import { hasFixtures, fixtureProvider } from './fixture-provider';
import type { IsoDate } from '../src/lib/types';

/**
 * The optimised rolling module against the one it replaced.
 * =============================================================================
 * `_rolling-reference.ts` is the implementation as it stood at HEAD, kept
 * verbatim so the two can be run side by side. This is the only honest way to
 * optimise a metrics path: the claim being made is "same numbers, less work",
 * and the only proof of the first half is running both.
 *
 * The reference is checked in deliberately. A benchmark that says something got
 * faster is worth very little on its own — the fast way to compute a drawdown
 * is to compute the wrong one — and the reference is what stops that.
 *
 * Two differences ARE expected and are asserted as such rather than waved at:
 *
 *   - The reference computes `maxDrawdown` for every window and then discards
 *     ~92% of them; the current one computes it for the kept windows only. The
 *     kept points must agree exactly.
 *   - The reference skipped drawdowns entirely on large inputs, reporting
 *     `null`, because the whole sweep was too expensive. The current one
 *     budgets against the work it actually does, so it can report a figure
 *     where the reference gave up. That is a strict improvement, and the test
 *     allows the current one to be non-null where the reference is null but
 *     never the reverse.
 */

function walk(n: number, seed: number): { dates: IsoDate[]; index: number[]; returns: number[] } {
  const dates = makeCalendar('1995-01-03', n);
  let s = seed >>> 0;
  const index = [100];
  const returns = [0];
  for (let i = 1; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    // Deliberately fat-tailed and drifting, so drawdowns are deep and frequent
    // rather than a gentle wobble that any implementation would agree on.
    const u = s / 0x7fffffff;
    const r = (u - 0.48) * 0.05;
    returns.push(r);
    index.push(index[i - 1] * (1 + r));
  }
  return { dates, index, returns };
}

const CASES = [
  { label: 'short history, 3 years', n: 900 },
  { label: 'ten years', n: 2520 },
  { label: 'twenty-five years', n: 6300 },
];

describe('optimised rolling matches the implementation it replaced', () => {
  for (const { label, n } of CASES) {
    describe(label, () => {
      const { dates, index, returns } = walk(n, 987654321);

      it('produces identical summaries for every window length', () => {
        for (const years of ROLLING_WINDOWS) {
          const now = computeRolling(dates, index, returns, years, 252);
          const ref = referenceRolling(dates, index, returns, years, 252);
          expect(now === null, `${years}y presence`).toBe(ref === null);
          if (!now || !ref) continue;
          // The summary is built from every window, not just the plotted ones,
          // so it must be bit-identical.
          expect(now.summary, `${years}y summary`).toEqual(ref.summary);
        }
      });

      it('plots the same windows with the same returns and volatility', () => {
        for (const years of ROLLING_WINDOWS) {
          const now = computeRolling(dates, index, returns, years, 252);
          const ref = referenceRolling(dates, index, returns, years, 252);
          if (!now || !ref) continue;
          expect(now.points.length, `${years}y point count`).toBe(ref.points.length);
          for (let i = 0; i < now.points.length; i++) {
            const a = now.points[i];
            const b = ref.points[i];
            expect(a.startDate, `${years}y point ${i} start`).toBe(b.startDate);
            expect(a.endDate, `${years}y point ${i} end`).toBe(b.endDate);
            expect(a.annualised, `${years}y point ${i} annualised`).toBe(b.annualised);
            expect(a.volatility, `${years}y point ${i} volatility`).toBe(b.volatility);
          }
        }
      });

      it('reports the same drawdown wherever the reference reported one', () => {
        for (const years of ROLLING_WINDOWS) {
          const now = computeRolling(dates, index, returns, years, 252);
          const ref = referenceRolling(dates, index, returns, years, 252);
          if (!now || !ref) continue;
          for (let i = 0; i < now.points.length; i++) {
            const a = now.points[i].maxDrawdown;
            const b = ref.points[i].maxDrawdown;
            if (b === null) continue; // The reference gave up; we may not have.
            expect(a, `${years}y point ${i} drawdown`).toBe(b);
          }
        }
      });

      it('never reports a drawdown of null where the reference managed one', () => {
        for (const years of ROLLING_WINDOWS) {
          const now = computeRolling(dates, index, returns, years, 252);
          const ref = referenceRolling(dates, index, returns, years, 252);
          if (!now || !ref) continue;
          const lostGround = now.points.filter(
            (p, i) => p.maxDrawdown === null && ref.points[i].maxDrawdown !== null,
          );
          expect(lostGround).toEqual([]);
        }
      });
    });
  }

  it('agrees across the whole window set at once', () => {
    const { dates, index, returns } = walk(4000, 24680);
    const now = computeAllRolling(dates, index, returns, 252);
    const ref = referenceAll(dates, index, returns, 252);
    expect(now.map((r) => r.years)).toEqual(ref.map((r) => r.years));
    expect(now.map((r) => r.summary)).toEqual(ref.map((r) => r.summary));
  });

  it('agrees on a weekly calendar, where the annualiser is not 252', () => {
    // The window is calendar-measured, so a coarser series must still land on
    // the same dates — this is where an index-arithmetic shortcut would break.
    const n = 1200;
    const dates: IsoDate[] = [];
    let t = Date.parse('2000-01-07T00:00:00Z');
    for (let i = 0; i < n; i++) {
      dates.push(new Date(t).toISOString().slice(0, 10) as IsoDate);
      t += 7 * 86_400_000;
    }
    let s = 555;
    const index = [100];
    const returns = [0];
    for (let i = 1; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const r = (s / 0x7fffffff - 0.47) * 0.06;
      returns.push(r);
      index.push(index[i - 1] * (1 + r));
    }
    for (const years of ROLLING_WINDOWS) {
      const now = computeRolling(dates, index, returns, years, 52);
      const ref = referenceRolling(dates, index, returns, years, 52);
      expect(now === null).toBe(ref === null);
      if (!now || !ref) continue;
      expect(now.summary).toEqual(ref.summary);
      expect(now.points.map((p) => [p.startDate, p.endDate])).toEqual(
        ref.points.map((p) => [p.startDate, p.endDate]),
      );
    }
  });
});

const FIXTURES = path.join(__dirname, 'fixtures');
const haveSpy = fs.existsSync(path.join(FIXTURES, 'tiingo-spy-2015-2024.json'));

describe.runIf(haveSpy && hasFixtures(['SPY']))('and on real recorded SPY history', () => {
  it('matches window for window', async () => {
    const provider = fixtureProvider();
    const series = await provider.getHistoricalPrices('SPY', {
      start: '2015-01-02',
      end: '2024-12-31',
    });
    const dates = series.bars.map((b) => b.date);
    // Total-return index from raw closes and cash dividends, so the series has
    // the real shape rather than a smoothed one.
    const divs = new Map(series.dividends.map((d) => [d.date, d.amount]));
    const index = [1];
    const returns = [0];
    for (let i = 1; i < series.bars.length; i++) {
      const r =
        (series.bars[i].close + (divs.get(series.bars[i].date) ?? 0)) / series.bars[i - 1].close - 1;
      returns.push(r);
      index.push(index[i - 1] * (1 + r));
    }
    for (const years of ROLLING_WINDOWS) {
      const now = computeRolling(dates, index, returns, years, 252);
      const ref = referenceRolling(dates, index, returns, years, 252);
      expect(now === null, `${years}y`).toBe(ref === null);
      if (!now || !ref) continue;
      expect(now.summary, `${years}y summary`).toEqual(ref.summary);
      for (let i = 0; i < now.points.length; i++) {
        expect(now.points[i].annualised).toBe(ref.points[i].annualised);
        if (ref.points[i].maxDrawdown !== null) {
          expect(now.points[i].maxDrawdown).toBe(ref.points[i].maxDrawdown);
        }
      }
    }
  });
});
