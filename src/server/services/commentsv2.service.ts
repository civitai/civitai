import {
  commentDetachedSql,
  heldCommentInTreeSql,
  threadDetachedSql,
} from '~/server/services/comment-thread-hold';
import type { GetByIdInput } from './../schema/base.schema';
import type {
  CommentV2Model,
  CommentV2WithCachedUser,
} from '~/server/selectors/commentv2.selector';
import {
  commentV2Select,
  commentV2WithCachedUserSelect,
} from '~/server/selectors/commentv2.selector';
import { recordStickerUsage, spendStickerUses } from '~/server/services/sticker.service';
import {
  MAX_THREAD_CHAIN_DEPTH,
  threadAncestorsCte,
  threadIsRooted,
  UNRESOLVED_THREAD_CHAIN_MESSAGE,
} from '~/server/common/thread-chain';
import { notCommentMuted } from '~/server/notifications/base.notifications';
import { kyselyRead } from '~/server/db/kyselyDb';
import {
  isPrismaForeignKeyViolation,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';
import { dbWrite, dbRead } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { getImageThread } from '@civitai/db-queries/hot-reads';
import type {
  UpsertCommentV2Input,
  CommentConnectorInput,
  GetCommentsInfiniteInput,
  SectionMuteInput,
  ToggleThreadMuteInput,
} from './../schema/commentv2.schema';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import {
  accountHoldSql,
  contentKeptError,
  holdMarkerViewExists,
  isLegalHoldAbort,
  logHoldRetained,
} from '~/server/services/legal-hold.service';
import {
  getBlockCheckOwnerIdsForComment,
  getBlockCheckOwnerIdsForReply,
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
import { CommentEntityType } from '~/shared/utils/prisma/enums';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import { onCommentCreated, onCommentsRemoved } from '~/server/events/points/hooks';
import { getCosmeticsAndProfilePicturesForUsers } from '~/server/services/user.service';

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
  excludedUserIds,
  isModerator = false,
}: {
  commentIds: number[];
  depth: number;
  limit: number;
  budget: number;
  sort: ThreadSort;
  excludedUserIds: number[];
  isModerator?: boolean;
}): Promise<{ threads: ReplyThread<CommentV2WithCachedUser>[]; childlessCommentIds: number[] }> {
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
  const [comments, countGroups] = await Promise.all([
    dbRead.commentV2.findMany({
      where: {
        threadId: { in: threadIds },
        tosViolation: isModerator ? undefined : false,
        userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
      },
      select: commentV2WithCachedUserSelect,
    }),
    // The CTE carries `Thread.commentCount`, which a ToS flag never decrements. This seeds the
    // client's reply count, so it must agree with `getCommentCount`: same predicate, and no
    // viewer-preference exclusion either.
    dbRead.commentV2.groupBy({
      by: ['threadId'],
      where: {
        threadId: { in: threadIds },
        tosViolation: isModerator ? undefined : false,
      },
      _count: { _all: true },
    }),
  ]);

  const commentCounts = Object.fromEntries(
    countGroups.map((group) => [group.threadId, group._count._all])
  );

  const threads = groupReplyThreads({
    threads: selected,
    comments,
    commentCounts,
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
    FROM "CommentV3" c
    WHERE c."entityType" = 'image' AND c."entityId" = ${imageId} AND c."parentId" IS NULL
      AND c."userId" = ${judgeUserId} AND c."deletedAt" IS NULL
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
    case 'crucible':
      return findUserId(
        dbRead.crucible.findUnique({ where: { id: entityId }, select: { userId: true } })
      );
    case 'storyline':
      return findUserId(
        dbRead.storyline.findUnique({ where: { id: entityId }, select: { userId: true } })
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
 * Reaching the cap is treated as "could not resolve", not as "no lock found" — a caller who built a
 * chain past it must not get a pass out of the guard. The number itself, and what production
 * actually holds, live beside the constant.
 */

/**
 * Refuses a write into a locked thread, into any thread nested under one, or into a chain this
 * cannot resolve to a top-level thread.
 *
 * A moderator locks a single `Thread` row, but a reply lives in a child thread of its own, so a
 * check against the target row alone leaves every reply below a locked thread writable. The chain
 * is walked through `Thread.commentId -> CommentV2.threadId`, which is derived from the stored
 * rows; older rows took `parentThreadId` from request input, so it cannot decide this.
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
  if (chain?.unresolved) throw throwBadRequestError(UNRESOLVED_THREAD_CHAIN_MESSAGE);
}

export const upsertComment = async ({
  userId,
  entityType,
  entityId,
  // Destructured to keep it out of `data`; ancestry comes from the parent comment, since the client
  // value can be a stale cached null.
  parentThreadId: _clientParentThreadId,
  isModerator,
  includeHidden,
  track,
  eventPoints = true,
  ...data
}: UpsertCommentV2Input & {
  userId: number;
  isModerator?: boolean;
  // An edit that reaches a comment hidden for ToS (the challenge judge re-reviewing its own). Widens
  // only the edit's target; every content and block check still runs.
  includeHidden?: boolean;
  track?: Parameters<typeof recordStickerUsage>[0]['track'];
  // False for automated accounts (the challenge judge): event points are for people engaging.
  eventPoints?: boolean;
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
  else if (entityType === 'comment')
    await throwIfBlockedByOwners({
      userId,
      ownerIds: await getBlockCheckOwnerIdsForReply(entityId),
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
  let parentCommentThreadId: number | undefined;
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
    if (!thread && entityType === 'comment')
      parentCommentThreadId = (
        await dbWrite.commentV2.findUnique({
          where: { id: entityId },
          select: { threadId: true },
        })
      )?.threadId;
    await throwIfThreadChainLocked(thread?.id ?? parentCommentThreadId);
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
    const created = await dbWrite.$transaction(async (tx) => {
      const chargedStickers = await chargeStickers(tx);
      if (!thread) {
        // A NULL root drops the reply from the notification queries (INNER JOIN on it) and 404s
        // its permalink.
        const parentThread = parentCommentThreadId
          ? await tx.thread.findUnique({
              where: { id: parentCommentThreadId },
              select: { id: true, rootThreadId: true },
            })
          : null;

        try {
          thread = await tx.thread.create({
            data: {
              [`${entityType}Id`]: entityId,
              parentThreadId: parentThread?.id ?? null,
              rootThreadId: parentThread ? parentThread.rootThreadId ?? parentThread.id : null,
            },
            select: { id: true, locked: true, rootThreadId: true, parentThreadId: true },
          });
        } catch (error) {
          // This create carries the FK to the entity being commented on; when that row is gone
          // (a deleted image whose page still rendered a comment box), it rejects with a P2003
          // whose raw constraint name would otherwise reach the user. Scoped to this call so a
          // P2003 from anything else in the transaction is not mislabeled as a missing entity.
          if (isPrismaForeignKeyViolation(error))
            throw throwNotFoundError(`Cannot comment: this ${entityType} no longer exists.`);
          throw error;
        }
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

    queueScamScan({ entityType: 'CommentV2', entityId: created.id });
    if (eventPoints)
      void onCommentCreated({ userId, entityType, entityId, threadId: created.threadId });
    return created;
  }
  // Wrapped so the edit's charge and the edit itself commit together.
  const { updated, charged } = await dbWrite.$transaction(async (tx) => {
    const chargedStickers = await chargeStickers(tx);
    // A member edits only a comment still on the page: one hidden since the read above (an author's
    // delete can keep it that way for a hold) answers as gone, and only a moderator sets the flag.
    const row = await tx.commentV2
      .update({
        where:
          isModerator || includeHidden ? { id: data.id } : { id: data.id, tosViolation: false },
        data: isModerator ? data : { ...data, tosViolation: undefined },
        select: commentV2Select,
      })
      .catch((e: { code?: string }) => {
        throw e?.code === 'P2025' ? throwNotFoundError() : e;
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

  queueScamScan({ entityType: 'CommentV2', entityId: updated.id });
  return updated;
};

export async function toggleThreadMute({
  commentId,
  userId,
}: ToggleThreadMuteInput & { userId: number }) {
  const comment = await dbWrite.commentV2.findUnique({
    where: { id: commentId },
    select: {
      threadId: true,
      tosViolation: true,
      childThread: { select: { id: true } },
    },
  });
  if (!comment) throw throwNotFoundError();
  // A ToS-flagged comment is not visible to a non-moderator, and this endpoint takes a bare id — so
  // without this it doubles as an oracle for whether an id exists and whether it was actioned.
  if (comment.tosViolation) throw throwNotFoundError();

  let threadId = comment.childThread?.id;
  if (!threadId) {
    // Only the CREATE path is gated. Muting an existing thread writes one small row; creating one
    // writes into `Thread`, which is large and heavily indexed, so that is the path worth refusing
    // inside a chain no one may write to.
    await throwIfThreadChainLocked(comment.threadId);
    // A comment's reply thread is created lazily by the first reply, so muting can run before one
    // exists. It must be created with the SAME ancestry `upsertComment` would give it: the reply
    // path finds this row and skips its own create, and a thread left with a null `rootThreadId`
    // drops out of the reply/thread-response notification queries entirely — they INNER JOIN on it.
    const parentThread = await dbWrite.thread.findUnique({
      where: { id: comment.threadId },
      select: { id: true, rootThreadId: true },
    });
    // `upsert`, not `create`: a first mute and a first reply can land on the same comment together
    // and `Thread.commentId` is unique, so the loser of that race would surface a raw constraint
    // error and silently not mute.
    const created = await dbWrite.thread.upsert({
      where: { commentId },
      create: {
        commentId,
        parentThreadId: comment.threadId,
        rootThreadId: parentThread?.rootThreadId ?? comment.threadId,
      },
      update: {},
      select: { id: true },
    });
    threadId = created.id;
  }

  const { count } = await dbWrite.threadMute.deleteMany({ where: { threadId, userId } });
  if (count > 0) return { muted: false, threadId };

  // `createMany({ skipDuplicates })` emits ON CONFLICT DO NOTHING: two concurrent toggles both see
  // no row and both insert, and the loser would surface a raw constraint error over a mute that did
  // apply. Same reason the `Thread` write above is an upsert.
  await dbWrite.threadMute.createMany({ data: [{ threadId, userId }], skipDuplicates: true });
  return { muted: true, threadId };
}

/**
 * The section-level mute: silences a whole comment section rather than one conversation. Its
 * `ThreadMute` on the entity root thread reaches `notCommentMuted` as a `CommentTopicMute` row
 * through the `commentv3_mirror` trigger on `ThreadMute`.
 */
export async function toggleSectionMute({
  entityType,
  entityId,
  userId,
}: SectionMuteInput & { userId: number }) {
  // Deliberately does NOT create the thread. An entity with no thread has no comments, so there is
  // nothing to be notified about and nothing to mute; the first comment creates the thread and the
  // control works from then on. Refusing to create also means this endpoint — which takes a plain
  // entity id — cannot be walked to insert rows into `Thread`.
  const thread = await dbWrite.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true },
  });
  if (!thread) return { muted: false, threadId: null };

  const { count } = await dbWrite.threadMute.deleteMany({ where: { threadId: thread.id, userId } });
  if (count > 0) return { muted: false, threadId: thread.id };

  await dbWrite.threadMute.createMany({
    data: [{ threadId: thread.id, userId }],
    skipDuplicates: true,
  });
  return { muted: true, threadId: thread.id };
}

const isCommentEntityType = (type: string): type is CommentEntityType =>
  (Object.values(CommentEntityType) as string[]).includes(type);

export async function getSectionMuted({
  entityType,
  entityId,
  userId,
}: SectionMuteInput & { userId: number }) {
  const thread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true },
  });
  // `hasThread: false` is not "not muted": the toggle writes a ThreadMute on the root thread, so
  // with no thread nothing can be muted and offering the action would report success over a no-op.
  if (!thread) return { muted: false, hasThread: false };

  // Read what the suppression reads (`CommentTopicMute`), not the `ThreadMute` the toggle writes:
  // the mirror trigger keeps them in step, and if they drift the suppression is what the user
  // experiences. A retired thread type (question, answer) has no topic.
  if (!isCommentEntityType(entityType)) return { muted: false, hasThread: true };
  const mute = await kyselyRead
    .selectFrom('CommentTopicMute')
    .select('userId')
    .where('userId', '=', userId)
    .where('entityType', '=', entityType)
    .where('entityId', '=', entityId)
    .executeTakeFirst();
  return { muted: !!mute, hasThread: true };
}

