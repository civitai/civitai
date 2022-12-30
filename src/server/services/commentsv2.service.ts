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
  return !data.id
    ? await prisma.commentV2.create({
        data: {
          userId,
          ...data,
          [entityType]: {
            create: {
              [entityType]: {
                connect: { id: entityId },
              },
            },
          },
        },
      })
    : await prisma.commentV2.update({ where: { id: data.id }, data });
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
      [entityType]: {
        [`${entityType}Id`]: entityId,
      },
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
      [entityType]: {
        [`${entityType}Id`]: entityId,
      },
    },
  });
};
