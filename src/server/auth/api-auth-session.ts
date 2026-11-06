import type { NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { BANNED_ACCOUNT_MESSAGE } from '~/server/utils/errorHandling';

type ApiSessionContext = {
  req: Parameters<typeof getServerAuthSession>[0]['req'];
  res: NextApiResponse;
};

/**
 * How an API route treats a session whose user is banned:
 * - `refuse`: answer 403 and return `false`. For routes that act as the user.
 * - `anonymous`: return `null`, as a banned bearer token already resolves. For public routes that
 *   only personalize their response with the session.
 *
 * Bearer/API-key sessions never reach this with a banned user (`getSessionFromBearerToken` drops them).
 */
export type BannedSessionMode = 'refuse' | 'anonymous';

/**
 * The session for an API route, with the ban applied. `getServerAuthSession` itself still returns a
 * banned user, because page renders and `/api/auth/session` need it to show the banned page.
 */
export async function getApiAuthSession(
  ctx: ApiSessionContext,
  opts: { whenBanned: 'anonymous' }
): Promise<Session | null>;
export async function getApiAuthSession(
  ctx: ApiSessionContext,
  opts: { whenBanned: 'refuse' }
): Promise<Session | null | false>;
export async function getApiAuthSession(
  { req, res }: ApiSessionContext,
  { whenBanned }: { whenBanned: BannedSessionMode }
): Promise<Session | null | false> {
  const session = await getServerAuthSession({ req, res });
  if (!session?.user?.bannedAt) return session;
  if (whenBanned === 'anonymous') return null;
  res.status(403).json({ error: BANNED_ACCOUNT_MESSAGE });
  return false;
}

type SessionUser = NonNullable<Session['user']>;

/**
 * The viewer for a tRPC context. A banned user gets no `user`, so public procedures answer as for a
 * signed-out visitor; it stays on `bannedUser` for the auth middleware alone, which refuses it with
 * the banned message (and lets it reach the site appeal form).
 */
export function trpcViewer(user: SessionUser | undefined): {
  user: SessionUser | undefined;
  bannedUser?: SessionUser;
} {
  return user?.bannedAt ? { user: undefined, bannedUser: user } : { user };
}
