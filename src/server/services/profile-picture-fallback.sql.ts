// No Prisma imports: raw SQL text, read by modules that suites load under a `@prisma/client` mock.
import {
  blockMarkerText,
  ownImageNamedByUserImage,
  userImageNamesPicture,
} from '@civitai/db-queries/profile-picture-clear';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';

const heldReviewList = OWNER_HIDDEN_REVIEWS.map((review) => `'${review}'`).join(', ');

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;
const alias = (user: string) => {
  if (!SQL_ALIAS.test(user)) throw new Error(`not a SQL alias: ${user}`);
  return user;
};

const heldOrBlocked = (image: string) =>
  `(${image}."needsReview" IN (${heldReviewList}) OR ${blockMarkerText(image)})`;

/**
 * Whether `User` (aliased `user`) has a `User.image` naming one of the user's own images while it is
 * under an owner-hidden hold or carries a block marker: the profile picture, or any other own upload
 * (`ownImageNamedByUserImage`, the clear's own match, on `Image_url_covered_idx`).
 */
export const userImageNamesHeldPictureOf = (user: string) => `(EXISTS (
    SELECT 1 FROM "Image" held
    WHERE held.id = ${alias(user)}."profilePictureId"
      AND ${heldOrBlocked('held')}
      AND ${userImageNamesPicture('held', user)}
  ) OR EXISTS (
    SELECT 1 FROM "Image" held
    WHERE ${ownImageNamedByUserImage('held', user)}
      AND ${heldOrBlocked('held')}
  ))`;

export const userImageNamesHeldPicture = userImageNamesHeldPictureOf('u');

/**
 * `User.image` over `User` aliased `u`, for reads that fall back to it when there is no profile
 * picture: null when it names one of the user's own images that is under an owner-hidden review hold
 * or carries a block marker, the images the clear nulls it for. A raw column for `SELECT` lists built
 * as text. `fallbackUserImageColumnOf` takes another alias for `User`.
 */
export const fallbackUserImageColumnOf = (user: string) =>
  `CASE WHEN ${userImageNamesHeldPictureOf(user)} THEN NULL ELSE ${alias(user)}.image END`;

export const fallbackUserImageColumn = fallbackUserImageColumnOf('u');
