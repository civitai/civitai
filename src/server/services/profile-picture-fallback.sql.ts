// No Prisma imports: raw SQL text, read by modules that suites load under a `@prisma/client` mock.
import { blockMarkerText, userImageNamesPicture } from '@civitai/db-queries/profile-picture-clear';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';

const heldReviewList = OWNER_HIDDEN_REVIEWS.map((review) => `'${review}'`).join(', ');

/**
 * Whether `User.image` (aliased `u`) names the user's profile picture while it is under an
 * owner-hidden hold or carries a block marker.
 */
export const userImageNamesHeldPictureOf = (user: string) => `EXISTS (
    SELECT 1 FROM "Image" held
    WHERE held.id = ${user}."profilePictureId"
      AND (held."needsReview" IN (${heldReviewList}) OR ${blockMarkerText('held')})
      AND ${userImageNamesPicture('held', user)}
  )`;

export const userImageNamesHeldPicture = userImageNamesHeldPictureOf('u');

/**
 * `User.image` over `User` aliased `u`, for reads that fall back to it when there is no profile
 * picture: null when it names the user's profile picture and that picture is under an owner-hidden
 * review hold or carries a block marker, the same rule the clear follows. A raw column for `SELECT`
 * lists built as text. `fallbackUserImageColumnOf` takes another alias for `User`.
 */
export const fallbackUserImageColumnOf = (user: string) =>
  `CASE WHEN ${userImageNamesHeldPictureOf(user)} THEN NULL ELSE ${user}.image END`;

export const fallbackUserImageColumn = fallbackUserImageColumnOf('u');
