import type {
  CatalogColumn,
  CatalogForeignKey,
  CatalogUniqueIndex,
  DbCatalog,
  ReferentialAction,
} from './types';
import { PG_ACTION_CODES } from './types';

/**
 * Minimal shape of whatever runs the queries. Kept structural so the caller owns the
 * connection (and so this module has no opinion about where the database is — the
 * connection string comes from `DATABASE_URL` in the environment, nowhere else).
 */
export interface CatalogQueryRunner {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export const DEFAULT_DB_SCHEMA = 'public';

/**
 * `relkind` values we treat as "a table a constraint can live on": ordinary (`r`) and
 * partitioned (`p`). Views (`v`), materialised views (`m`) and foreign tables (`f`) are
 * deliberately excluded — a model mapped to one of those is skipped by the differ rather
 * than reported as missing every constraint it declares.
 */
const TABLE_RELKINDS = "('r', 'p')";

const TABLES_SQL = `
  SELECT c.relname AS table_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ${TABLE_RELKINDS}
`;

/**
 * Nullability.
 *
 * The result column is `is_not_null`, NOT `notnull`. `NOTNULL` is a reserved word in
 * Postgres: `SELECT a.attnotnull notnull` parses as the postfix `IS NOT NULL` operator
 * applied to `a.attnotnull`, so the query succeeds and returns a constant `true` for every
 * row. That fabricated 626 one-directional nullability findings before it was caught.
 * `assertCatalogSanity` in compare.ts is the standing guard.
 */
const COLUMNS_SQL = `
  SELECT c.relname AS table_name,
         a.attname AS column_name,
         a.attnotnull AS is_not_null
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
    AND c.relkind IN ${TABLE_RELKINDS}
    AND a.attnum > 0
    AND NOT a.attisdropped
`;

/**
 * Foreign keys, with their constrained and referenced columns in CONSTRAINT order.
 *
 * `conkey` / `confkey` are ordered arrays; `WITH ORDINALITY` preserves that order through
 * the join to `pg_attribute`. Sorting the names alphabetically instead would make a
 * composite FK on (a, b) indistinguishable from one on (b, a).
 *
 * `attname::text` is load-bearing, not tidiness. `attname` is `name`, and node-postgres has
 * no array parser registered for `name[]` (OID 1003), so `array_agg(a.attname)` arrives in
 * JavaScript as the raw literal STRING `"{projectId,position}"` — not an array. Every
 * column-tuple comparison downstream then compares a string, silently: unique indexes
 * vanish from the catalog entirely and foreign keys match nothing. `text[]` (OID 1009) has
 * a parser, so the cast is what makes the result an array. `assertParsedArray` below is the
 * standing guard.
 */
const FOREIGN_KEYS_SQL = `
  SELECT con.conname AS name,
         c.relname AS table_name,
         rc.relname AS ref_table,
         con.confdeltype::text AS on_delete_code,
         con.confupdtype::text AS on_update_code,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_catalog.pg_attribute a
              ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_catalog.pg_attribute a
              ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE con.contype = 'f' AND n.nspname = $1
`;

/**
 * Unique indexes, excluding partial ones.
 *
 * `indpred IS NULL` is load-bearing: a partial unique index enforces uniqueness only over
 * the rows matching its WHERE clause, so it does not satisfy a `@unique` / `@@unique`
 * declaration, which is a promise about every row.
 *
 * `k.ord <= i.indnkeyatts` drops INCLUDE columns, which are payload and not part of the
 * uniqueness key. Expression indexes carry attnum 0, which has no `pg_attribute` row; the
 * join drops those positions and the length check in the reader discards the index.
 */
const UNIQUE_INDEXES_SQL = `
  SELECT c.relname AS table_name,
         i.indnkeyatts AS key_count,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_catalog.pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE k.ord <= i.indnkeyatts) AS columns
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE i.indisunique
    AND i.indpred IS NULL
    AND i.indisvalid
    AND c.relkind IN ${TABLE_RELKINDS}
    AND n.nspname = $1
`;

function decodeAction(code: string | null): ReferentialAction | null {
  if (!code) return null;
  const action = PG_ACTION_CODES[code];
  if (!action) throw new Error(`Unrecognised Postgres referential-action code "${code}"`);
  return action;
}

/**
 * Reject a column list the driver handed back unparsed.
 *
 * A missing array parser turns `{a,b}` into a 5-character string rather than a 2-element
 * array. Nothing throws, `.length` still answers, and the comparison downstream quietly
 * becomes meaningless — so this fails the read instead of returning a plausible catalog.
 */
function assertParsedArray(value: unknown, context: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `Expected an array of column names for ${context}, got ${typeof value} (${String(value)}). ` +
        'The driver did not parse the array: select the aggregate as text[] (attname::text).'
    );
  }
  return value as string[];
}

/**
 * Read the constraint catalogs of a live database.
 *
 * Read-only: every statement is a SELECT against `pg_catalog`. Nothing here writes, and
 * nothing here applies a migration.
 */
export async function readCatalog(
  runner: CatalogQueryRunner,
  dbSchema: string = DEFAULT_DB_SCHEMA
): Promise<DbCatalog> {
  const [tableRows, columnRows, fkRows, uniqueRows] = await Promise.all([
    runner.query<{ table_name: string }>(TABLES_SQL, [dbSchema]),
    runner.query<{ table_name: string; column_name: string; is_not_null: boolean }>(COLUMNS_SQL, [
      dbSchema,
    ]),
    runner.query<{
      name: string;
      table_name: string;
      ref_table: string;
      on_delete_code: string | null;
      on_update_code: string | null;
      columns: string[] | null;
      ref_columns: string[] | null;
    }>(FOREIGN_KEYS_SQL, [dbSchema]),
    runner.query<{ table_name: string; key_count: number; columns: string[] | null }>(
      UNIQUE_INDEXES_SQL,
      [dbSchema]
    ),
  ]);

  const columns: CatalogColumn[] = columnRows.rows.map((r) => ({
    table: r.table_name,
    column: r.column_name,
    notNull: r.is_not_null,
  }));

  const foreignKeys: CatalogForeignKey[] = fkRows.rows.map((r) => ({
    name: r.name,
    table: r.table_name,
    columns: assertParsedArray(r.columns, `foreign key ${r.name}`),
    refTable: r.ref_table,
    refColumns: assertParsedArray(r.ref_columns, `foreign key ${r.name} (referenced)`),
    onDelete: decodeAction(r.on_delete_code),
    onUpdate: decodeAction(r.on_update_code),
  }));

  const uniqueIndexes: CatalogUniqueIndex[] = uniqueRows.rows
    .map((r) => ({
      table: r.table_name,
      keyCount: r.key_count,
      columns: assertParsedArray(r.columns, `unique index on ${r.table_name}`),
    }))
    // An expression index loses positions in the join above, so its column list is short.
    // It cannot be matched against a column-name declaration; drop it.
    .filter((r) => r.columns.length === r.keyCount)
    .map((r) => ({ table: r.table, columns: r.columns }));

  return {
    tables: tableRows.rows.map((r) => r.table_name),
    columns,
    foreignKeys,
    uniqueIndexes,
  };
}
