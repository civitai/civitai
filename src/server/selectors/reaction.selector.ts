import { Prisma } from '@prisma/client';

/**
 * Comment reactions only ever need to name the reactor.
 *
 * Two fields are read, and nothing else. `ReactionPicker` reads
 * `user.username` — for the "who reacted" tooltip, and for its own "have I
 * reacted" comparison against the current user's username. Its three callers
 * (`CommentSectionItem`, `CommentDiscussionItem`, `CommentThreadModal`) read
 * `user.id`, to find the viewer's existing reaction before toggling it.
 *
 * This used to select the full `simpleUserSelect`, which additionally
 * pulled `deletedAt`, `image` and the whole `profilePicture` Image relation.
 * Two distinct costs, and they are not the same size:
 *
 * 1. An EXTRA QUERY — plausibly the larger cost, and per call rather than per
 *    row, but CONDITIONAL like the decode below. `profilePicture` is a
 *    relation, and the schema's generator block enables only
 *    `previewFeatures = ["metrics"]` — no `relationJoins` — so Prisma has no
 *    join strategy available and resolves a nested relation with an additional
 *    round-trip rather than a widened one. Selecting it meant one `Image`
 *    SELECT per call — not per row — whenever AT LEAST ONE reactor in the batch
 *    has a profile picture; when the collected FK set is empty Prisma skips the
 *    child query entirely. Measured on this exact shape (Prisma 6.13.0, PG16,
 *    SQL captured via `$on('query')`): a batch of 5 reactors issues 0 `Image`
 *    SELECTs with none of them carrying a picture, and 1 (`WHERE "Image"."id"
 *    IN (…)`) whether one carries one or all five do. That query is on top of
 *    the `User` SELECT the `user` relation still costs; dropping
 *    `profilePicture` removes it, rather than just a column.
 *
 * 2. Per-row decoding, but only CONDITIONALLY. Prisma converts tagged values
 *    on the JS main thread (`DateTime` -> `new Date`, `Json` -> `JSON.parse`),
 *    and both dropped columns are nullable — `User.deletedAt` is `DateTime?`
 *    and `User.profilePictureId` is `Int?` — so a live user with no profile
 *    picture (the common case) paid neither. The decode cost landed only on
 *    rows where the value was actually non-null: a `new Date()` per deleted
 *    reactor, and, for each reactor who has one, a `JSON.parse` of that
 *    Image's `metadata` (which is a non-null `Json` column, so it is always
 *    parsed once the row is fetched at all).
 *
 * The deleted-user case still renders correctly: `deleteUser` nulls
 * `username`, and the renderer already falls back on
 * `username ?? '<deleted user>'`, so it reads the null rather than the
 * timestamp.
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
