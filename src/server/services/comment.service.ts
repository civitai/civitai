import { Prisma, ReviewReactions } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { getAllCommentsSelect } from '~/server/selectors/comment.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getComments = async <TSelect extends Prisma.CommentSelect>({
  input: { limit = DEFAULT_PAGE_SIZE, page, cursor, modelId, userId, filterBy, sort },
  user,
  select,
  includeNsfw = false,
}: {
  input: GetAllCommentsSchema;
  select: TSelect;
  user?: SessionUser;
  includeNsfw?: boolean;
}) => {
  const skip = page ? (page - 1) * limit : undefined;
  const canViewNsfw = (includeNsfw || user?.showNsfw) ?? env.UNAUTHENTICATE_LIST_NSFW;

  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  return await prisma.comment.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      userId,
      nsfw: canViewNsfw ? (filterBy?.includes(ReviewFilter.NSFW) ? true : undefined) : false,
      reviewId: { equals: null },
      parentId: { equals: null },
    },
    orderBy: {
      createdAt:
        sort === ReviewSort.Oldest ? 'asc' : sort === ReviewSort.Newest ? 'desc' : undefined,
      reactions: sort === ReviewSort.MostLiked ? { _count: 'desc' } : undefined,
      comments: sort === ReviewSort.MostComments ? { _count: 'desc' } : undefined,
    },
    select,
  });
};

export const getCommentById = <TSelect extends Prisma.CommentSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return prisma.comment.findUnique({
    where: { id },
    select,
  });
};

export const getCommentReactions = ({ commentId }: GetCommentReactionsSchema) => {
  return prisma.commentReaction.findMany({
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
  return prisma.commentReaction.findFirst({ where: { reaction, userId, commentId } });
};

export const createOrUpdateComment = async ({
  ownerId,
  ...input
}: CommentUpsertInput & { ownerId: number }) => {
  const { id, ...commentInput } = input;

  return prisma.comment.upsert({
    where: { id: id ?? -1 },
    create: { ...commentInput, userId: ownerId },
    update: { ...commentInput },
    select: {
      id: true,
      modelId: true,
      reviewId: true,
      content: true,
    },
  });
};

export const deleteCommentById = async ({ id }: GetByIdInput) => {
  return await prisma.comment.delete({
    where: { id },
  });
};

export const updateCommentById = ({
  id,
  data,
}: {
  id: number;
  data: Prisma.CommentUpdateInput;
}) => {
  return prisma.comment.update({ where: { id }, data, select: getAllCommentsSelect });
};
