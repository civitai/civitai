import { dbWrite } from '~/server/db/client';

// Its own module so a caller that only needs the probe does not import the search index.
export const COVER_INDEX_NAME = 'Collection_imageId_idx';

/**
 * Is the cover leg's index present AND usable?
 *
 * `pg_class` alone is not enough: a `CREATE INDEX CONCURRENTLY` row exists from the start of the
 * build and stays after a failed one, so a name-only check would switch the cover leg on early.
 * `indisvalid AND indisready` means usable by the planner. Schema-qualified because `relname` is not
 * unique across schemas.
 *
 * A catalog lookup, not a cached flag, so the leg starts working as soon as the index becomes valid,
 * with no deploy or restart.
 *
 * Once the index is valid in every environment, this gate and its branch can go.
 */
export async function coverIndexExists() {
  const rows = await dbWrite.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_index x ON x.indexrelid = c.oid
      WHERE c.relname = ${COVER_INDEX_NAME}
        AND c.relkind = 'i'
        AND c.relnamespace = 'public'::regnamespace
        AND x.indisvalid
        AND x.indisready
    ) AS "present"
  `;
  return rows[0]?.present === true;
}
