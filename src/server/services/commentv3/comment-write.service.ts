import type { Prisma } from '@prisma/client';
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
  type SqlRunner,
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
 * decided the writer may: this is the write, not its checks. `section` may be resolved inside the
 * transaction, and `afterInsert` writes the caller's own rows in it, so they commit with the comment
 * or not at all.
 */
export async function writeNewComment({
  userId,
  section,
  parent,
  content,
  metadata,
  track,
  afterInsert,
}: {
  userId: number;
  section: Section | ((db: SqlRunner) => Promise<Section>);
  parent?: StoredCommentV3;
  content: string;
  /** Server-built; never a client's object. */
  metadata?: Record<string, unknown>;
  track?: Track;
  afterInsert?: (db: SqlRunner, row: StoredCommentV3) => Promise<void>;
}) {
  const saved = await dbWrite.$transaction(async (tx) => {
    const db = prismaRunner(tx);
    // The parent before the stickers, the lock order an edit takes, so the two cannot deadlock.
    if (parent) await getStoredComment(db, parent.id, 'FOR KEY SHARE');
    const charged = await spendStickerUses({ userId, surface: 'comment', content, tx });
    const { entityType, entityId } = typeof section === 'function' ? await section(db) : section;
    const row = await insertComment(db, {
      userId,
      entityType,
      entityId,
      parentId: parent?.id,
      content,
      metadata,
    });
    await afterInsert?.(db, row);
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
  beforeLock,
  beforeUpdate,
}: {
  userId: number;
  comment: StoredCommentV3;
  content: string;
  track?: Track;
  /** Runs before the comment's row lock is taken, for a lock that must come first. */
  beforeLock?: (tx: Prisma.TransactionClient) => Promise<unknown>;
  /** Runs with the comment locked FOR UPDATE, before the write: throw to refuse the edit. */
  beforeUpdate?: (
    db: SqlRunner,
    current: StoredCommentV3,
    tx: Prisma.TransactionClient
  ) => Promise<void>;
}) {
  const saved = await dbWrite.$transaction(async (tx) => {
    const db = prismaRunner(tx);
    const parentPath = comment.path.split('.').slice(0, -1).join('.') || null;
    if (await isCommentWriteLocked(db, { ...comment, path: parentPath }))
      throw throwBadRequestError('comment thread locked');
    // Charged against the content as locked here, so two concurrent edits are not both charged
    // for the same new sticker.
    await beforeLock?.(tx);
    const current = await getStoredComment(db, comment.id, 'FOR UPDATE');
    if (!current || current.deletedAt) throw throwNotFoundError('Comment not found');
    await beforeUpdate?.(db, current, tx);
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
