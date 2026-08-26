import type { NextAuthOptions } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import type { Adapter } from 'next-auth/adapters';
import GitHubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import { db, databaseConfigured } from '@/lib/db';

/**
 * Authentication.
 * =============================================================================
 * Optional by design. The product works with no account at all — portfolios
 * live in browser storage and never leave the machine — and auth turns on only
 * when a database and a secret are configured. That keeps the zero-setup path
 * intact instead of putting a login wall in front of a local tool.
 *
 * Sessions are database-backed rather than JWT. A JWT cannot be revoked before
 * it expires; for a product holding someone's financial planning, being able to
 * end a session server-side is worth the extra query.
 */

export function authConfigured(): boolean {
  return databaseConfigured() && Boolean(process.env.NEXTAUTH_SECRET?.trim());
}

/** Providers are added only when their credentials exist. */
function providers(): NextAuthOptions['providers'] {
  const list: NextAuthOptions['providers'] = [];

  if (process.env.GITHUB_ID?.trim() && process.env.GITHUB_SECRET?.trim()) {
    list.push(
      GitHubProvider({
        clientId: process.env.GITHUB_ID,
        clientSecret: process.env.GITHUB_SECRET,
      }),
    );
  }

  if (process.env.GOOGLE_ID?.trim() && process.env.GOOGLE_SECRET?.trim()) {
    list.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_ID,
        clientSecret: process.env.GOOGLE_SECRET,
      }),
    );
  }

  return list;
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db) as Adapter,
  session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
  providers: providers(),
  pages: { signIn: '/settings' },
  callbacks: {
    /** The app keys everything on user id, so it has to be on the session. */
    async session({ session, user }) {
      if (session.user) (session.user as { id?: string }).id = user.id;
      return session;
    },
  },
  // Never true in production; NEXTAUTH_SECRET is required there and its absence
  // should fail loudly rather than fall back to something guessable.
  debug: false,
};