export async function getThreadMuted({
  commentId,
  userId,
}: ToggleThreadMuteInput & { userId: number }) {
  const comment = await dbRead.commentV2.findUnique({
    where: { id: commentId },
    select: { tosViolation: true, childThread: { select: { id: true } } },
  });
  // Refuses what the toggle refuses; answering for a ToS-removed comment makes this the oracle its
  // neighbour was fixed not to be.
  if (!comment || comment.tosViolation) return { muted: false, viaAncestor: false, canMute: false };

  // The suppression's own predicate (`notCommentMuted`), so the label matches what is delivered:
  // `ancestor` is its verdict on this comment, `own` the user's mute on the comment itself.
  // `dbWrite`, deliberately: the client invalidates this query the moment a toggle succeeds, so off
  // the replica the refetch can return the pre-toggle state — and because the mutation flips from DB
  // state, the next click then does the opposite of what the label says.
  const [row] = await dbWrite.$queryRaw<
    {
      own: boolean | null;
      ancestor: boolean | null;
      locked: boolean | null;
    }[]
  >`
    SELECT
      EXISTS (SELECT 1 FROM "CommentMute" m WHERE m."userId" = u.id AND m."commentId" = c.id) "own",
      NOT ${Prisma.raw(notCommentMuted('u.id', 'c'))} "ancestor",
      (COALESCE((SELECT ct.locked FROM "CommentTopic" ct
                  WHERE ct."entityType" = c."entityType" AND ct."entityId" = c."entityId"), false)
        OR EXISTS (SELECT 1 FROM "CommentV3" lk WHERE lk.path @> c.path AND lk.locked)) "locked"
    FROM "CommentV3" c, (SELECT ${userId}::int AS id) u
    WHERE c.id = ${commentId}
  `;

  const own = row?.own ?? false;
  const ancestor = row?.ancestor ?? false;
  // Muting a comment with no reply thread has to CREATE one, which `throwIfThreadChainLocked`
  // refuses anywhere in a locked chain: the comment, an ancestor or its topic. Answered here rather
  // than from the client's `isLocked`, which is assembled from React nesting and is simply false on
  // a drilled-in or deep-linked thread — the view a reply notification actually opens.
  const canMute = !!comment.childThread || !(row?.locked ?? false);
  return { muted: own || ancestor, viaAncestor: !own && ancestor, canMute };
}

