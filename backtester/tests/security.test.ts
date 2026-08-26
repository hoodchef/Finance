import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { errorResponse } from '../src/lib/api-errors';
import { MarketDataError } from '../src/lib/market-data/provider';
import { ValidationError } from '../src/lib/validate';

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function listFiles(dir: string, filter: (f: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (filter(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Security invariants.
 * =============================================================================
 * These are the failures that would not announce themselves: a key reaching the
 * browser bundle, a token echoed inside an error, a provider URL printed to a
 * log. Each is cheap to reintroduce and expensive to notice, so each is pinned.
 */

describe('secrets never reach the client', () => {
  const clientFiles = listFiles(SRC, (f) => f.endsWith('.tsx') || f.endsWith('.ts')).filter((f) =>
    fs.readFileSync(f, 'utf8').startsWith("'use client'"),
  );

  it('finds client components to check', () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it('no client component reads process.env', () => {
    // Anything a client component reads is inlined into the browser bundle.
    for (const f of clientFiles) {
      const body = fs.readFileSync(f, 'utf8');
      expect(/process\.env\./.test(body), `${path.relative(SRC, f)} reads process.env`).toBe(false);
    }
  });

  it('declares no NEXT_PUBLIC_ variable carrying a key', () => {
    for (const f of listFiles(SRC, (f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      const body = fs.readFileSync(f, 'utf8');
      const hits = body.match(/NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/g);
      expect(hits, `${path.relative(SRC, f)} exposes ${hits?.join(', ')}`).toBeNull();
    }
  });

  it('reports only whether a key is configured, never its value', () => {
    const body = fs.readFileSync(path.join(SRC, 'app/api/data-source/route.ts'), 'utf8');
    expect(body).toMatch(/Boolean\(process\.env\.TIINGO_API_KEY/);
    // A bare interpolation of the key would ship it to the browser.
    expect(/\$\{process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/.test(body)).toBe(false);
  });
});

describe('errors do not leak internals', () => {
  it('passes through messages this codebase wrote deliberately', async () => {
    const v = await errorResponse(new ValidationError('Weights must sum to 100.', 'positions'))
      .json();
    expect(v.error).toBe('Weights must sum to 100.');
    expect(v.kind).toBe('validation');

    const m = await errorResponse(new MarketDataError('Provider unreachable.', 'SPY')).json();
    expect(m.error).toBe('Provider unreachable.');
    expect(m.kind).toBe('market-data');
  });

  it('replaces an unrecognised error rather than echoing it', async () => {
    // The realistic worst case: a runtime error carrying a provider URL with a
    // live token in the query string.
    const leaky = new Error(
      'request to https://api.tiingo.com/tiingo/daily/SPY/prices?token=abcd1234secret failed',
    );
    const res = errorResponse(leaky);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).not.toMatch(/token|tiingo|secret|abcd1234/i);
    expect(body.error).toBe('Something failed while computing this result.');
  });

  it('does not echo a filesystem path', async () => {
    const body = await errorResponse(new Error('ENOENT: /Users/someone/.env.local')).json();
    expect(body.error).not.toMatch(/\/Users\/|\.env/);
  });
});

describe('provider requests cannot be steered or unbounded', () => {
  it('never logs outbound URLs, which carry keys in query strings', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'next.config.js'), 'utf8');
    expect(cfg).toMatch(/fullUrl:\s*false/);
  });

  it('bounds the search query before it becomes an outbound URL', () => {
    const body = fs.readFileSync(path.join(SRC, 'app/api/search/route.ts'), 'utf8');
    expect(body).toMatch(/\.slice\(0,\s*\d+\)/);
  });

  it('sanitises cache filenames so a symbol cannot traverse the path', () => {
    const body = fs.readFileSync(path.join(SRC, 'lib/market-data/cache.ts'), 'utf8');
    expect(body).toMatch(/replace\(\/\[\^A-Za-z0-9\._-\]\/g/);
  });

  it('serves security headers, including a frame-ancestors denial', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require(path.join(ROOT, 'next.config.js'));
    const groups = await cfg.headers();
    const keys = groups[0].headers.map((h: { key: string }) => h.key);
    for (const required of [
      'Content-Security-Policy',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
    ]) {
      expect(keys, `missing ${required}`).toContain(required);
    }
    const csp = groups[0].headers.find(
      (h: { key: string }) => h.key === 'Content-Security-Policy',
    ).value;
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
  });
});
