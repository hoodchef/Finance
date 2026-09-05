import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The provider chain, and why its order is load-bearing.
 * =============================================================================
 * Each vendor rate-limits separately. Wiring a page to one of them makes that
 * vendor's ceiling the whole application's — which is exactly what happened
 * when the chart called Polygon directly and a five-symbol optimisation
 * stopped on its five-a-minute limit. Chained, the allowances add up.
 *
 * These assert the composition rather than the network, so they are fast and
 * cannot be flaky.
 */

async function chainFor(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  const { getProvider } = await import('../src/lib/market-data');
  return getProvider();
}

/** The ids a provider covers, whether single or chained. */
function idsOf(p: { id: string; providers?: Array<{ id: string }> }): string[] {
  const inner = (p as { providers?: Array<{ id: string }> }).providers;
  return inner ? inner.map((x) => x.id) : [p.id];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the chain', () => {
  it('includes Polygon when its key is set', async () => {
    const p = await chainFor({
      TIINGO_API_KEY: 'x',
      POLYGON_API_KEY: 'y',
      ALPHA_VANTAGE_API_KEY: '',
      MARKET_DATA_PROVIDER: '',
    });
    expect(idsOf(p)).toContain('polygon');
  });

  it('leaves it out when there is no key, rather than failing every request', async () => {
    const p = await chainFor({
      TIINGO_API_KEY: 'x',
      POLYGON_API_KEY: '',
      ALPHA_VANTAGE_API_KEY: '',
      MARKET_DATA_PROVIDER: '',
    });
    expect(idsOf(p)).not.toContain('polygon');
  });

  it('puts Tiingo ahead of Polygon, and Polygon ahead of Yahoo', async () => {
    /*
     * Tiingo first: a larger hourly quota and explicit corporate actions.
     * Polygon next: it is the only one here serving crypto and option
     * contracts. Yahoo last of the three: an undocumented endpoint that
     * rate-limits by IP without notice.
     */
    const ids = idsOf(
      await chainFor({
        TIINGO_API_KEY: 'x',
        POLYGON_API_KEY: 'y',
        ALPHA_VANTAGE_API_KEY: '',
        MARKET_DATA_PROVIDER: '',
      }),
    );
    expect(ids.indexOf('tiingo')).toBeLessThan(ids.indexOf('polygon'));
    expect(ids.indexOf('polygon')).toBeLessThan(ids.indexOf('yahoo'));
  });

  it('still chains when Polygon is the only key', async () => {
    const ids = idsOf(
      await chainFor({
        TIINGO_API_KEY: '',
        POLYGON_API_KEY: 'y',
        ALPHA_VANTAGE_API_KEY: '',
        MARKET_DATA_PROVIDER: '',
      }),
    );
    expect(ids[0]).toBe('polygon');
    expect(ids.length).toBeGreaterThan(1);
  });

  it('never falls back to synthetic data, whatever the keys', async () => {
    // A missing key must not silently downgrade a deployment to invented
    // prices; demo is only reachable by setting the provider explicitly.
    for (const env of [
      { TIINGO_API_KEY: '', POLYGON_API_KEY: '', ALPHA_VANTAGE_API_KEY: '' },
      { TIINGO_API_KEY: 'x', POLYGON_API_KEY: 'y', ALPHA_VANTAGE_API_KEY: 'z' },
    ]) {
      const p = await chainFor({ ...env, MARKET_DATA_PROVIDER: '' });
      expect(idsOf(p)).not.toContain('demo');
      expect((p as { synthetic?: boolean }).synthetic).not.toBe(true);
    }
  });

  it('honours an explicit provider choice', async () => {
    const p = await chainFor({ MARKET_DATA_PROVIDER: 'polygon', POLYGON_API_KEY: 'y' });
    expect(p.id).toBe('polygon');
  });
});
