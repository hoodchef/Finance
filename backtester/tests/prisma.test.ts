import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../node_modules/.prisma/test-client';
import { PrismaPortfolioRepository, StorageConflictError } from '../src/lib/storage-prisma';
import { InMemoryPortfolioRepository } from '../src/lib/storage';
import type { Portfolio } from '../src/lib/types';

/**
 * Storage, exercised against a real database.
 *
 * SQLite rather than Postgres, because a test that needs a server standing up
 * is a test that stops being run. The schema is generated from the Postgres one
 * so the models cannot drift; what is verified here is the repository's
 * behaviour, and above all that every read and write is scoped to its owner.
 */

const DB_FILE = path.join(__dirname, '..', '.cache', 'test.db');
const db = new PrismaClient({ datasources: { db: { url: `file:${DB_FILE}` } } });
const repo = new PrismaPortfolioRepository(db as never);

const ALICE = 'user_alice';
const BOB = 'user_bob';

function portfolio(id: string, name: string): Portfolio {
  return {
    id,
    name,
    positions: [
      { id: 'p1', symbol: 'SPY', weight: 60, expenseRatio: 0.09 },
      { id: 'p2', symbol: 'BND', weight: 40 },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const hasDb = fs.existsSync(DB_FILE);

describe.runIf(hasDb)('PrismaPortfolioRepository', () => {
  beforeAll(async () => {
    await db.$connect();
    for (const id of [ALICE, BOB]) {
      await db.user.upsert({
        where: { id },
        create: { id, email: `${id}@example.test` },
        update: {},
      });
    }
  });

  beforeEach(async () => {
    await db.position.deleteMany({});
    await db.portfolio.deleteMany({});
  });

  afterAll(async () => {
    await db.position.deleteMany({});
    await db.portfolio.deleteMany({});
    await db.$disconnect();
  });

  it('round-trips a portfolio with its holdings in order', async () => {
    await repo.save(ALICE, portfolio('pf_1', 'Balanced'));
    const got = await repo.get(ALICE, 'pf_1');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('Balanced');
    expect(got!.positions.map((p) => p.symbol)).toEqual(['SPY', 'BND']);
    // Decimal columns must arrive as numbers; a Decimal object entering weight
    // arithmetic would produce NaN somewhere far from here.
    expect(typeof got!.positions[0].weight).toBe('number');
    expect(got!.positions[0].weight).toBe(60);
    expect(got!.positions[0].expenseRatio).toBe(0.09);
    expect(got!.positions[1].expenseRatio).toBeUndefined();
  });

  it('replaces holdings on update rather than accumulating them', async () => {
    await repo.save(ALICE, portfolio('pf_2', 'First'));
    const edited: Portfolio = {
      ...portfolio('pf_2', 'Renamed'),
      positions: [{ id: 'x', symbol: 'VTI', weight: 100 }],
    };
    await repo.save(ALICE, edited);
    const got = await repo.get(ALICE, 'pf_2');
    expect(got!.name).toBe('Renamed');
    expect(got!.positions).toHaveLength(1);
    expect(got!.positions[0].symbol).toBe('VTI');
  });

  it('preserves holding order across a save', async () => {
    const p = portfolio('pf_3', 'Ordered');
    p.positions = [
      { id: 'a', symbol: 'AAA', weight: 10 },
      { id: 'b', symbol: 'BBB', weight: 20 },
      { id: 'c', symbol: 'CCC', weight: 70 },
    ];
    await repo.save(ALICE, p);
    const got = await repo.get(ALICE, 'pf_3');
    expect(got!.positions.map((x) => x.symbol)).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('lists only the caller’s own portfolios, newest first', async () => {
    await repo.save(ALICE, portfolio('pf_a1', 'Alice one'));
    await repo.save(BOB, portfolio('pf_b1', 'Bob one'));
    await repo.save(ALICE, portfolio('pf_a2', 'Alice two'));

    const mine = await repo.list(ALICE);
    expect(mine.map((p) => p.id).sort()).toEqual(['pf_a1', 'pf_a2']);
    expect(await repo.list(BOB)).toHaveLength(1);
  });

  /* -------------------------------------------------------------- */
  /* Authorisation                                                   */
  /* -------------------------------------------------------------- */

  it('does not return another user’s portfolio by id', async () => {
    await repo.save(BOB, portfolio('pf_secret', "Bob's"));
    // Knowing the id must not be enough. A findUnique on id alone here would
    // be an authorisation bug wearing an ORM.
    expect(await repo.get(ALICE, 'pf_secret')).toBeNull();
  });

  it('does not let one user overwrite another’s portfolio', async () => {
    await repo.save(BOB, portfolio('pf_shared_id', 'Bob original'));

    // The id is a primary key across accounts, so this is a refusal rather
    // than a second row. What matters is that Bob's data survives untouched
    // and Alice learns nothing about it.
    await expect(
      repo.save(ALICE, portfolio('pf_shared_id', 'Alice takeover')),
    ).rejects.toThrow(StorageConflictError);

    expect((await repo.get(BOB, 'pf_shared_id'))!.name).toBe('Bob original');
    expect(await repo.list(ALICE)).toHaveLength(0);
  });

  it('refuses without revealing that the id belongs to someone else', async () => {
    await repo.save(BOB, portfolio('pf_probe', "Bob's"));
    // A save endpoint that distinguishes "taken by another account" from any
    // other failure is an existence oracle for other users' data.
    const err = await repo.save(ALICE, portfolio('pf_probe', 'probe')).catch((e) => e);
    expect(err).toBeInstanceOf(StorageConflictError);
    expect(String(err.message)).not.toMatch(/bob|another|exists|owner/i);
  });

  it('does not let one user delete another’s portfolio', async () => {
    await repo.save(BOB, portfolio('pf_del', "Bob's"));
    await repo.delete(ALICE, 'pf_del');
    expect(await repo.get(BOB, 'pf_del')).not.toBeNull();

    await repo.delete(BOB, 'pf_del');
    expect(await repo.get(BOB, 'pf_del')).toBeNull();
  });

  it('deletes holdings with the portfolio rather than orphaning them', async () => {
    await repo.save(ALICE, portfolio('pf_cascade', 'Doomed'));
    await repo.delete(ALICE, 'pf_cascade');
    expect(await db.position.count({ where: { portfolioId: 'pf_cascade' } })).toBe(0);
  });

  it('treats deleting something absent as a no-op', async () => {
    await expect(repo.delete(ALICE, 'never_existed')).resolves.toBeUndefined();
  });
});

describe('the two implementations agree', () => {
  it('expose the same interface', () => {
    const memory = new InMemoryPortfolioRepository();
    for (const method of ['list', 'get', 'save', 'delete'] as const) {
      expect(typeof memory[method]).toBe('function');
      expect(typeof repo[method]).toBe('function');
    }
  });
});

describe('the SQLite mirror does not drift from the Postgres schema', () => {
  const dir = path.join(__dirname, '..', 'prisma');
  const models = (text: string) =>
    [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
      name,
      fields: [...body.matchAll(/^\s{2}(\w+)\s+(\S+)/gm)]
        .map(([, f, t]) => `${f}:${t.replace(/\?$/, '?')}`)
        .sort(),
    }));

  it('has the same models with the same fields', () => {
    // Storage details differ (SQLite has no Decimal/Date hints and no Json).
    // The MODEL must not — a mirror that quietly lost a column would make the
    // repository tests above pass against a schema nobody ships.
    const pg = models(fs.readFileSync(path.join(dir, 'schema.prisma'), 'utf8'));
    const lite = models(fs.readFileSync(path.join(dir, 'schema.sqlite.prisma'), 'utf8'));

    expect(lite.map((m) => m.name).sort()).toEqual(pg.map((m) => m.name).sort());
    for (const model of pg) {
      const other = lite.find((m) => m.name === model.name)!;
      const normalise = (f: string[]) => f.map((x) => x.replace(':Json', ':String')).sort();
      expect(normalise(other.fields), `${model.name} drifted`).toEqual(normalise(model.fields));
    }
  });
});

describe('the Postgres migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'migrations', '20260826000000_init', 'migration.sql'),
    'utf8',
  );

  /**
   * Generated by `prisma migrate diff` and checked in, because no Postgres was
   * reachable from the machine that wrote it. It has NOT been applied to a live
   * server — these assert that what would be applied matches the schema, which
   * is a weaker claim than "it runs" and is stated as such in the README.
   */
  it('creates every model in the schema', () => {
    const models = [
      ...fs
        .readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
        .matchAll(/^model\s+(\w+)/gm),
    ].map(([, name]) => name);
    expect(models.length).toBeGreaterThanOrEqual(7);
    for (const m of models) {
      expect(sql, `no CREATE TABLE for ${m}`).toContain(`CREATE TABLE "${m}"`);
    }
  });

  it('cascades deletes from the owner', () => {
    // A user row removed without its portfolios going with it leaves financial
    // data belonging to nobody.
    for (const table of ['Account', 'Session', 'Portfolio']) {
      const fk = new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?ON DELETE CASCADE`);
      expect(fk.test(sql), `${table} does not cascade from User`).toBe(true);
    }
    expect(/ALTER TABLE "Position"[\s\S]*?ON DELETE CASCADE/.test(sql)).toBe(true);
  });

  it('enforces the uniqueness the auth adapter depends on', () => {
    // Auth.js looks accounts up by (provider, providerAccountId) and sessions
    // by token; without these a duplicate row silently forks a login.
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Account_provider_providerAccountId_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Session_sessionToken_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "User_email_key"/);
  });

  it('stores money and weights as exact decimals, not floats', () => {
    // Binary floating point cannot represent 0.1. Weights and balances must be
    // DECIMAL or a portfolio that sums to 100 stops doing so after a round trip.
    expect(sql).toMatch(/DECIMAL\(/);
    expect(sql).not.toMatch(/\bweight"?\s+DOUBLE PRECISION/i);
  });
});
