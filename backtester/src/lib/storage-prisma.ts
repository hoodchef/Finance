import type { PrismaClient } from '@prisma/client';
import type { Portfolio, Position } from '@/lib/types';
import type { PortfolioRepository } from '@/lib/storage';

/**
 * Raised when a portfolio id is already taken by someone else.
 *
 * The message is deliberately incurious: confirming that the id belongs to
 * another account would turn a save endpoint into an existence oracle for
 * other users' data.
 */
export class StorageConflictError extends Error {
  constructor() {
    super('That portfolio could not be saved under this account.');
    this.name = 'StorageConflictError';
  }
}

/**
 * Prisma-backed portfolio storage.
 *
 * Satisfies the same interface the in-memory implementation does, so nothing in
 * the engine, the metrics or the UI changes when the app moves off browser
 * local storage.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It never trusts a caller's ownerId against a row it did not scope. Every
 *    read and write filters on userId, so a valid portfolio id belonging to
 *    somebody else returns null rather than their data. An `update` keyed on id
 *    alone would be an authorisation bug wearing an ORM.
 *  - It does not store market data. Prices are cached by the provider layer and
 *    are disposable; a stale row in a prices table is the easiest way to
 *    produce a wrong backtest that looks right.
 */
export class PrismaPortfolioRepository implements PortfolioRepository {
  constructor(private readonly db: PrismaClient) {}

  async list(ownerId: string): Promise<Portfolio[]> {
    const rows = await this.db.portfolio.findMany({
      where: { userId: ownerId },
      include: { positions: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toPortfolio);
  }

  async get(ownerId: string, id: string): Promise<Portfolio | null> {
    // Scoped by owner, not just id: this is the authorisation check.
    const row = await this.db.portfolio.findFirst({
      where: { id, userId: ownerId },
      include: { positions: { orderBy: { sortOrder: 'asc' } } },
    });
    return row ? toPortfolio(row) : null;
  }

  async save(ownerId: string, portfolio: Portfolio): Promise<Portfolio> {
    const positions = portfolio.positions.map((p, i) => ({
      symbol: p.symbol,
      name: p.name ?? null,
      weight: Number(p.weight) || 0,
      expenseRatio: p.expenseRatio == null ? null : Number(p.expenseRatio),
      sortOrder: i,
    }));

    // One transaction: a half-written portfolio — new name, old holdings — is
    // a worse outcome than a failed save.
    const saved = await this.db.$transaction(async (tx) => {
      const existing = await tx.portfolio.findFirst({
        where: { id: portfolio.id, userId: ownerId },
        select: { id: true },
      });

      if (!existing) {
        // The id is a primary key across every account, so an id that is not
        // the caller's may still exist. Checking first turns a raw constraint
        // violation into a deliberate refusal — and the check must not report
        // WHY, only that it failed.
        const takenByAnother = await tx.portfolio.findUnique({
          where: { id: portfolio.id },
          select: { id: true },
        });
        if (takenByAnother) throw new StorageConflictError();

        return tx.portfolio.create({
          data: {
            id: portfolio.id,
            userId: ownerId,
            name: portfolio.name,
            presetId: portfolio.presetId ?? null,
            positions: { create: positions },
          },
          include: { positions: { orderBy: { sortOrder: 'asc' } } },
        });
      }

      // Positions are replaced wholesale. They have no identity worth
      // preserving across an edit — reordering and re-weighting are the normal
      // case, and diffing them would buy nothing.
      await tx.position.deleteMany({ where: { portfolioId: portfolio.id } });
      return tx.portfolio.update({
        where: { id: portfolio.id },
        data: {
          name: portfolio.name,
          presetId: portfolio.presetId ?? null,
          positions: { create: positions },
        },
        include: { positions: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    return toPortfolio(saved);
  }

  async delete(ownerId: string, id: string): Promise<void> {
    // deleteMany, not delete: scoped by owner, and deleting nothing is not an
    // error worth throwing over.
    await this.db.portfolio.deleteMany({ where: { id, userId: ownerId } });
  }
}

interface Row {
  id: string;
  name: string;
  presetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  positions: Array<{
    id: string;
    symbol: string;
    name: string | null;
    weight: unknown;
    expenseRatio: unknown;
  }>;
}

/**
 * Prisma returns Decimal columns as a Decimal object, not a number. Handing one
 * straight to the engine would flow a non-numeric into weight arithmetic, so
 * every numeric crosses this boundary explicitly.
 */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value == null) return 0;
  return Number(value.toString());
}

function toPortfolio(row: Row): Portfolio {
  const positions: Position[] = row.positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    name: p.name ?? undefined,
    weight: num(p.weight),
    expenseRatio: p.expenseRatio == null ? undefined : num(p.expenseRatio),
  }));
  return {
    id: row.id,
    name: row.name,
    presetId: row.presetId ?? undefined,
    positions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
