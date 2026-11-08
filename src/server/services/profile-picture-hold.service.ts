import { Prisma } from '@prisma/client';
import { profilePictures as eventEngineProfilePictures } from '../../../event-engine-common/caches';
import type { CacheContext } from '../../../event-engine-common/caches/base';
import type { IRedisClient } from '../../../event-engine-common/types/package-stubs';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
import { bountiesSearchIndex } from '~/server/search-index/bounties.search-index';
import { collectionsSearchIndex } from '~/server/search-index/collections.search-index';
import { comicsSearchIndex } from '~/server/search-index/comics.search-index';
import { usersSearchIndex } from '~/server/search-index/users.search-index';
import { keysIn } from '~/server/services/image-url-ownership';
import { ownerHeldSql } from '~/server/services/legal-hold.service';
import { IMAGE_SAFETY_CONDITION } from '~/server/services/personal-data-export/sources/postgres';
import { avatarRemovalUndisclosedSql } from '~/server/services/profile-picture-hold.sql';
import { refreshProfilePicturesForUsers } from '~/server/services/user.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

// 🔴 Reads of "ProfilePictureHold" use dbWrite: see no-replica-profile-picture-hold-read.test.ts.

export const PROFILE_PICTURE_SYNC_OVERDUE_MINUTES = 15;
export const PROFILE_PICTURE_SYNC_HEARTBEAT = 'profile-picture-sync-heartbeat';
export const PROFILE_PICTURE_SYNC_OVERDUE = 'profile-picture-sync-overdue';
const PROFILE_PICTURE_SYNC_FAILED = 'profile-picture-sync-failed';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export type ProfilePictureSyncOutcome =
  | { action: 'held' | 'restored'; userId: number }
  | { action: 'none' | 'unclaimed' };

/**
 * Brings one image's avatar pointer in line with the image's state NOW, not with the event that queued
 * it. Lock order is Image, then JobQueue, then User: a block or unblock still in flight either commits
 * before the FOR SHARE (and is what we read), or its trigger queues a fresh row after this commits.
 */
