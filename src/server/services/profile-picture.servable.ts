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
