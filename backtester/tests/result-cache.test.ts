import { beforeEach, describe, expect, it } from 'vitest';
import { __resetResultCache, cachedResult, resultCacheStats, resultKey } from '../src/lib/result-cache';
import { defaultConfig } from '../src/lib/defaults';
import type { BacktestResult } from '../src/lib/backtest';

const portfolio = {
  id: 'p',
  name: 'Balanced',
  positions: [
    { id: '1', symbol: 'SPY', weight: 60 },
    { id: '2', symbol: 'BND', weight: 40 },
  ],
};

const key = (over: Partial<Parameters<typeof resultKey>[0]> = {}) =>
  resultKey({
    portfolio,
    config: defaultConfig(),
    providerId: 'tiingo',
    includeAssetAnalysis: false,
    ...over,
  });

const fake = (tag: string) => ({ engineVersion: tag }) as unknown as BacktestResult;

describe('the shared result cache', () => {
  beforeEach(() => __resetResultCache());

  it('computes once and serves the rest', async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return fake('a');
    };
    const first = await cachedResult(key(), compute);
    const second = await cachedResult(key(), compute);
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('shares one computation between concurrent callers', async () => {
    // Studies fires several analyses at once. Without this they each run the
    // engine on identical inputs.
    let calls = 0;
    const compute = () =>
      new Promise<BacktestResult>((resolve) => {
        calls++;
        setTimeout(() => resolve(fake('b')), 30);
      });
    await Promise.all([
      cachedResult(key(), compute),
      cachedResult(key(), compute),
      cachedResult(key(), compute),
    ]);
    expect(calls).toBe(1);
  });

  it('does not leak a failure into the cache', async () => {
    await expect(
      cachedResult(key(), async () => {
        throw new Error('provider down');
      }),
    ).rejects.toThrow('provider down');
    // A failed run must not poison the key, nor be served as a result.
    expect(resultCacheStats().entries).toBe(0);
    expect(resultCacheStats().inFlight).toBe(0);
    const ok = await cachedResult(key(), async () => fake('c'));
    expect(ok.cached).toBe(false);
  });
});

describe('what counts as the same question', () => {
  it('ignores key order', () => {
    const a = resultKey({ portfolio, config: defaultConfig(), providerId: 'x', includeAssetAnalysis: false });
    const reordered = { ...defaultConfig() };
    const b = resultKey({ portfolio, config: reordered, providerId: 'x', includeAssetAnalysis: false });
    expect(a).toBe(b);
  });

  it('ignores a rename, which cannot change the answer', () => {
    const renamed = { ...portfolio, name: 'Something else', id: 'other' };
    expect(key()).toBe(key({ portfolio: renamed }));
  });

  it('normalises symbol case and whitespace', () => {
    const messy = {
      ...portfolio,
      positions: [
        { id: '1', symbol: ' spy ', weight: 60 },
        { id: '2', symbol: 'bnd', weight: 40 },
      ],
    };
    expect(key()).toBe(key({ portfolio: messy }));
  });

  it.each([
    ['a weight', { positions: [{ id: '1', symbol: 'SPY', weight: 70 }, { id: '2', symbol: 'BND', weight: 30 }] }],
    ['a holding', { positions: [{ id: '1', symbol: 'SPY', weight: 100 }] }],
  ])('treats %s as a different question', (_label, patch) => {
    expect(key()).not.toBe(key({ portfolio: { ...portfolio, ...patch } }));
  });

  it('treats a different window, fee or provider as different', () => {
    const base = defaultConfig();
    expect(key()).not.toBe(key({ config: { ...base, start: '2001-01-02' } }));
    expect(key()).not.toBe(
      key({ config: { ...base, fees: { ...base.fees, managementFeePct: 1 } } }),
    );
    // The same portfolio answered by a different provider is a different
    // result, and must never be served from one provider's cache to another.
    expect(key()).not.toBe(key({ providerId: 'yahoo' }));
  });

  it('treats per-asset analysis as part of the question', () => {
    // A result computed without it lacks fields a caller may then read as
    // empty rather than absent.
    expect(key()).not.toBe(key({ includeAssetAnalysis: true }));
  });
});
