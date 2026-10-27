import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { HOLD_MARKER_VIEW } from './csam-flag-clear';

const SET_ASIDE_TABLE = 'CsamQueueSetAside';

/** Which set-aside rows can be read: none without the table, and `AfterReport` rows only with the
 *  marker view too. A row that cannot be read never counts, so the queue shows the image. */
export type SetAsideState = { table: boolean; markerView: boolean };

export async function setAsideState(db: Kysely<DB>): Promise<SetAsideState> {
  const { rows } = await sql<{ table: unknown; view: unknown }>`
    SELECT to_regclass(${`"${SET_ASIDE_TABLE}"`}) IS NOT NULL AS table,
           to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL AS view`.execute(db);
  return { table: rows[0]?.table === true, markerView: rows[0]?.view === true };
}

/**
 * The image (`image` is the table or alias it is read as) has a set-aside row that counts: any
 * dismissal, or a row set aside after a report while its owner's row is in the view. False when
 * `state` has no table.
 */
export function setAsideCounts(image: string, state: SetAsideState) {
  if (!state.table) return sql<boolean>`false`;
  const col = (name: string) => sql.ref(`${image}.${name}`);
  const afterReport = state.markerView
    ? sql<boolean>`(
        s.outcome = 'AfterReport'
        and exists (select 1 from ${sql.table(HOLD_MARKER_VIEW)} h where h."userId" = ${col(
        'userId'
      )})
      )`
    : sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1
    from "CsamQueueSetAside" s
    where s."imageId" = ${col('id')}
      and (s.outcome = 'Dismissed' or ${afterReport})
  )`;
}
