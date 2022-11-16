import { Prisma } from '@prisma/client';
import { simpleUserSelect } from '~/server/validators/user/simpleUserSelect';

export const getReactionsSelect = Prisma.validator<Prisma.ReviewReactionSelect>()({
  id: true,
  reaction: true,
  user: {
    select: simpleUserSelect,
  },
});

const getReactions = Prisma.validator<Prisma.ReviewReactionArgs>()({
  select: getReactionsSelect,
});

export type ReactionDetails = Prisma.ReviewReactionGetPayload<typeof getReactions>;
