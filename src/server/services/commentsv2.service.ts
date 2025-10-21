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
    user: any; // Will be parsed as JSON
    reactions: any; // Will be parsed as JSON
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
            'nsfw', pp.nsfw,
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
      AND (${excludedUserIds.length} = 0 OR c."userId" NOT IN (${Prisma.join(excludedUserIds)}))
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

  // 3. Fetch regular comments using unified pagination
  const regularComments = await fetchCommentsPaginated({
    threadId: mainThread.id,
    limit,
    cursor,
    sort,
    excludedUserIds,
    hidden,
  });

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
