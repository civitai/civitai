import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import {
  readFpMirrorByRequest,
  readFpMirrorByUrns,
} from '@civitai/db-queries/feature-page-comments';
import { fileReport } from '~/server/controllers/report.controller';
import type { ProtectedContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { kyselyWrite } from '~/server/db/kyselyDb';
import {
  afterCommentsV3Deleted,
  deleteOwnCommentV3,
} from '~/server/services/commentv3/moderation.service';
import { commentContentSchema } from '~/server/schema/commentv3.schema';
import type {
  FeaturePageCommentEditInput,
  FeaturePageCommentInput,
  FeaturePageCommentReportInput,
  FeaturePageCommentRetractInput,
} from '~/server/schema/feature-pages.schema';
import { createReportInputSchema } from '~/server/schema/report.schema';
import { throwIfBlockedByOwners } from '~/server/services/block-check.service';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import {
  writeCommentEdit,
  writeNewComment,
} from '~/server/services/commentv3/comment-write.service';
import { commentV3CsamHold, hasOpenCommentReport } from '~/server/services/commentv3/review-hold';
import {
  getStoredComment,
  prismaRunner,
  type SqlRunner,
  type StoredCommentV3,
} from '~/server/services/commentv3/write.service';
import { fpPostDigest, fpWantDigest } from '~/server/services/feature-pages/comment-state';
import { fpHtmlToText, fpTextToHtml } from '~/server/services/feature-pages/comment-text';
import {
  FP_INLINE_GRACE_SECONDS,
  isFpCommentShown,
  pushNewFpComment,
} from '~/server/services/feature-pages/mirror.service';
import { maskProfanityInChat } from '~/server/services/profanity-mask.service';
import { handleLogError, throwNotFoundError } from '~/server/utils/errorHandling';
import { lockCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { ReportEntity } from '~/shared/utils/report-helpers';

export type FeaturePageCommentView = {
  /** The platform's name for it; null until the mirror has posted it. */
  urn: string | null;
  sourceId: number;
  parent: string | null;
  text: string;
  maskedText: string | null;
  createdAt: Date;
  updatedAt: Date;
  author: { id: number; username: string | null };
};
export type FeaturePageCommentReply = { comment: FeaturePageCommentView };

const refused = (message = 'Refused') => new TRPCError({ code: 'FORBIDDEN', message });
const tryAgain = (cause?: unknown) =>
  new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Feature pages: try again', cause });

class BlockedContent extends Error {}
class EditAlreadyApplied extends Error {}
class DuplicateRequest extends Error {}
/** The recent edit requestIds a comment remembers, so a resend is recognised. */
const FP_EDIT_REQUESTS_KEPT = 20;
/** Blocked text answers 'blocked' in the frame: the writer can change it and send again. */
const blocked = () => new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: 'blocked' });

/** The text as stored HTML, held to the site's comment rules (sanitized, within its length). */
function storedHtml(text: string) {
  const parsed = commentContentSchema.safeParse(fpTextToHtml(text));
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Comment too long' });
  return parsed.data;
}

async function assertNotBlocked(ctx: ProtectedContext, html: string) {
  try {
    await throwOnBlockedCommentContent(html, {
      isModerator: ctx.user.isModerator,
      onBlocked: () => {
        throw new BlockedContent();
      },
    });
  } catch (e) {
    if (e instanceof BlockedContent) throw blocked();
    throw e;
  }
}

/** A request's own earlier answer: the comment it wrote, or its refusal once that is gone. */
async function answerOfWrittenRequest(
  ctx: ProtectedContext,
  written: { commentId: number; urn: string | null; pushedState: string | null },
  parent: string | null
): Promise<FeaturePageCommentReply> {
  if (written.pushedState === 'refused') throw refused('Unknown feature');
  const stored = await getStoredComment(prismaRunner(dbWrite), written.commentId);
  if (!stored || stored.deletedAt) throw refused();
  return { comment: await viewOf(stored, ctx, { urn: written.urn, parent }) };
}

async function commentIdOfUrn(urn: string) {
  const [row] = await readFpMirrorByUrns(kyselyWrite, [urn]);
  if (!row) throw throwNotFoundError('Comment not found');
  return row.commentId;
}

async function viewOf(
  row: StoredCommentV3,
  ctx: ProtectedContext,
  { urn, parent }: { urn: string | null; parent: string | null }
): Promise<FeaturePageCommentView> {
  const text = fpHtmlToText(row.content);
  const [masked] = await maskProfanityInChat([text]);
  return {
    urn,
    sourceId: row.id,
    parent,
    text,
    maskedText: typeof masked === 'string' ? masked : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: { id: ctx.user.id, username: ctx.user.username ?? null },
  };
}

