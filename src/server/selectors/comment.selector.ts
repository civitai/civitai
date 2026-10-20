import { Prisma } from '@prisma/client';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import {
  userWithCachedCosmeticsSelect,
  userWithCosmeticsSelect,
} from '~/server/selectors/user.selector';

export const commentDetailSelect = Prisma.validator<Prisma.CommentSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  content: true,
  modelId: true,
  parentId: true,
  locked: true,
  tosViolation: true,
  hidden: true,
  pinnedAt: true,
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
  // Prisma does this in a slow and inefficient way
  // _count: {
  //   select: {
  //     comments: true,
  //   },
  // },
});

/** `getAllCommentsSelect` for a caller that fills the user's cosmetics and profile picture from cache. */
export const getAllCommentsWithCachedUserSelect = Prisma.validator<Prisma.CommentSelect>()({
  ...getAllCommentsSelect,
  user: { select: userWithCachedCosmeticsSelect },
});
