import { Prisma } from '@prisma/client';

/**
 * Comment reactions only ever need to name the reactor.
 *
 * The renderer (`ReactionPicker`) reads `user.username` for the "who reacted"
 * tooltip and `user.id` to decide whether the viewer already reacted — nothing
 * else. Selecting the full `simpleUserSelect` here dragged in `deletedAt` and,
 * worse, the whole `profilePicture` Image relation, whose `metadata` is a
 * non-null `Json` column. Prisma decodes tagged values on the JS main thread,
 * so that was a `JSON.parse` plus a `new Date()` for every reaction on every
 * comment of every page — for two strings that are never rendered.
 *
 * The deleted-user case still works: `deleteUser` nulls `username`, and the
 * renderer already falls back on `username ?? '<deleted user>'`, so it reads
 * the null rather than the timestamp.
 */
export const getReactionsSelect = Prisma.validator<Prisma.CommentReactionSelect>()({
  id: true,
  reaction: true,
  user: {
    select: { id: true, username: true },
  },
});

export const getReactionsSelectV2 = Prisma.validator<Prisma.CommentReactionSelect>()({
  userId: true,
  reaction: true,
});

export type ReactionDetails = Prisma.CommentReactionGetPayload<typeof getReactions>;
const getReactions = Prisma.validator<Prisma.CommentReactionFindManyArgs>()({
  select: getReactionsSelect,
});