export const getComment = async ({
  id,
  isModerator = false,
}: GetByIdInput & { isModerator?: boolean }): Promise<Comment> => {
  const comment = await dbRead.commentV2.findFirst({
    where: { id, tosViolation: isModerator ? undefined : false },
    select: commentV2Select,
  });
  if (!comment) throw throwNotFoundError();
  return comment;
};

export async function getCommentThreadBounty(
  threadId: number
): Promise<{ bountyId: number } | { entryId: number } | null> {
  const thread = await dbRead.thread.findUnique({
    where: { id: threadId },
    select: {
      bountyId: true,
      bountyEntryId: true,
      rootThread: { select: { bountyId: true, bountyEntryId: true } },
    },
  });
  const bountyId = thread?.bountyId ?? thread?.rootThread?.bountyId;
  if (bountyId) return { bountyId };
  const entryId = thread?.bountyEntryId ?? thread?.rootThread?.bountyEntryId;
  return entryId ? { entryId } : null;
}

export async function getCommentThreadCrucibleId(threadId: number): Promise<number | null> {
  const thread = await dbRead.thread.findUnique({
    where: { id: threadId },
    select: { crucibleId: true, rootThread: { select: { crucibleId: true } } },
  });
  return thread?.crucibleId ?? thread?.rootThread?.crucibleId ?? null;
}

