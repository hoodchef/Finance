import { PrismaClient } from '@prisma/client';

/**
 * One Prisma client per process.
 *
 * Next's dev server re-evaluates modules on every hot reload, and a fresh
 * PrismaClient each time exhausts the database's connection pool within a few
 * edits. Stashing it on globalThis is the documented workaround and is
 * dev-only; production evaluates the module once.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

/** True when a database is configured at all. */
export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