const upsertTopic = async (db: SqlRunner, urn: string) => {
  const kind = urn.includes(':feature-pages/features/') ? 'feature' : 'request';
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "FeaturePageTopic" (urn, kind) VALUES ($1, $2)
     ON CONFLICT (urn) DO UPDATE SET urn = EXCLUDED.urn
     RETURNING id`,
    [urn, kind]
  );
  return { entityType: 'featurePage', entityId: rows[0].id };
};

export async function postFeaturePageComment(
  ctx: ProtectedContext,
  input: FeaturePageCommentInput
): Promise<FeaturePageCommentReply> {
  const userId = ctx.user.id;
  const html = storedHtml(input.text);
  const parentUrn = input.parent ?? null;
  // A resend of a request that already wrote its comment gets that comment back.
  const written = await readFpMirrorByRequest(kyselyWrite, userId, input.requestId);
  if (written) return answerOfWrittenRequest(ctx, written, parentUrn);

  await assertNotBlocked(ctx, html);
  let parent: StoredCommentV3 | undefined;
  if (input.parent) {
    const stored = await getStoredComment(
      prismaRunner(dbWrite),
      await commentIdOfUrn(input.parent)
    );
    // A parent removed for ToS is not found to a member, as on the site.
    if (
      !stored ||
      stored.deletedAt ||
      stored.entityType !== 'featurePage' ||
      (stored.tosViolation && !ctx.user.isModerator)
    )
      throw throwNotFoundError('The comment you are replying to no longer exists.');
    parent = stored;
  }
  await throwIfBlockedByOwners({
    userId,
    ownerIds: [parent?.userId],
    isModerator: ctx.user.isModerator,
  });
  const pending = (content: string) =>
    fpWantDigest(
      'visible',
      fpPostDigest('visible', { authorName: ctx.user.username ?? '', content, version: 1 })
    );
  let row: StoredCommentV3;
  try {
    // The topic, the comment and its mirror row commit together. insertComment refuses a parent on
    // another subject's thread (not found) and a locked thread or comment chain. The mirror row is
    // unique per (userId, requestId): of two concurrent sends, the second waits on the first and
    // rolls its own comment back.
    row = await writeNewComment({
      userId,
      section: (db) => upsertTopic(db, input.subject),
      parent,
      content: html,
      track: ctx.track,
      afterInsert: async (db, inserted) => {
        const { rows: claimed } = await db.query(
          `INSERT INTO "FeaturePageCommentMirror" ("commentId", "userId", "requestId", "nextPushAt", "pendingDigest")
           VALUES ($1, $2, $3, now() + make_interval(secs => ${FP_INLINE_GRACE_SECONDS}), $4)
           ON CONFLICT ("userId", "requestId") DO NOTHING
           RETURNING "commentId"`,
          [inserted.id, userId, input.requestId, pending(inserted.content)]
        );
        // Another send of this request committed first: roll this comment back.
        if (!claimed.length) throw new DuplicateRequest();
      },
    });
  } catch (e) {
    if (!(e instanceof DuplicateRequest)) throw e;
    const winner = await readFpMirrorByRequest(kyselyWrite, userId, input.requestId);
    if (!winner) throw tryAgain(e);
    return answerOfWrittenRequest(ctx, winner, parentUrn);
  }

  const first = { comment: await viewOf(row, ctx, { urn: null, parent: parentUrn }) };
  const pushed = await pushNewFpComment(row.id);
  if (pushed === 'refused') throw refused('Unknown feature');
  const [mirror] = await mirrorUrnOf(row.id);
  return mirror?.urn ? { comment: { ...first.comment, urn: mirror.urn } } : first;
}

async function mirrorUrnOf(commentId: number) {
  return kyselyWrite
    .selectFrom('FeaturePageCommentMirror')
    .select(['urn'])
    .where('commentId', '=', commentId)
    .execute();
}

/** featurePages.edit: the author replaces the text; the rescan and the mirror's re-post follow. */
/**
 * The edit's checks and its mirror bump, run with the comment's hold lock and then its row lock
 * held: a ToS removal, a report or a hold committed meanwhile is seen, and a resend of an edit
 * already applied changes nothing (edit A, edit B, resend A leaves B).
 */
export const fpEditHooks = (commentId: number, requestId: string) => ({
  beforeLock: (tx: Prisma.TransactionClient) => lockCsamHold(tx, 'CommentV3', commentId),
  beforeUpdate: (db: SqlRunner, current: StoredCommentV3, tx: Prisma.TransactionClient) =>
    fpEditUnderLock(db, current, tx, requestId),
});

async function fpEditUnderLock(
  db: SqlRunner,
  current: StoredCommentV3,
  tx: Prisma.TransactionClient,
  requestId: string
) {
  const { rows: applied } = await db.query(
    `SELECT 1 AS x FROM "FeaturePageCommentMirror"
     WHERE "commentId" = $1 AND $2 = ANY("editRequestIds")`,
    [current.id, requestId]
  );
  if (applied.length) throw new EditAlreadyApplied();
  if (current.tosViolation) throw throwNotFoundError('Comment not found');
  const hold = await commentV3CsamHold(current.id, tx);
  // Not yet verified clear (a scan in flight): the frame offers a retry; held stays refused.
  if (hold === 'unverified')
    throw new TRPCError({ code: 'CONFLICT', message: 'This comment is being checked.' });
  if (hold !== 'clear') throw refused();
  if (await hasOpenCommentReport(db, current.id)) throw refused('This comment is under review.');
  await db.query(
    `UPDATE "FeaturePageCommentMirror"
     SET version = version + 1, "contentAt" = now(), "nextPushAt" = now(), "pushAttempts" = 0,
         "pendingDigest" = NULL, "updatedAt" = now(),
         "editRequestIds" = (array_append("editRequestIds", $2))[
           greatest(1, cardinality("editRequestIds") + 2 - ${FP_EDIT_REQUESTS_KEPT}):]
     WHERE "commentId" = $1`,
    [current.id, requestId]
  );
}

export async function editFeaturePageComment(
  ctx: ProtectedContext,
  input: FeaturePageCommentEditInput
): Promise<FeaturePageCommentReply> {
  const html = storedHtml(input.text);
  const commentId = await commentIdOfUrn(input.comment);
  const comment = await getStoredComment(prismaRunner(dbWrite), commentId);
  if (!comment || comment.deletedAt || comment.entityType !== 'featurePage')
    throw throwNotFoundError('Comment not found');
  if (comment.userId !== ctx.user.id) throw refused();
  if (comment.tosViolation) throw throwNotFoundError('Comment not found');
  const answered = await Promise.all(
    [comment.parentId, comment.replyToId].map(async (id) => {
      const row = id ? await getStoredComment(prismaRunner(dbWrite), id) : undefined;
      return row && !row.deletedAt ? row.userId : undefined;
    })
  );
  await throwIfBlockedByOwners({
    userId: ctx.user.id,
    ownerIds: answered,
    isModerator: ctx.user.isModerator,
  });
  await assertNotBlocked(ctx, html);
  let row: StoredCommentV3;
  try {
    row = await writeCommentEdit({
      userId: ctx.user.id,
      comment,
      content: html,
      track: ctx.track,
      ...fpEditHooks(comment.id, input.requestId),
    });
  } catch (e) {
    if (!(e instanceof EditAlreadyApplied)) throw e;
    const current = await getStoredComment(prismaRunner(dbWrite), comment.id);
    if (!current || current.deletedAt) throw throwNotFoundError('Comment not found');
    row = current;
  }
  return { comment: await viewOf(row, ctx, { urn: input.comment, parent: null }) };
}

export async function retractFeaturePageComment(
  ctx: ProtectedContext,
  input: FeaturePageCommentRetractInput
) {
  const [mirrored] = await readFpMirrorByUrns(kyselyWrite, [input.comment]);
  if (!mirrored) throw throwNotFoundError('Comment not found');
  const id = mirrored.commentId;
  // A resend of a retract that already went through: the same answer, nothing done twice.
  if (mirrored.userId === ctx.user.id && mirrored.goneCause === 'author')
    return { comment: input.comment };
  const comment = await getStoredComment(prismaRunner(dbWrite), id);
  if (!comment || comment.entityType !== 'featurePage')
    throw throwNotFoundError('Comment not found');
  // The frame offers retract on one's own comments only; a moderator removes from the queue.
  if (comment.userId !== ctx.user.id) throw refused();
  if (comment.deletedAt) return { comment: input.comment };
  afterCommentsV3Deleted(await dbWrite.$transaction((tx) => deleteOwnCommentV3(tx, comment)));
  ctx.track.commentEvent({ type: 'Delete', commentId: id }).catch(handleLogError);
  return { comment: input.comment };
}

export async function reportFeaturePageComment(
  ctx: ProtectedContext,
  input: FeaturePageCommentReportInput
) {
  const id = await commentIdOfUrn(input.comment);
  // Not the generic comment gate, which keeps this entity type to moderators: a member reports
  // what the frame shows them.
  const comment = await getStoredComment(prismaRunner(dbWrite), id);
  if (
    !comment ||
    comment.entityType !== 'featurePage' ||
    comment.deletedAt ||
    (!ctx.user.isModerator && !(await isFpCommentShown(id)))
  )
    throw throwNotFoundError('Comment not found');
  const parsed = createReportInputSchema.safeParse({
    type: ReportEntity.CommentV3,
    id,
    reason: input.reason,
    details: input.details ?? {},
  });
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid report' });
  await fileReport({ input: parsed.data, ctx });
  return { comment: input.comment };
}
