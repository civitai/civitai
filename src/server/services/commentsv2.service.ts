import { GetByIdInput } from './../schema/base.schema';
import { commentV2Select } from '~/server/selectors/commentv2.selector';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import {
  UpsertCommentV2Input,
  GetCommentsV2Input,
  CommentConnectorInput,
} from './../schema/commentv2.schema';
import { CommentV2Sort } from '~/server/common/enums';

export const upsertComment = async ({
  userId,
  entityType,
  entityId,
  ...data
}: UpsertCommentV2Input & { userId: number }) => {
  // only check for threads on comment create
  let thread = await dbWrite.thread.findUnique({
    where: { [`${entityType}Id`]: entityId },
    select: { id: true, locked: true },
  });
  if (!data.id) {
    return await dbWrite.$transaction(async (tx) => {
      if (!thread) {
        thread = await tx.thread.create({
          data: { [`${entityType}Id`]: entityId },
          select: { id: true, locked: true },
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

export const getComment = async ({ id }: GetByIdInput) => {
  const comment = await dbRead.commentV2.findFirst({
    where: { id },
    select: { ...commentV2Select, thread: true },
  });
  if (!comment) throw throwNotFoundError();
  return comment;
};

export const getComments = async <TSelect extends Prisma.CommentV2Select>({
  entityType,
  entityId,
  limit,
  cursor,
  select,
  sort,
  excludedUserIds,
}: GetCommentsV2Input & {
  select: TSelect;
  excludedUserIds?: number[];
}) => {
  const orderBy: Prisma.Enumerable<Prisma.CommentV2OrderByWithRelationInput> = [];
  if (sort === CommentV2Sort.Newest) orderBy.push({ createdAt: 'desc' });
  else orderBy.push({ createdAt: 'asc' });

  return await dbRead.commentV2.findMany({
    take: limit,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      thread: { [`${entityType}Id`]: entityId },
      userId: excludedUserIds?.length ? { notIn: excludedUserIds } : undefined,
    },
    orderBy,
    select,
  });
};

export const deleteComment = async ({ id }: { id: number }) => {
  await dbWrite.commentV2.delete({ where: { id } });
};

export const getCommentCount = async ({ entityId, entityType }: CommentConnectorInput) => {
  return await dbRead.commentV2.count({
    where: {
      thread: {
        [`${entityType}Id`]: entityId,
      },
    },
  });
};

export const getCommentsThreadDetails = async ({ entityId, entityType }: CommentConnectorInput) => {
  return await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId },
    select: {
      id: true,
      locked: true,
      comments: { select: commentV2Select },
    },
  });
};

export const toggleLockCommentsThread = async ({ entityId, entityType }: CommentConnectorInput) => {
  const thread = await dbWrite.thread.findUnique({
    where: { [`${entityType}Id`]: entityId },
    select: { id: true, locked: true },
  });
  if (!thread) throw throwNotFoundError();
  return await dbWrite.thread.update({
    where: { [`${entityType}Id`]: entityId },
    data: { locked: !thread.locked },
    select: { locked: true },
  });
};
