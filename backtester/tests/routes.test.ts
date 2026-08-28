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

  /**
   * The heading a route renders must be the label that led there.
   *
   * Six of ten drifted apart when the nav was regrouped and the pages were not
   * touched with it: clicking "Studies" landed on a page headed "Analytics",
   * "Holdings" on one headed "Assets". Nothing fails, nothing logs, and the
   * product feels like parts bolted together — which is exactly what a nav
   * rename is supposed to stop it feeling like.
   */
  it.each(NAV_ITEMS.map((i) => [i.href, i.label]))(
    '%s renders the heading "%s" that the nav promises',
    (href, label) => {
      const dir = href === '/' ? APP : path.join(APP, href.replace(/^\//, ''));
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
      // `&` is escaped in JSX, so compare against both forms.
      const wanted = [`title="${label}"`, `title="${label.replace(/&/g, '&amp;')}"`];
      const found = files.some((body) => wanted.some((w) => body.includes(w)));
      expect(found, `${href} has no PageHeader titled "${label}"`).toBe(true);
    },
  );

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

describe('every destination is reachable on a phone', () => {
  /**
   * The bottom bar carries five of the twelve destinations, which is the right
   * number for a thumb-sized bar. That left the other seven — Research and
   * Settings among them — with no route to them at all on a phone, until the
   * nav bar's menu enumerated the full set.
   *
   * Checked at the source rather than by rendering: the failure being guarded
   * against is someone giving the mobile menu its own hand-written list that
   * then falls behind NAV_GROUPS, and a shorter list is exactly what this
   * catches.
   */
  const navBar = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'layout', 'nav-bar.tsx'),
    'utf8',
  );

  it('builds its menus from the shared groups, not a copy of them', () => {
    expect(navBar).toContain('NAV_GROUPS');
    // Two menus — the desktop bar and the mobile sheet — both mapping groups.
    expect(navBar.match(/NAV_GROUPS\.map/g) ?? []).toHaveLength(2);
  });

  it('does not enumerate any destination by hand', () => {
    // A literal href in the bar is a link that will not follow a rename.
    const literals = NAV_ITEMS.filter((i) => i.href !== '/').filter((i) =>
      navBar.includes(`"${i.href}"`),
    );
    expect(literals.map((i) => i.href)).toEqual([]);
  });

  it('reaches every destination the bottom bar omits', () => {
    const inBar = new Set(MOBILE_NAV.map((i) => i.href));
    const missing = NAV_ITEMS.filter((i) => !inBar.has(i.href));
    // These are the ones that depend on the menu existing at all.
    expect(missing.length).toBeGreaterThan(0);
    const grouped = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
    for (const item of missing) {
      expect(grouped.has(item.href), `${item.href} is in no group, so no menu shows it`).toBe(true);
    }
  });
});

describe('the shell mounts the navigation bar', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'layout', 'app-shell.tsx'),
    'utf8',
  );

  it('renders the bar', () => {
    expect(shell).toContain('<NavBar />');
  });

  it('keeps the bottom bar for phones only', () => {
    expect(shell).toContain('lg:hidden');
  });
});
