// No Prisma imports: the profile reads that use it run under suites that mock `@prisma/client`.
import { isHeldForReview } from '~/server/common/owner-hidden-reviews';
import { isRestrictedImage } from '~/shared/utils/restricted-image';

/**
 * Whether a profile picture already fetched may be served to a viewer other than its owner: only
 * a Scanned, rated one, and never one under an owner-hidden review hold. Deliberately stricter than
 * `servableProfilePictureSql`, which also admits a moderator-locked rating (`imageReviewedSql`):
 * these reads do not carry the lock fields, so strict Scanned is the rule at TS sites.
 * Only the owner-hidden holds are checked, not any `needsReview`: a picture held for another review stays served,
 * as in `servableProfilePictureSql`; article images (`servableArticleImage`) hide any.
 * Never a mature picture made with a restricted base model (`isRestrictedImage`).
 * `needsReview` and `modelRestricted` are separate, required arguments so a read that does not
 * select them fails to compile rather than skipping the check, and so neither joins the payload.
 */
export function servableProfilePicture<
  T extends { ingestion: string | null; nsfwLevel: number | null }
>(
  picture: T | null,
  needsReview: string | null | undefined,
  modelRestricted: boolean | null | undefined
): T | null;
export function servableProfilePicture<
  T extends { ingestion: string | null; nsfwLevel: number | null }
>(
  picture: T | null | undefined,
  needsReview: string | null | undefined,
  modelRestricted: boolean | null | undefined
): T | null | undefined;
export function servableProfilePicture<
  T extends { ingestion: string | null; nsfwLevel: number | null }
>(
  picture: T | null | undefined,
  needsReview: string | null | undefined,
  modelRestricted: boolean | null | undefined
) {
  if (!picture) return picture;
  if (picture.ingestion !== 'Scanned' || picture.nsfwLevel === 0 || isHeldForReview(needsReview))
    return null;
  if (isRestrictedImage({ nsfwLevel: picture.nsfwLevel ?? 0, modelRestricted })) return null;
  return picture;
}

/**
 * A profile picture under an owner-hidden review hold is served to no one, its owner included, as
 * in `servableProfilePictureSql`; for reads that otherwise give the owner their own picture.
 */
export function withoutHeldPicture<T>(picture: T | null, needsReview: string | null | undefined) {
  return isHeldForReview(needsReview) ? null : picture;
}

/**
 * A user's `User.image` as a fallback avatar: null when it names `picture` (the user's profile
 * picture, read with its `needsReview`) while that picture is under an owner-hidden review hold.
 * The TS form of `fallbackUserImageColumn` for holds only: its readers do not select the block
 * markers, so a blocked picture's value relies on the clear.
 */
export function fallbackUserImage(
  image: string | null | undefined,
  picture: { url?: unknown; needsReview?: unknown } | null | undefined
) {
  if (!image || !picture || !isHeldForReview(picture.needsReview as string | null)) return image;
  return namesPicture(image, picture.url) ? null : image;
}

/** Whether `image` carries `url`, the picture's key, compared as `fallbackUserImageColumn` does. */
export function namesPicture(image: string, url: unknown) {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    image.toLowerCase().replaceAll('%2d', '-').includes(url.toLowerCase())
  );
}
