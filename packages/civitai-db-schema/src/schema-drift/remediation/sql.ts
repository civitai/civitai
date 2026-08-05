/**
 * Statement builders for the foreign-key remediation runner.
 *
 * Every statement this module can produce is here, so the set of things the runner is able
 * to execute is readable in one file. Nothing here runs anything.
 */
import type { ReferentialAction } from '../types';

/** Postgres truncates an identifier longer than this SILENTLY, at 63 bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * Map Prisma's referential actions onto SQL.
 *
 * `NoAction` and `Restrict` are distinct in Postgres and are kept distinct here. They are
 * present because a constraint is written with its declared action even when the runner
 * refuses to touch the DATA for that action — the two decisions are separate, and folding
 * them together is how a `Restrict` relation gets a `CASCADE` constraint.
 */
const SQL_ACTIONS: Record<ReferentialAction, string> = {
  Cascade: 'CASCADE',
  Restrict: 'RESTRICT',
  NoAction: 'NO ACTION',
  SetNull: 'SET NULL',
  SetDefault: 'SET DEFAULT',
};

export function sqlAction(action: ReferentialAction): string {
  const sql = SQL_ACTIONS[action];
  if (!sql) throw new Error(`No SQL spelling for referential action "${action}"`);
  return sql;
}

/**
 * Quote an identifier.
 *
 * These identifiers come from a Prisma schema in this repository, not from user input, but
 * a schema is still an untrusted-enough source that concatenating it into DDL unquoted is
 * not defensible. A NUL byte cannot appear in a Postgres identifier and would terminate the
 * string at the protocol layer, so it is rejected rather than escaped.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw new Error('Refusing to quote an empty identifier');
  if (name.includes('\0'))
    throw new Error(`Identifier contains a NUL byte: ${JSON.stringify(name)}`);
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Byte length, because Postgres's 63 limit is bytes, not characters. */
export function identifierBytes(name: string): number {
  return Buffer.byteLength(name, 'utf8');
}

/** Prisma's foreign-key naming convention: `<Table>_<col>[_<col>...]_fkey`. */
export function constraintNameFor(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}_fkey`;
}

/** Where a relation's orphan rows are preserved before they are changed. */
export function backupTableNameFor(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}_orphans`;
}

/** Prisma's index naming convention for a single-column `@@index`. */
export function indexNameFor(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}_idx`;
}

export interface RelationSqlContext {
  table: string;
  columns: readonly string[];
  refTable: string;
  refColumns: readonly string[];
  constraintName: string;
  backupSchema: string;
  backupTable: string;
  batchSize: number;
}

/**
 * The anti-join that defines "orphan" for this module.
 *
 * `IS NOT NULL` on every referencing column is load-bearing: a NULL reference is not an
 * orphan, it is an absent one, and a foreign key permits it. Counting NULLs as orphans
 * would make a `SetNull` remediation set columns that are already NULL and would inflate
 * every count in the plan.
 */
function orphanPredicate(ctx: RelationSqlContext, alias: string): string {
  const notNull = ctx.columns
    .map((c) => `${alias}.${quoteIdent(c)} IS NOT NULL`)
    .join('\n    AND ');
  const join = ctx.columns
    .map((c, i) => `r.${quoteIdent(ctx.refColumns[i])} = ${alias}.${quoteIdent(c)}`)
    .join(' AND ');
  return `${notNull}\n    AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(
    ctx.refTable
  )} r WHERE ${join})`;
}

export function countOrphansSql(ctx: RelationSqlContext): string {
  return (
    `SELECT count(*)::bigint AS orphans\n` +
    `  FROM ${quoteIdent(ctx.table)} t\n` +
    ` WHERE ${orphanPredicate(ctx, 't')};`
  );
}

export function createBackupSchemaSql(backupSchema: string): string {
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(backupSchema)};`;
}

/**
 * The backup table.
 *
 * `(LIKE ... )` with no `INCLUDING` copies column names and types and nothing else — no
 * indexes, no constraints, no defaults. That is deliberate: the backup must accept rows the
 * live table would now reject, and it must be cheap to create on a hot table.
 *
 * The column list is identical to the source table's, which is what lets the remediation
 * statements below use a bare `SELECT t.*`. Adding a bookkeeping column here (a timestamp,
 * a batch id) would break that silently in the direction of "inserted into the wrong
 * columns", so it is not done.
 */
