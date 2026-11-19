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
      (1, 'key-1', 1, 1), (2, 'key-2', 4, 1), (3, 'key-3', 1, 1), (4, 'key-4', 4, 1);
  `);
  await pg.query(
    `INSERT INTO "KnightsRatingGuideItem" VALUES
       (10, $1, 3, 'ACCEPTED', '2026-01-01'), (11, $1, 1, 'ACCEPTED', '2026-01-02'),
       (12, $1, 4, 'REVIEW', '2026-01-03')`,
    [RATING_GUIDE_COLLECTION_ID]
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
    expect(examples[1].map((e) => e.id)).toEqual([3, 1]);
  });
});
