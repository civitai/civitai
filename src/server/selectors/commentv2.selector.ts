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

export const getRelationalComments = () => {
  return;
};
