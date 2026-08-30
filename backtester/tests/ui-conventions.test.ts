import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The interface contract, enforced.
 * =============================================================================
 * `UI-CONVENTIONS.md` is the target every page is written to. A convention
 * nothing checks is a convention that survives exactly as long as the person
 * who remembers it, which matters most when several people — or several agents
 * — work on different pages at once and each one is individually reasonable.
 *
 * These are the rules that can be checked mechanically. Hierarchy and density
 * cannot be, and are reviewed by looking at the screen.
 */

const SRC = path.join(__dirname, '..', 'src');

function tsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) out.push(full);
    }
  };
  walk(path.join(SRC, 'app'));
  walk(path.join(SRC, 'components'));
  return out;
}

const files = tsxFiles();
const rel = (f: string) => path.relative(SRC, f);

describe('colour comes from theme tokens', () => {
  /**
   * There are four themes — light, dark, terminal and bloomberg. A hardcoded
   * colour is illegible or invisible in at least one of them, and the failure
   * is silent: the page renders, it just cannot be read. This already happened
   * once, when a blanket rule in the bloomberg theme turned every gain cyan.
   */
  const PALETTE =
    /\b(?:text|bg|border|ring|fill|stroke|from|via|to)-(?:red|green|blue|yellow|orange|purple|pink|indigo|teal|cyan|lime|amber|emerald|violet|fuchsia|rose|sky|slate|gray|zinc|neutral|stone)-\d{2,3}\b/g;

  it('uses no Tailwind palette colours', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(PALETTE)) {
        offenders.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(offenders, `use hsl(var(--positive)) etc:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('uses no hex colours outside the theme-colour meta tag', () => {
    // layout.tsx declares the browser chrome colour, which has to be a literal
    // because it is read by the OS rather than by CSS.
    const allowed = new Set(['app/layout.tsx']);
    const offenders: string[] = [];
    for (const f of files) {
      if (allowed.has(rel(f))) continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the type scale', () => {
  it('never sets a paragraph at 11px', () => {
    /*
     * `text-2xs` is 0.6875rem. It is right for a unit suffix or a column
     * label and wrong for anything anyone reads a sentence of. This app
     * explains its assumptions on nearly every panel, and 54 of those blocks
     * were at 11px before they were raised.
     *
     * `leading-relaxed` is the marker: it appears on multi-line prose and not
     * on labels, so the pairing identifies exactly the wrong cases.
     */
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (src.includes('text-2xs leading-relaxed')) offenders.push(rel(f));
      if (src.includes('leading-relaxed text-2xs')) offenders.push(rel(f));
    }
    expect(offenders, `prose must be text-xs or larger:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the conventions are written down', () => {
  it('keeps UI-CONVENTIONS.md present and covering each enforced rule', () => {
    // The test and the document must not drift apart: someone reading the
    // failure needs somewhere to go that explains why the rule exists.
    const doc = fs.readFileSync(path.join(__dirname, '..', 'UI-CONVENTIONS.md'), 'utf8');
    for (const topic of ['text-2xs', 'hsl(var(--positive))', 'grid-cols-2', 'Empty states', 'numeric']) {
      expect(doc, `UI-CONVENTIONS.md should cover ${topic}`).toContain(topic);
    }
  });
});
