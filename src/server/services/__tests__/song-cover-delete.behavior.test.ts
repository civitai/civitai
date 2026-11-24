import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * Deleting a song deletes its cover, through the real `deleteImages` and `deletePost`, whose SQL runs
 * on PGlite with the `Track` link and its cascade. A cover under a hold is kept and blocked. The rule:
 * docs/features/music.md, "A generated song's cover" (cover cleanup).
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { deleteImages, deleteImagesWithOutcome } from '~/server/services/image.service';
import { deletePost } from '~/server/services/post.service';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';

const OWNER = 5;
const MODERATOR = 99;
const SONG = 1;
const POST = 10;
const COVER = 2;
const owner = { id: OWNER, isModerator: false };
const moderator = { id: MODERATOR, isModerator: true };

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3));
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), metadata jsonb);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL, "postId" int REFERENCES "Post"(id) ON DELETE SET NULL,
      "nsfwLevel" int NOT NULL DEFAULT 1, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "blockedFor" text, metadata jsonb, "updatedAt" timestamp(3)
    );
    CREATE TABLE "Track" (
      "imageId" int PRIMARY KEY REFERENCES "Image"(id) ON DELETE CASCADE,
      "coverImageId" int REFERENCES "Image"(id) ON DELETE SET NULL
    );
    CREATE TABLE "EvidenceHoldImage" ("imageId" int, "userId" int, "postId" int);
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM (
      'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel', 'PendingDelete', 'BlockedImageDelete'
    );
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await pg.exec(imageUseTablesSql);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  // Only the statements on the rows under test reach Postgres; the rest (collections, open
  // reports, avatars) find nothing.
  const run = async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...(values as never[]))
      : (strings as Prisma.Sql);
    if (
      !/DELETE FROM "(Image|Post)"|AS deletable|"Track"|"EvidenceHoldImage"|"JobQueue"/.test(
        sql.text
      )
    )
      return [];
    return (await pg.query(sql.text, sql.values as unknown[])).rows;
  };
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(run as never);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(run as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (fn: unknown) =>
    (fn as (tx: unknown) => unknown)(dbMock.dbWrite)) as never);

  await pg.exec(`
    TRUNCATE "Track", "Image", "Post", "JobQueue", "EvidenceHoldImage", "CsamQueueSetAside";
    INSERT INTO "Post" (id, "userId") VALUES (${POST}, ${OWNER});
    INSERT INTO "Image" (id, "userId", url, "postId", metadata) VALUES
      (${SONG}, ${OWNER}, 'song', ${POST}, NULL),
      (${COVER}, ${OWNER}, 'cover', NULL, '{"parentId": ${SONG}}');
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES (${SONG}, ${COVER});
  `);
});

const remaining = async () =>
  (await pg.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map((r) => r.id);
const queuedFiles = async () =>
  (
    await pg.query<{ url: string }>(
      `SELECT data->>'url' AS url FROM "JobQueue" WHERE type = 'ImageStorageDelete' ORDER BY url`
    )
  ).rows.map((r) => r.url);
const imageRow = async (id: number) =>
  (
    await pg.query<{ ingestion: string; nsfwLevel: number }>(
      `SELECT ingestion::text, "nsfwLevel" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe.each([
  ['its owner', () => deleteImages([SONG], { actor: owner })],
  ['a moderator', () => deleteImages([SONG], { actor: moderator })],
  ['a system job', () => deleteImages([SONG], { actor: { system: 'test' } })],
  ['its owner deleting the post', () => deletePost({ id: POST, actor: owner })],
])('a song deleted by %s', (_, remove) => {
  it('deletes its cover and the cover file with it', async () => {
    await remove();
    expect(await remaining()).toEqual([]);
    expect(await queuedFiles()).toEqual(['cover', 'song']);
  });
});

describe('a song delete', () => {
  it('returns the cover among the deleted images', async () => {
    const { deleted } = await deleteImagesWithOutcome([SONG], { actor: owner });
    expect(deleted.map((row) => row.id).sort()).toEqual([SONG, COVER]);
  });

  it('keeps a cover under a hold, blocked', async () => {
    await pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${COVER}`);
    const { kept } = await deleteImagesWithOutcome([SONG], { actor: owner });
    expect(await remaining()).toEqual([COVER]);
    expect(kept).toEqual([COVER]);
    expect(await imageRow(COVER)).toEqual({ ingestion: 'Blocked', nsfwLevel: 32 });
    expect(await queuedFiles()).toEqual(['song']);
  });

  it('leaves the cover of a song its hold keeps', async () => {
    await pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${SONG}`);
    await deleteImages([SONG], { actor: owner });
    expect(await remaining()).toEqual([SONG, COVER]);
    expect(await imageRow(COVER)).toEqual({ ingestion: 'Scanned', nsfwLevel: 1 });
  });

  it("leaves another song's linked image that names this song as its parent", async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, "userId", url, metadata) VALUES
        (6, ${OWNER}, 'song-6', NULL), (3, ${OWNER}, 'other', '{"parentId": ${SONG}}');
      INSERT INTO "Track" ("imageId", "coverImageId") VALUES (6, 3);
    `);
    await deleteImages([6], { actor: owner });
    expect(await remaining()).toEqual([SONG, COVER, 3]);
  });

  it('leaves a linked image that is in a post', async () => {
    await pg.exec(`UPDATE "Image" SET "postId" = ${POST} WHERE id = ${COVER}`);
    await deleteImages([SONG], { actor: owner });
    expect(await remaining()).toEqual([COVER]);
  });

  it('deletes a song listed with its own cover once', async () => {
    const { deleted } = await deleteImagesWithOutcome([SONG, COVER], { actor: owner });
    expect(deleted.map((row) => row.id).sort()).toEqual([SONG, COVER]);
    expect(await queuedFiles()).toEqual(['cover', 'song']);
  });

  it('keeps a held cover listed with its song once', async () => {
    await pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${COVER}`);
    const { deleted, kept } = await deleteImagesWithOutcome([SONG, COVER], { actor: owner });
    expect(deleted.map((row) => row.id)).toEqual([SONG]);
    expect(kept).toEqual([COVER]);
  });

  it('leaves a linked image that was not made for the song', async () => {
    await pg.exec(`UPDATE "Image" SET metadata = NULL WHERE id = ${COVER}`);
    await deleteImages([SONG], { actor: owner });
    expect(await remaining()).toEqual([COVER]);
  });

  it("leaves a linked image of another user's", async () => {
    await pg.exec(`UPDATE "Image" SET "userId" = 6 WHERE id = ${COVER}`);
    await deleteImages([SONG], { actor: moderator });
    expect(await remaining()).toEqual([COVER]);
  });
});

describe('an image delete', () => {
  it('deletes only the image, not an image naming it as its parent', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, "userId", url, metadata) VALUES
        (4, ${OWNER}, 'video', NULL), (5, ${OWNER}, 'thumb', '{"parentId": 4}');
    `);
    const deleted = await deleteImages([4], { actor: owner });
    expect(deleted.map((row) => row.id)).toEqual([4]);
    expect(await remaining()).toEqual([SONG, COVER, 5]);
  });
});
