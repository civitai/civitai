import { dbWrite } from '~/server/db/client';

/**
 * Whether an account holds any moderator access: the flag, `moderator:admin`, or a role that some
 * moderator-app page or grant lists. Reads the primary, since a grant must count the moment it lands.
 */
export async function holdsModeratorAccess(user: {
  isModerator?: boolean | null;
  roles: string[];
}): Promise<boolean> {
  if (user.isModerator) return true;
  if (!user.roles.length) return false;
  if (user.roles.includes('moderator:admin')) return true;
  const held = await dbWrite.appPageAccess.findFirst({
    where: { app: 'moderator', roles: { hasSome: user.roles } },
    select: { path: true },
  });
  return !!held;
}

/**
 * {@link holdsModeratorAccess} for a user id, read fresh and unioned with `alsoHeld` (e.g. a cached
 * session copy), so either source holding access counts. A missing row counts as holding it.
 */
export async function userHoldsModeratorAccess(
  userId: number,
  alsoHeld?: { isModerator?: boolean | null; roles?: string[] }
): Promise<boolean> {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { isModerator: true, roles: { select: { role: true } } },
  });
  if (!user) return true;
  const roles = new Set([...user.roles.map(({ role }) => role), ...(alsoHeld?.roles ?? [])]);
  return holdsModeratorAccess({
    isModerator: user.isModerator || !!alsoHeld?.isModerator,
    roles: [...roles],
  });
}
