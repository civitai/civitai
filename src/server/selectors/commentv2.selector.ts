import { Prisma } from '@prisma/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const commentV2Select = Prisma.validator<Prisma.CommentV2Select>()({
  id: true,
  createdAt: true,
  nsfw: true,
  tosViolation: true,
  content: true,
  parentId: true,
  user: {
    select: simpleUserSelect,
  },
  // comments: {
  //   select: // TODO - child comments??? how many layers will we support?
  // },
  // reactions: {
  //   select: //TODO - reactionSelect or totalReactionSelect???
  // },
});

//TODO - come up with a better way of prefetching data and communicating the limits of that prefetched data to the client component
// When I  prefetch relational messages and `take` a number of messages, the client Comments component needs to know the `take` number so that it knows when to display a show more message
export const getRelationalComments = () => {
  return;
};
