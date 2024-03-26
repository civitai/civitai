import { Prisma, ReportReason, ReportStatus, ReviewReactions } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';

import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { dbWrite, dbRead } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import { userMetrics } from '~/server/metrics';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentCountByModelInput,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { getAllCommentsSelect } from '~/server/selectors/comment.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { HiddenUsers } from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getComments = async <TSelect extends Prisma.CommentSelect>({
  input: {
    limit = DEFAULT_PAGE_SIZE,
    page,
    cursor,
    modelId,
    userId,
    filterBy,
    sort,
    hidden = false,
  },
  select,
  user,
}: {
  input: GetAllCommentsSchema;
  select: TSelect;
  user?: SessionUser;
}) => {
  const skip = page ? (page - 1) * limit : undefined;
  const isMod = user?.isModerator ?? false;
  // const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;

  const excludedUserIds = (await HiddenUsers.getCached({ userId: user?.id })).map((x) => x.id);

  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  const db = await getDbWithoutLag('commentModel', modelId);
  const comments = await db.comment.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      userId: userId ? userId : excludedUserIds ? { notIn: excludedUserIds } : undefined,
      parentId: { equals: null },
      tosViolation: !isMod ? false : undefined,
      hidden,
      // OR: [
      //   {
      //     userId: { not: user?.id },
      //     nsfw: canViewNsfw ? (filterBy?.includes(ReviewFilter.NSFW) ? true : undefined) : false,
      //   },
      //   { userId: user?.id },
      // ],
    },
    orderBy: {
      createdAt:
        sort === ReviewSort.Oldest ? 'asc' : sort === ReviewSort.Newest ? 'desc' : undefined,
      reactions: sort === ReviewSort.MostLiked ? { _count: 'desc' } : undefined,
      comments: sort === ReviewSort.MostComments ? { _count: 'desc' } : undefined,
    },
    select,
  });

  return comments;
};

export const getCommentById = <TSelect extends Prisma.CommentSelect>({
  id,
  select,
  user,
}: GetByIdInput & { select: TSelect; user?: SessionUser }) => {
  const isMod = user?.isModerator ?? false;

  return dbRead.comment.findFirst({
    where: {
      id,
      tosViolation: !isMod ? false : undefined,
      model: isMod
        ? undefined
        : { OR: [{ status: 'Published' }, { userId: user?.id }], locked: false },
    },
    select,
  });
};

export const getCommentReactions = ({ commentId }: GetCommentReactionsSchema) => {
  return dbRead.commentReaction.findMany({
    where: { commentId },
    select: getReactionsSelect,
  });
};

export const getUserReactionByCommentId = ({
  reaction,
  userId,
  commentId,
}: {
  reaction: ReviewReactions;
  userId: number;
  commentId: number;
}) => {
  return dbRead.commentReaction.findFirst({ where: { reaction, userId, commentId } });
};

export const createOrUpdateComment = async ({
  ownerId,
  ...input
}: CommentUpsertInput & { ownerId: number; locked: boolean }) => {
  const { id, locked, ...commentInput } = input;

  // If we are editing, but the comment is locked
  // prevent from updating
  if (id && locked)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This comment is locked and cannot be updated',
    });

  const result = await dbWrite.comment.upsert({
    where: { id: id ?? -1 },
    create: { ...commentInput, userId: ownerId },
    update: { ...commentInput },
    select: {
      id: true,
      modelId: true,
      content: true,
      nsfw: true,
    },
  });
  await preventReplicationLag('commentModel', input.modelId);
  return result;
};

export const toggleHideComment = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator: boolean }) => {
  const AND = [Prisma.sql`c.id = ${id}`];
  // Only comment owner, model owner, or moderator can hide comment
  if (!isModerator) AND.push(Prisma.sql`(m."userId" = ${userId} OR c."userId" = ${userId})`);

  const [comment] = await dbWrite.$queryRaw<{ hidden: boolean; modelId: number }[]>`
    SELECT
      c.hidden, c."modelId"
    FROM "Comment" c
    JOIN "Model" m ON m.id = c."modelId"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  if (!comment) throw throwNotFoundError(`You don't have permission to hide this comment`);
  const hidden = comment.hidden;

  await dbWrite.comment.updateMany({
    where: { id },
    data: { hidden: !hidden },
  });
  await preventReplicationLag('commentModel', comment.modelId);
};

export const deleteCommentById = async ({ id }: GetByIdInput) => {
  const { modelId, model } =
    (await dbWrite.comment.findUnique({
      where: { id },
      select: { modelId: true, model: { select: { userId: true } } },
    })) ?? {};

  const deleted = await dbWrite.comment.delete({ where: { id } });
  if (!deleted) throw throwNotFoundError(`No comment with id ${id}`);
  await preventReplicationLag('commentModel', modelId);

  if (model?.userId) await userMetrics.queueUpdate(model.userId);

  return deleted;
};

export const updateCommentById = async ({
  id,
  data,
}: {
  id: number;
  data: Prisma.CommentUpdateInput;
}) => {
  const results = await dbWrite.comment.update({
    where: { id },
    data,
    select: getAllCommentsSelect,
  });
  await preventReplicationLag('commentModel', results.modelId);
  return results;
};

export const updateCommentReportStatusByReason = ({
  id,
  reason,
  status,
}: {
  id: number;
  reason: ReportReason;
  status: ReportStatus;
}) => {
  return dbWrite.report.updateMany({
    where: { reason, comment: { commentId: id } },
    data: { status },
  });
};

export const getCommentCountByModel = ({
  modelId,
  hidden = false,
}: GetCommentCountByModelInput) => {
  return dbRead.comment.count({ where: { modelId, hidden } });
};
