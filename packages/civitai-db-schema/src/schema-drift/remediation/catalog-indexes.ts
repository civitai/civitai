/**
 * The one catalog fact the drift detector does not collect: ordinary (non-unique) indexes.
 *
 * The detector only needs unique indexes, because a `@unique` declaration is the only
 * index-shaped thing a Prisma schema promises. This planner needs the general list, because
 * an unindexed referencing column turns every delete of a referenced row into a sequential
 * scan of the referencing table — 16.9M rows for `Collection.imageId`, 5.9M for
 * `ImageEngagement.imageId`.
 *
 * Read-only: one SELECT against pg_catalog.
 */
import type { CatalogQueryRunner } from '../catalog';
import type { CatalogIndexEntry } from './types';

const TABLE_RELKINDS = "('r', 'p')";

/**
 * Key columns of every valid index, in index order.
 *
 * `k.ord <= i.indnkeyatts` drops INCLUDE columns: they are payload, they are not part of
 * the search key, and an index whose leading key column is `userId` does not help a lookup
 * on `imageId` no matter what it INCLUDEs.
 *
 * Partial indexes (`indpred`) ARE included here, unlike in the detector's unique-index
 * read, and the reader below drops them: a partial index does not support a lookup for
 * rows outside its predicate, so counting it as coverage would wave through exactly the
 * seq-scan case this check exists to catch.
 *
 * `attname::text` is load-bearing — `name[]` (OID 1003) has no array parser registered in
 * node-postgres, so without the cast the aggregate arrives as the literal string
 * `"{userId,imageId}"` and every prefix comparison downstream silently compares characters.
 */
const INDEXES_SQL = `
  SELECT c.relname AS table_name,
         i.indnkeyatts AS key_count,
         (i.indpred IS NOT NULL) AS is_partial,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_catalog.pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE k.ord <= i.indnkeyatts) AS columns
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE i.indisvalid
    AND c.relkind IN ${TABLE_RELKINDS}
    AND n.nspname = $1
`;

export async function readIndexes(
  runner: CatalogQueryRunner,
  dbSchema: string
): Promise<CatalogIndexEntry[]> {
  const result = await runner.query<{
    table_name: string;
    key_count: number;
    is_partial: boolean;
    columns: string[] | null;
  }>(INDEXES_SQL, [dbSchema]);

  return (
    result.rows
      .filter((r) => !r.is_partial)
      .map((r) => {
        if (r.columns !== null && !Array.isArray(r.columns)) {
          throw new Error(
            `Expected an array of column names for an index on ${r.table_name}, got ` +
              `${typeof r.columns}. The driver did not parse the array: select the aggregate ` +
              'as text[] (attname::text).'
          );
        }
        return { table: r.table_name, keyCount: r.key_count, columns: r.columns ?? [] };
      })
      // An expression index carries attnum 0, which has no pg_attribute row, so the join
      // above loses that position and the column list comes back short. It cannot be matched
      // against a column-name declaration, so it is dropped rather than treated as a prefix.
      .filter((r) => r.columns.length === r.keyCount)
      .map((r) => ({ table: r.table, columns: r.columns }))
  );
}
