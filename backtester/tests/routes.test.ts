import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV_GROUPS, NAV_ITEMS, MOBILE_NAV } from '../src/components/layout/nav';

const APP = path.join(__dirname, '..', 'src', 'app');

/**
 * The navigation promises destinations; these check they exist.
 *
 * A nav entry pointing at a route nobody created is a 404 that only appears
 * when someone clicks it, and it will not fail a build or a type check.
 */
describe('every navigation target is a real route', () => {
  it.each(NAV_ITEMS.map((i) => [i.href, i.label]))('%s (%s) has a page', (href) => {
    const dir = href === '/' ? APP : path.join(APP, href.replace(/^\//, ''));
    expect(fs.existsSync(path.join(dir, 'page.tsx')), `${href} has no page.tsx`).toBe(true);
  });

  it('groups the destinations rather than listing them flat', () => {
    // A flat list of ten gives no reading of what the product is for, and is
    // how the planner came to look like a bolted-on second application.
    expect(NAV_GROUPS.length).toBeGreaterThanOrEqual(3);
    for (const g of NAV_GROUPS) expect(g.items.length).toBeGreaterThan(0);
  });

  it('keeps the mobile bar to a thumb-sized number of targets', () => {
    expect(MOBILE_NAV.length).toBeLessThanOrEqual(5);
    expect(MOBILE_NAV.length).toBeGreaterThan(2);
    // Every mobile entry must also be a real destination.
    for (const m of MOBILE_NAV) expect(NAV_ITEMS.some((i) => i.href === m.href)).toBe(true);
  });

  it('carries the planner and the simulator in the primary journey', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    for (const required of ['/', '/planner', '/backtest', '/simulator', '/lab']) {
      expect(hrefs, `missing ${required}`).toContain(required);
    }
  });

  it('gives every destination a distinct path and label', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.label)).size).toBe(NAV_ITEMS.length);
  });
});

describe('every API route the client calls exists', () => {
  const CALLED = [
    'backtest', 'compare', 'data-source', 'factors', 'lab',
    'montecarlo', 'planner', 'rebalance-analysis', 'scenarios', 'search', 'simulate',
  ];
  it.each(CALLED)('/api/%s', (name) => {
    expect(fs.existsSync(path.join(APP, 'api', name, 'route.ts'))).toBe(true);
  });
});
