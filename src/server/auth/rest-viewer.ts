import { isSessionOrFullUserKey, withModeratorRightsFor } from '~/server/auth/full-user-credential';
import { getRequestCredential } from '~/server/auth/request-credential';

type User = { id: number; isModerator?: boolean | null };

/**
 * A REST route's user with moderator rights only where tRPC's request context would leave them: a
 * session, a full-access personal key, or the system account's own keys. The session lookup must
 * have run on `req` first.
 */
export function restModeratorViewer<T extends User>(req: unknown, user: T | undefined) {
  return withModeratorRightsFor(user, getRequestCredential(req));
}

/**
 * The viewer for an owner-or-moderator check on a REST route: the user on a session or a
 * full-access key, or a moderator who kept moderator rights; anyone else reads as no one.
 */
export function restOwnerOrModeratorViewer<T extends User>(req: unknown, user: T | undefined) {
  const viewer = restModeratorViewer(req, user);
  if (!viewer) return undefined;
  return viewer.isModerator || isSessionOrFullUserKey(getRequestCredential(req))
    ? viewer
    : undefined;
}
