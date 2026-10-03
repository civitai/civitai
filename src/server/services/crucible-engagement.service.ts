import { dbRead, dbWrite } from '~/server/db/client';
import { isCrucibleHiddenByScan } from '~/server/services/crucible.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  isPrismaUniqueViolation,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { CrucibleEngagementType, CrucibleStatus } from '~/shared/utils/prisma/enums';

const NOTIFY = CrucibleEngagementType.Notify;

// Following only buys something while the crucible still has an ending ahead of it. Unfollowing
// stays open at any status so a stale follow can always be cleared.
const FOLLOWABLE_STATUSES: CrucibleStatus[] = [CrucibleStatus.Pending, CrucibleStatus.Active];

export async function toggleCrucibleFollow({
  crucibleId,
  userId,
  isModerator,
  setTo,
}: {
  crucibleId: number;
  userId: number;
  isModerator?: boolean;
  setTo?: boolean;
}): Promise<boolean> {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      userId: true,
      status: true,
      ingestion: true,
      image: { select: { ingestion: true } },
    },
  });
  if (!crucible) throw throwNotFoundError('Crucible not found');

  const where = { type_crucibleId_userId: { type: NOTIFY, crucibleId, userId } };
  const existing = await dbRead.crucibleEngagement.findUnique({ where, select: { type: true } });
  const next = setTo ?? !existing;

  if (!next) {
    if (existing) await dbWrite.crucibleEngagement.delete({ where });
    return false;
  }

  // Ids are sequential: without the detail page's own gates this would confirm, and subscribe a
  // user to, a crucible that page hides from them.
  if (isCrucibleHiddenByScan(crucible, { viewerId: userId, isModerator }))
    throw throwNotFoundError('Crucible not found');
  if (
    !isModerator &&
    crucible.userId !== userId &&
    (await amIBlockedByUser({ userId, targetUserId: crucible.userId }))
  )
    throw throwNotFoundError('Crucible not found');

  if (!FOLLOWABLE_STATUSES.includes(crucible.status))
    throw throwBadRequestError('This crucible has already ended');

  if (existing) return true;
  await dbWrite.crucibleEngagement
    .create({ data: { type: NOTIFY, crucibleId, userId } })
    .catch((error) => {
      // Two concurrent follows both read "absent"; the loser's row already exists.
      if (!isPrismaUniqueViolation(error)) throw error;
    });
  return true;
}

export async function getFollowedCrucibleIds(userId: number): Promise<number[]> {
  const rows = await dbRead.crucibleEngagement.findMany({
    where: { userId, type: NOTIFY, crucible: { status: { in: FOLLOWABLE_STATUSES } } },
    select: { crucibleId: true },
  });
  return rows.map((r) => r.crucibleId);
}
