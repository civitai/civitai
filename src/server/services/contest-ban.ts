import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import type { UserMeta } from '~/server/schema/user.schema';

// A leaf module: `user.service` is too large to import from the services that need only this.
export const CONTEST_BANNED_MESSAGE = 'You are banned from participating in contests';

/** For queries that alias "User" as `u`. */
export const contestBannedSql = Prisma.sql`u.meta ->> 'contestBanDetails' IS NOT NULL`;

export const isContestBanned = async (userId: number, db: Pick<typeof dbRead, 'user'> = dbRead) => {
  const user = await db.user.findUnique({ where: { id: userId }, select: { meta: true } });
  return !!(user?.meta as UserMeta | null | undefined)?.contestBanDetails;
};
