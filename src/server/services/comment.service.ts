import { Prisma, ReportReason, ReportStatus, ReviewReactions } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';

import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { dbWrite, dbRead } from '~/server/db/client';
import { modelMetrics, userMetrics } from '~/server/metrics';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentCountByModelInput,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { getAllCommentsSelect } from '~/server/selectors/comment.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { getHiddenUsersForUser } from '~/server/services/user-cache.service';
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

  const excludedUserIds = await getHiddenUsersForUser({ userId: user?.id });

  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  const comments = await dbRead.comment.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      userId: userId ? userId : excludedUserIds ? { notIn: excludedUserIds } : undefined,
      reviewId: { equals: null },
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

export const createOrUpdateComment = ({
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

  return dbWrite.comment.upsert({
    where: { id: id ?? -1 },
    create: { ...commentInput, userId: ownerId },
    update: { ...commentInput },
    select: {
      id: true,
      modelId: true,
      reviewId: true,
      content: true,
      nsfw: true,
    },
  });
};

export const deleteCommentById = async ({ id }: GetByIdInput) => {
  const { modelId, model } =
    (await dbWrite.comment.findUnique({
      where: { id },
      select: { modelId: true, model: { select: { userId: true } } },
    })) ?? {};

  const deleted = await dbWrite.comment.delete({ where: { id } });
  if (!deleted) throw throwNotFoundError(`No comment with id ${id}`);

  if (model?.userId) await userMetrics.queueUpdate(model.userId);

  return deleted;
};

export const updateCommentById = ({
  id,
  data,
}: {
  id: number;
  data: Prisma.CommentUpdateInput;
}) => {
  return dbWrite.comment.update({ where: { id }, data, select: getAllCommentsSelect });
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
