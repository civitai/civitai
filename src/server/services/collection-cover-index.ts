import { dbWrite } from '~/server/db/client';

// Its own module so a caller that only needs the probe does not import the search index.
export const COVER_INDEX_NAME = 'Collection_imageId_idx';

/**
 * Is the cover leg's index present AND USABLE?
 *
 * 🔴 `pg_class` alone is NOT sufficient, and getting this wrong fails OPEN. A
 * `CREATE INDEX CONCURRENTLY` row appears in `pg_class` from the START of the build
 * and stays there permanently if the build fails — so a name-only check returns true
 * throughout a multi-minute build of a 2.8 GB heap, and forever after a failure. That
 * is precisely the window this gate exists to cover: the deploy-then-migrate ordering
 * would switch the cover leg on while the index is still being built, and every image
 * delete would pay the sequential scan concurrently with the build, on the primary,
 * up to five at a time (`deleteImages` runs `Limiter({ batchSize: 100 })`, whose
 * default concurrency is 5). `indisvalid AND indisready` is what makes the gate mean
 * "usable by the planner" rather than "someone started building this once".
 *
 * Schema-qualified because `relname` is not unique across schemas and this database
 * has a second one (`fk_remediation_backup`).
 *
 * A catalog lookup, not a cached flag: two index scans, cost 5.01 — far less than the
 * seven-leg query it guards — and re-reading it means the leg starts working the
 * moment the index becomes valid, with no deploy or restart.
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
