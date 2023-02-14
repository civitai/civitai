import { Prisma } from '@prisma/client';
import { prisma } from '~/server/db/client';
import {
  UpsertCommentV2Input,
  GetCommentsV2Input,
  CommentConnectorInput,
} from './../schema/commentv2.schema';

export const upsertComment = async ({
  userId,
  entityType,
  entityId,
  ...data
}: UpsertCommentV2Input & { userId: number }) => {
  // only check for threads on comment create
  if (!data.id) {
    let thread = await prisma.thread.findUnique({
      where: { [`${entityType}Id`]: entityId },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      if (!thread) {
        thread = await tx.thread.create({
          data: { [`${entityType}Id`]: entityId },
          select: { id: true },
        });
      }
      return await tx.commentV2.create({
        data: {
          userId,
          ...data,
          threadId: thread.id,
        },
      });
    });
  }

  return await prisma.commentV2.update({ where: { id: data.id }, data });
};

export const getComments = async <TSelect extends Prisma.CommentV2Select>({
  entityType,
  entityId,
  limit,
  cursor,
  select,
}: GetCommentsV2Input & {
  select: TSelect;
}) => {
  const take = limit ?? 20;

  return await prisma.commentV2.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      thread: { [`${entityType}Id`]: entityId },
    },
    orderBy: {
      createdAt: 'asc',
    },
    select,
  });
};

export const deleteComment = async ({ id }: { id: number }) => {
  await prisma.commentV2.delete({ where: { id } });
};

export const getCommentCount = async ({ entityId, entityType }: CommentConnectorInput) => {
  return await prisma.commentV2.count({
    where: {
      thread: {
        [`${entityType}Id`]: entityId,
      },
    },
  });
};
