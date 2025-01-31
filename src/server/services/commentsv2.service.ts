import { GetByIdInput } from './../schema/base.schema';
import { CommentV2Model, commentV2Select } from '~/server/selectors/commentv2.selector';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import { UpsertCommentV2Input, CommentConnectorInput } from './../schema/commentv2.schema';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';

export type CommentThread = {
  id: number;
  locked: boolean;
  commentId?: number | null;
  comments?: Comment[];
  _count?: { comments: number };
};

export type Comment = Omit<CommentV2Model, 'childThread'> & {
  childThread?: CommentThread | null;
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
    select: { ...commentV2Select, thread: true },
  });
  if (!comment) throw throwNotFoundError();
  const childThread = await dbRead.thread.findFirst({
    where: { commentId: comment.id },
    select: {
      id: true,
      locked: true,
      _count: {
        select: {
          comments: true,
        },
      },
    },
  });
  return { ...comment, childThread: childThread ?? undefined };
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
}: CommentConnectorInput) {
  console.time('getCommentsThreadDetails2');
  const mainThread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: {
      id: true,
      locked: true,
    },
  });
  if (!mainThread) throw throwNotFoundError();

  const childThreads = await dbRead.thread.findMany({
    where: { rootThreadId: mainThread.id },
    select: {
      id: true,
      locked: true,
      commentId: true,
    },
  });

  const threadIds = [mainThread.id, ...childThreads.map((x) => x.id)];
  const comments = await dbRead.commentV2.findMany({
    orderBy: { createdAt: 'asc' },
    where: {
      threadId: { in: threadIds },
      hidden,
      userId: excludedUserIds?.length ? { notIn: excludedUserIds } : undefined,
    },
    select: commentV2Select,
  });

  function combineThreadWithComments(rootThread: {
    id: number;
    locked: boolean;
    commentId?: number | null;
  }): CommentThread {
    const filtered = comments.filter((comment) => comment.threadId === rootThread.id);

    return {
      ...rootThread,
      _count: filtered.length ? { comments: comments.length } : undefined,
      comments: filtered.map((comment) => {
        const childThread = childThreads.find((x) => x.commentId === comment.id);
        return {
          ...comment,
          childThread: childThread ? combineThreadWithComments(childThread) : undefined,
        };
      }),
    };
  }

  const result = combineThreadWithComments(mainThread);
  console.timeEnd('getCommentsThreadDetails2');

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
