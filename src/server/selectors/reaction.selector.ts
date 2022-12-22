import { Prisma } from '@prisma/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const getReactionsSelect = Prisma.validator<Prisma.ReviewReactionSelect>()({
  id: true,
  reaction: true,
  user: {
    select: simpleUserSelect,
  },
});

export type ReactionDetails = Prisma.ReviewReactionGetPayload<typeof getReactions>;
const getReactions = Prisma.validator<Prisma.ReviewReactionArgs>()({
  select: getReactionsSelect,
});

export const reactionSelect = Prisma.validator<Prisma.ReactionSelect>()({
  id: true,
  user: { select: simpleUserSelect },
  like: true,
  dislike: true,
  laugh: true,
  cry: true,
  heart: true,
});
