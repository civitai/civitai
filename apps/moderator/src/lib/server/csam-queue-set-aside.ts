import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';

const SET_ASIDE_TABLE = 'CsamQueueSetAside';

/** Whether set-aside rows can be read (`table`) and written (`writable`): the table exists and this
 *  role may. A row that cannot be read never counts, so the queue shows the image. */
export type SetAsideState = { table: boolean; writable: boolean };

export async function setAsideState(db: Kysely<DB>): Promise<SetAsideState> {
  const table = sql`to_regclass(${`"${SET_ASIDE_TABLE}"`})`;
  // A dismissal inserts and reads back what it inserted, so writing takes both.
  const { rows } = await sql<{ table: boolean | null; writable: boolean | null }>`
    SELECT has_table_privilege(${table}, 'SELECT') AS table,
      has_table_privilege(${table}, 'SELECT') AND has_table_privilege(${table}, 'INSERT') AS writable`.execute(
    db
  );
  return { table: rows[0]?.table === true, writable: rows[0]?.writable === true };
}

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

/**
 * The image (`image` is the table or alias it is read as) was dismissed and is still removed. False
 * when `state` has no table.
 */
export function setAsideCounts(image: string, state: SetAsideState) {
  if (!state.table) return sql<boolean>`false`;
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`(${col('ingestion')} = 'Blocked' and exists (
    select 1
    from "CsamQueueSetAside" s
    where s."imageId" = ${col('id')}
      and s.outcome = 'Dismissed'
  ))`;
}
