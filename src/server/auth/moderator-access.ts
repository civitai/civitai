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
