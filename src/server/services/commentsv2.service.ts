import { GetByIdInput } from './../schema/base.schema';
import { CommentV2Model, commentV2Select } from '~/server/selectors/commentv2.selector';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import { UpsertCommentV2Input, CommentConnectorInput } from './../schema/commentv2.schema';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { constants } from '~/server/common/constants';

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
  return await dbRead.commentV2.count({
    where: {
      thread: {
        [`${entityType}Id`]: entityId,
      },
      hidden,
    },
  });
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
      (comment) => comment.threadId === thread.id && !excludedUserIds?.includes(comment.user.id)
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
