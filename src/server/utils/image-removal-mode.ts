import { Prisma } from '@prisma/client';
import {
  GRACE_PRIOR_BLOCKED_FOR_KEY,
  GRACE_PRIOR_INGESTION_KEY,
  GRACE_PRIOR_KEYS,
  GRACE_PRIOR_NEEDS_REVIEW_KEY,
  GRACE_PRIOR_NSFW_LEVEL_KEY,
  GRACE_PRIOR_NSFW_LOCKED_KEY,
} from '@civitai/shared/account-deletion-grace';
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
export const PRIOR_INGESTION_KEY = GRACE_PRIOR_INGESTION_KEY;
export const PRIOR_BLOCKED_FOR_KEY = GRACE_PRIOR_BLOCKED_FOR_KEY;
/**
 * The image's `needsReview` before the grace block, which clears every review but 'csam' on the
 * rows it hides. A row written before this key existed has none, and the restore leaves its flag.
 */
export const PRIOR_NEEDS_REVIEW_KEY = GRACE_PRIOR_NEEDS_REVIEW_KEY;
export const PRIOR_NSFW_LEVEL_KEY = GRACE_PRIOR_NSFW_LEVEL_KEY;
export const PRIOR_NSFW_LOCKED_KEY = GRACE_PRIOR_NSFW_LOCKED_KEY;
export const PRIOR_KEYS = GRACE_PRIOR_KEYS;
/** ` - key::text` for every grace breadcrumb: after a jsonb value, strips them all. */
export const minusPriorKeysSql = Prisma.join(
  PRIOR_KEYS.map((key) => Prisma.sql`${key}::text`),
  ' - ',
  ' - '
);
