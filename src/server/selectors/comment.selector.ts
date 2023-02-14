import { Prisma } from '@prisma/client';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const commentDetailSelect = Prisma.validator<Prisma.CommentSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  content: true,
  modelId: true,
  parentId: true,
  reviewId: true,
  locked: true,
  tosViolation: true,
  user: {
    select: userWithCosmeticsSelect,
  },
  reactions: {
    select: getReactionsSelect,
  },
  model: { select: { name: true } },
});

export const getAllCommentsSelect = Prisma.validator<Prisma.CommentSelect>()({
  ...commentDetailSelect,
  _count: {
    select: {
      comments: true,
    },
  },
});
