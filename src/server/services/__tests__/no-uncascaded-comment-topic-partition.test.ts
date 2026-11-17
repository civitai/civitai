import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every CommentTopic partition a migration adds must add its cascading `entityId` key with it: an
 * entity's delete then takes its comments, rather than leaving them readable by id, permalink or
 * notification with nothing to hang off. The partitions the schema migration creates are checked
 * against a real database in comment-topic-cascade.sql.behavior.test.ts.
 */

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);

// A partition created in a DO loop names its table through `format('… %I …')`; its key is added the
// same way, so a file with one must carry the other.
const FORMAT_PARTITION = /format\(\s*'CREATE TABLE %I PARTITION OF "CommentTopic"/;
const FORMAT_CASCADE =
  /format\(\s*'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY \("entityId"\) REFERENCES [^']*ON DELETE CASCADE'/;
const LOOP_PARTITIONS = 'format() partitions';

const partitionsNamedIn = (sql: string) => [
  ...[...sql.matchAll(/"(CommentTopic_\w+)" PARTITION OF "CommentTopic"/g)].map((m) => m[1]),
  ...(FORMAT_PARTITION.test(sql) ? [LOOP_PARTITIONS] : []),
];
const partitionsWithoutCascade = (sql: string) =>
  partitionsNamedIn(sql).filter((name) =>
    name === LOOP_PARTITIONS
      ? !FORMAT_CASCADE.test(sql)
      : !new RegExp(
          `ALTER TABLE "${name}"[^;]*FOREIGN KEY \\("entityId"\\) REFERENCES [^;]*ON DELETE CASCADE`
        ).test(sql)
  );

describe('no CommentTopic partition without a cascading entity key', () => {
  it('flags a partition added without one (positive control)', () => {
    expect(
      partitionsWithoutCascade(
        `CREATE TABLE "CommentTopic_x" PARTITION OF "CommentTopic" FOR VALUES IN ('x');`
      )
    ).toEqual(['CommentTopic_x']);
  });

  it('flags partitions a DO loop creates through format() without one (positive control)', () => {
    const create = `EXECUTE format('CREATE TABLE %I PARTITION OF "CommentTopic" FOR VALUES IN (%L)', 'CommentTopic_' || t, t);`;
    expect(partitionsWithoutCascade(create)).toEqual([LOOP_PARTITIONS]);
    expect(
      partitionsWithoutCascade(
        `${create}
         EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("entityId") REFERENCES %I (%I) ON DELETE CASCADE', a, b, c, d);`
      )
    ).toEqual([]);
  });

  it('finds none in the migrations', () => {
    let scanned = 0;
    const named = readdirSync(MIGRATIONS).flatMap((dir) => {
      let sql: string;
      try {
        sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
      } catch {
        return [];
      }
      scanned += partitionsNamedIn(sql).length;
      return partitionsWithoutCascade(sql).map((name) => `${dir}: ${name}`);
    });
    // A floor (the schema migration's loop and the storyline partition): a moved migrations
    // directory or a changed declaration shape would otherwise scan nothing and pass.
    expect(scanned).toBeGreaterThanOrEqual(2);
    expect(named).toEqual([]);
  });
});