/**
 * The storyline above a thread, as one query. Matches on the stored `commentId -> threadId` chain
 * or on any chain thread's `rootThreadId`: some reply threads have no `rootThreadId`, and a deleted
 * comment breaks the chain, so either alone can miss a storyline and let a reply skip its gate.
 */
const storylineAboveSql = (seed: string) => Prisma.sql`
  ${Prisma.raw(threadAncestorsCte(seed))}
  SELECT th."storylineId"
  FROM (
    SELECT mt."id" FROM thread_ancestors mt
    UNION ALL
    SELECT t."rootThreadId" FROM thread_ancestors mt JOIN "Thread" t ON t.id = mt."id"
  ) chain
  JOIN "Thread" th ON th.id = chain."id"
  WHERE th."storylineId" IS NOT NULL
  LIMIT 1`;

export const storylineOfThreadSql = (threadId: number) =>
  storylineAboveSql(String(Number(threadId)));

export const storylineOfCommentSql = (commentId: number) =>
  storylineAboveSql(`(SELECT c."threadId" FROM "CommentV2" c WHERE c.id = ${Number(commentId)})`);

const firstStorylineId = async (sql: Prisma.Sql) =>
  (await dbRead.$queryRaw<{ storylineId: number }[]>(sql))[0]?.storylineId ?? null;

const isDetached = async (sql: Prisma.Sql) =>
  (await dbRead.$queryRaw<{ detached: boolean }[]>(sql))[0]?.detached === true;

