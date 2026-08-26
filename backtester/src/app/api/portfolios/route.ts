import { NextResponse } from 'next/server';
import { db, databaseConfigured } from '@/lib/db';
import { PrismaPortfolioRepository, StorageConflictError } from '@/lib/storage-prisma';
import { currentOwnerId } from '@/lib/auth/session';
import { authConfigured } from '@/lib/auth/options';
import { errorResponse } from '@/lib/api-errors';
import { parsePortfolio } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-side portfolio storage.
 *
 * Returns 501 when no database is configured, which is the default. That is
 * not a failure: the app stores portfolios in the browser and works completely
 * without this route. The client uses it only when the server says it exists.
 */
function unavailable() {
  return NextResponse.json(
    {
      error: 'Server-side storage is not configured; portfolios are kept in this browser.',
      kind: 'not-configured',
    },
    { status: 501 },
  );
}

function unauthorised() {
  return NextResponse.json({ error: 'Sign in to continue.', kind: 'auth' }, { status: 401 });
}

export async function GET() {
  try {
    if (!databaseConfigured()) return unavailable();
    const owner = await currentOwnerId();
    if (!owner) return unauthorised();
    const repo = new PrismaPortfolioRepository(db);
    return NextResponse.json({ portfolios: await repo.list(owner), authRequired: authConfigured() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!databaseConfigured()) return unavailable();
    const owner = await currentOwnerId();
    if (!owner) return unauthorised();

    const body = await request.json();
    // The same validator the engine uses. A stored portfolio that cannot be
    // backtested is worse than a rejected save.
    const portfolio = parsePortfolio(body.portfolio);
    const repo = new PrismaPortfolioRepository(db);
    const saved = await repo.save(owner, {
      ...portfolio,
      id: String(body.portfolio?.id ?? portfolio.id),
      name: portfolio.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ portfolio: saved });
  } catch (error) {
    if (error instanceof StorageConflictError) {
      return NextResponse.json({ error: error.message, kind: 'conflict' }, { status: 409 });
    }
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    if (!databaseConfigured()) return unavailable();
    const owner = await currentOwnerId();
    if (!owner) return unauthorised();
    const id = new URL(request.url).searchParams.get('id')?.slice(0, 64) ?? '';
    if (!id) return NextResponse.json({ error: 'Missing id.', kind: 'request' }, { status: 400 });
    await new PrismaPortfolioRepository(db).delete(owner, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
