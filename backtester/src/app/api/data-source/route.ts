import { NextResponse } from 'next/server';
import { getProvider, PROVIDER_LICENCES, EVALUATED_AND_REJECTED } from '@/lib/market-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which provider this deployment is actually serving, and under what terms.
 *
 * Read-only and contains no secrets: it reports whether a key is configured,
 * never the key itself.
 */
export async function GET() {
  const provider = getProvider();
  return NextResponse.json({
    active: {
      id: provider.id,
      label: provider.label,
      description: provider.description,
      synthetic: provider.synthetic,
    },
    licence: PROVIDER_LICENCES[provider.id] ?? null,
    allLicences: Object.values(PROVIDER_LICENCES),
    rejected: EVALUATED_AND_REJECTED,
    tiingoKeyConfigured: Boolean(process.env.TIINGO_API_KEY?.trim()),
  });
}
