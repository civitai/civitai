import type { GetByIdInput } from './../schema/base.schema';
import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import { commentV2Select } from '~/server/selectors/commentv2.selector';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import type {
  UpsertCommentV2Input,
  CommentConnectorInput,
  GetCommentsInfiniteInput,
} from './../schema/commentv2.schema';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { constants } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { ThreadSort } from '~/server/common/enums';

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

export const upsertComment = async ({
  userId,
  entityType,
  entityId,
  parentThreadId,
  ...data
}: UpsertCommentV2Input & { userId: number }) => {
  await throwOnBlockedLinkDomain(data.content);
  // only check for threads on comment create
  let thread = await dbWrite.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true, locked: true },
  });

  if (!data.id) {
    return await dbWrite.$transaction(async (tx) => {
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
      return await tx.commentV2.create({
        data: {
          userId,
          ...data,
          threadId: thread.id,
        },
        select: commentV2Select,
      });
    });
  }
  if (thread?.locked) throw throwBadRequestError('comment thread locked');
  return await dbWrite.commentV2.update({ where: { id: data.id }, data, select: commentV2Select });
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

export const getCommentCount = async ({ entityId, entityType, hidden }: CommentConnectorInput) => {
  const thread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { commentCount: true },
  });

  return thread?.commentCount ?? 0;
};

export async function getCommentsThreadDetails2({
  entityId,
  entityType,
  hidden = false,
  excludedUserIds,
}: CommentConnectorInput): Promise<CommentThread | null> {
  const mainThread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: {
      id: true,
      locked: true,
    },
  });
  if (!mainThread) return null;

  const maxDepth = constants.comments.getMaxDepth({ entityType });

  const childThreads = await dbRead.$queryRaw<
    {
      id: number;
      locked: boolean;
      commentId: number | null;
      depth: number;
    }[]
  >`
    WITH RECURSIVE generation AS (
      SELECT
          id,
          "parentThreadId",
          1 AS depth,
          "commentId",
          locked
      FROM "Thread" t
      WHERE t."parentThreadId" = ${mainThread.id}

      UNION ALL

      SELECT
          ct.id,
          ct."parentThreadId",
          depth+1 AS depth,
          ct."commentId",
          ct.locked
      FROM "Thread" ct
      JOIN generation g
        ON g.id = ct."parentThreadId"
    )
    SELECT
      g.id,
      g.locked,
      g."commentId",
      g.depth
    FROM generation g
    JOIN "Thread" t
    ON g."parentThreadId" = t.id
    WHERE depth < ${maxDepth + 1}
    ORDER BY depth;
  `;

  const threadIds = [mainThread.id, ...childThreads.map((x) => x.id)];
  const comments = await dbRead.commentV2.findMany({
    orderBy: { createdAt: 'asc' },
    where: {
      threadId: { in: threadIds },
      userId: excludedUserIds?.length ? { notIn: excludedUserIds } : undefined,
    },
    select: commentV2Select,
  });

  function combineThreadWithComments(thread: {
    id: number;
    locked: boolean;
    commentId?: number | null;
    depth?: number;
  }): CommentThread {
    const allComments = comments.filter(
      (comment) => comment.threadId === thread.id // && !excludedUserIds?.includes(comment.user.id)
    );
    const filtered = allComments.filter((comment) => comment.hidden === hidden);
    const hiddenCount = !hidden ? allComments.length - filtered.length : 0;

    return {
      ...thread,
      depth: thread.depth ?? 0,
      hidden: hiddenCount,
      comments: filtered,
      count: filtered.length,
    };
  }

  const result = {
    ...combineThreadWithComments(mainThread),
    children: childThreads.map(combineThreadWithComments),
  };

  // console.log(result);

  return result;
}

export const toggleLockCommentsThread = async ({ entityId, entityType }: CommentConnectorInput) => {
  const thread = await dbWrite.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true, locked: true },
  });
  if (!thread) throw throwNotFoundError();
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

