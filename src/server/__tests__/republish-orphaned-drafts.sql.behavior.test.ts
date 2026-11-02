import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishOrphanedDraftSql } from '~/pages/api/admin/temp/republish-orphaned-drafts';

/**
 * The endpoint picks its candidates on the replica, so its publish re-checks each on the primary: a
 * model published, deleted or kept by a content wipe since then stays as it is.
 */

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, status text NOT NULL, "publishedAt" timestamp(3), "deletedAt" timestamp(3),
      meta jsonb
    );
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Model";
    INSERT INTO "Model" (id, status, "deletedAt", meta) VALUES
      (1, 'Draft', NULL, '{}'),
      (2, 'Draft', NULL, '{"removedWithOwner": true, "statusBeforeRemoval": "Draft"}'),
      (3, 'Published', NULL, '{}'),
      (4, 'Draft', now(), '{}');
  `);
});

const publish = async (id: number) => {
  const sql = publishOrphanedDraftSql(id, new Date('2026-10-01T00:00:00Z'));
  return (await db.query(sql.text, sql.values)).affectedRows;
};

describe('publishing an orphaned draft', () => {
  it('publishes an undeleted draft with no record (control)', async () => {
    expect(await publish(1)).toBe(1);
    expect((await db.query(`SELECT status FROM "Model" WHERE id = 1`)).rows).toEqual([
      { status: 'Published' },
    ]);
  });

  it.each([
    ['a content wipe kept since', 2],
    ['already published', 3],
    ['deleted', 4],
  ])('leaves a model %s as it is', async (_, id) => {
    const before = (await db.query(`SELECT * FROM "Model" WHERE id = ${id}`)).rows;
    expect(await publish(id)).toBe(0);
    expect((await db.query(`SELECT * FROM "Model" WHERE id = ${id}`)).rows).toEqual(before);
  });
});
