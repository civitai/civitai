import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { notCommentMuted } from '~/server/notifications/base.notifications';
import type { CommentMuteInput, CommentSectionInput } from '~/server/schema/commentv3.schema';
import { getBlockCheckOwnerIds } from '~/server/services/block-check.service';
import {
  getV3WriteComment,
  isTopicMuted,
  prismaRunner,
  toggleCommentMute as writeCommentMute,
  toggleTopicLock,
  toggleTopicMute,
  type StoredCommentV3,
} from '~/server/services/commentv3/write.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

export const toggleSectionLock = (section: CommentSectionInput) =>
  toggleTopicLock(prismaRunner(dbWrite), section);

/** Refuses a missing entity rather than write a mute row for a bare id. */
export async function toggleSectionMute({
  entityType,
  entityId,
  userId,
}: CommentSectionInput & { userId: number }) {
  if (!(await getBlockCheckOwnerIds({ entityType, entityId })).length)
    return { muted: false, exists: false };
  const { muted } = await toggleTopicMute(prismaRunner(dbWrite), { userId, entityType, entityId });
  return { muted, exists: true };
}

export async function getSectionMuted({
  entityType,
  entityId,
  userId,
}: CommentSectionInput & { userId: number }) {
  const [owners, muted] = await Promise.all([
    getBlockCheckOwnerIds({ entityType, entityId }),
    isTopicMuted(prismaRunner(dbRead), { userId, entityType, entityId }),
  ]);
  return { muted, exists: owners.length > 0 };
}

/** The comment exactly as `getV3WriteComment` returned it from the primary, to spare a second read. */
type Loaded = { comment: StoredCommentV3 | undefined };

export async function toggleCommentMute(
  { commentId, userId }: CommentMuteInput & { userId: number },
  loaded?: Loaded
) {
  const comment = loaded
    ? loaded.comment
    : await getV3WriteComment(prismaRunner(dbWrite), commentId);
  // A ToS removal answers as missing: the endpoint takes a bare id, so it must not tell them apart.
  if (!comment || comment.tosViolation) throw throwNotFoundError();
  return writeCommentMute(prismaRunner(dbWrite), { userId, commentId });
}

export async function getCommentMuted(
  { commentId, userId }: CommentMuteInput & { userId: number },
  loaded?: Loaded
) {
  const comment = loaded
    ? loaded.comment
    : await getV3WriteComment(prismaRunner(dbWrite), commentId);
  if (!comment || comment.tosViolation) return { muted: false, viaAncestor: false, canMute: false };

  // The suppression's own predicate (`notCommentMuted`), so the label matches what is delivered.
  // `dbWrite`: the client refetches right after a toggle, and a replica could return the
  // pre-toggle state.
  const [row] = await dbWrite.$queryRaw<{ own: boolean | null; ancestor: boolean | null }[]>`
    SELECT
      EXISTS (SELECT 1 FROM "CommentMute" m WHERE m."userId" = u.id AND m."commentId" = c.id) "own",
      NOT ${Prisma.raw(notCommentMuted('u.id', 'c'))} "ancestor"
    FROM "CommentV3" c, (SELECT ${userId}::int AS id) u
    WHERE c.id = ${commentId}
  `;
  const own = row?.own ?? false;
  const ancestor = row?.ancestor ?? false;
  return { muted: own || ancestor, viaAncestor: !own && ancestor, canMute: true };
}