/** Whether a thread was taken off a deleted parent to keep a held author's comment: not public. */
export const isThreadDetached = (threadId: number) => isDetached(threadDetachedSql(threadId));

export const isCommentDetached = (commentId: number) => isDetached(commentDetachedSql(commentId));

/**
 * Whether a member gets the comment as missing: gone, hidden for ToS, or detached. Read on the
 * primary, so a delete just made counts.
 */
export const isCommentGoneForMembers = async (commentId: number) => {
  const row = await dbWrite.commentV2.findUnique({
    where: { id: commentId },
    select: { tosViolation: true },
  });
  return !row || row.tosViolation || (await isCommentDetached(commentId));
};

export const getCommentThreadStorylineId = (threadId: number) =>
  firstStorylineId(storylineOfThreadSql(threadId));

export const getCommentStorylineId = (commentId: number) =>
  firstStorylineId(storylineOfCommentSql(commentId));

/**
 * A comment kept for a hold is hidden for ToS instead, which its author cannot tell from a delete:
 * it goes from every read they get, and its points with it.
 */
export const deleteComment = async ({
  id,
  byAuthor = false,
}: {
  id: number;
  byAuthor?: boolean;
}) => {
  const comment = await dbWrite.commentV2.findUnique({ where: { id } });
  if (!comment) return null;
  const markerView = await holdMarkerViewExists();
  const { deleted, retained } = await dbWrite
    .$transaction((tx) => deleteCommentsV2UnlessHeld(tx, [id], markerView, { byAuthor }))
    .catch((e: unknown) => {
      throw isLegalHoldAbort(e) ? contentKeptError(false) : e;
    });
  if (!deleted.length && !retained.length) return null;
  if (retained.length)
    void logHoldRetained(
      'commentV2.delete',
      retained.map((r) => r.userId)
    ).catch(() => undefined);
  void onCommentsRemoved([comment]);
  return comment;
};

/**
 * The CommentV2 half of the moderator bulk delete (`bulkDeleteComments`), in the caller's
 * transaction. Deleting one sets its reply thread's link null rather than deleting the replies, but
 * an orphaned reply thread does not stay safe, so a comment is also kept while a held author replied
 * anywhere below it. The hold is checked once per author below, not per reply: its cost grows with
 * the number of holding reports.
 */
export async function deleteCommentsV2UnlessHeld(
  tx: Prisma.TransactionClient,
  ids: number[],
  markerView: boolean,
  { byAuthor = false } = {}
) {
  if (ids.length === 0) return { deleted: [], retained: [] };
  const deleted = await tx.$queryRaw<{ userId: number; threadId: number }[]>`
    DELETE FROM "CommentV2" c
    WHERE c.id = ANY(${ids}::int[])
      AND NOT ${accountHoldSql(Prisma.sql`c."userId"`, markerView)}
      AND NOT EXISTS (
        SELECT 1 FROM "Thread" t
        WHERE t."commentId" = c.id AND ${heldCommentInTreeSql(Prisma.raw('t.id'), markerView)}
      )
    RETURNING c."userId", c."threadId"
  `;
  // One its author removed is marked, so a moderator's ToS restore can tell it from a ToS removal.
  const removedByAuthor = byAuthor
    ? Prisma.sql`, metadata = COALESCE(metadata, '{}'::jsonb) || '{"removedByAuthor": true}'::jsonb`
    : Prisma.empty;
  const retained = await tx.$queryRaw<{ userId: number }[]>`
    UPDATE "CommentV2" SET "tosViolation" = true, "updatedAt" = now() ${removedByAuthor}
    WHERE id = ANY(${ids}::int[])
    RETURNING "userId"
  `;
  return { deleted, retained };
}

/** What follows a committed `deleteCommentsV2UnlessHeld`. */
export async function afterCommentsV2Deleted({
  deleted,
  retained,
}: Awaited<ReturnType<typeof deleteCommentsV2UnlessHeld>>) {
  if (retained.length)
    await logHoldRetained(
      'commentV2.bulkDelete',
      retained.map((r) => r.userId)
    );
  void onCommentsRemoved(deleted);
}

