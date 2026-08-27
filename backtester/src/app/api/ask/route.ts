import { NextResponse } from 'next/server';
import { OllamaUnavailableError, ollamaStatus, proposePortfolio } from '@/lib/ai/ollama';
import { interpretProposal } from '@/lib/ai/interpret';
import { errorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turns a description into a proposed portfolio, using a LOCAL model.
 *
 * The request text goes to a daemon on this machine and nowhere else. The
 * model's answer is treated as untrusted input and validated by the same
 * functions a typed request uses; the response is a PROPOSAL for the user to
 * look at, never something applied on their behalf.
 *
 * Nothing here produces a figure that reaches a result. The model chooses
 * tickers and weights; the engine still computes every number.
 */

/** Whether the feature should appear at all. */
export async function GET() {
  return NextResponse.json({ status: await ollamaStatus() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const text = String(body.request ?? '').trim();
    if (!text) {
      return NextResponse.json(
        { error: 'Describe the portfolio you want.', kind: 'request' },
        { status: 400 },
      );
    }

    const raw = await proposePortfolio(text);
    const interpreted = interpretProposal(raw);

    return NextResponse.json({
      proposal: {
        name: interpreted.name,
        positions: interpreted.positions,
        symbols: interpreted.symbols,
        config: interpreted.config,
        defaulted: interpreted.defaulted,
        notes: interpreted.notes,
        warnings: interpreted.warnings,
      },
    });
  } catch (error) {
    if (error instanceof OllamaUnavailableError) {
      // Not a server fault, and not something to retry silently: the daemon is
      // the user's to start.
      return NextResponse.json({ error: error.message, kind: 'ollama' }, { status: 503 });
    }
    return errorResponse(error);
  }
}
