export type ImageRemovalMode = 'grace' | 'immediate';

/** Absent means immediate: backlog accounts predate the choice and must keep hard-delete. */
export function imageRemovalMode(removeImages?: boolean): ImageRemovalMode {
  return removeImages === false ? 'grace' : 'immediate';
}

/**
 * `Image.metadata` keys the grace block writes so `restoreUser` can undo exactly what it did.
 * `blockedFor = 'moderated'` is what a moderator block writes too, so it cannot tell the two
 * apart, and the values (rather than a flag) are what let a restore put a `Pending` image back
 * as `Pending` instead of promoting it to `Scanned` past its scan.
 */
export const PRIOR_INGESTION_KEY = 'accountDeletionPriorIngestion';
export const PRIOR_BLOCKED_FOR_KEY = 'accountDeletionPriorBlockedFor';
/**
 * The image's `needsReview` before the grace block, which clears every review but 'csam' on the
 * rows it hides. A row written before this key existed has none, and the restore leaves its flag.
 */
export const PRIOR_NEEDS_REVIEW_KEY = 'accountDeletionPriorNeedsReview';

/** Every grace-block breadcrumb key: stripped together, and never accepted from a client. */
export const GRACE_MARKER_KEYS = [
  PRIOR_INGESTION_KEY,
  PRIOR_BLOCKED_FOR_KEY,
  PRIOR_NEEDS_REVIEW_KEY,
] as const;
