import { dbRead, dbWrite } from '~/server/db/client';
import { isCrucibleHiddenByScan } from '~/server/services/crucible.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  isPrismaUniqueViolation,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { CRUCIBLE_FOLLOWABLE_STATUSES } from '~/shared/constants/crucible.constants';
import { CrucibleEngagementType } from '~/shared/utils/prisma/enums';

const NOTIFY = CrucibleEngagementType.Notify;

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
  const row = { type: NOTIFY, crucibleId, userId };
  const follow =
    setTo ??
    !(await dbWrite.crucibleEngagement.findUnique({
      where: { type_crucibleId_userId: row },
      select: { type: true },
    }));

  // Unfollowing reads nothing first: it answers the same for any id, hidden or not, and a row the
  // replica has not caught up to yet is still removed.
  if (!follow) {
    await dbWrite.crucibleEngagement.deleteMany({ where: { type: NOTIFY, crucibleId, userId } });
    return false;
  }

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

  if (!CRUCIBLE_FOLLOWABLE_STATUSES.includes(crucible.status))
    throw throwBadRequestError('This crucible has already ended');

  await dbWrite.crucibleEngagement.create({ data: row }).catch((error) => {
    // Already following, or a concurrent follow won the race.
    if (!isPrismaUniqueViolation(error)) throw error;
  });
  return true;
}

export async function getFollowedCrucibleIds(userId: number): Promise<number[]> {
  const rows = await dbRead.crucibleEngagement.findMany({
    where: { userId, type: NOTIFY, crucible: { status: { in: CRUCIBLE_FOLLOWABLE_STATUSES } } },
    select: { crucibleId: true },
  });
  return rows.map((r) => r.crucibleId);
}
