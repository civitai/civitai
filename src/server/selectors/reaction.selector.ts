import { Prisma } from '@prisma/client';

export const getReactionsSelectV2 = Prisma.validator<Prisma.ImageReactionSelect>()({
  userId: true,
  reaction: true,
});

/**
 * The viewer's own reaction rows on an entity whose counts come from its stats, so the payload carries no other
 * user's reaction. A signed-out viewer gets none.
 */
export function viewerReactionsSelect(userId: number | undefined) {
  return { where: { userId }, take: userId ? undefined : 0, select: getReactionsSelectV2 };
}
