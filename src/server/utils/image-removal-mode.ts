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