/**
 * Mirror of the legacy `setTosViolationHandler` flow for CommentV2:
 * 1) Set `tosViolation = true` — the reads here filter it for non-moderators, which is what takes the
 *    comment off the page. `hidden` does not: it only swaps the comment for a placeholder any
 *    viewer can reveal.
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

  const { reportAcceptedReward } = await import('~/server/rewards');
  const { createNotification } = await import('~/server/services/notification.service');
  const { NotificationCategory } = await import('~/server/common/enums');
  const enums = await import('~/shared/utils/prisma/enums');

  let rewardedReports = 0;
  let notified = 0;
  // Rows written, NOT ids submitted — see the note on the legacy twin in comment.service.ts. A row
  // already hidden counts: its reports are actioned on this pass.
  let count = 0;

  for (const id of ids) {
    // An already-hidden comment may be one its author deleted, kept for a hold: its reports are still
    // actioned, but its author must not hear about a comment they removed.
    const wasHidden = (
      await dbWrite.commentV2.findUnique({ where: { id }, select: { tosViolation: true } })
    )?.tosViolation;
    const updated = await dbWrite.commentV2
      .update({
        where: { id },
        data: { tosViolation: true },
        select: { id: true, userId: true },
      })
      .catch(() => null);
    if (!updated) continue;
    count += 1;

    const reports = await dbWrite.$queryRaw<{ id: number; userId: number }[]>`
      UPDATE "Report" r SET
        status = ${enums.ReportStatus.Actioned}::"ReportStatus",
        "statusSetAt" = now(),
        "statusSetBy" = ${actor.id}
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

    if (wasHidden) continue;
    await createNotification({
      userId: updated.userId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:commentv2:${crypto.randomUUID()}`,
      details: { modelName: '', entity: 'comment' },
    })
      .then(() => {
        notified += 1;
      })
      .catch(() => undefined);
  }

  return { count, notified, rewardedReports };
}

// Counts rows rather than reading `Thread.commentCount`: an INSERT/DELETE trigger maintains that
// counter, so a ToS flag never decrements it and the count keeps advertising a removed comment.
//
// Reached through the thread relation rather than resolving the thread first, so this stays ONE
// round trip. Do not reach for a filtered Prisma `_count` on `Thread` instead: that compiles to an
// uncorrelated aggregate subquery, which seq-scans all of CommentV2 (measured 1.7s on production
// against 0.08ms for this).
export const getCommentCount = async ({
  entityId,
  entityType,
  isModerator = false,
}: CommentConnectorInput & { isModerator?: boolean }) =>
  dbRead.commentV2.count({
    where: {
      thread: { [`${entityType}Id`]: entityId } as Prisma.ThreadWhereInput,
      tosViolation: isModerator ? undefined : false,
    },
  });

export async function getCommentsThreadDetails2({
  entityId,
  entityType,
}: CommentConnectorInput): Promise<{ id: number; locked: boolean } | null> {
  const viaKysely = await readImageThreadViaKysely(entityType, entityId);
  if (viaKysely !== undefined) return viaKysely;
  return dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true, locked: true },
  });
}

/**
 * An IMAGE's thread on the replica through Kysely when `kysely-hot-reads-2` is on: `{ id, locked }`,
 * or `null` when the image has none, exactly as the Prisma `findUnique` answers. `undefined` means
 * "not taken": the flag is off or the entity is not an image, and the caller reads Prisma as before.
 * Only images, the hot shape; every other entity type stays on Prisma.
 */
async function readImageThreadViaKysely(
  entityType: string,
  entityId: number
): Promise<{ id: number; locked: boolean } | null | undefined> {
  if (entityType !== 'image') return undefined;
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_2))) return undefined;
  return (await getImageThread((await loadKyselyDb()).kyselyRead, entityId)) ?? null;
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
 * @returns Array of comments in requested sort order
 */
