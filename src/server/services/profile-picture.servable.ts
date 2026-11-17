// A leaf with no imports: the profile reads that use it run under suites that mock `@prisma/client`.

/**
 * Whether a profile picture already fetched may be served to a viewer other than its owner: only
 * a Scanned one, and never one flagged `csam`. Deliberately stricter than
 * `servableProfilePictureSql`, which also admits a moderator-locked rating (`imageReviewedSql`):
 * these reads do not carry the lock fields, so strict Scanned is the rule at TS sites.
 * Only `csam` is checked, not any `needsReview`: a picture held for another review stays served,
 * as in `servableProfilePictureSql`; article images (`servableArticleImage`) hide any.
 * `needsReview` is a separate, required argument so a read that does not select it fails to
 * compile rather than skipping the check, and so the flag never joins the payload.
 */
export function servableProfilePicture<T extends { ingestion: string | null }>(
  picture: T | null,
  needsReview: string | null | undefined
): T | null;
export function servableProfilePicture<T extends { ingestion: string | null }>(
  picture: T | null | undefined,
  needsReview: string | null | undefined
): T | null | undefined;
export function servableProfilePicture<T extends { ingestion: string | null }>(
  picture: T | null | undefined,
  needsReview: string | null | undefined
) {
  if (!picture) return picture;
  if (picture.ingestion !== 'Scanned' || needsReview === 'csam') return null;
  return picture;
}

/**
 * A profile picture flagged `csam` is served to no one, its owner included, as in
 * `servableProfilePictureSql`; for reads that otherwise give the owner their own picture.
 */
export function withoutCsamPicture<T>(picture: T | null, needsReview: string | null | undefined) {
  return needsReview === 'csam' ? null : picture;
}
