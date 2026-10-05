import type { Prisma } from '@prisma/client';

/**
 * THE user chip every moderator App-Block review surface projects — the queue list (on-site
 * AND off-site rows), the per-submission page, the prior-versions modal, and the moderation
 * listings table's pending request.
 *
 * 🔴 WHY A LEAF MODULE WITH A TYPE-ONLY PRISMA IMPORT, AND NOT A SECOND EXPORT IN
 * `user.selector.ts`. That is where it belongs conceptually and where it started — but
 * `user.selector` calls `Prisma.validator` at module scope and pulls in
 * `image.selector` → `tag.selector`, which does the same. Several service test suites mock
 * `@prisma/client` with a narrow factory (`{ Prisma: { sql, join } }`), so the moment one of
 * those modules enters their graph every case in the file dies on
 * `Prisma.validator is not a function` — measured: adding the import to
 * `app-listing.service.ts` turned 43 previously-green analytics cases red, in files that
 * have nothing to do with user chips.
 *
 * `satisfies` gives the identical compile-time checking and is ERASED at build, so this
 * module has no runtime dependency on anything and can be imported from any service without
 * dragging the selector graph behind it. The trade is real but small: `Prisma.validator`
 * also infers the literal type, which `as const` supplies here.
 *
 * 🔴 WHY ONE DECLARATION. It was spelled inline at NINE sites in
 * `publish-request.service.ts`, one in `offsite-listing.service.ts` and one in
 * `app-listing.service.ts`, and the copies genuinely diverged: `deletedAt` reached the five
 * `submittedBy` ones a whole round before the four `reviewedBy` ones, and the off-site chip
 * after both — so for a while `/apps/review`, which interleaves both row kinds into ONE
 * list, rendered a closed account as "[deleted]" on an on-site row and as a live, linked
 * profile on the off-site row directly beneath.
 *
 * 🔴 `deletedAt` IS LOAD-BEARING, NOT DECORATION. `UserAvatar` BRANCHES on it twice —
 * `UserProfileLink` suppresses `linkToProfile` for a closed account, and `Username` renders
 * "[deleted]" instead of a name. Omit it and the value is `undefined` ⇒ falsy ⇒ a deleted
 * account renders as a live, linked one, on the surface where who submitted a bundle is the
 * fact being judged.
 *
 * ⚠️ `profilePicture` is deliberately NOT here — the one remaining field `UserAvatar` reads,
 * but a NESTED select, so Prisma issues an extra batched query against one of the largest
 * tables in the database per list call, on three mod-queue list paths, for a gain the avatar
 * already falls back from (it uses the `image` string when there is no profile-picture row).
 * If it ever becomes affordable the route is the profile-picture cache, not a nested select.
 * `review-submitter-select-parity.test.ts` asserts this is exactly `simpleUserSelect` minus
 * that field, so widening the house chip turns a test red rather than propagating here.
 */
export const reviewUserChipSelect = {
  id: true,
  username: true,
  deletedAt: true,
  image: true,
} as const satisfies Prisma.UserSelect;
