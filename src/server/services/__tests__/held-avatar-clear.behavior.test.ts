import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  servablePictureParameters,
  servablePictureText,
} from '@civitai/db-queries/profile-picture-clear';
import {
  clearHeldUserImages,
  clearUserImageKeys,
  getPictureUserIds,
  userImageKeyPlan,
} from '~/server/services/held-image-keys';

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  },
  $queryRawUnsafe: (text: string, ...values: unknown[]) =>
    pg.query(text, values).then((r) => r.rows),
} as never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1, "userId" int NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      metadata jsonb, "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb,
      "modelRestricted" boolean NOT NULL DEFAULT false, "blockedFor" text
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int, image text, meta jsonb);
    CREATE TABLE "JobQueue" ("entityId" int NOT NULL, "entityType" text NOT NULL, type text NOT NULL);
  `);
});
beforeEach(() => pg.exec('TRUNCATE "Image", "User", "JobQueue"'));
afterAll(() => pg.close());

const user = async (id: number) =>
  (
    await pg.query<{ image: string | null; meta: unknown }>(
      'SELECT image, meta FROM "User" WHERE id = $1',
      [id]
    )
  ).rows[0];

const pictureServable = async (userId: number) =>
  (
    await pg.query<{ servable: boolean }>(
      `SELECT ${servablePictureText} AS servable FROM "User" u JOIN "Image" i ON i.id = u."profilePictureId" WHERE u.id = $1`,
      [userId, ...servablePictureParameters]
    )
  ).rows[0]?.servable ?? false;

describe('a User.image cleared by a hold', () => {
  it('🔴 stays empty once the hold lifts, and the picture serves the avatar', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", "needsReview") VALUES (1, 'key-1', 1, 'minor');
      INSERT INTO "User" VALUES (1, 1, 'key-1', '{"keep": true}');
    `);
    expect(await clearHeldUserImages(db, [1])).toEqual([1]);
    expect(await pictureServable(1)).toBe(false);
    await pg.exec(`UPDATE "Image" SET "needsReview" = NULL WHERE id = 1`);
    // Another refresh after the lift writes nothing back.
    expect(await clearHeldUserImages(db, [1])).toEqual([]);
    expect(await user(1)).toEqual({ image: null, meta: { keep: true } });
    expect(await pictureServable(1)).toBe(true);
  });
});

