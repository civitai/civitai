import { Prisma } from '@prisma/client';

import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const articleDetailSelect = Prisma.validator<Prisma.ArticleSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  content: true,
  cover: true,
  updatedAt: true,
  title: true,
  publishedAt: true,
  tags: { select: { tag: { select: simpleTagSelect } } },
  user: {
    select: userWithCosmeticsSelect,
  },
  reactions: {
    select: getReactionsSelect,
  },
});
