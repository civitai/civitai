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
import { constants } from '../common/constants';

export const upsertComment = async ({
  userId,
  entityType,
  entityId,
  parentThreadId,
  ...data
}: UpsertCommentV2Input & { userId: number }) => {
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
  hidden = false,
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
      hidden,
    },
    orderBy,
    select,
  });
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

export const getCommentsThreadDetails = async ({
  entityId,
  entityType,
  hidden = false,
}: CommentConnectorInput) => {
  const mainThread = await dbRead.thread.findUnique({
    where: { [`${entityType}Id`]: entityId } as unknown as Prisma.ThreadWhereUniqueInput,
    select: {
      id: true,
      locked: true,
      rootThreadId: true,
      comments: {
        orderBy: { createdAt: 'asc' },
        where: { hidden },
        select: commentV2Select,
      },
    },
  });

  if (!mainThread) return null;

  type ChildThread = {
    id: number;
    parentThreadId: number | null;
    generation: number;
  };

  const childThreadHierarchy = await dbRead.$queryRaw<ChildThread[]>`
    WITH RECURSIVE generation AS (
      SELECT id,
          "parentThreadId",
          1 AS "generationNumber"
      FROM "Thread" t
      WHERE t."parentThreadId" = ${mainThread?.id}

      UNION ALL

      SELECT "childThread".id,
          "childThread"."parentThreadId",
          "generationNumber"+1 AS "generationNumber"
      FROM "Thread" "childThread"
      JOIN generation g
        ON g.id = "childThread"."parentThreadId"
    )
    SELECT
      g.id,
      g."generationNumber" as "generation",
      "parentThread".id as "parentThreadId"
    FROM generation g
    JOIN "Thread" "parentThread"
    ON g."parentThreadId" = "parentThread".id
    WHERE "generationNumber" < ${
      `${entityType}MaxDepth` in constants.comments
        ? constants.comments[`${entityType}MaxDepth` as keyof typeof constants.comments]
        : constants.comments.maxDepth
    }
    ORDER BY "generationNumber";
  `;

  const childThreadIds = childThreadHierarchy.map((c) => c.id);
  const children = childThreadIds?.length
    ? await dbRead.thread.findMany({
        where: { id: { in: childThreadIds } },
        select: {
          id: true,
          locked: true,
          commentId: true, // All children are for comments.
          rootThreadId: true,
          comments: {
            orderBy: { createdAt: 'asc' },
            where: { hidden },
            select: commentV2Select,
          },
        },
      })
    : [];

  return {
    ...mainThread,
    children: children.map((c) => ({
      ...c,
      // So that we can keep typescript happy when setting the data on TRPC.
      children: [],
    })),
  };
};

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
