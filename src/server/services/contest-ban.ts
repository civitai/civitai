import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import type { UserMeta } from '~/server/schema/user.schema';

// A leaf module: `user.service` is too large to import from the services that need only this.
export { CONTEST_BANNED_MESSAGE } from '~/shared/constants/contest-ban.constants';

/** For queries that alias "User" as `u`. */
export const contestBannedSql = Prisma.sql`u.meta ->> 'contestBanDetails' IS NOT NULL`;

/** Sort key for the ban list; an ISO-8601 UTC string, so the text order is chronological. */
export const contestBannedAtSql = Prisma.sql`u."meta" #>> '{contestBanDetails,bannedAt}'`;

export const isContestBanned = async (userId: number, db: Pick<typeof dbRead, 'user'> = dbRead) => {
  const user = await db.user.findUnique({ where: { id: userId }, select: { meta: true } });
  return !!(user?.meta as UserMeta | null | undefined)?.contestBanDetails;
};