async function fetchCommentsPaginated({
  threadId,
  limit,
  cursor,
  sort,
  excludedUserIds = [],
  isModerator = false,
}: {
  threadId: number;
  limit: number;
  cursor?: number;
  sort: ThreadSort;
  excludedUserIds: number[];
  isModerator?: boolean;
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
      ${isModerator ? Prisma.empty : Prisma.sql`AND c."tosViolation" = false`}
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
  cursor,
  targetCommentId,
  repliesDepth,
  repliesLimit = constants.comments.replyPageSize,
  excludedUserIds = [],
  isModerator = false,
}: GetCommentsInfiniteInput & { excludedUserIds?: number[]; isModerator?: boolean }) {
  return withSpan('commentv2:getInfinite', async () => {
    // 1. Get thread metadata
    const imageThread = await readImageThreadViaKysely(entityType, entityId);
    const mainThread =
      imageThread !== undefined
        ? imageThread && { id: imageThread.id }
        : await dbRead.thread.findUnique({
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
            tosViolation: isModerator ? undefined : false,
          },
          orderBy: { pinnedAt: 'desc' },
          select: commentV2WithCachedUserSelect,
        })
      : [];

    // 3. Fetch regular comments using unified pagination
    const regularComments = await fetchCommentsPaginated({
      threadId: mainThread.id,
      limit,
      cursor,
      sort,
      excludedUserIds,
      isModerator,
    });

    // 4. If a target comment was requested (notification deep-link) and it isn't already
    //    in this first-page batch, fetch it separately so the client can render + scroll
    //    to it without forcing the user to click "Load More" until they hit it.
    let targetComment: CommentV2WithCachedUser | null = null;
    if (!cursor && targetCommentId) {
      const alreadyIncluded =
        pinnedComments.some((c) => c.id === targetCommentId) ||
        regularComments.some((c) => c.id === targetCommentId);
      if (!alreadyIncluded) {
        const candidate = await dbRead.commentV2.findFirst({
          where: {
            id: targetCommentId,
            threadId: mainThread.id,
            tosViolation: isModerator ? undefined : false,
            userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
          },
          select: commentV2WithCachedUserSelect,
        });
        if (candidate) targetComment = candidate;
      }
    }

    // 5. Determine next cursor and hasMore
    const nextCursor =
      regularComments.length === limit ? regularComments[regularComments.length - 1].id : undefined;

    const commentIds = [
      ...pinnedComments.map((x) => x.id),
      ...regularComments.map((x) => x.id),
      ...(targetComment ? [targetComment.id] : []),
    ];

    const replies = repliesDepth
      ? await getReplyThreads({
          commentIds,
          depth: repliesDepth,
          limit: repliesLimit,
          budget: constants.comments.autoExpandBudget,
          sort,
          excludedUserIds,
          isModerator,
        })
      : { threads: [], childlessCommentIds: [] };

    const replyComments = replies.threads.flatMap((thread) => thread.comments);
    const userCosmetics = await getCosmeticsAndProfilePicturesForUsers(
      [...pinnedComments, ...replyComments, ...(targetComment ? [targetComment] : [])].map(
        (x) => x.user.id
      )
    );
    const withUserCosmetics = (comment: CommentV2WithCachedUser): CommentV2Model => ({
      ...comment,
      user: { ...comment.user, ...userCosmetics(comment.user.id) },
    });

    return {
      comments: [...pinnedComments.map(withUserCosmetics), ...regularComments],
      nextCursor,
      targetComment: targetComment ? withUserCosmetics(targetComment) : null,
      replyThreads: replies.threads.map((thread) => ({
        ...thread,
        comments: thread.comments.map(withUserCosmetics),
      })),
      childlessCommentIds: replies.childlessCommentIds,
    };
  });
}

/**
 * The reverse of `bulkSetCommentV2TosViolation`, and the reason it exists: setting `tosViolation` was a
 * one-way door. Nothing in the main app or the moderator spoke cleared it, there is no comment
 * equivalent of `restoreImages`, and a ban purge can set it across a whole account in one click. So a
 * false positive had no route back at all.
 *
 * Mirrors the forward flow in two of its four steps and deliberately NOT in the other two:
 *
 * 1) `tosViolation = false` — puts the comment back on the page for everyone.
 * 2) Its actioned `TOSViolation` reports go back to `Pending`, which is what the forward action closed.
 *    A report is reopened rather than dismissed: the flag being wrong does not make the report wrong,
 *    and a moderator still has to rule on it.
 *
 * 🔴 3) Rewards are NOT reversed. `reportAcceptedReward` has already paid Buzz to the reporters, and
 *    there is no claw-back — nor should there be, since reporting in good faith is the behaviour being
 *    paid for. Re-actioning later does not double-pay: the reward is keyed on `reportId`.
 * 🔴 4) No notification. The forward action tells the owner their comment broke the rules; there is no
 *    "never mind" equivalent, and inventing one would tell an author their comment was removed at the
 *    moment it is being restored.
 */