describe('a User.image naming a blocked profile picture', () => {
  it('is cleared for each block marker, leaving meta as it was, and nothing else is', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "nsfwLevel", "blockedFor") VALUES
        (1, 'key-1', 1, 'Blocked', 1, NULL),
        (2, 'key-2', 2, 'Scanned', 32, NULL),
        (3, 'key-3', 3, 'Rescan', 1, 'tos'),
        (4, 'key-4', 4, 'Blocked', 1, NULL),
        (5, 'key-5', 5, 'Scanned', 1, NULL),
        (6, 'key-6', 6, 'Blocked', 1, NULL),
        (7, '', 7, 'Blocked', 1, NULL);
      INSERT INTO "User" VALUES
        (1, 1, 'https://cdn.example/KEY-1/width=96', '{"keep": true}'),
        (2, 2, 'key%2d2', NULL),
        (3, 3, 'key-3', '{}'),
        (4, 4, 'legacy-other', '{}'),
        (5, 5, 'key-5', '{}'),
        (6, 6, 'key-6', '{}'),
        (7, 7, 'any-value', '{}');
    `);
    expect((await clearHeldUserImages(db, [1, 2, 3, 4, 5, 7])).sort()).toEqual([1, 2, 3, 4, 7]);
    expect(await user(1)).toEqual({ image: null, meta: { keep: true } });
    expect(await user(2)).toEqual({ image: null, meta: null });
    expect(await user(3)).toEqual({ image: null, meta: {} });
    // A value naming another key, an unblocked picture, and a user not passed are kept.
    expect(await user(4)).toEqual({ image: 'legacy-other', meta: {} });
    expect(await user(5)).toEqual({ image: 'key-5', meta: {} });
    expect(await user(6)).toEqual({ image: 'key-6', meta: {} });
    // A picture with an empty url names nothing.
    expect(await user(7)).toEqual({ image: 'any-value', meta: {} });
  });
});

describe("a User.image naming another of the user's own images", () => {
  const OLD_KEY = '3f6e2a10-9b4c-4d7e-8a21-6c0b5d9e1f42';
  // Upper-case and CDN-wrapped, as a stored url may be; the match lowercases it.
  const staleKey = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${OLD_KEY.toUpperCase()}/width=96`;
  const seed = async (oldImage: string, image: string, owner = 1, storedUrl = OLD_KEY) =>
    pg.exec(`
      INSERT INTO "Image" (id, url, "userId") VALUES (1, 'key-1', 1);
      INSERT INTO "Image" (id, url, "userId") VALUES (2, '${storedUrl}', ${owner});
      UPDATE "Image" SET ${oldImage} WHERE id = 2;
      INSERT INTO "User" VALUES (1, 1, '${image}', NULL);
    `);

  it.each([
    ['held', `"needsReview" = 'minor'`],
    ['blocked', `"blockedFor" = 'tos'`],
    ['at the Blocked level', `"nsfwLevel" = 32`],
  ])('🔴 is cleared when that image is %s', async (_state, set) => {
    await seed(set, staleKey);
    expect(await clearHeldUserImages(db, [1])).toEqual([1]);
    expect(await user(1)).toEqual({ image: null, meta: null });
  });

  it('is left when that image is neither held nor blocked (control)', async () => {
    await seed(`"nsfwLevel" = 1`, staleKey);
    expect(await clearHeldUserImages(db, [1])).toEqual([]);
    expect((await user(1)).image).toBe(staleKey);
  });

  it('leaves an external avatar url, even with a held upload in the history', async () => {
    const external = 'https://avatars.githubusercontent.com/u/1?v=4';
    await seed(`"needsReview" = 'minor'`, external);
    expect(await clearHeldUserImages(db, [1])).toEqual([]);
    expect((await user(1)).image).toBe(external);
  });

  it('🔴 brings its owner into the refresh for a change to that image', async () => {
    await seed(`"nsfwLevel" = 1`, staleKey);
    expect(await getPictureUserIds(db, [2])).toEqual([1]);
  });

  it('brings in no one for an image their User.image does not name (control)', async () => {
    await seed(`"nsfwLevel" = 1`, 'https://avatars.githubusercontent.com/u/1?v=4');
    expect(await getPictureUserIds(db, [2])).toEqual([]);
    // The profile picture's own user is still found.
    expect(await getPictureUserIds(db, [1])).toEqual([1]);
  });
  it.each([
    ['an upper-case stored url', staleKey, OLD_KEY.toUpperCase()],
    ['an encoded dash in User.image', staleKey.replace(/-/g, '%2D'), OLD_KEY],
  ])('🔴 is cleared for %s', async (_form, image, storedUrl) => {
    await seed(`"needsReview" = 'minor'`, image, 1, storedUrl);
    expect(await clearHeldUserImages(db, [1])).toEqual([1]);
    expect((await user(1)).image).toBeNull();
  });

  it("is left when the held image is another user's (owner-scoped)", async () => {
    await seed(`"needsReview" = 'minor'`, staleKey, 2);
    expect(await clearHeldUserImages(db, [1])).toEqual([]);
    expect((await user(1)).image).toBe(staleKey);
  });
});

