import type { Session, SessionUser } from '~/types/session';

// Every `Date`-typed field on SessionUser. Kept in sync by `session-props.test.ts`, which reads
// `src/types/session.ts` and fails if a new one is added without being listed here.
export const SESSION_DATE_FIELDS = [
  'emailVerified',
  'createdAt',
  'mutedAt',
  'bannedAt',
  'deletedAt',
] as const;

/**
 * Props are plain JSON — nothing transforms them the way `trpcState` is transformed — and the session
 * legitimately carries real `Date`s: a warm `session:data2` hit is msgpack, which round-trips Dates
 * (`@civitai/auth`'s `getSessionUser` documents this; only the cold-miss HTTP path yields ISO strings).
 * Next's dev server rejects a Date in props with a page-wide 500, while production serializes it to an
 * ISO string silently — so normalizing here makes dev agree with what prod already sends to the client.
 */
export const jsonSafeSession = (session: Session | null): Session | null => {
  if (!session?.user) return session;
  const user: Record<string, unknown> = { ...session.user };
  for (const field of SESSION_DATE_FIELDS) {
    const value = user[field];
    if (value != null) user[field] = new Date(value as Date).toISOString();
  }
  return { ...session, user: user as unknown as SessionUser };
};
