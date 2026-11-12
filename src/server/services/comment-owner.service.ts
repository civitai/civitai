import { dbRead } from '~/server/db/client';
import { kyselyRead } from '~/server/db/kyselyDb';
import type { CommentTargetType } from '~/server/schema/commentv3.schema';

/**
 * Resolve the owner (creator) userId of the entity a comment thread hangs off of, so callers
 * can tell whether the current viewer is looking at engagement on their OWN content. Returns
 * null for entity types we can't cheaply resolve — callers treat that as "not the owner",
 * which keeps the anti-harassment `blockedByUsers` exclusion in place (the safe default).
 */
export async function getThreadEntityOwnerId({
  entityType,
  entityId,
}: {
  entityType: CommentTargetType;
  entityId: number;
}): Promise<number | null> {
  const findUserId = async (row: Promise<{ userId: number | null } | null>) =>
    (await row)?.userId ?? null;

  switch (entityType) {
    case 'image':
      return findUserId(
        dbRead.image.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'post':
      return findUserId(
        dbRead.post.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'model':
      return findUserId(
        dbRead.model.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'article':
      return findUserId(
        dbRead.article.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'bounty':
      return findUserId(
        dbRead.bounty.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'bountyEntry':
      return findUserId(
        dbRead.bountyEntry.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'review':
      return findUserId(
        dbRead.resourceReview.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'comment': {
      const row = await kyselyRead
        .selectFrom('CommentV3')
        .select('userId')
        .where('id', '=', entityId)
        .executeTakeFirst();
      return row?.userId ?? null;
    }
    case 'challenge': {
      const row = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      return row?.createdById ?? null;
    }
    case 'crucible':
      return findUserId(
        dbRead.crucible.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'storyline':
      return findUserId(
        dbRead.storyline.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'model3d':
      return findUserId(
        dbRead.model3D.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'model3dReview':
      return findUserId(
        dbRead.model3DReview.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    // `entityId` is the serialId. Stays user_id: `ownerOfThreadContent` grants hide/pin on it.
    case 'appListing':
      return findUserId(
        dbRead.appListing.findUnique({ where: { serialId: entityId }, select: { userId: true } })
      );
    case 'comicChapter': {
      const row = await dbRead.comicChapter.findUnique({
        where: { id: entityId },
        select: { project: { select: { userId: true } } },
      });
      return row?.project?.userId ?? null;
    }
    default:
      return null;
  }
}

/**
 * Whether `userId` owns the entity this comment thread hangs off of. Skips the lookup unless a
 * viewer is present AND has a non-empty blocked-by list — dropping `blockedByUsers` only
 * matters (and only for the owner) in that case, so the extra query stays off the hot path for
 * everyone else.
 */
export async function isViewerContentOwner({
  entityType,
  entityId,
  userId,
  blockedByUsers,
}: {
  entityType: CommentTargetType;
  entityId: number;
  userId?: number;
  blockedByUsers: number[];
}): Promise<boolean> {
  if (!userId || !blockedByUsers.length) return false;
  const ownerId = await getThreadEntityOwnerId({ entityType, entityId });
  return ownerId === userId;
}