export async function syncProfilePictureForImage(
  tx: Tx,
  imageId: number
): Promise<ProfilePictureSyncOutcome> {
  const [image] = await tx.$queryRaw<
    {
      userId: number;
      url: string;
      ingestion: string;
      needsReview: string | null;
      blockedFor: string | null;
    }[]
  >`
    SELECT "userId", url, ingestion::text AS ingestion, "needsReview", "blockedFor"
    FROM "Image" WHERE id = ${imageId}
    FOR SHARE
  `;
  const claimed = await tx.$executeRaw`
    DELETE FROM "JobQueue"
    WHERE type = ${JobQueueType.ProfilePictureSync}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
      AND "entityId" = ${imageId}
  `;
  if (!claimed) return { action: 'unclaimed' };
  if (!image) return { action: 'none' };

  // Any review kind, not only csam: the owner must not be able to tell which it is.
  const flagged = image.needsReview !== null;
  if (image.ingestion === 'Blocked' || flagged) {
    // No deletedAt test: a deleted account's blocked avatar is recorded too.
    const [user] = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM "User" WHERE "profilePictureId" = ${imageId} FOR UPDATE
    `;
    const reason = flagged ? 'flagged' : 'blocked';
    let ownerId = user?.id ?? 0;
    if (!user) {
      // Flagged, then blocked: the flag already took the pointer, so the block's record goes to the
      // owner of the flagged record, while the image is still theirs.
      if (reason !== 'blocked') return { action: 'none' };
      const [prior] = await tx.$queryRaw<{ id: number }[]>`
        SELECT u.id FROM "ProfilePictureHold" h
        JOIN "User" u ON u.id = h."userId"
        WHERE h."imageId" = ${imageId} AND h.reason = 'flagged' AND h."userId" = ${image.userId}
        FOR UPDATE OF u
      `;
      if (!prior) return { action: 'none' };
      ownerId = prior.id;
    }
    // `exportable` is decided here and never recomputed, so a later hold or report cannot take a
    // row out of a later export. DO NOTHING, not an upsert: the write role has no UPDATE.
    const owner = Prisma.sql`${ownerId}::int`;
    const inserted = await tx.$executeRaw`
      INSERT INTO "ProfilePictureHold" ("userId", "imageId", reason, exportable)
      VALUES (${owner}, ${imageId}, ${reason}, (
        ${reason} = 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM "Image" WHERE "Image".id = ${imageId} AND ${Prisma.raw(
      IMAGE_SAFETY_CONDITION
    )}
        )
        AND NOT ${avatarRemovalUndisclosedSql(owner)}
      ))
      ON CONFLICT ("imageId", reason) DO NOTHING
    `;
    if (!user) return inserted ? { action: 'held', userId: ownerId } : { action: 'none' };
    // The legacy `image` url is the avatar fallback once the pointer is NULL. Exact match only.
    await tx.$executeRaw`
      UPDATE "User" u SET
        "profilePictureId" = NULL,
        image = CASE
          WHEN u.image = ${image.url} OR EXISTS (
            SELECT 1 FROM "Image" bi
            WHERE bi."userId" = u.id AND bi.url = u.image
              AND (bi.ingestion = 'Blocked' OR bi."needsReview" IS NOT NULL)
          ) THEN NULL
          ELSE u.image
        END
      WHERE u.id = ${user.id}
    `;
    return { action: 'held', userId: user.id };
  }

  const clear = image.needsReview === null && image.blockedFor !== 'CSAM';
  if (!clear) return { action: 'none' };
  // When the avatar is not put back, a cleared flag's record goes anyway; a held owner keeps it.
  const declined = async () => {
    await tx.$executeRaw`
      DELETE FROM "ProfilePictureHold" h
      WHERE h."imageId" = ${imageId} AND h.reason = 'flagged'
        AND NOT ${ownerHeldSql(Prisma.raw('h."userId"'))}
    `;
    return { action: 'none' } as const;
  };

  // Their own image only: an image that changed owner since is not their avatar to put back. An
  // image can have two records, flagged and blocked; either being their newest counts.
  const owner = image.userId;
  const [hold] = await tx.$queryRaw<{ newest: boolean | null }[]>`
    SELECT bool_or(h.id = (
      SELECT n.id FROM "ProfilePictureHold" n
      WHERE n."userId" = h."userId"
      ORDER BY n."createdAt" DESC, n.id DESC
      LIMIT 1
    )) AS newest
    FROM "ProfilePictureHold" h WHERE h."imageId" = ${imageId} AND h."userId" = ${owner}
  `;
  if (!hold?.newest) return declined();
  const restored = await tx.$executeRaw`
    UPDATE "User" SET "profilePictureId" = ${imageId}
    WHERE id = ${owner} AND "profilePictureId" IS NULL AND "deletedAt" IS NULL
  `;
  if (!restored) return declined();
  // A held owner keeps the records, avatar restored or not.
  await tx.$executeRaw`
    DELETE FROM "ProfilePictureHold"
    WHERE "imageId" = ${imageId} AND "userId" = ${owner}
      AND NOT ${ownerHeldSql(Prisma.sql`${owner}::int`)}
  `;
  return { action: 'restored', userId: owner };
}

/** Busts the event-engine copy of these users' avatars, read from the same redis the main app uses. */
async function bustEventEngineProfilePictures(userIds: number[]) {
  const ctx = { redis: redis as unknown as IRedisClient } as CacheContext;
  await eventEngineProfilePictures.bust(ctx, userIds);
}

/** Every search doc that embeds the owner's avatar. The image indexes are retired. */
async function queueOwnerSearchUpdates(userIds: number[]) {
  const update = SearchIndexUpdateQueueAction.Update;
  const [bounties, collections, comics] = await Promise.all([
    dbWrite.bounty.findMany({ where: { userId: { in: userIds } }, select: { id: true } }),
    dbWrite.collection.findMany({ where: { userId: { in: userIds } }, select: { id: true } }),
    dbWrite.comicProject.findMany({ where: { userId: { in: userIds } }, select: { id: true } }),
  ]);
  await Promise.all([
    usersSearchIndex.queueUpdate(userIds.map((id) => ({ id, action: update }))),
    bountiesSearchIndex.queueUpdate(bounties.map(({ id }) => ({ id, action: update }))),
    collectionsSearchIndex.queueUpdate(collections.map(({ id }) => ({ id, action: update }))),
    comicsSearchIndex.queueUpdate(comics.map(({ id }) => ({ id, action: update }))),
  ]);
}

/** After the pointer changed: caches and search docs. Never throws; the change has committed. */
export async function afterProfilePictureSync(userIds: number[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await refreshProfilePicturesForUsers(ids);
  await Promise.all([bustEventEngineProfilePictures(ids), queueOwnerSearchUpdates(ids)]).catch(
    (error) =>
      logToAxiom({
        type: 'error',
        name: 'profile-picture-sync-after',
        message: (error as Error)?.message,
        userIds: ids.join(','),
      }).catch(() => undefined)
  );
}

export async function runProfilePictureSync({ limit = 1000 }: { limit?: number } = {}) {
  const queued = await dbWrite.$queryRaw<{ entityId: number; createdAt: Date }[]>`
    SELECT "entityId", "createdAt" FROM "JobQueue"
    WHERE type = ${JobQueueType.ProfilePictureSync}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
    ORDER BY "createdAt"
    LIMIT ${limit}
  `;
  const oldestAgeMinutes = queued.length
    ? Math.floor((Date.now() - queued[0].createdAt.getTime()) / 60_000)
    : 0;

  const changed: number[] = [];
  let processed = 0;
  let failed = 0;
  for (const { entityId } of queued) {
    try {
      const outcome = await dbWrite.$transaction((tx) => syncProfilePictureForImage(tx, entityId));
      if (outcome.action !== 'unclaimed') processed++;
      // Per image, not once per batch: its queue row is gone, so a run that dies later would
      // leave this user's caches and search docs stale with nothing to retry them.
      if (outcome.action === 'held' || outcome.action === 'restored') {
        changed.push(outcome.userId);
        await afterProfilePictureSync([outcome.userId]);
      }
    } catch (error) {
      failed++;
      await logToAxiom({
        type: 'error',
        name: PROFILE_PICTURE_SYNC_FAILED,
        imageId: entityId,
        message: (error as Error)?.message,
      }).catch(() => undefined);
    }
  }

  const summary = { oldestAgeMinutes, processed, failed, changed: changed.length };
  await logToAxiom({ type: 'info', name: PROFILE_PICTURE_SYNC_HEARTBEAT, ...summary }).catch(
    () => undefined
  );
  if (oldestAgeMinutes > PROFILE_PICTURE_SYNC_OVERDUE_MINUTES) {
    await logToAxiom({ type: 'error', name: PROFILE_PICTURE_SYNC_OVERDUE, ...summary }).catch(
      () => undefined
    );
  }
  return summary;
}

/**
 * Whether `url` is, or carries the key of, one of this user's images that is Blocked or under any
 * review.
 */
export async function isUnservableOwnImageUrl(userId: number, url: string): Promise<boolean> {
  const urls = [...new Set([url, ...keysIn(url)])];
  const rows = await dbWrite.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "Image"
      WHERE "userId" = ${userId} AND url = ANY(${urls}::text[])
        AND (ingestion = 'Blocked' OR "needsReview" IS NOT NULL)
    ) AS found
  `;
  return rows?.[0]?.found === true;
}
