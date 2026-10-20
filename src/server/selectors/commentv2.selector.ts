import { Prisma } from '@prisma/client';
import { getReactionsSelectV2 } from '~/server/selectors/reaction.selector';
import {
  userWithCachedCosmeticsSelect,
  userWithCosmeticsSelect,
} from '~/server/selectors/user.selector';

/*
  TODO.comments - connections? (ie. imageId, reviewId, versionId, modelId)
  - comment connections will be difficult until we can manage to convert all comments to the commentv2 model
*/

// TODO.comments - optional reactions?
export const commentV2Select = Prisma.validator<Prisma.CommentV2Select>()({
  id: true,
  createdAt: true,
  nsfw: true,
  tosViolation: true,
  content: true,
  hidden: true,
  threadId: true,
  pinnedAt: true,
  reactionCount: true,
  user: {
    select: userWithCosmeticsSelect,
  },
  reactions: {
    select: getReactionsSelectV2,
  },
});

export type CommentV2Model = Prisma.CommentV2GetPayload<typeof commentV2>;
const commentV2 = Prisma.validator<Prisma.CommentV2FindManyArgs>()({ select: commentV2Select });

/** `commentV2Select` for a read that fills the user's cosmetics and profile picture from cache. */
export const commentV2WithCachedUserSelect = Prisma.validator<Prisma.CommentV2Select>()({
  ...commentV2Select,
  user: { select: userWithCachedCosmeticsSelect },
});
export type CommentV2WithCachedUser = Prisma.CommentV2GetPayload<{
  select: typeof commentV2WithCachedUserSelect;
}>;

//TODO - come up with a better way of prefetching data and communicating the limits of that prefetched data to the client component
// When I  prefetch relational messages and `take` a number of messages, the client Comments component needs to know the `take` number so that it knows when to display a show more message
export const getRelationalComments = () => {
  return;
};
