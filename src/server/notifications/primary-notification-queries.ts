import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type { NotificationProcessorRunInput } from '~/server/notifications/base.notifications';
import { avatarRemovalUndisclosedSql } from '~/server/services/profile-picture-hold.sql';

/**
 * Avatars blocked since `lastSent`, whether the sync job has already moved the pointer to a
 * ProfilePictureHold record or not. No notice for a CSAM block or flag, nor for an owner the export
 * also leaves out (`avatarRemovalUndisclosedSql`).
 * Read from the primary: the record table is not readable from the replica.
 */
export async function getBlockedProfilePictureNotices(lastSent: Date) {
  return dbWrite.$queryRaw<{ imageId: number; userId: number }[]>`
    WITH blocked AS (
      SELECT h."imageId", h."userId"
      FROM "ProfilePictureHold" h
      WHERE h.reason = 'blocked' AND h."createdAt" > ${lastSent}
      UNION
      SELECT i.id, u.id
      FROM "Image" i
      JOIN "User" u ON i.id = u."profilePictureId"
      WHERE i."updatedAt" > ${lastSent} AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
    )
    SELECT b."imageId", b."userId"
    FROM blocked b
    JOIN "Image" i ON i.id = b."imageId"
    WHERE i."needsReview" IS DISTINCT FROM 'csam'
      AND i."blockedFor" IS DISTINCT FROM 'CSAM'
      AND NOT ${avatarRemovalUndisclosedSql(Prisma.raw('b."userId"'))}
  `;
}

async function profilePictureBlockedQuery({ lastSentDate }: NotificationProcessorRunInput) {
  const notices = await getBlockedProfilePictureNotices(lastSentDate);
  if (!notices.length) return undefined;
  const rows = notices
    .map(({ imageId, userId }) => `(${Number(imageId)}, ${Number(userId)})`)
    .join(', ');
  // Keyed by image, so the record and the pointer path cannot both send.
  return `
    WITH data ("imageId", "userId") AS (VALUES ${rows})
    SELECT
      CONCAT('profile-picture-blocked:',"imageId") "key",
      "userId",
      'profile-picture-blocked' "type",
      '{}'::jsonb "details"
    FROM data
    WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" uns WHERE uns."userId" = data."userId" AND uns.type = 'profile-picture-blocked')
  `;
}

/** prepareQuery for processors whose selection needs server-only reads. Keyed by processor key. */
export const primaryPrepareQueries: Record<
  string,
  (input: NotificationProcessorRunInput) => Promise<string | undefined>
> = {
  'profile-picture-blocked': profilePictureBlockedQuery,
};
