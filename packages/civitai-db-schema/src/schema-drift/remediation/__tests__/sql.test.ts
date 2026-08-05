import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_BYTES,
  addConstraintNotValidSql,
  backupTableNameFor,
  constraintNameFor,
  countOrphansSql,
  createBackupSchemaSql,
  createBackupTableSql,
  createIndexConcurrentlySql,
  deleteOrphanBatchSql,
  identifierBytes,
  indexNameFor,
  nullOrphanBatchSql,
  quoteIdent,
  quoteQualified,
  sqlAction,
  validateConstraintSql,
} from '../sql';
import type { RelationSqlContext } from '../sql';

/**
 * Expected statements are written out literally.
 *
 * Deriving them by calling the builder and comparing to itself would assert only that the
 * function is deterministic. These are the statements a human would execute against
 * production, so they are pinned as text.
 */
const CTX: RelationSqlContext = {
  table: 'ImageTagForReview',
  columns: ['imageId'],
  refTable: 'Image',
  refColumns: ['id'],
  constraintName: 'ImageTagForReview_imageId_fkey',
  backupSchema: 'fk_remediation_backup',
  backupTable: 'ImageTagForReview_imageId_orphans',
  batchSize: 5000,
};

describe('identifier handling', () => {
  it('quotes and doubles an embedded quote', () => {
    expect(quoteIdent('Image')).toBe('"Image"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('rejects a NUL byte rather than escaping it', () => {
    expect(() => quoteIdent('bad\0name')).toThrow(/NUL byte/);
  });

  it('rejects an empty identifier', () => {
    expect(() => quoteIdent('')).toThrow(/empty identifier/);
  });

  it('qualifies a name with its schema', () => {
    expect(quoteQualified('fk_remediation_backup', 'T_c_orphans')).toBe(
      '"fk_remediation_backup"."T_c_orphans"'
    );
  });

  it('measures identifier length in BYTES, not characters', () => {
    // Postgres's 63 limit is bytes. A 63-character identifier of multi-byte characters is
    // over the limit and would be truncated silently.
    expect(identifierBytes('abc')).toBe(3);
    expect(identifierBytes('é')).toBe(2);
    expect(MAX_IDENTIFIER_BYTES).toBe(63);
  });

  it('follows the Prisma naming conventions', () => {
    expect(constraintNameFor('Thread', ['imageId'])).toBe('Thread_imageId_fkey');
    expect(constraintNameFor('T', ['a', 'b'])).toBe('T_a_b_fkey');
    expect(backupTableNameFor('Thread', ['imageId'])).toBe('Thread_imageId_orphans');
    expect(indexNameFor('Thread', ['imageId'])).toBe('Thread_imageId_idx');
  });
});

describe('referential actions in SQL', () => {
  it.each([
    ['Cascade', 'CASCADE'],
    ['Restrict', 'RESTRICT'],
    ['NoAction', 'NO ACTION'],
    ['SetNull', 'SET NULL'],
    ['SetDefault', 'SET DEFAULT'],
  ] as const)('spells %s as %s', (action, sql) => {
    expect(sqlAction(action)).toBe(sql);
  });

  it('keeps NoAction and Restrict distinct', () => {
    // They are different codes in Postgres and Prisma emits them distinctly. Folding them
    // together is how a Restrict relation acquires a NO ACTION constraint.
    expect(sqlAction('NoAction')).not.toBe(sqlAction('Restrict'));
  });

  it('throws rather than emitting an empty action', () => {
    expect(() => sqlAction('Frobnicate' as never)).toThrow(/No SQL spelling/);
  });
});

describe('the orphan predicate', () => {
  it('counts orphans with an anti-join, excluding NULL references', () => {
    expect(countOrphansSql(CTX)).toBe(
      'SELECT count(*)::bigint AS orphans\n' +
        '  FROM "ImageTagForReview" t\n' +
        ' WHERE t."imageId" IS NOT NULL\n' +
        '    AND NOT EXISTS (SELECT 1 FROM "Image" r WHERE r."id" = t."imageId");'
    );
  });

  it('treats a NULL reference as absent, not orphaned', () => {
    // A foreign key permits a NULL. Counting NULLs as orphans would inflate every count in
    // the plan and make a SetNull remediation set columns that are already NULL.
    expect(countOrphansSql(CTX)).toContain('IS NOT NULL');
  });

  it('requires EVERY column of a composite relation to be non-null', () => {
    const composite = { ...CTX, columns: ['a', 'b'], refColumns: ['x', 'y'] };
    const sql = countOrphansSql(composite);
    expect(sql).toContain('t."a" IS NOT NULL');
    expect(sql).toContain('t."b" IS NOT NULL');
    expect(sql).toContain('r."x" = t."a" AND r."y" = t."b"');
  });

  it('pairs referencing and referenced columns positionally', () => {
    // A composite foreign key on (a, b) referencing (x, y) is a different constraint from
    // one referencing (y, x). Sorting either list would make them indistinguishable.
    const composite = { ...CTX, columns: ['a', 'b'], refColumns: ['y', 'x'] };
    expect(countOrphansSql(composite)).toContain('r."y" = t."a" AND r."x" = t."b"');
  });
});

describe('the backup', () => {
  it('creates the schema if it does not exist', () => {
    expect(createBackupSchemaSql('fk_remediation_backup')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "fk_remediation_backup";'
    );
  });

  it('creates a column-compatible table with no constraints of its own', () => {
    // The backup must accept rows the live table would now reject, and must be cheap to
    // create on a hot table. `(LIKE t)` with no INCLUDING copies columns and types only.
    expect(createBackupTableSql(CTX)).toBe(
      'CREATE TABLE IF NOT EXISTS "fk_remediation_backup"."ImageTagForReview_imageId_orphans"\n' +
        '  (LIKE "ImageTagForReview");'
    );
    expect(createBackupTableSql(CTX)).not.toContain('INCLUDING');
  });
});

describe('the DELETE batch', () => {
  const sql = deleteOrphanBatchSql(CTX);

  it('is the exact statement, pinned', () => {
    expect(sql).toBe(
      'WITH doomed AS (\n' +
        '  SELECT t.ctid FROM "ImageTagForReview" t\n' +
        '   WHERE t."imageId" IS NOT NULL\n' +
        '    AND NOT EXISTS (SELECT 1 FROM "Image" r WHERE r."id" = t."imageId")\n' +
        '   LIMIT 5000\n' +
        '), moved AS (\n' +
        '  DELETE FROM "ImageTagForReview" t USING doomed d WHERE t.ctid = d.ctid\n' +
        '  RETURNING t.*\n' +
        ')\n' +
        'INSERT INTO "fk_remediation_backup"."ImageTagForReview_imageId_orphans" SELECT * FROM moved;'
    );
  });

  it('backs the rows up in the SAME statement that deletes them', () => {
    // Not "backs up first, then deletes": there is no interleaving in which rows are gone
    // and not preserved, because there is only one statement.
    const deleteAt = sql.indexOf('DELETE FROM');
    const insertAt = sql.indexOf('INSERT INTO');
    expect(deleteAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(sql).toContain('RETURNING t.*');
    expect(sql.slice(deleteAt, insertAt)).toContain('RETURNING');
  });

  it('is bounded so it cannot hold one long transaction', () => {
    expect(sql).toContain('LIMIT 5000');
    expect(deleteOrphanBatchSql({ ...CTX, batchSize: 100 })).toContain('LIMIT 100');
  });
});

describe('the SET NULL batch', () => {
  const sql = nullOrphanBatchSql(CTX);

  it('is the exact statement, pinned', () => {
    expect(sql).toBe(
      'WITH doomed AS (\n' +
        '  SELECT t.ctid FROM "ImageTagForReview" t\n' +
        '   WHERE t."imageId" IS NOT NULL\n' +
        '    AND NOT EXISTS (SELECT 1 FROM "Image" r WHERE r."id" = t."imageId")\n' +
        '   LIMIT 5000\n' +
        '), saved AS (\n' +
        '  INSERT INTO "fk_remediation_backup"."ImageTagForReview_imageId_orphans"\n' +
        '  SELECT t.* FROM "ImageTagForReview" t JOIN doomed d ON t.ctid = d.ctid\n' +
        ')\n' +
        'UPDATE "ImageTagForReview" t SET "imageId" = NULL FROM doomed d WHERE t.ctid = d.ctid;'
    );
  });

  it('contains no DELETE at all', () => {
    // The whole point. A SET NULL path that also deletes is the bug this module was built
    // to remove.
    expect(sql).not.toContain('DELETE');
  });

  it('preserves the pre-update row, because SET NULL destroys the old value too', () => {
    expect(sql).toContain('INSERT INTO "fk_remediation_backup"');
  });

  it('nulls every column of a composite relation', () => {
    expect(nullOrphanBatchSql({ ...CTX, columns: ['a', 'b'], refColumns: ['x', 'y'] })).toContain(
      'SET "a" = NULL, "b" = NULL'
    );
  });
});

describe('adding the constraint', () => {
  it('is NOT VALID, so it takes no scan-length lock', () => {
    expect(addConstraintNotValidSql(CTX, 'Cascade', 'Cascade')).toBe(
      'ALTER TABLE "ImageTagForReview" ADD CONSTRAINT "ImageTagForReview_imageId_fkey"\n' +
        '  FOREIGN KEY ("imageId") REFERENCES "Image"("id")\n' +
        '  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;'
    );
  });

  it('carries the DECLARED actions, not a fixed pair', () => {
    expect(addConstraintNotValidSql(CTX, 'SetNull', 'Cascade')).toContain(
      'ON UPDATE CASCADE ON DELETE SET NULL NOT VALID'
    );
    expect(addConstraintNotValidSql(CTX, 'Restrict', 'NoAction')).toContain(
      'ON UPDATE NO ACTION ON DELETE RESTRICT NOT VALID'
    );
  });

  it('validates as a SEPARATE statement', () => {
    // Combining the two takes ACCESS EXCLUSIVE for the whole scan; splitting them means
    // VALIDATE runs under SHARE UPDATE EXCLUSIVE and reads and writes continue.
    expect(validateConstraintSql(CTX)).toBe(
      'ALTER TABLE "ImageTagForReview" VALIDATE CONSTRAINT "ImageTagForReview_imageId_fkey";'
    );
    expect(addConstraintNotValidSql(CTX, 'Cascade', 'Cascade')).not.toContain('VALIDATE');
    expect(validateConstraintSql(CTX)).not.toContain('NOT VALID');
  });
});

describe('the index prerequisite statement', () => {
  it('is CONCURRENTLY and idempotent', () => {
    expect(createIndexConcurrentlySql(CTX, 'ImageTagForReview_imageId_idx')).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImageTagForReview_imageId_idx"\n' +
        '  ON "ImageTagForReview" ("imageId");'
    );
  });
});
