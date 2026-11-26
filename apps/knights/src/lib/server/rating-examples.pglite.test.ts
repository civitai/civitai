import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';

vi.mock('$env/dynamic/private', () => ({ env: { IMAGE_LOCATION: 'https://cdn.test' } }));

const { RATING_GUIDE_COLLECTION_ID, ratingExamples } = await import('./rating-examples');

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await pg.exec(`
    CREATE TABLE "KnightsRatingGuideItem" (
      "id" INTEGER PRIMARY KEY, "collectionId" INTEGER NOT NULL, "imageId" INTEGER NOT NULL,
      "status" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL
    );
    CREATE TABLE "CollectionItem" (
      "id" INTEGER PRIMARY KEY, "collectionId" INTEGER NOT NULL, "imageId" INTEGER,
      "status" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL
    );
    INSERT INTO "Post" ("id", "publishedAt") VALUES (1, '2020-01-01');
    INSERT INTO "Image" ("id", "url", "nsfwLevel", "postId") VALUES
      (1, 'key-1', 1, 1), (2, 'key-2', 4, 1), (3, 'key-3', 1, 1), (4, 'key-4', 4, 1),
      (5, 'key-5', 1, 1), (6, 'key-6', 1, 1), (7, 'key-7', 2, 1);
  `);
  // Ids run against createdAt, rows 10 and 11 tie on createdAt, and insertion order is neither.
  await pg.query(
    `INSERT INTO "KnightsRatingGuideItem" VALUES
       (11, $1, 5, 'ACCEPTED', '2026-01-03'), (30, $1, 3, 'ACCEPTED', '2026-01-01'),
       (12, $1, 4, 'REVIEW', '2026-01-01'), (10, $1, 6, 'ACCEPTED', '2026-01-03'),
       (20, $1, 1, 'ACCEPTED', '2026-01-02'), (40, $2, 7, 'ACCEPTED', '2026-01-01')`,
    [RATING_GUIDE_COLLECTION_ID, RATING_GUIDE_COLLECTION_ID + 1]
  );
  // The collection table itself holds something else: the guide must not read it.
  await pg.query(`INSERT INTO "CollectionItem" VALUES (20, $1, 2, 'ACCEPTED', '2026-01-01')`, [
    RATING_GUIDE_COLLECTION_ID,
  ]);
});
afterAll(() => pg.close());

describe('ratingExamples', () => {
  it('reads accepted examples from the rating guide view, in its order', async () => {
    const examples = await ratingExamples(db, 0);

    expect(Object.keys(examples)).toEqual(['1']);
    expect(examples[1].map((e) => e.id)).toEqual([3, 1, 6, 5]);
  });

  it('keeps the last examples through failed reads for 30 minutes, then shows none', async () => {
    const minute = 60_000;
    const read = 1_000_000_000;
    expect(Object.keys(await ratingExamples(db, read))).toEqual(['1']);
    await pg.exec(`ALTER TABLE "KnightsRatingGuideItem" RENAME TO "KnightsRatingGuideItemGone"`);
    try {
      expect(Object.keys(await ratingExamples(db, read + 11 * minute))).toEqual(['1']);
      expect(Object.keys(await ratingExamples(db, read + 29 * minute))).toEqual(['1']);
      expect(await ratingExamples(db, read + 31 * minute)).toEqual({});
    } finally {
      await pg.exec(`ALTER TABLE "KnightsRatingGuideItemGone" RENAME TO "KnightsRatingGuideItem"`);
    }
  });
});
