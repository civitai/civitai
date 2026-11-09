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

const { getComments, getCommentsV2 } = await import('../user-account.service');

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

describe("a user's comment lists, which moderators bulk-delete and flag by id", () => {
  it('lists every live model comment by its CommentV3 id, old or new, and no tombstone', async () => {
    const { items } = await getComments(10);
    expect(items.map((r) => [r.id, r.modelId])).toEqual([
      [2, 70],
      [1, 70],
    ]);
  });

  it('lists everything else under the other comments', async () => {
    const { items } = await getCommentsV2(10);
    expect(items.map((r) => [r.id, r.entityType])).toEqual([[3, 'image']]);
  });
});
