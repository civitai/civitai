import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ImagesFeed } from '@/common/feeds/images.feed';

type FeedArgs = ConstructorParameters<typeof ImagesFeed>;

// The image_sort_at the Image trigger uses, from the one file that defines it.
const TRIGGERS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql'
);
const imageSortAtSql = () => {
  const match = readFileSync(TRIGGERS, 'utf8').match(
    /CREATE OR REPLACE FUNCTION image_sort_at\([\s\S]*?\$\$;/
  );
  if (!match) throw new Error('image_sort_at not found in image_post_triggers.sql');
  return match[0];
};

describe('image feed document sortAt, against the real query', () => {
  test('a released held image sorts at its first-visible time; others keep GREATEST', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3), availability text,
        "modelVersionId" int);
      CREATE TABLE "Image" (id int PRIMARY KEY, index int, "postId" int, url text,
        "nsfwLevel" int, "aiNsfwLevel" int, "nsfwLevelLocked" boolean, width int, height int,
        hash text, "hideMeta" boolean, type text, "userId" int, "needsReview" text,
        "blockedFor" text, minor boolean, poi boolean, "acceptableMinor" boolean, meta jsonb,
        "createdAt" timestamp(3), "scannedAt" timestamp(3), "firstVisibleAt" timestamp(3));
      CREATE TABLE "ImageTool" ("imageId" int, "toolId" int);
      CREATE TABLE "ImageTechnique" ("imageId" int, "techniqueId" int);
      CREATE TABLE "Model" (id int, type text, poi boolean);
      CREATE TABLE "ModelVersion" (id int, "modelId" int, "baseModel" text);
      CREATE TABLE "ImageResourceNew" ("imageId" int, "modelVersionId" int, detected boolean);
      ${imageSortAtSql()}
      INSERT INTO "Post" VALUES (1, '2026-01-01 00:00:00', 'Public', NULL);
      INSERT INTO "Image" (id, index, "postId", url, "nsfwLevel", "aiNsfwLevel", "nsfwLevelLocked",
        width, height, hash, "hideMeta", type, "userId", minor, poi, "acceptableMinor",
        "createdAt", "scannedAt", "firstVisibleAt")
      VALUES
        -- held from upload, released by a moderator three days after publish
        (1, 0, 1, 'a', 1, 1, false, 1, 1, 'h', false, 'image', 7, false, false, false,
          '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-04 00:00:00'),
        -- no firstVisibleAt (a row from before the column): the old GREATEST, here scannedAt
        (2, 1, 1, 'b', 1, 1, false, 1, 1, 'h', false, 'image', 7, false, false, false,
          '2025-12-31 00:00:00', '2026-01-02 00:00:00', NULL);
    `);

    try {
      const feed = new ImagesFeed(
        (() => ({ getIndex: () => new Promise(() => {}) })) as unknown as FeedArgs[0],
        {} as FeedArgs[1],
        pg as unknown as FeedArgs[2],
        { fetch: async () => ({}) } as unknown as FeedArgs[3],
        { fetch: async () => ({}) } as unknown as FeedArgs[4]
      );
      const docs = await feed.createDocuments([1, 2]);
      const sortAt = Object.fromEntries(docs.map((d) => [d.id, d.sortAtUnix]));
      expect(sortAt).toEqual({
        1: Date.UTC(2026, 0, 4),
        2: Date.UTC(2026, 0, 2),
      });
    } finally {
      await pg.close();
    }
  });
});
