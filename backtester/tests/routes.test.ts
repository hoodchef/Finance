import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV_GROUPS, NAV_ITEMS, MOBILE_NAV } from '../src/components/layout/nav';
import { PROVIDER_LICENCES } from '../src/lib/market-data/licence';

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

describe('one implementation per piece of arithmetic', () => {
  /**
   * A program-wide guard against the drift that produced it.
   *
   * Two functions of the same name with different conventions is the failure
   * this catches: `market-data/dates.ts` measures years on ACT/365.25, which
   * is right for annualising a return series, while an option's time to
   * expiry is ACT/365. Both were called `yearsBetween`, sat one import apart,
   * and differed by 0.07% — small enough that nothing would ever look wrong.
   *
   * The same applies to a numeric helper copied rather than imported: the copy
   * does not get the next fix. The normal CDF here went from ~1e-7 accuracy to
   * machine precision, and a second copy would still be carrying the old error.
   */
  const sourceFiles = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src', 'lib'));
    return out;
  })();

  /** Numeric helpers that must have exactly one definition in src/lib. */
  const SINGLETONS = [
    'normCdf',
    'normInv',
    'normPdf',
    'spanDays',
    'yearsBetween',
    'yearsToExpiry',
    'intrinsicValue',
    'blackScholes',
  ];

  it.each(SINGLETONS)('defines %s exactly once', (name) => {
    const pattern = new RegExp(`function\\s+${name}\\s*\\(`);
    const defining = sourceFiles.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')));
    expect(defining.map((f) => path.relative(process.cwd(), f))).toHaveLength(1);
  });

  it('keeps the two year conventions under distinct names', () => {
    // Not a style point: they disagree, and both are correct in their domain.
    const dates = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'market-data', 'dates.ts'), 'utf8');
    const pricing = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'options', 'pricing.ts'), 'utf8');
    expect(dates).toMatch(/yearsBetween[\s\S]*?365\.25/);
    expect(pricing).toMatch(/yearsToExpiry/);
    expect(pricing).not.toMatch(/function yearsBetween/);
  });
});

describe('every data source is recorded in the licence registry', () => {
  /**
   * The registry exists so a licensing constraint is visible in the
   * application rather than only in somebody's memory, and there is a guard
   * asserting no options source is marked `permitted`. That guard cannot fire
   * for a provider that was never registered — which is exactly what happened
   * when Alpaca was integrated straight into `options/chain.ts`.
   */
  const providersInCode = () => {
    const dir = path.join(__dirname, '..', 'src', 'lib');
    const found = new Set<string>();
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) {
          const src = fs.readFileSync(full, 'utf8');
          // A hostname is the tell that this module talks to a vendor.
          for (const m of src.matchAll(/https:\/\/(?:[a-z0-9-]+\.)*([a-z0-9-]+)\.(?:com|markets|io|org)/g)) {
            found.add(m[1].toLowerCase());
          }
        }
      }
    };
    walk(dir);
    return found;
  };

  it('registers every vendor the code actually calls', () => {
    const known = new Set(Object.keys(PROVIDER_LICENCES));
    // Hosts that are not paid data vendors: government, docs and self-links.
    const exempt = new Set(['sec', 'stlouisfed', 'french', 'dartmouth', 'github', 'localhost', 'schema', 'w3']);
    const unregistered = [...providersInCode()].filter((h) => !known.has(h) && !exempt.has(h));
    expect(unregistered, `unregistered data hosts: ${unregistered.join(', ')}`).toEqual([]);
  });
});
