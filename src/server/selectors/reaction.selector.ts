import { Prisma } from '@prisma/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const getReactionsSelect = Prisma.validator<Prisma.CommentReactionSelect>()({
  id: true,
  reaction: true,
  user: {
    select: simpleUserSelect,
  },
});

export const getReactionsSelectV2 = Prisma.validator<Prisma.CommentReactionSelect>()({
  userId: true,
  reaction: true,
});

export type ReactionDetails = Prisma.CommentReactionGetPayload<typeof getReactions>;
const getReactions = Prisma.validator<Prisma.CommentReactionArgs>()({
  select: getReactionsSelect,
});
