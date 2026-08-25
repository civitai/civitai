import type { GetByIdInput } from './../schema/base.schema';
import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import { commentV2Select } from '~/server/selectors/commentv2.selector';
import { recordStickerUsage, spendStickerUses } from '~/server/services/sticker.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import type {
  UpsertCommentV2Input,
  CommentConnectorInput,
  GetCommentsInfiniteInput,
} from './../schema/commentv2.schema';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import {
  getBlockCheckOwnerIdsForComment,
  throwIfBlockedByEntityOwner,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import type { NsfwLevel } from '~/server/common/enums';
import { ThreadSort } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import type { ReplyThread, ReplyThreadRow } from '~/server/services/commentsv2.reply-threads';
import {
  getChildlessCommentIds,
  groupReplyThreads,
  selectReplyThreadsWithinBudget,
} from '~/server/services/commentsv2.reply-threads';
import { withSpan } from '~/server/utils/otel-helpers';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import type { ImageMetadata } from '~/server/schema/media.schema';

export type CommentThread = {
  id: number;
  locked: boolean;
  commentId?: number | null;
  comments?: Comment[];
  count: number;
  depth: number;
  hidden: number;
  children?: CommentThread[];
};

export type Comment = CommentV2Model & {
  // childThread?: { id: number; _count?: { comments: number } } | null;
};

/**
 * The reply threads nested under `commentIds`, down to `depth` levels and capped at `budget`
 * comments, in two queries — so a surface can render whole conversations without a request per
 * comment per level, and without a 1k-comment article turning one page into thousands of nodes.
 */
async function getReplyThreads({
  commentIds,
  depth,
  limit,
  budget,
  sort,
  hidden,
  excludedUserIds,
}: {
  commentIds: number[];
  depth: number;
  limit: number;
  budget: number;
  sort: ThreadSort;
  hidden: boolean | null;
  excludedUserIds: number[];
}): Promise<{ threads: ReplyThread[]; childlessCommentIds: number[] }> {
  const empty = { threads: [], childlessCommentIds: [] };
  if (!commentIds.length || depth < 1) return empty;

  const rows = await dbRead.$queryRaw<ReplyThreadRow[]>`
    WITH RECURSIVE generation AS (
      SELECT t.id, t."commentId", t.locked, t."commentCount", 1 AS depth
      FROM "Thread" t
      WHERE t."commentId" = ANY(${commentIds}::int[])

      UNION ALL

      SELECT c.id, c."commentId", c.locked, c."commentCount", g.depth + 1 AS depth
      FROM "Thread" c
      JOIN generation g ON g.id = c."parentThreadId"
      WHERE g.depth < ${depth}
    )
    SELECT id, "commentId", locked, "commentCount", depth
    FROM generation
    WHERE "commentId" IS NOT NULL AND "commentCount" > 0
    ORDER BY depth;
  `;
  if (!rows.length) return empty;

  const { selected, completedDepth } = selectReplyThreadsWithinBudget({ rows, limit, budget });
  if (!selected.length) return empty;

  const threadIds = selected.map((x) => x.id);
  const [comments, hiddenGroups] = await Promise.all([
    dbRead.commentV2.findMany({
      where: {
        threadId: { in: threadIds },
        hidden: hidden ?? false,
        userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
      },
      select: commentV2Select,
    }),
    dbRead.commentV2.groupBy({
      by: ['threadId'],
      where: {
        threadId: { in: threadIds },
        hidden: true,
        userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
      },
      _count: { _all: true },
    }),
  ]);

  const hiddenCounts = Object.fromEntries(
    hiddenGroups.map((group) => [group.threadId, group._count._all])
  );

  const threads = groupReplyThreads({
    threads: selected,
    comments: comments as CommentV2Model[],
    hiddenCounts,
    sort,
    limit,
  });

  return {
    threads,
    childlessCommentIds: getChildlessCommentIds({
      pageCommentIds: commentIds,
      threads,
      rows,
      completedDepth,
    }),
  };
}

export async function getJudgeCommentForImage({
  imageId,
  judgeUserId,
}: {
  imageId: number;
  judgeUserId: number;
}) {
  const result = await dbRead.$queryRaw<[{ content: string }?]>`
    SELECT c.content
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id AND c."userId" = ${judgeUserId}
    WHERE t."imageId" = ${imageId}
    ORDER BY c."createdAt" ASC
    LIMIT 1
  `;
  return result[0]?.content ?? null;
}

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
  entityType: CommentConnectorInput['entityType'];
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
    case 'comment':
      return findUserId(
        dbRead.commentV2.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'question':
      return findUserId(
        dbRead.question.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'answer':
      return findUserId(
        dbRead.answer.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'challenge': {
      const row = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      return row?.createdById ?? null;
    }
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
  entityType: CommentConnectorInput['entityType'];
  entityId: number;
  userId?: number;
  blockedByUsers: number[];
}): Promise<boolean> {
  if (!userId || !blockedByUsers.length) return false;
  const ownerId = await getThreadEntityOwnerId({ entityType, entityId });
  return ownerId === userId;
}

/**
 * Both a cycle backstop and a ceiling on how deep a chain this can resolve. Reaching it is
 * treated as "could not resolve", not as "no lock found" — measured on the 2,000 most recent
 * threads in production the deepest chain is 17 and the mean is 2.65, so no real conversation
 * is near it, and a caller who built one past it must not get a pass out of the guard.
 */
const MAX_THREAD_CHAIN_DEPTH = 100;

/**
 * Every owner-bearing FK on `Thread`. A thread with none of them and no parent comment is an
 * ORPHAN — its parent comment was deleted, and `Thread.commentId` is `onDelete: SetNull`, so the
 * link upward is gone while its replies remain. A column missing from this list turns that
 * entity's threads into apparent orphans and refuses writes on them, so it must stay complete.
 * Kept beside `threadContentSelect` in `block-check.service.ts`, which lists the same columns for
 * the same reason.
 */
const threadIsRooted = (alias: string) => Prisma.sql`num_nonnulls(
  ${Prisma.raw(alias)}."questionId", ${Prisma.raw(alias)}."answerId", ${Prisma.raw(
  alias
)}."imageId",
  ${Prisma.raw(alias)}."postId", ${Prisma.raw(alias)}."reviewId", ${Prisma.raw(alias)}."modelId",
  ${Prisma.raw(alias)}."articleId", ${Prisma.raw(alias)}."bountyId",
  ${Prisma.raw(alias)}."bountyEntryId", ${Prisma.raw(alias)}."clubPostId",
  ${Prisma.raw(alias)}."comicProjectId", ${Prisma.raw(alias)}."challengeId",
  ${Prisma.raw(alias)}."model3dId", ${Prisma.raw(alias)}."model3dReviewId",
  ${Prisma.raw(alias)}."appListingId"
) > 0`;

/**
 * Refuses a write into a locked thread, into any thread nested under one, or into a chain this
 * cannot resolve to a top-level thread.
 *
 * A moderator locks a single `Thread` row, but a reply lives in a child thread of its own, so a
 * check against the target row alone leaves every reply below a locked thread writable. The chain
 * is walked through `Thread.commentId -> CommentV2.threadId`, which is derived from the stored
 * rows; `parentThreadId` is written from request input, so it cannot decide this.
 *
 * 🔴 The walk FAILS CLOSED. `Thread.commentId` is `onDelete: SetNull` and deleting a comment does
 * not clean up the thread hanging off it, so a deleted comment leaves an orphan whose surviving
 * replies have no path back to the entity — 250,071 such threads in production when this was
 * written, 4.6% of all threads. A walk that ends there has not proved the absence of a lock, it has
 * run out of road, and the two are indistinguishable from the recursion alone. Same for hitting the
 * depth cap. Both refuse, with their own message so the refusal is not mistaken for a moderator's.
 *
 * `dbWrite`, deliberately: a lock is read immediately after a moderator sets it, and off the
 * replica that read can still return the pre-lock row.
 */
async function throwIfThreadChainLocked(threadId: number | null | undefined) {
  if (threadId == null) return;
  const [chain] = await dbWrite.$queryRaw<{ locked: boolean | null; unresolved: boolean | null }[]>`
    WITH RECURSIVE chain AS (
      SELECT t.id, t.locked, t."commentId", ${threadIsRooted('t')} AS rooted, 1 AS depth
      FROM "Thread" t
      WHERE t.id = ${threadId}

      UNION ALL

      SELECT p.id, p.locked, p."commentId", ${threadIsRooted('p')} AS rooted, c.depth + 1 AS depth
      FROM chain c
      JOIN "CommentV2" pc ON pc.id = c."commentId"
      JOIN "Thread" p ON p.id = pc."threadId"
      WHERE c.depth < ${MAX_THREAD_CHAIN_DEPTH}
    )
    SELECT
      bool_or(locked) AS locked,
      bool_or(("commentId" IS NULL AND NOT rooted) OR depth >= ${MAX_THREAD_CHAIN_DEPTH})
        AS unresolved
    FROM chain;
  `;
  if (chain?.locked) throw throwBadRequestError('comment thread locked');
  if (chain?.unresolved) throw throwBadRequestError('comment thread is no longer available');
}

export const upsertComment = async ({
  userId,
  entityType,
  entityId,
  parentThreadId,
  isModerator,
  track,
  ...data
}: UpsertCommentV2Input & {
  userId: number;
  isModerator?: boolean;
  track?: Parameters<typeof recordStickerUsage>[0]['track'];
}) => {
  await throwOnBlockedCommentContent(data.content, { isModerator });
  // Edits too, not just creates — a comment written before the block would otherwise stay editable
  // into anything afterwards. An edit resolves its target from the stored comment rather than from
  // `entityType`/`entityId`: those are client-supplied and never checked against the comment being
  // edited, so trusting them here would let the caller pick which block gets enforced.
  if (data.id)
    await throwIfBlockedByOwners({
      userId,
      ownerIds: await getBlockCheckOwnerIdsForComment(data.id),
      isModerator,
    });
  else await throwIfBlockedByEntityOwner({ userId, entityType, entityId, isModerator });
  // The lock is resolved from the row being written. On an edit that is the stored comment's own
  // thread: `entityType`/`entityId` are client-supplied and never checked against the comment, so
  // reading the lock from them lets the caller choose which thread's lock is enforced. On a create
  // it is the thread the comment lands in, plus its ancestors — see `throwIfThreadChainLocked`.
  let thread: { id: number; locked: boolean } | null = null;
  // One read of the row being edited, for both the lock and the sticker charge below.
  let previous: { threadId: number; content: string } | null = null;
  if (data.id) {
    previous = await dbWrite.commentV2.findUnique({
      where: { id: data.id },
      select: { threadId: true, content: true },
    });
    if (!previous) throw throwNotFoundError();
    await throwIfThreadChainLocked(previous.threadId);
  } else {
    thread = await dbWrite.thread.findUnique({
      where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
      select: { id: true, locked: true },
    });
    // A reply's own thread row is created lazily, so on the first reply to a comment there is no
    // thread yet to carry the ancestors — walk from the parent comment's thread instead.
    const anchorThreadId =
      thread?.id ??
      (entityType === 'comment'
        ? (
            await dbWrite.commentV2.findUnique({
              where: { id: entityId },
              select: { threadId: true },
            })
          )?.threadId
        : undefined);
    await throwIfThreadChainLocked(anchorThreadId);
  }

  // An edit that adds stickers must pay for the ones it added, or posting an
  // empty comment and editing stickers in would be free. The spend runs inside
  // the same transaction as the write below — charging in its own transaction
  // would debit uses and then lose the comment to any failure in between.
  const chargeStickers = (tx: Prisma.TransactionClient) =>
    spendStickerUses({
      userId,
      surface: 'comment',
      content: data.content ?? '',
      previousContent: previous?.content ?? '',
      tx,
    });

  if (!data.id) {
    return await dbWrite.$transaction(async (tx) => {
      const chargedStickers = await chargeStickers(tx);
      if (!thread) {
        const parentThread = parentThreadId
          ? await tx.thread.findUnique({ where: { id: parentThreadId } })
          : undefined;

        thread = await tx.thread.create({
          data: {
            [`${entityType}Id`]: entityId,
            parentThreadId: parentThread?.id ?? parentThreadId,
            rootThreadId: parentThread?.rootThreadId ?? parentThread?.id ?? parentThreadId,
          },
          select: { id: true, locked: true, rootThreadId: true, parentThreadId: true },
        });
      }
      const created = await tx.commentV2.create({
        data: {
          userId,
          ...data,
          threadId: thread.id,
        },
        select: commentV2Select,
      });
      recordStickerUsage({
        track,
        userId,
        charged: chargedStickers,
        entityType: 'comment',
        entityId: created.id,
      });
      return created;
    });
  }
  // Wrapped so the edit's charge and the edit itself commit together.
  const { updated, charged } = await dbWrite.$transaction(async (tx) => {
    const chargedStickers = await chargeStickers(tx);
    const row = await tx.commentV2.update({
      where: { id: data.id },
      data,
      select: commentV2Select,
    });
    return { updated: row, charged: chargedStickers };
  });
  recordStickerUsage({
    track,
    userId,
    charged,
    entityType: 'comment',
    entityId: updated.id,
  });
  return updated;
};

export const getComment = async ({ id }: GetByIdInput): Promise<Comment> => {
  const comment = await dbRead.commentV2.findFirst({
    where: { id },
    select: commentV2Select,
  });
  if (!comment) throw throwNotFoundError();
  return comment;
};

export const deleteComment = ({ id }: { id: number }) => {
  return dbWrite.commentV2.delete({ where: { id } });
};

export async function bulkDeleteCommentsV2({ ids }: { ids: number[] }) {
  if (ids.length === 0) return { count: 0 };
  const result = await dbWrite.commentV2.deleteMany({ where: { id: { in: ids } } });
  return { count: result.count };
}

/**
 * Mirror of the legacy `setTosViolationHandler` flow for CommentV2:
 * 1) Set `tosViolation = true`
 * 2) Mark CommentV2Report rows with reason=TOSViolation as Actioned
 * 3) Reward reporters via reportAcceptedReward
 * 4) Send 'tos-violation' notification to comment owner
 */
export async function bulkSetCommentV2TosViolation({
  ids,
  actor,
}: {
  ids: number[];
  actor: { id: number; ip?: string };
}) {
  if (ids.length === 0) return { count: 0, notified: 0, rewardedReports: 0 };

  const { v4: uuid } = await import('uuid');
  const { reportAcceptedReward } = await import('~/server/rewards');
  const { createNotification } = await import('~/server/services/notification.service');
  const { NotificationCategory } = await import('~/server/common/enums');
  const enums = await import('~/shared/utils/prisma/enums');

  let rewardedReports = 0;
  let notified = 0;

  for (const id of ids) {
    const updated = await dbWrite.commentV2
      .update({
        where: { id },
        data: { tosViolation: true },
        select: { id: true, userId: true },
      })
      .catch(() => null);
    if (!updated) continue;

    const reports = await dbWrite.$queryRaw<{ id: number; userId: number }[]>`
      UPDATE "Report" r SET status = ${enums.ReportStatus.Actioned}::"ReportStatus"
      FROM "CommentV2Report" c
      WHERE c."reportId" = r.id
        AND c."commentV2Id" = ${id}
        AND r.reason = ${enums.ReportReason.TOSViolation}::"ReportReason"
        AND r.status <> ${enums.ReportStatus.Actioned}::"ReportStatus"
      RETURNING id, "userId"
    `;
    rewardedReports += reports.length;

    await Promise.allSettled(
      reports.map((report) =>
        reportAcceptedReward.apply({ userId: report.userId, reportId: report.id }, { ip: actor.ip })
      )
    );

    await createNotification({
      userId: updated.userId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:commentv2:${uuid()}`,
      details: { modelName: '', entity: 'comment' },
    })
      .then(() => {
        notified += 1;
      })
      .catch(() => {});
  }

  return { count: ids.length, notified, rewardedReports };
}

export const getCommentCount = async ({ entityId, entityType, hidden }: CommentConnectorInput) => {
  const thread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { commentCount: true },
  });

  return thread?.commentCount ?? 0;
};

// Get thread metadata including hidden comment count - optimized for separate thread meta queries
export async function getCommentsThreadDetails2({
  entityId,
  entityType,
  excludedUserIds = [],
}: CommentConnectorInput & {
  excludedUserIds?: number[];
}): Promise<{ id: number; locked: boolean; hiddenCount: number } | null> {
  const mainThread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true, locked: true },
  });
  if (!mainThread) return null;

  // Get hidden comment count for this thread
  const hiddenCount = await dbRead.commentV2.count({
    where: {
      threadId: mainThread.id,
      userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
      hidden: true,
    },
  });

  return {
    ...mainThread,
    hiddenCount,
  };
}

export const toggleLockCommentsThread = async ({ entityId, entityType }: CommentConnectorInput) => {
  const thread = await dbWrite.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true, locked: true },
  });

  if (!thread) {
    // No thread exists yet — create one in the locked state
    return await dbWrite.thread.create({
      data: {
        [`${entityType}Id`]: entityId,
        locked: true,
      } as unknown as Prisma.ThreadCreateInput,
      select: { locked: true },
    });
  }

  return await dbWrite.thread.update({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    data: { locked: !thread.locked },
    select: { locked: true },
  });
};

export const toggleHideComment = async ({
  id,
  currentToggle,
}: GetByIdInput & { currentToggle: boolean }) => {
  return dbWrite.commentV2.update({
    where: { id },
    data: { hidden: !currentToggle },
  });
};

export async function togglePinComment({ id }: GetByIdInput) {
  const comment = await dbRead.commentV2.findUnique({ where: { id }, select: { pinnedAt: true } });
  if (!comment) throw throwNotFoundError();

  return dbWrite.commentV2.update({
    where: { id },
    data: { pinnedAt: !comment.pinnedAt ? new Date() : null },
  });
}

/**
 * Unified pagination function for comments supporting all sort modes.
 *
 * Uses a single raw SQL query that fetches all comment data including user and reactions,
 * following the pattern from article.service.ts. Dynamic ORDER BY construction and adaptive
 * cursor logic based on sort type.
 *
 * **Sort Modes:**
 * - Oldest: Simple cursor pagination by id ASC
 * - Newest: Simple cursor pagination by id DESC
 * - MostReactions: Keyset pagination by reactionCount DESC, id DESC (composite)
 *
 * **Cursor Strategy:**
 * - For simple sorts (Oldest/Newest): Use id-based cursor (id < cursor or id > cursor)
 * - For composite sorts (MostReactions): Use keyset pagination with reactionCount + id
 *
 * @param threadId - The thread to paginate comments from
 * @param limit - Maximum comments to return
 * @param cursor - Comment ID to paginate from (exclusive)
 * @param sort - Sort mode (Oldest, Newest, MostReactions)
 * @param excludedUserIds - User IDs to filter out (blocked/hidden users)
 * @param hidden - Whether to show hidden comments
 * @returns Array of comments in requested sort order
 */
async function fetchCommentsPaginated({
  threadId,
  limit,
  cursor,
  sort,
  excludedUserIds = [],
  hidden = false,
}: {
  threadId: number;
  limit: number;
  cursor?: number;
  sort: ThreadSort;
  excludedUserIds: number[];
  hidden: boolean | null;
}): Promise<CommentV2Model[]> {
  // Build dynamic ORDER BY based on sort mode
  let orderBy: string;
  switch (sort) {
    case ThreadSort.MostReactions:
      orderBy = 'c."reactionCount" DESC, c.id DESC';
      break;
    case ThreadSort.Newest:
      orderBy = 'c.id DESC';
      break;
    case ThreadSort.Oldest:
    default:
      orderBy = 'c.id ASC';
      break;
  }

  // Build cursor condition based on sort mode
  let cursorCondition = Prisma.empty;
  if (cursor) {
    if (sort === ThreadSort.MostReactions) {
      // For composite sort, use CTE-based keyset pagination
      cursorCondition = Prisma.sql`
        AND EXISTS (
          SELECT 1 FROM "CommentV2" cursor_c 
          WHERE cursor_c.id = ${cursor}
          AND (
            c."reactionCount" < cursor_c."reactionCount"
            OR (c."reactionCount" = cursor_c."reactionCount" AND c.id < ${cursor})
          )
        )
      `;
    } else {
      // For simple sorts (date-based), use simple cursor condition
      const cursorOperator = sort === ThreadSort.Newest ? '<' : '>';
      cursorCondition = Prisma.sql`AND c.id ${Prisma.raw(cursorOperator)} ${cursor}`;
    }
  }

  // Single unified query that fetches all data
  type CommentRaw = {
    id: number;
    content: string;
    createdAt: Date;
    nsfw: boolean;
    tosViolation: boolean;
    hidden: boolean | null;
    threadId: number;
    pinnedAt: Date | null;
    reactionCount: number;
    user: {
      id: number;
      username: string | null;
      deletedAt: Date | null;
      image: string | null;
      profilePicture?: {
        id: number;
        name: string;
        url: string;
        nsfwLevel: NsfwLevel;
        width: number;
        height: number;
        hash: string;
        type: string;
        metadata: ImageMetadata | null;
        ingestion: string | null;
        needsReview: boolean;
      } | null;
      cosmetics: {
        data: string;
        cosmetic: {
          id: number;
          data: string;
          type: string;
          source: string;
          name: string;
        };
      }[];
    };
    reactions: { userId: number; reaction: ReviewReactions }[];
  };

  const comments = await dbRead.$queryRaw<CommentRaw[]>`
    SELECT
      c.id,
      c.content,
      c."createdAt",
      c.nsfw,
      c."tosViolation",
      c.hidden,
      c."threadId",
      c."pinnedAt",
      c."reactionCount",
      jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'deletedAt', u."deletedAt",
        'image', u.image,
        'profilePicture', CASE 
          WHEN pp.id IS NOT NULL THEN jsonb_build_object(
            'id', pp.id,
            'name', pp.name,
            'url', pp.url,
            'nsfwLevel', pp."nsfwLevel",
            'width', pp.width,
            'height', pp.height,
            'hash', pp.hash,
            'type', pp.type,
            'metadata', pp.metadata,
            'ingestion', pp.ingestion,
            'needsReview', pp."needsReview"
          )
          ELSE NULL
        END,
        'cosmetics', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'data', uc.data,
                'cosmetic', jsonb_build_object(
                  'id', cos.id,
                  'data', cos.data,
                  'type', cos.type,
                  'source', cos.source,
                  'name', cos.name
                )
              )
            )
            FROM "UserCosmetic" uc
            JOIN "Cosmetic" cos ON cos.id = uc."cosmeticId"
            WHERE uc."userId" = u.id 
              AND uc."equippedAt" IS NOT NULL 
              AND uc."equippedToId" IS NULL
          ),
          '[]'::jsonb
        )
      ) as "user",
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'userId', r."userId",
              'reaction', r.reaction
            )
          )
          FROM "CommentV2Reaction" r
          WHERE r."commentId" = c.id
        ),
        '[]'::jsonb
      ) as "reactions"
    FROM "CommentV2" c
    JOIN "User" u ON c."userId" = u.id
    LEFT JOIN "Image" pp ON u."profilePictureId" = pp.id
    WHERE
      c."threadId" = ${threadId}
      AND c."pinnedAt" IS NULL
      ${
        excludedUserIds.length
          ? Prisma.sql`AND c."userId" != ALL(${excludedUserIds}::int[])`
          : Prisma.empty
      }
      AND c.hidden = ${hidden}
      ${cursorCondition}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${limit}
  `;

  // Map raw results to CommentV2Model type
  return comments.map((comment) => ({
    ...comment,
    user: comment.user,
    reactions: comment.reactions,
  })) as CommentV2Model[];
}

// Cursor-based infinite pagination for comments
export async function getCommentsInfinite({
  entityId,
  entityType,
  limit = 20,
  sort = ThreadSort.Oldest,
  hidden = false,
  cursor,
  targetCommentId,
  repliesDepth,
  repliesLimit = constants.comments.replyPageSize,
  excludedUserIds = [],
}: GetCommentsInfiniteInput & { excludedUserIds?: number[] }) {
  return withSpan('commentv2:getInfinite', async () => {
    // 1. Get thread metadata
    const mainThread = await dbRead.thread.findUnique({
      where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
      select: { id: true },
    });
    if (!mainThread) return null;

    // 2. Fetch pinned comments (only when no cursor = first page)
    const pinnedComments = !cursor
      ? await dbRead.commentV2.findMany({
          where: {
            threadId: mainThread.id,
            pinnedAt: { not: null },
            userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
            hidden,
          },
          orderBy: { pinnedAt: 'desc' },
          select: commentV2Select,
        })
      : [];

    // 3. Fetch regular comments using unified pagination
    const regularComments = await fetchCommentsPaginated({
      threadId: mainThread.id,
      limit,
      cursor,
      sort,
      excludedUserIds,
      hidden,
    });

    // 4. If a target comment was requested (notification deep-link) and it isn't already
    //    in this first-page batch, fetch it separately so the client can render + scroll
    //    to it without forcing the user to click "Load More" until they hit it.
    let targetComment: CommentV2Model | null = null;
    if (!cursor && targetCommentId) {
      const alreadyIncluded =
        pinnedComments.some((c) => c.id === targetCommentId) ||
        regularComments.some((c) => c.id === targetCommentId);
      if (!alreadyIncluded) {
        const candidate = await dbRead.commentV2.findFirst({
          where: {
            id: targetCommentId,
            threadId: mainThread.id,
            hidden,
            userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
          },
          select: commentV2Select,
        });
        if (candidate) targetComment = candidate as CommentV2Model;
      }
    }

    // 5. Determine next cursor and hasMore
    const nextCursor =
      regularComments.length === limit ? regularComments[regularComments.length - 1].id : undefined;

    const comments = !cursor ? [...pinnedComments, ...regularComments] : regularComments;

    const replies = repliesDepth
      ? await getReplyThreads({
          commentIds: [...comments, ...(targetComment ? [targetComment] : [])].map((x) => x.id),
          depth: repliesDepth,
          limit: repliesLimit,
          budget: constants.comments.autoExpandBudget,
          sort,
          hidden,
          excludedUserIds,
        })
      : { threads: [], childlessCommentIds: [] };

    return {
      comments,
      nextCursor,
      targetComment,
      replyThreads: replies.threads,
      childlessCommentIds: replies.childlessCommentIds,
    };
  });
}
