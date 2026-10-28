import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

const SET_ASIDE_TABLE = 'CsamQueueSetAside';

/** Whether set-aside rows can be read. A row that cannot be read never counts, so the queue shows
 *  the image. */
export type SetAsideState = { table: boolean };

export async function setAsideState(db: Kysely<DB>): Promise<SetAsideState> {
  const { rows } = await sql<{ table: unknown }>`
    SELECT to_regclass(${`"${SET_ASIDE_TABLE}"`}) IS NOT NULL AS table`.execute(db);
  return { table: rows[0]?.table === true };
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
