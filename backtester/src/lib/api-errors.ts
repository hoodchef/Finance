import { NextResponse } from 'next/server';
import { MarketDataError } from '@/lib/market-data/provider';
import { ValidationError } from '@/lib/validate';

/**
 * Maps a thrown error to a response the UI can act on.
 *
 * `kind` matters: the client shows a different recovery hint for a bad input
 * than for an upstream data outage, and neither should read as "something went
 * wrong". Route files cannot export helpers, so this lives in lib.
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ValidationError) {
    return NextResponse.json(
      { error: error.message, field: error.field, kind: 'validation' },
      { status: 400 },
    );
  }
  if (error instanceof MarketDataError) {
    return NextResponse.json(
      { error: error.message, symbol: error.symbol, kind: 'market-data' },
      { status: 502 },
    );
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: 'Malformed request body.', kind: 'request' },
      { status: 400 },
    );
  }
  console.error('[api]', error);
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : 'Unexpected error running the backtest.',
      kind: 'server',
    },
    { status: 500 },
  );
}
