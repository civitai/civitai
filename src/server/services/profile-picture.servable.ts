// No Prisma imports: the profile reads that use it run under suites that mock `@prisma/client`.
import { hasBlockMarker } from '~/server/common/image-block-marker';
import { isHeldForReview } from '~/server/common/owner-hidden-reviews';
import { isRestrictedImage } from '~/shared/utils/restricted-image';

/**
 * Whether a profile picture already fetched may be served to a viewer other than its owner: only
 * a Scanned, rated one, and never one under an owner-hidden review hold. Deliberately stricter than
 * `servableProfilePictureSql`, which also admits a moderator-locked rating (`imageReviewedSql`):
 * these reads do not carry the lock fields, so strict Scanned is the rule at TS sites.
 * Only the owner-hidden holds are checked, not any `needsReview`: a picture held for another review stays served,
 * as in `servableProfilePictureSql`; article images (`servableArticleImage`) hide any.
 * Never a mature picture made with a restricted base model (`isRestrictedImage`), nor one
 * carrying a block marker (`hasBlockMarker`).
 * `needsReview`, `modelRestricted` and `blockedFor` are separate, required arguments so a read
 * that does not select them fails to compile rather than skipping the check, and so none joins the
 * payload.
 */
export function servableProfilePicture<
  T extends { ingestion: string | null; nsfwLevel: number | null }
>(
  picture: T | null,
  needsReview: string | null | undefined,
  modelRestricted: boolean | null | undefined,
  blockedFor: string | null | undefined
): T | null;
export function servableProfilePicture<
  T extends { ingestion: string | null; nsfwLevel: number | null }
>(
  picture: T | null | undefined,
  needsReview: string | null | undefined,
  modelRestricted: boolean | null | undefined,
  blockedFor: string | null | undefined
): T | null | undefined;
export function servableProfilePicture<
  T extends { ingestion: string | null; nsfwLevel: number | null }
>(
  picture: T | null | undefined,
  needsReview: string | null | undefined,
  modelRestricted: boolean | null | undefined,
  blockedFor: string | null | undefined
) {
  if (!picture) return picture;
  if (picture.ingestion !== 'Scanned' || picture.nsfwLevel === 0 || isHeldForReview(needsReview))
    return null;
  if (isRestrictedImage({ nsfwLevel: picture.nsfwLevel ?? 0, modelRestricted })) return null;
  if (isBlocked({ ...picture, blockedFor })) return null;
  return picture;
}

/**
 * A profile picture under an owner-hidden review hold is served to no one, its owner included, as
 * in `servableProfilePictureSql`; for reads that otherwise give the owner their own picture.
 */
export function withoutHeldPicture<T>(picture: T | null, needsReview: string | null | undefined) {
  return isHeldForReview(needsReview) ? null : picture;
}

type BlockFields = {
  ingestion: string | null;
  nsfwLevel: number | null;
  blockedFor: string | null | undefined;
};

const isBlocked = (picture: BlockFields) =>
  hasBlockMarker({
    ingestion: picture.ingestion ?? '',
    nsfwLevel: picture.nsfwLevel ?? 0,
    blockedFor: picture.blockedFor ?? null,
  });

/**
 * A user's `User.image` as a fallback avatar: null when it names `picture` (the user's profile
 * picture) while that picture is under an owner-hidden review hold or carries a block marker. The
 * profile-picture half of `fallbackUserImageColumn` only: it does not see another own upload that
 * `User.image` names. The block fields are required so a read that does not select them fails to
 * compile.
 */
export function fallbackUserImage<T extends string | null | undefined>(
  image: T,
  picture: ({ url: unknown; needsReview: unknown } & BlockFields) | null | undefined
): T | null {
  if (!image || !picture) return image;
  if (!isHeldForReview(picture.needsReview as string | null) && !isBlocked(picture)) return image;
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