export function createBackupTableSql(ctx: RelationSqlContext): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${quoteQualified(ctx.backupSchema, ctx.backupTable)}\n` +
    `  (LIKE ${quoteIdent(ctx.table)});`
  );
}

/**
 * Delete one batch of orphans, backing them up in the SAME statement.
 *
 * The backup is not a preceding statement that the runner is trusted to have executed: the
 * `DELETE ... RETURNING` feeds the `INSERT` directly, so there is no interleaving in which
 * rows are deleted and not preserved. A crash between two statements cannot lose them
 * because there are not two statements.
 *
 * `ctid` is safe here for the same reason: every sub-statement of one statement sees one
 * snapshot, so a `ctid` selected by the CTE cannot have been recycled by the time the
 * DELETE resolves it. The same idiom split across two statements would not be safe.
 *
 * `LIMIT` bounds the transaction. A single unbounded DELETE against these tables holds one
 * long transaction over a multi-million-row seq scan, which is what the batching exists to
 * avoid.
 */
export function deleteOrphanBatchSql(ctx: RelationSqlContext): string {
  return (
    `WITH doomed AS (\n` +
    `  SELECT t.ctid FROM ${quoteIdent(ctx.table)} t\n` +
    `   WHERE ${orphanPredicate(ctx, 't')}\n` +
    `   LIMIT ${ctx.batchSize}\n` +
    `), moved AS (\n` +
    `  DELETE FROM ${quoteIdent(ctx.table)} t USING doomed d WHERE t.ctid = d.ctid\n` +
    `  RETURNING t.*\n` +
    `)\n` +
    `INSERT INTO ${quoteQualified(ctx.backupSchema, ctx.backupTable)} SELECT * FROM moved;`
  );
}

/**
 * Null one batch of orphan references, backing the whole pre-update row up first.
 *
 * Setting a column to NULL destroys the old value, so it gets the same backup treatment as
 * a delete. Both sub-statements read the one statement snapshot, so the `INSERT` captures
 * the rows as they were regardless of the order the planner picks for the CTEs.
 */
export function nullOrphanBatchSql(ctx: RelationSqlContext): string {
  const assignments = ctx.columns.map((c) => `${quoteIdent(c)} = NULL`).join(', ');
  return (
    `WITH doomed AS (\n` +
    `  SELECT t.ctid FROM ${quoteIdent(ctx.table)} t\n` +
    `   WHERE ${orphanPredicate(ctx, 't')}\n` +
    `   LIMIT ${ctx.batchSize}\n` +
    `), saved AS (\n` +
    `  INSERT INTO ${quoteQualified(ctx.backupSchema, ctx.backupTable)}\n` +
    `  SELECT t.* FROM ${quoteIdent(ctx.table)} t JOIN doomed d ON t.ctid = d.ctid\n` +
    `)\n` +
    `UPDATE ${quoteIdent(ctx.table)} t SET ${assignments} FROM doomed d WHERE t.ctid = d.ctid;`
  );
}

/**
 * Add the constraint without validating it.
 *
 * `NOT VALID` is what keeps this off the hot path: the statement takes a brief ACCESS
 * EXCLUSIVE lock to write the catalog row and returns, instead of holding it for a full
 * scan of the table. Note the lock is taken on the REFERENCED table too, so a
 * long-scanning form of this statement blocks writes to `Image` — not only to the
 * referencing table.
 */
export function addConstraintNotValidSql(
  ctx: RelationSqlContext,
  onDelete: ReferentialAction,
  onUpdate: ReferentialAction
): string {
  const cols = ctx.columns.map(quoteIdent).join(', ');
  const refCols = ctx.refColumns.map(quoteIdent).join(', ');
  return (
    `ALTER TABLE ${quoteIdent(ctx.table)} ADD CONSTRAINT ${quoteIdent(ctx.constraintName)}\n` +
    `  FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(ctx.refTable)}(${refCols})\n` +
    `  ON UPDATE ${sqlAction(onUpdate)} ON DELETE ${sqlAction(onDelete)} NOT VALID;`
  );
}

/**
 * Validate, as a SEPARATE statement.
 *
 * This is the whole point of the split: `VALIDATE CONSTRAINT` takes SHARE UPDATE EXCLUSIVE,
 * which lets reads and writes continue while it scans. Combining the two — an ordinary
 * `ADD CONSTRAINT` — takes ACCESS EXCLUSIVE for the duration of the scan instead.
 */
export function validateConstraintSql(ctx: RelationSqlContext): string {
  return `ALTER TABLE ${quoteIdent(ctx.table)} VALIDATE CONSTRAINT ${quoteIdent(
    ctx.constraintName
  )};`;
}

/**
 * The index a cascading delete needs on the referencing side.
 *
 * `CONCURRENTLY` cannot run inside a transaction block, which is why this is never part of
 * the runner's executed sequence — it is emitted as a prerequisite for a human to run.
 */
export function createIndexConcurrentlySql(ctx: RelationSqlContext, indexName: string): string {
  const cols = ctx.columns.map(quoteIdent).join(', ');
  return (
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(indexName)}\n` +
    `  ON ${quoteIdent(ctx.table)} (${cols});`
  );
}
