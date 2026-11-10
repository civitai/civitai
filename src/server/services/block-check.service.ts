import { dbRead, dbWrite } from '~/server/db/client';
import type { CommentTargetType } from '~/server/schema/commentv3.schema';
import type { ReactionEntityType } from '~/server/schema/reaction.schema';
import { amIBlockedByUser } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Every entity type any write path can hand the owner resolver: comment surfaces
 * plus reaction surfaces. Adding a member to either enum breaks the switch in
 * `getBlockCheckOwnerIds` until an owner is resolved for it.
 */
export type BlockCheckEntityType = CommentTargetType | ReactionEntityType;

// These lookups guard writes that land on the primary, and the replica can lag behind a row written
// moments ago, so they read the primary.
const guardDb = dbWrite;

// For the highest-volume targets the replica answers first, and only a miss there reads the primary.
async function readGuardRow<T>(read: (db: typeof guardDb) => Promise<T | null>): Promise<T | null> {
  return (await read(dbRead)) ?? (await read(guardDb));
}

/** A live comment's author and section. */
async function storedComment(commentId: number) {
  const [row] = await guardDb.$queryRaw<
    {
      userId: number;
      entityType: CommentTargetType;
      entityId: number;
    }[]
  >`
    SELECT c."userId", c."entityType"::text AS "entityType", c."entityId"
    FROM "CommentV3" c
    WHERE c.id = ${commentId} AND c."deletedAt" IS NULL
  `;
  return row;
}

/** Block targets for reacting to a comment: its author and its section's owner. */
async function ownersForComment(commentId: number): Promise<number[]> {
  const comment = await storedComment(commentId);
  if (!comment) throw throwNotFoundError(`No comment with id ${commentId}`);
  return [...new Set([comment.userId, ...(await getBlockCheckOwnerIds(comment))])];
}

// Resolves the content owner user id(s) relevant to an interaction on a given
// entity, so we can enforce user-blocking on write paths (comment/reaction).
export async function getBlockCheckOwnerIds({
  entityType,
  entityId,
}: {
  entityType: BlockCheckEntityType;
  entityId: number;
}): Promise<number[]> {
  switch (entityType) {
    case 'image': {
      const r = await readGuardRow((db) =>
        db.image.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
      return r ? [r.userId] : [];
    }
    case 'post': {
      const r = await readGuardRow((db) =>
        db.post.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
      return r ? [r.userId] : [];
    }
    case 'article': {
      const r = await readGuardRow((db) =>
        db.article.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
      return r ? [r.userId] : [];
    }
    case 'model': {
      const r = await guardDb.model.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'review':
    case 'resourceReview': {
      const r = await guardDb.resourceReview.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'bounty': {
      const r = await guardDb.bounty.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r?.userId ? [r.userId] : [];
    }
    case 'bountyEntry': {
      const r = await guardDb.bountyEntry.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r?.userId ? [r.userId] : [];
    }
    case 'model3d': {
      const r = await guardDb.model3D.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'model3dReview': {
      const r = await guardDb.model3DReview.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'comicChapter': {
      const r = await guardDb.comicChapter.findUnique({
        where: { id: entityId },
        select: { project: { select: { userId: true } } },
      });
      return r?.project?.userId ? [r.project.userId] : [];
    }
    case 'challenge': {
      const r = await guardDb.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      return r?.createdById ? [r.createdById] : [];
    }
    case 'appListing': {
      // Threads key off the INTEGER surrogate, so `entityId` here is `serialId`,
      // not the listing's ULID `id`.
      const r = await guardDb.appListing.findUnique({
        where: { serialId: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'crucible': {
      const r = await guardDb.crucible.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'storyline': {
      const r = await guardDb.storyline.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'comment':
      return ownersForComment(entityId);
    default:
      // Compile-time exhaustiveness: a new comment/reaction entity type fails to
      // build here until it resolves an owner. Runtime still yields "no owner"
      // rather than throwing, so an unexpected value can't take a write path down.
      entityType satisfies never;
      return [];
  }
}

export async function throwIfBlockedByOwners({
  userId,
  ownerIds,
  isModerator,
}: {
  userId: number;
  ownerIds: Array<number | null | undefined>;
  isModerator?: boolean;
}) {
  if (isModerator) return;
  for (const ownerId of ownerIds) {
    if (!ownerId || ownerId === userId) continue;
    // A write path: confirm a cache "not blocked" on the primary.
    const blocked = await amIBlockedByUser({
      userId,
      targetUserId: ownerId,
      confirmOnPrimary: true,
    });
    if (blocked) throw throwNotFoundError();
  }
}

// Throws NotFound (mirroring the read-side block enforcement) when `userId` is
// blocked by the owner of the content they're trying to interact with.
export async function throwIfBlockedByEntityOwner({
  userId,
  entityType,
  entityId,
  isModerator,
}: {
  userId: number;
  entityType: BlockCheckEntityType;
  entityId: number;
  isModerator?: boolean;
}) {
  if (isModerator) return;
  const ownerIds = await getBlockCheckOwnerIds({ entityType, entityId });
  await throwIfBlockedByOwners({ userId, ownerIds, isModerator });
}
