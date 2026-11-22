import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// A blocked-level tag puts its image on a tag-review hold, which drops it from the main app's
// collection reads, so the main app's home blocks are told (src/pages/api/internal/home-block-evict.ts).

vi.setConfig({ hookTimeout: 60_000 });

const dbHandle = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('$env/dynamic/private', () => ({
  env: { WEBHOOK_TOKEN: 'test-token', CIVITAI_APP_URL: 'https://main.test' },
}));
vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../redis', () => ({ getRedis: () => ({ get: async () => '[]' }) }));
vi.mock('../search-index', () => ({ syncSearchIndexBulk: vi.fn() }));
vi.mock('../cache', () => ({ bustImageTagCaches: vi.fn() }));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', () => ({ invalidateThumbnails: vi.fn(async () => undefined) }));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));

const { upsertTagsOnImageNew } = await import('../tags-on-image.service');

const BLOCKED = 32;
const SCHEMA = `
CREATE TYPE "TagSource" AS ENUM ('User', 'Computed');
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "nsfwLevel" INTEGER NOT NULL);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "needsReview" TEXT,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
  "blockedFor" TEXT,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "TagsOnImageDetails" (
  "imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("imageId", "tagId")
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER, PRIMARY KEY ("imageId", "tagId"));
CREATE FUNCTION upsert_tag_on_image(
  "imageId" INTEGER, "tagId" INTEGER, "source" "TagSource", "confidence" INTEGER,
  "automated" BOOLEAN, "disabled" BOOLEAN, "needsReview" BOOLEAN
) RETURNS VOID LANGUAGE SQL AS $$
  INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", "disabled")
  VALUES ($1, $2, COALESCE($6, FALSE)) ON CONFLICT DO NOTHING;
$$;
-- Raises an image to Blocked when it carries an enabled blocked-level tag, as the real one does.
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" i SET "nsfwLevel" = ${BLOCKED}
  WHERE i.id = ANY(ids) AND NOT i."nsfwLevelLocked" AND EXISTS (
    SELECT 1 FROM "TagsOnImageDetails" toi JOIN "Tag" t ON t.id = toi."tagId"
    WHERE toi."imageId" = i.id AND NOT toi.disabled AND t."nsfwLevel" = ${BLOCKED});
$$;
`;

let db: PGlite;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));
const refreshed = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/api/internal/home-block-evict'))
    .map(([, init]) => JSON.parse(String(init?.body)).imageIds as number[]);
const q = async <T>(text: string) => (await db.query<T>(text)).rows;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});
afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Tag", "Image", "TagsOnImageDetails", "ImageTagForReview";
    INSERT INTO "Tag" VALUES (2, ${BLOCKED}), (5, 1);
    -- 1 is free to hold; 3 is already held in another queue.
    INSERT INTO "Image" ("id", "needsReview") VALUES (1, NULL), (3, 'minor'), (4, NULL);
  `);
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('a blocked-level tag write', () => {
  it('queues the same tag reviews, and refreshes the home blocks of the image it held', async () => {
    await upsertTagsOnImageNew([
      { imageId: 1, tagId: 2 },
      { imageId: 3, tagId: 2 },
      { imageId: 4, tagId: 5 },
    ]);

    expect(await q(`SELECT "imageId", "tagId" FROM "ImageTagForReview" ORDER BY 1, 2`)).toEqual([
      { imageId: 1, tagId: 2 },
    ]);
    expect(await q(`SELECT id, "needsReview" FROM "Image" ORDER BY id`)).toEqual([
      { id: 1, needsReview: 'tag' },
      { id: 3, needsReview: 'minor' },
      { id: 4, needsReview: null },
    ]);
    expect(refreshed()).toEqual([[1]]);
  });

  it('still refreshes an image whose tag review was already queued', async () => {
    await db.exec(`INSERT INTO "ImageTagForReview" VALUES (1, 2)`);

    await upsertTagsOnImageNew([{ imageId: 1, tagId: 2 }]);

    expect(await q(`SELECT "imageId", "tagId" FROM "ImageTagForReview"`)).toEqual([
      { imageId: 1, tagId: 2 },
    ]);
    expect(refreshed()).toEqual([[1]]);
  });

  it('refreshes nothing when no image is held', async () => {
    await upsertTagsOnImageNew([{ imageId: 4, tagId: 5 }]);

    expect(await q(`SELECT 1 FROM "ImageTagForReview"`)).toEqual([]);
    expect(refreshed()).toEqual([]);
  });
});
