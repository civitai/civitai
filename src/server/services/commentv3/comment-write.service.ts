import { dbWrite } from '~/server/db/client';
import {
  getBlockCheckOwnerIds,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import {
  getStoredComment,
  insertComment,
  isCommentWriteLocked,
  prismaRunner,
  type StoredCommentV3,
  updateCommentContent,
} from '~/server/services/commentv3/write.service';
import { recordStickerUsage, spendStickerUses } from '~/server/services/sticker.service';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

type Section = { entityType: string; entityId: number };
type Track = Parameters<typeof recordStickerUsage>[0]['track'];

/**
 * Writes a new comment, charging its stickers in the same transaction. The caller has already
 * decided the writer may: this is the write, not its checks.
 */
export async function writeNewComment({
  userId,
  section,
  parent,
  content,
  track,
}: {
  userId: number;
  section: Section;
  parent?: StoredCommentV3;
  content: string;
  track?: Track;
}) {
  const saved = await dbWrite.$transaction(async (tx) => {
    // The parent before the stickers, the lock order an edit takes, so the two cannot deadlock.
    if (parent) await getStoredComment(prismaRunner(tx), parent.id, 'FOR KEY SHARE');
    const charged = await spendStickerUses({ userId, surface: 'comment', content, tx });
    const row = await insertComment(prismaRunner(tx), {
      userId,
      entityType: section.entityType,
      entityId: section.entityId,
      parentId: parent?.id,
      content,
    });
    return { row, charged };
  });
  recordStickerUsage({
    track,
    userId,
    charged: saved.charged,
    entityType: 'comment',
    entityId: saved.row.id,
  });
  queueScamScan({ entityType: 'CommentV3', entityId: saved.row.id });
  return saved.row;
}

/** Replaces a comment's content, charging only the stickers the edit adds. */
export async function writeCommentEdit({
  userId,
  comment,
  content,
  track,
}: {
  userId: number;
  comment: StoredCommentV3;
  content: string;
  track?: Track;
}) {
  const saved = await dbWrite.$transaction(async (tx) => {
    const db = prismaRunner(tx);
    const parentPath = comment.path.split('.').slice(0, -1).join('.') || null;
    if (await isCommentWriteLocked(db, { ...comment, path: parentPath }))
      throw throwBadRequestError('comment thread locked');
    // Charged against the content as locked here, so two concurrent edits are not both charged
    // for the same new sticker.
    const current = await getStoredComment(db, comment.id, 'FOR UPDATE');
    if (!current || current.deletedAt) throw throwNotFoundError('Comment not found');
    const charged = await spendStickerUses({
      userId,
      surface: 'comment',
      content,
      previousContent: current.content,
      tx,
    });
    const row = await updateCommentContent(db, { id: comment.id, content });
    if (!row) throw throwNotFoundError('Comment not found');
    return { row, charged };
  });
  recordStickerUsage({
    track,
    userId,
    charged: saved.charged,
    entityType: 'comment',
    entityId: comment.id,
  });
  queueScamScan({ entityType: 'CommentV3', entityId: comment.id });
  return saved.row;
}

/** The challenge judge's comment on an image. Automated, so no event points. */
export async function writeJudgeComment({
  userId,
  imageId,
  content,
}: {
  userId: number;
  imageId: number;
  content: string;
}) {
  await throwOnBlockedCommentContent(content, { isModerator: false });
  await throwIfBlockedByOwners({
    userId,
    ownerIds: await getBlockCheckOwnerIds({ entityType: 'image', entityId: imageId }),
  });
  await writeNewComment({ userId, section: { entityType: 'image', entityId: imageId }, content });
}