export async function bulkClearCommentV2TosViolation({ ids }: { ids: number[] }) {
  if (ids.length === 0) return { count: 0, reopenedReports: 0, retainedHidden: 0 };

  const enums = await import('~/shared/utils/prisma/enums');
  const markerView = await holdMarkerViewExists();

  let reopenedReports = 0;
  // Rows actually cleared, NOT ids submitted — a comment already unflagged must not be counted, or the
  // caller reports a restore that restored nothing.
  let count = 0;
  const retained: number[] = [];
  let retainedHidden = 0;

  for (const id of ids) {
    const outcome = await clearTosOrKeep('CommentV2', id, markerView);
    if (outcome?.held) {
      retainedHidden += 1;
      if (outcome.userId !== null) retained.push(outcome.userId);
    }
    if (!outcome?.cleared) continue;
    count += 1;

    // Only `Actioned` rows: a report someone Dismissed for its own reasons was not closed by this flag,
    // and reopening it would put a ruled-on report back in the queue.
    const reports = await dbWrite.$queryRaw<{ id: number }[]>`
      UPDATE "Report" r SET status = ${enums.ReportStatus.Pending}::"ReportStatus"
      FROM "CommentV2Report" c
      WHERE c."reportId" = r.id
        AND c."commentV2Id" = ${id}
        AND r.reason = ${enums.ReportReason.TOSViolation}::"ReportReason"
        AND r.status = ${enums.ReportStatus.Actioned}::"ReportStatus"
      RETURNING id
    `;
    reopenedReports += reports.length;
  }

  if (retained.length) await logHoldRetained('comment.restoreFromTos', retained);
  return { count, reopenedReports, retainedHidden };
}

/**
 * Whether a held author replied anywhere below the comment aliased `c`: a moderator's delete keeps
 * such a comment, hidden, as it keeps a held author's own.
 */
const heldReplyBelowSql = (table: 'Comment' | 'CommentV2', markerView: boolean) =>
  table === 'Comment'
    ? Prisma.sql`EXISTS (
        WITH RECURSIVE below AS (
          SELECT r.id, r."userId" FROM "Comment" r WHERE r."parentId" = c.id
          UNION
          SELECT r.id, r."userId" FROM "Comment" r JOIN below b ON r."parentId" = b.id
        )
        SELECT 1 FROM below WHERE ${accountHoldSql(Prisma.sql`below."userId"`, markerView)}
      )`
    : Prisma.sql`EXISTS (
        SELECT 1 FROM "Thread" t
        WHERE t."commentId" = c.id AND ${heldCommentInTreeSql(Prisma.raw('t.id'), markerView)}
      )`;

const removedByAuthorSql = {
  Comment: Prisma.sql`c."removedByAuthor"`,
  CommentV2: Prisma.sql`(c.metadata ->> 'removedByAuthor')::boolean`,
};

/**
 * Clears the ToS flag on the flagged comment `id` unless a moderator's delete would keep it: its
 * author, or anyone who replied below it, is held. Such a comment stays hidden. The hold is read in
 * the same statement as the write. Null when there is no such flagged comment, or when its author
 * deleted it: clearing that would republish it.
 */
export async function clearTosUnlessHeld(
  table: 'Comment' | 'CommentV2',
  id: number,
  markerView: boolean
) {
  const [row] = await dbWrite.$queryRaw<{ userId: number; held: boolean; cleared: boolean }[]>`
    WITH target AS (
      SELECT c.id, c."userId",
        (${accountHoldSql(Prisma.raw('c."userId"'), markerView)}
          OR ${heldReplyBelowSql(table, markerView)}) AS held
      FROM ${Prisma.raw(`"${table}"`)} c WHERE c.id = ${id} AND c."tosViolation"
        AND ${removedByAuthorSql[table]} IS NOT TRUE
    ), cleared AS (
      UPDATE ${Prisma.raw(`"${table}"`)} c SET "tosViolation" = false, "updatedAt" = now()
      FROM target t WHERE c.id = t.id AND t.held IS FALSE
      RETURNING c.id
    )
    SELECT t."userId", t.held IS NOT FALSE AS held, EXISTS (SELECT 1 FROM cleared) AS cleared
    FROM target t
  `;
  return row ?? null;
}

/**
 * `clearTosUnlessHeld`, where a statement that fails leaves the comment hidden, as a hold would: the
 * rest of the batch still runs and reports what it did.
 */
export async function clearTosOrKeep(
  table: 'Comment' | 'CommentV2',
  id: number,
  markerView: boolean
) {
  try {
    return await clearTosUnlessHeld(table, id, markerView);
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'comment-tos-restore',
      message: 'Clearing a ToS flag failed; the comment stays hidden',
      details: { table, id, error: (e as Error)?.message },
    }).catch(() => undefined);
    return { userId: null, held: true, cleared: false };
  }
}