describe('the one-off clean-up of User.image keys', () => {
  const KEY = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;
  const seed = () =>
    pg.exec(`
      INSERT INTO "Image" (id, url, "userId", "needsReview") VALUES
        (10, '${KEY(1)}', 1, NULL),
        (20, '${KEY(2)}', 2, NULL),
        (30, '${KEY(3)}', 3, NULL),
        (50, '${KEY(5)}', 5, 'minor'),
        (60, '${KEY(6)}', 99, NULL);
      INSERT INTO "JobQueue" VALUES (30, 'Image', 'ReplacedImageDelete');
      INSERT INTO "User" VALUES
        (1, 10, '${KEY(1)}', NULL),
        (2, NULL, 'https://image.civitai.com/x/${KEY(2)
          .toUpperCase()
          .replace(/-/g, '%2D')}/width=96', NULL),
        (3, NULL, '${KEY(3)}', NULL),
        (4, NULL, '${KEY(4)}', NULL),
        (5, NULL, '${KEY(5)}', NULL),
        (6, NULL, '${KEY(6)}', NULL),
        (7, NULL, 'https://avatars.githubusercontent.com/u/1?v=4', NULL),
        (8, NULL, NULL, NULL),
        (0, NULL, '${KEY(4)}', NULL);
    `);

  it('plans every key in any form, and which own image each could move to', async () => {
    await seed();
    const plan = await userImageKeyPlan(db, 100);
    expect(plan).toEqual([
      { id: 1, hasPicture: true, movableImageId: 10, keyImageQueued: false },
      { id: 2, hasPicture: false, movableImageId: 20, keyImageQueued: false },
      { id: 3, hasPicture: false, movableImageId: null, keyImageQueued: true },
      { id: 4, hasPicture: false, movableImageId: null, keyImageQueued: false },
      { id: 5, hasPicture: false, movableImageId: null, keyImageQueued: false },
      { id: 6, hasPicture: false, movableImageId: null, keyImageQueued: false },
    ]);
    expect(await userImageKeyPlan(db, 2)).toHaveLength(2);
  });

  it('🔴 empties each key, moves a servable unqueued own image to the picture, and returns the old values', async () => {
    await seed();
    const cleared = await clearUserImageKeys(db, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      cleared
        .sort((a, b) => a.id - b.id)
        .map(({ id, previousPictureId, pictureId }) => ({ id, previousPictureId, pictureId }))
    ).toEqual([
      { id: 1, previousPictureId: 10, pictureId: 10 },
      { id: 2, previousPictureId: null, pictureId: 20 },
      // queued for deletion, held, or another user's: no move
      { id: 3, previousPictureId: null, pictureId: null },
      { id: 4, previousPictureId: null, pictureId: null },
      { id: 5, previousPictureId: null, pictureId: null },
      { id: 6, previousPictureId: null, pictureId: null },
    ]);
    expect(cleared.find((row) => row.id === 3)?.previousImage).toBe(KEY(3));
    // User 5's key names their held image: withheld.
    expect(cleared.find((row) => row.id === 5)?.previousImage).toBeNull();
    const { rows } = await pg.query<{ id: number; image: string | null }>(
      'SELECT id, image FROM "User" WHERE id > 0 ORDER BY id'
    );
    expect(rows.map((row) => row.image)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      'https://avatars.githubusercontent.com/u/1?v=4',
      null,
    ]);
    // A second run finds nothing.
    expect(await userImageKeyPlan(db, 100)).toEqual([]);
    expect(await clearUserImageKeys(db, [1, 2, 3, 4, 5, 6, 7, 8])).toEqual([]);
  });

  it('🔴 does not move a picture whose file another own row holds under a hold or block', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", "needsReview") VALUES
        (1, '${KEY(9)}', 1, NULL),
        (2, '${KEY(9)}', 1, 'minor');
      INSERT INTO "User" VALUES (1, NULL, '${KEY(9)}', NULL);
    `);
    const [row] = await clearUserImageKeys(db, [1]);
    expect(row).toMatchObject({ id: 1, pictureId: null });
    // The key names a held own image, so its value is withheld from the result.
    expect(row.previousImage).toBeNull();
  });

  it('moves it once no twin is held (control)', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId") VALUES (1, '${KEY(9)}', 1), (2, '${KEY(9)}', 1);
      INSERT INTO "User" VALUES (1, NULL, '${KEY(9)}', NULL);
    `);
    const [row] = await clearUserImageKeys(db, [1]);
    expect(row).toMatchObject({ id: 1, pictureId: 1, previousImage: KEY(9) });
  });

  it('touches only the users given (control)', async () => {
    await seed();
    expect((await clearUserImageKeys(db, [4])).map((row) => row.id)).toEqual([4]);
    expect((await user(3)).image).toBe(KEY(3));
    expect(await clearUserImageKeys(db, [])).toEqual([]);
  });
});
