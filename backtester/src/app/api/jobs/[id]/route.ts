import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Polling endpoint for work accepted by a 202. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) {
    // Also the answer for a job that finished long enough ago to be reclaimed,
    // which the client should treat as "run it again" rather than an error.
    return NextResponse.json({ error: 'No such job.', kind: 'expired' }, { status: 404 });
  }
  return NextResponse.json({ job });
}
