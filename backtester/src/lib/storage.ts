import type { Portfolio } from '@/lib/types';

/**
 * The seam between the app and wherever saved portfolios live.
 *
 * Today the only implementation is browser local storage, driven by the
 * zustand store in `src/store/workspace.ts`. That is a deliberate choice, not
 * an oversight: it means the product works with no database, no account and no
 * server round-trip, and a user's portfolios never leave their machine.
 *
 * `prisma/schema.prisma` defines the equivalent Postgres model. Moving to it
 * means writing one class that satisfies this interface and pointing the store
 * at it — no engine, metric or UI code changes.
 */
export interface PortfolioRepository {
  list(ownerId: string): Promise<Portfolio[]>;
  get(ownerId: string, id: string): Promise<Portfolio | null>;
  save(ownerId: string, portfolio: Portfolio): Promise<Portfolio>;
  delete(ownerId: string, id: string): Promise<void>;
}

/**
 * In-memory implementation. Used by tests and as the reference for the shape a
 * real adapter has to honour; it is not wired into the running app, because a
 * server-side store that forgets everything on restart would be worse than the
 * browser storage it replaced.
 */
export class InMemoryPortfolioRepository implements PortfolioRepository {
  private readonly byOwner = new Map<string, Map<string, Portfolio>>();

  private bucket(ownerId: string): Map<string, Portfolio> {
    let b = this.byOwner.get(ownerId);
    if (!b) {
      b = new Map();
      this.byOwner.set(ownerId, b);
    }
    return b;
  }

  async list(ownerId: string): Promise<Portfolio[]> {
    return [...this.bucket(ownerId).values()].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    );
  }

  async get(ownerId: string, id: string): Promise<Portfolio | null> {
    return this.bucket(ownerId).get(id) ?? null;
  }

  async save(ownerId: string, portfolio: Portfolio): Promise<Portfolio> {
    const next = { ...portfolio, updatedAt: new Date().toISOString() };
    this.bucket(ownerId).set(next.id, next);
    return next;
  }

  async delete(ownerId: string, id: string): Promise<void> {
    this.bucket(ownerId).delete(id);
  }
}
