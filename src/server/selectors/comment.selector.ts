import { Prisma } from '@prisma/client';

import { simpleUserSelect } from '~/server/selectors/user.selector';

export const getAllCommentsSelect = Prisma.validator<Prisma.CommentSelect>()({
  id: true,
  createdAt: true,
  nsfw: true,
  content: true,
  modelId: true,
  user: {
    select: simpleUserSelect,
  },
  _count: { select: { comments: true } },
});
