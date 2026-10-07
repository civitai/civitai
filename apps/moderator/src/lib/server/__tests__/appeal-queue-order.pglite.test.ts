import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { walkPages } from './keyset-walk.harness';

/**
 * The appeals queue is worked oldest APPEAL first, and paging through it reaches every appeal.
 *
 * Seeded so the two orders disagree: the oldest appeal is on the oldest image. Ordering by image id
 * descending (what this queue did until 2026-10-07) serves the reverse of what these tests expect.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// The tosReason lookup is wrapped in a try/catch, so a client with no `query` is a failed lookup.
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { getAppealImageQueue } = await import('../image-review.service');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL DEFAULT 'u',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "width" INTEGER,
  "height" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'image',
  "needsReview" TEXT,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "blockedFor" TEXT,
  "userId" INTEGER NOT NULL
);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "appealMessage" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ModActivity" (
  "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, "activity" TEXT, "createdAt" TIMESTAMP(3)
);
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER, "reason" TEXT, "status" TEXT, "details" JSONB,
  "createdAt" TIMESTAMP(3)
);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
`;

// Image 101 carries the oldest appeal, so newest-image-first would serve it last.
const IMAGES_BY_APPEAL_AGE = [101, 102, 103, 104, 105];

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.query(`INSERT INTO "User" ("id", "username") VALUES (7, 'appellant')`);
  for (const [days, imageId] of IMAGES_BY_APPEAL_AGE.entries()) {
    await db.query(
      `INSERT INTO "Image" ("id", "needsReview", "blockedFor", "userId") VALUES ($1, 'appeal', 'moderated', 7)`,
      [imageId]
    );
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId", "createdAt")
       VALUES (7, 'Image', $1, TIMESTAMP '2026-09-01' + make_interval(days => $2))`,
      [imageId, days]
    );
  }
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const walk = (limit: number) =>
  walkPages((cursor?: number) => getAppealImageQueue({ browsingLevel: 1, cursor, limit }));

describe('appeal queue order', () => {
  it('serves the oldest appeal first, not the newest image', async () => {
    const { items } = await getAppealImageQueue({ browsingLevel: 1, limit: 10 });

    expect(items.map((i) => i.id)).toEqual(IMAGES_BY_APPEAL_AGE);
  });

  // Page boundaries are where an item goes missing: the cursor is exclusive, so it must be the last
  // row shown and never the extra row fetched to detect a next page.
  it.each([1, 2, 3, 4])('reaches every appeal exactly once at %i per page', async (limit) => {
    expect(await walk(limit)).toEqual(IMAGES_BY_APPEAL_AGE);
  });
});
