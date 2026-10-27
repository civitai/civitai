import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { HOLD_MARKER_VIEW } from './csam-flag-clear';

const SET_ASIDE_TABLE = 'CsamQueueSetAside';

/**
 * Whether set-aside rows can be read: the table and the marker view must both exist. When either is
 * missing no row counts, so the queue shows every image rather than hiding one it cannot account for.
 */
export async function setAsideReadable(db: Kysely<DB>): Promise<boolean> {
  const { rows } = await sql<{ readable: unknown }>`
    SELECT to_regclass(${`"${SET_ASIDE_TABLE}"`}) IS NOT NULL
       AND to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL AS readable`.execute(db);
  return rows[0]?.readable === true;
}

/**
 * The image (`image` is the table or alias it is read as) has a set-aside row that still counts: its
 * owner is in the marker view, or it is a dismissal made within the last year. Only valid where
 * `setAsideReadable` returned true.
 */
export function setAsideCounts(image: string) {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`exists (
    select 1
    from "CsamQueueSetAside" s
    where s."imageId" = ${col('id')}
      and (
        exists (select 1 from ${sql.table(HOLD_MARKER_VIEW)} h where h."userId" = ${col('userId')})
        or (
          s.outcome = 'Dismissed'
          and s."createdAt" > (now() AT TIME ZONE 'UTC') - interval '1 year'
        )
      )
  )`;
}
