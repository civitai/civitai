import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { setAsideCounts, type SetAsideState } from '@civitai/db-queries/csam-queue';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';

export { setAsideCounts, setAsideState, type SetAsideState } from '@civitai/db-queries/csam-queue';

/** The image row's version: any write to it changes this, a report's same-value flag write included.
 *  A dismissal is taken only against the version the moderator was shown. */
export function imageVersion(image: string) {
  return sql<string>`${sql.ref(`${image}.xmin`)}::text`;
}

/** `imageVersion` over a set of images, as one value: what a bulk dismissal is taken against. */
export function imagesVersion(image: string) {
  return sql<string>`md5(string_agg(${sql.ref(`${image}.id`)}::text || ':' || ${imageVersion(
    image
  )}, ',' order by ${sql.ref(`${image}.id`)}))`;
}

/** Flagged, removed images not yet dismissed, as `i`: what the by-user page offers to bulk dismiss
 *  and what the bulk dismiss takes, so the `imagesVersion` the page shows is the one it checks. */
export function removedNotDismissed(db: Kysely<DB>, state: SetAsideState) {
  return db
    .selectFrom('Image as i')
    .where('i.needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
    .where('i.ingestion', '=', 'Blocked')
    .where(sql<boolean>`not ${setAsideCounts('i', state)}`);
}
