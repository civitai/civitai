import { Prisma } from '@prisma/client';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const commentDetailSelect = Prisma.validator<Prisma.CommentSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  content: true,
  modelId: true,
  parentId: true,
  reviewId: true,
  locked: true,
  user: {
    select: simpleUserSelect,
  },
  reactions: {
    select: getReactionsSelect,
  },
});

export const getAllCommentsSelect = Prisma.validator<Prisma.CommentSelect>()({
  ...commentDetailSelect,
  _count: {
    select: {
      comments: true,
    },
  },
});
