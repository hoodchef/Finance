import { getServerSession } from 'next-auth';
import { authOptions, authConfigured } from './options';

/**
 * The owner id every storage call is scoped to.
 *
 * When auth is switched off — the default, local-first mode — there is exactly
 * one implicit user and everything belongs to them. When it is on, an
 * unauthenticated request gets null and the caller must refuse rather than
 * quietly falling back to the shared local owner, which would hand one user's
 * data to anyone.
 */
export const LOCAL_OWNER = 'local';

export async function currentOwnerId(): Promise<string | null> {
  if (!authConfigured()) return LOCAL_OWNER;
  const session = await getServerSession(authOptions);
  const id = (session?.user as { id?: string } | undefined)?.id;
  return id ?? null;
}
