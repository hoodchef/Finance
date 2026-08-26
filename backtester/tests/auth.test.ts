import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Auth is optional, and the ways it can be wrong are asymmetric.
 *
 * Switched off, the product must keep working with no account — that is the
 * whole local-first proposition. Switched on, an unauthenticated request must
 * be refused rather than silently falling back to the shared local owner, which
 * would hand one person's saved portfolios to anybody who asked.
 */

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function loadSession() {
  return import('../src/lib/auth/session');
}

describe('when nothing is configured', () => {
  it('reports auth as unconfigured', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.NEXTAUTH_SECRET;
    vi.resetModules();
    const { authConfigured } = await import('../src/lib/auth/options');
    expect(authConfigured()).toBe(false);
  });

  it('gives every request the single local owner', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.NEXTAUTH_SECRET;
    vi.resetModules();
    const { currentOwnerId, LOCAL_OWNER } = await loadSession();
    // No login wall in front of a local tool.
    expect(await currentOwnerId()).toBe(LOCAL_OWNER);
  });
});

describe('a database without a secret is not authentication', () => {
  it('stays unconfigured until both are present', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    delete process.env.NEXTAUTH_SECRET;
    vi.resetModules();
    const { authConfigured } = await import('../src/lib/auth/options');
    // Half-configured auth that "works" would be signing sessions with nothing.
    expect(authConfigured()).toBe(false);
  });
});

describe('when auth is on', () => {
  it('returns null rather than the local owner for an anonymous request', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    process.env.NEXTAUTH_SECRET = 'x'.repeat(32);
    vi.resetModules();
    vi.doMock('next-auth', () => ({ getServerSession: async () => null }));

    const { currentOwnerId, LOCAL_OWNER } = await loadSession();
    const owner = await currentOwnerId();
    // The dangerous failure: falling back to LOCAL_OWNER here would serve one
    // shared bucket of portfolios to every anonymous visitor.
    expect(owner).toBeNull();
    expect(owner).not.toBe(LOCAL_OWNER);
  });

  it('uses the signed-in user id', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    process.env.NEXTAUTH_SECRET = 'x'.repeat(32);
    vi.resetModules();
    vi.doMock('next-auth', () => ({
      getServerSession: async () => ({ user: { id: 'user_42', email: 'a@b.c' } }),
    }));
    const { currentOwnerId } = await loadSession();
    expect(await currentOwnerId()).toBe('user_42');
  });

  it('returns null when a session exists but carries no user id', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    process.env.NEXTAUTH_SECRET = 'x'.repeat(32);
    vi.resetModules();
    vi.doMock('next-auth', () => ({ getServerSession: async () => ({ user: {} }) }));
    const { currentOwnerId } = await loadSession();
    expect(await currentOwnerId()).toBeNull();
  });
});

describe('the storage route refuses before it reads', () => {
  const route = read('app/api/portfolios/route.ts');

  it('checks the owner in every handler', () => {
    // GET, POST and DELETE each resolve an owner before touching the repo.
    const handlers = route.split(/export async function /).slice(1);
    expect(handlers.length).toBe(3);
    for (const h of handlers) {
      expect(h).toMatch(/currentOwnerId\(\)/);
      expect(h).toMatch(/unauthorised\(\)/);
    }
  });

  it('never constructs a repository before resolving an owner', () => {
    for (const h of route.split(/export async function /).slice(1)) {
      const ownerAt = h.indexOf('currentOwnerId');
      const repoAt = h.indexOf('PrismaPortfolioRepository');
      if (repoAt >= 0) expect(ownerAt).toBeGreaterThan(-1);
      if (repoAt >= 0) expect(ownerAt).toBeLessThan(repoAt);
    }
  });

  it('reports missing storage as unconfigured rather than as an error', () => {
    // The default path. A 500 here would make the local-first mode look broken.
    expect(route).toMatch(/status: 501/);
    expect(route).toMatch(/not-configured/);
  });
});

describe('session strategy', () => {
  it('uses database sessions, which can be revoked', () => {
    const options = read('lib/auth/options.ts');
    // A JWT cannot be revoked before it expires. For a product holding
    // someone's financial planning, ending a session server-side matters more
    // than saving a query.
    expect(options).toMatch(/strategy:\s*'database'/);
  });

  it('adds a provider only when its credentials exist', () => {
    const options = read('lib/auth/options.ts');
    expect(options).toMatch(/process\.env\.GITHUB_ID\?\.trim\(\)/);
    expect(options).toMatch(/process\.env\.GOOGLE_ID\?\.trim\(\)/);
  });

  it('hard-codes no secret or fallback', () => {
    const options = read('lib/auth/options.ts');
    expect(options).not.toMatch(/secret:\s*['"]/);
    expect(options).toMatch(/debug: false/);
  });
});
