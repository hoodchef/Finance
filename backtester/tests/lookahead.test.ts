import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/lib/engine/engine';
import { trendFilter, momentum, fixedWeights } from '../src/lib/engine/strategy';
import { buildPrepared, makeCalendar, testConfig } from './helpers';
import type { BacktestConfig } from '../src/lib/types';

/**
 * The engine may not trade on information it could not have had.
 * =============================================================================
 * A strategy is asked for weights on day `i`, and the trade that results fills
 * at day `i`'s CLOSE. So if the strategy is also allowed to READ day `i`'s
 * close, it is deciding on a number that does not exist until the market shuts
 * and then dealing at that very number. Nobody can do that. A market-on-close
 * order has to be submitted before the close is known.
 *
 * `trendFilter` did exactly this: it took today's close, folded it into the
 * moving average, compared the two, and traded. The effect is not subtle and it
 * is not random — it is a one-day head start on every exit, which means the
 * strategy steps out of a decline one day before anyone really could.
 *
 * These tests pin the fix by MEASURING the advantage rather than asserting that
 * some flag is set. `signalLagDays: 0` reproduces the old behaviour, so the two
 * can be run against the same prices and the gap read off directly. If someone
 * removes the lag, the first test fails with the size of the free money it
 * reintroduced.
 */

const CRASH_DAY = 150;

/**
 * A steady climb, then three sharp down days, then flat.
 *
 * Built this way so the two conventions are separated by exactly one crash day:
 * reading today's close gets you out at the first one, reading yesterday's gets
 * you out at the second.
 */
function climbThenCrash(n: number): number[] {
  const prices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < CRASH_DAY) prices.push(100 * (1 + i * 0.004));
    else if (i < CRASH_DAY + 3) prices.push(prices[i - 1] * 0.75);
    else prices.push(prices[i - 1]);
  }
  return prices;
}

function runWithLag(lag: number, strategy = trendFilter({ windowDays: 20 })) {
  const n = 200;
  const calendar = makeCalendar('2020-01-01', n);
  const data = buildPrepared(calendar, [
    { symbol: 'A', prices: climbThenCrash(n), weight: 100 },
  ]);
  const config: BacktestConfig = testConfig({
    start: calendar[0],
    end: calendar[n - 1],
    // A drift band, so the moment the filter says "out" the engine acts on it
    // rather than waiting for a month end.
    rebalance: 'threshold',
    rebalanceThresholdPct: 1,
    initialInvestment: 100_000,
  });
  const portfolio = {
    id: 'la',
    name: 'Trend',
    positions: [{ id: 'a', symbol: 'A', weight: 100 }],
  };
  return runEngine({ data, config, portfolio, strategy, signalLagDays: lag });
}

describe('a strategy cannot trade on the close it is reading', () => {
  it('shows the advantage the old convention handed out, and that it is gone', () => {
    const cheating = runWithLag(0);
    const honest = runWithLag(1);

    const cheatingFinal = cheating.totals.finalValue;
    const honestFinal = honest.totals.finalValue;

    // The look-ahead run steps out one crash day earlier, so it must finish
    // ahead. If this ever stops being true the scenario has drifted and the
    // test below is no longer measuring what it claims.
    expect(cheatingFinal).toBeGreaterThan(honestFinal);

    // And the gap is a whole 25% down day — not a rounding artefact.
    const advantage = cheatingFinal / honestFinal - 1;
    expect(advantage).toBeGreaterThan(0.2);
  });

  it('defaults to the honest convention', () => {
    // No `signalLagDays` given: the engine must behave like lag 1, not lag 0.
    const n = 200;
    const calendar = makeCalendar('2020-01-01', n);
    const data = buildPrepared(calendar, [
      { symbol: 'A', prices: climbThenCrash(n), weight: 100 },
    ]);
    const config = testConfig({
      start: calendar[0],
      end: calendar[n - 1],
      rebalance: 'threshold',
      rebalanceThresholdPct: 1,
      initialInvestment: 100_000,
    });
    const portfolio = {
      id: 'la',
      name: 'Trend',
      positions: [{ id: 'a', symbol: 'A', weight: 100 }],
    };
    const strategy = trendFilter({ windowDays: 20 });
    const defaulted = runEngine({ data, config, portfolio, strategy });
    const explicit = runWithLag(1);
    expect(defaulted.totals.finalValue).toBeCloseTo(explicit.totals.finalValue, 6);
  });

  it('leaves fixed weights untouched, which read no prices at all', () => {
    // The lag shifts the information set, not the calendar. A rule that never
    // looks at a price must produce byte-identical results either way, or the
    // change has done something beyond what it claims.
    const withLag = runWithLag(1, fixedWeights);
    const without = runWithLag(0, fixedWeights);
    expect(withLag.totals.finalValue).toBe(without.totals.finalValue);
    expect(withLag.daily.map((d) => d.index)).toEqual(without.daily.map((d) => d.index));
  });

  it('applies to momentum too, which ranks on a trailing return ending today', () => {
    // Two assets that swap leadership sharply; the ranking is what leaks.
    const n = 260;
    const calendar = makeCalendar('2020-01-01', n);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < n; i++) {
      a.push(i < 130 ? 100 * (1 + i * 0.005) : a[i - 1] * 0.98);
      b.push(i < 130 ? 100 : b[i - 1] * 1.02);
    }
    const data = buildPrepared(calendar, [
      { symbol: 'A', prices: a, weight: 50 },
      { symbol: 'B', prices: b, weight: 50 },
    ]);
    const config = testConfig({
      start: calendar[0],
      end: calendar[n - 1],
      rebalance: 'threshold',
      rebalanceThresholdPct: 1,
      initialInvestment: 100_000,
    });
    const portfolio = {
      id: 'mo',
      name: 'Momentum',
      positions: [
        { id: 'a', symbol: 'A', weight: 50 },
        { id: 'b', symbol: 'B', weight: 50 },
      ],
    };
    const strategy = momentum({ lookbackDays: 60, holdCount: 1 });
    const cheating = runEngine({ data, config, portfolio, strategy, signalLagDays: 0 });
    const honest = runEngine({ data, config, portfolio, strategy, signalLagDays: 1 });
    // The rotation is one day late once the leak is closed, so the honest run
    // cannot come out ahead.
    expect(honest.totals.finalValue).toBeLessThanOrEqual(cheating.totals.finalValue + 1e-6);
  });
});
