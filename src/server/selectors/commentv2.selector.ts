import { SessionUser } from 'next-auth';
import { Prisma } from '@prisma/client';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';

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
  user: {
    select: userWithCosmeticsSelect,
  },
  reactions: {
    select: getReactionsSelect,
  },
});

//TODO - come up with a better way of prefetching data and communicating the limits of that prefetched data to the client component
// When I  prefetch relational messages and `take` a number of messages, the client Comments component needs to know the `take` number so that it knows when to display a show more message
export const getRelationalComments = () => {
  return;
};
