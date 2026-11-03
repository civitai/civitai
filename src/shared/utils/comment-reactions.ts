import { ReviewReactions } from '~/shared/utils/prisma/enums';

/** A comment's per-type reaction counts with nothing counted yet. */
export const emptyReactionCounts = (): Record<ReviewReactions, number> =>
  Object.fromEntries(Object.values(ReviewReactions).map((r) => [r, 0])) as Record<
    ReviewReactions,
    number
  >;
