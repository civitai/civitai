import { isModerationAccountUser, isSystemAccountMeta } from '@civitai/auth';
import { env } from '~/env/server';
import { holdsModeratorAccess } from '~/server/auth/moderator-access';

/** The User columns {@link systemAccountRefusal} reads. */
export const systemAccountSelect = {
  id: true,
  username: true,
  meta: true,
  deletedAt: true,
  bannedAt: true,
  isModerator: true,
  roles: { select: { role: true } },
} as const;

type SystemAccountRow = {
  id: number;
  username: string | null;
  meta: unknown;
  deletedAt: Date | null;
  bannedAt: Date | null;
  isModerator: boolean | null;
  roles: { role: string }[];
};

/**
 * Why the admin system-account routes may not act on this account, or null when they may: it must
 * exist, be an active system account, and be neither the moderation account nor hold moderator access.
 */
export async function systemAccountRefusal(
  user: SystemAccountRow | null
): Promise<{ status: number; error: string } | null> {
  if (!user) return { status: 404, error: 'User not found' };
  if (!isSystemAccountMeta(user.meta)) return { status: 403, error: 'Not a system account' };
  if (user.deletedAt || user.bannedAt) return { status: 403, error: 'Account is not active' };
  if (
    isModerationAccountUser(user, env.CIVITAI_MODERATION_USER_ID) ||
    (await holdsModeratorAccess({
      isModerator: user.isModerator,
      roles: user.roles.map(({ role }) => role),
    }))
  )
    return { status: 403, error: 'Account has moderator access' };
  return null;
}
