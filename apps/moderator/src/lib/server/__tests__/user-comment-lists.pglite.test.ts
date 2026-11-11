import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));

const { getComments } = await import('../user-account.service');

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "CommentV3" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL,
      "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, "content" TEXT NOT NULL,
      "tosViolation" BOOLEAN NOT NULL DEFAULT false, "legacyV1Id" INTEGER,
      "deletedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL);
    INSERT INTO "CommentV3" VALUES
      -- A model comment from before the flip, and one written on CommentV3 since (no old id).
      (1, 10, 'model', 70, 'old model', false, 501, NULL, '2026-10-01'),
      (2, 10, 'model', 70, 'new model', false, NULL, NULL, '2026-11-08'),
      (3, 10, 'image', 80, 'on an image', false, NULL, NULL, '2026-11-07'),
      (4, 10, 'model', 70, '', false, NULL, '2026-11-08', '2026-11-06'),
      (5, 11, 'model', 70, 'someone else', false, NULL, NULL, '2026-11-08');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe("a user's comment list, which moderators bulk-delete and flag by id", () => {
  it('lists every live comment on any surface by its CommentV3 id, newest first, and no tombstone', async () => {
    const { items } = await getComments(10);
    expect(items.map((r) => [r.id, r.entityType, r.entityId])).toEqual([
      [2, 'model', 70],
      [3, 'image', 80],
      [1, 'model', 70],
    ]);
  });

  it('says when it stopped short', async () => {
    const { items, truncated } = await getComments(10, 2);
    expect(items.map((r) => r.id)).toEqual([2, 3]);
    expect(truncated).toBe(true);
  });

  it('pages through the whole history from the cursor each page hands back', async () => {
    const first = await getComments(10, 2);
    const second = await getComments(10, 2, first.next!);
    expect(second.items.map((r) => r.id)).toEqual([1]);
    expect(second.next).toBeNull();
  });

  it('breaks a createdAt tie on id rather than skipping the rows that share it', async () => {
    await db.exec(`INSERT INTO "CommentV3" VALUES
      (6, 10, 'image', 81, 'same instant', false, NULL, NULL, '2026-11-07 00:00:00.000123'),
      (7, 10, 'image', 82, 'same instant', false, NULL, NULL, '2026-11-07 00:00:00.000123')`);
    const first = await getComments(10, 2);
    const rest = await getComments(10, 50, first.next!);
    expect([...first.items, ...rest.items].map((r) => r.id)).toEqual([2, 7, 6, 3, 1]);
  });

  it('still finds the next page when the comment it ended on has since been deleted', async () => {
    const first = await getComments(10, 2);
    await db.exec(`DELETE FROM "CommentV3" WHERE id = ${first.items.at(-1)!.id}`);
    const rest = await getComments(10, 2, first.next!);
    expect(rest.items.map((r) => r.id)).toEqual([1]);
  });
});
