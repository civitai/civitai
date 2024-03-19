import { Prisma } from '@prisma/client';
import { imageSelect } from '~/server/selectors/image.selector';

import { getReactionsSelectV2 } from '~/server/selectors/reaction.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const articleDetailSelect = Prisma.validator<Prisma.ArticleSelect>()({
  id: true,
  createdAt: true,
  nsfwLevel: true,
  userNsfwLevel: true,
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
    select: getReactionsSelectV2,
  },
  stats: {
    select: {
      viewCountAllTime: true,
      commentCountAllTime: true,
      likeCountAllTime: true,
      dislikeCountAllTime: true,
      heartCountAllTime: true,
      laughCountAllTime: true,
      cryCountAllTime: true,
      favoriteCountAllTime: true,
      tippedAmountCountAllTime: true,
    },
  },
  availability: true,
  userId: true,
  coverImage: { select: imageSelect },
  lockedProperties: true,
});
