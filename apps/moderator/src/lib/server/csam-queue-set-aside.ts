import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

const SET_ASIDE_TABLE = 'CsamQueueSetAside';

/** Whether set-aside rows can be read (`table`) and written (`writable`): the table exists and this
 *  role may. A row that cannot be read never counts, so the queue shows the image. */
export type SetAsideState = { table: boolean; writable: boolean };

export async function setAsideState(db: Kysely<DB>): Promise<SetAsideState> {
  const table = sql`to_regclass(${`"${SET_ASIDE_TABLE}"`})`;
  const { rows } = await sql<{ table: boolean | null; writable: boolean | null }>`
    SELECT has_table_privilege(${table}, 'SELECT') AS table,
      has_table_privilege(${table}, 'INSERT') AS writable`.execute(db);
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
