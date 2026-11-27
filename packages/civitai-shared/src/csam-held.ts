import { csamInBlockedForSql } from './csam-blocked-for';

/** A table alias (`i`), or `"Image"` for the unaliased table, checked because the SQL splices it. */
export function imageAlias(ref: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ref) && ref !== '"Image"')
    throw new Error(`Bad table alias: ${ref}`);
  return ref;
}

/**
 * Whether the "Image" row aliased `image` is held for CSAM: removed for it (CSAM anywhere in its
 * `blockedFor` list), or flagged for review and
 * not dismissed from the CSAM queue. The main app's and the moderator app's one definition. Not
 * @civitai/shared/held-media's `heldImageSql`, whose legs differ.
 */
export function csamHeldImageSql(image: string): string {
  const i = imageAlias(image);
  return `(${csamInBlockedForSql(`${i}."blockedFor"`)} OR (${i}."needsReview" = 'csam' AND NOT EXISTS (
  SELECT 1 FROM "CsamQueueSetAside" sa WHERE sa."imageId" = ${i}.id AND sa.outcome = 'Dismissed')))`;
}