// Helper function for fetching comments sorted by reaction count
async function fetchByReactionCount({
  threadId,
  limit,
  offset,
  excludedUserIds = [],
  hidden = false,
}: {
  threadId: number;
  limit: number;
  offset: number;
  excludedUserIds: number[];
  hidden: boolean | null;
}) {
  // Step 1: Get sorted comment IDs with reaction counts using raw SQL
  const sortedIds = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT c.id
    FROM "CommentV2" c
    LEFT JOIN "CommentV2Reaction" r
      ON c.id = r."commentId"
      AND (${excludedUserIds.length} = 0 OR r."userId" NOT IN (${Prisma.join(excludedUserIds)}))
    WHERE
      c."threadId" = ${threadId}
      AND c."pinnedAt" IS NULL
      AND (${excludedUserIds.length} = 0 OR c."userId" NOT IN (${Prisma.join(excludedUserIds)}))
      AND c.hidden = ${hidden}
    GROUP BY c.id
    ORDER BY COUNT(r.id) DESC, c.id DESC
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `;

  const hasMore = sortedIds.length > limit;
  const ids = (hasMore ? sortedIds.slice(0, limit) : sortedIds).map((x) => x.id);

  // Step 2: Fetch full comments with relations using Prisma
  const comments = await dbRead.commentV2.findMany({
    where: { id: { in: ids } },
    select: commentV2Select,
  });

  // Step 3: Maintain sort order from the query
  const commentMap = new Map(comments.map((c) => [c.id, c]));
  const sortedComments = ids.map((id) => commentMap.get(id)).filter(isDefined);

  return { comments: sortedComments, hasMore };
}

// Helper function for cursor-based reaction sorting
async function fetchByReactionCountCursor({
  threadId,
  limit,
  cursor,
  excludedUserIds = [],
  hidden = false,
}: {
  threadId: number;
  limit: number;
  cursor?: number;
  excludedUserIds: number[];
  hidden: boolean | null;
}) {
  // Use strict < for cursor to avoid duplication
  const cursorCondition = cursor ? Prisma.sql`AND c.id < ${cursor}` : Prisma.empty;

  const sortedIds = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT c.id
    FROM "CommentV2" c
    LEFT JOIN "CommentV2Reaction" r
      ON c.id = r."commentId"
      AND (${excludedUserIds.length} = 0 OR r."userId" NOT IN (${Prisma.join(excludedUserIds)}))
    WHERE
      c."threadId" = ${threadId}
      AND c."pinnedAt" IS NULL
      AND (${excludedUserIds.length} = 0 OR c."userId" NOT IN (${Prisma.join(excludedUserIds)}))
      AND c.hidden = ${hidden}
      ${cursorCondition}
    GROUP BY c.id
    ORDER BY COUNT(r.id) DESC, c.id DESC
    LIMIT ${limit}
  `;

  const ids = sortedIds.map((x) => x.id);

  if (ids.length === 0) return [];

  const comments = await dbRead.commentV2.findMany({
    where: { id: { in: ids } },
    select: commentV2Select,
  });

  const commentMap = new Map(comments.map((c) => [c.id, c]));
  return ids.map((id) => commentMap.get(id)).filter(isDefined);
}

// Cursor-based infinite pagination for comments
export async function getCommentsInfinite({
  entityId,
  entityType,
  limit = 20,
  sort = ThreadSort.Oldest,
  hidden = false,
  cursor,
  excludedUserIds = [],
}: GetCommentsInfiniteInput & { excludedUserIds?: number[] }) {
  // 1. Get thread metadata
  const mainThread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: { id: true, locked: true },
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

  // 3. Fetch regular comments with cursor
  let regularComments: CommentV2Model[];

  if (sort === ThreadSort.MostReactions) {
    // Use cursor-based reaction sorting
    regularComments = await fetchByReactionCountCursor({
      threadId: mainThread.id,
      limit,
      cursor,
      excludedUserIds,
      hidden,
    });
  } else {
    // Use Prisma for date-based sorting with cursor
    const orderBy: Prisma.CommentV2OrderByWithRelationInput[] =
      sort === ThreadSort.Newest
        ? [{ id: 'desc' }] // Use id DESC for newest (maintains consistency with createdAt)
        : [{ id: 'asc' }]; // Use id ASC for oldest

    const allComments = await dbRead.commentV2.findMany({
      where: {
        threadId: mainThread.id,
        pinnedAt: null,
        userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
        hidden,
      },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0, // Skip the cursor item to avoid duplication
      orderBy,
      take: limit,
      select: commentV2Select,
    });

    regularComments = allComments;
  }

  // 4. Determine next cursor and hasMore
  const nextCursor =
    regularComments.length === limit ? regularComments[regularComments.length - 1].id : undefined;

  // 5. Get counts (only on first page for performance)
  const hiddenCount = !cursor
    ? await dbRead.commentV2.count({
        where: {
          threadId: mainThread.id,
          userId: excludedUserIds.length ? { notIn: excludedUserIds } : undefined,
          hidden: true,
        },
      })
    : undefined;

  return {
    comments: !cursor ? [...pinnedComments, ...regularComments] : regularComments.slice(0, limit),
    nextCursor,
    threadMeta: mainThread,
    hiddenCount: hiddenCount ?? 0,
  };
}
