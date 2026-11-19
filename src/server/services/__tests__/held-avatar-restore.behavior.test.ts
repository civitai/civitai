import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHeldUserImages,
  dropStaleHeldImageMarkers,
  getPictureUserIds,
  restoreClearedUserImages,
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

const marker = (pictureId: unknown) => JSON.stringify({ heldImageCleared: { pictureId } });

beforeEach(async () => {
  await pg?.close();
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
  `);
});
afterAll(() => pg.close());

const user = async (id: number) =>
  (
    await pg.query<{ image: string | null; meta: unknown }>(
      'SELECT image, meta FROM "User" WHERE id = $1',
      [id]
    )
  ).rows[0];

describe('a cleared User.image after its hold lifts', () => {
  it('comes back from the picture once it is servable, and not while it is held', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", "needsReview") VALUES (1, 'key-1', 1, 'minor');
      INSERT INTO "User" VALUES (1, 1, 'key-1', '{"keep": true}');
    `);
    expect(await clearHeldUserImages(db, [1])).toEqual([1]);
    expect(await restoreClearedUserImages(db, [1])).toEqual([]);

    // A moderator release: the hold is lifted and nothing else runs until the next refresh.
    await pg.exec(`UPDATE "Image" SET "needsReview" = NULL WHERE id = 1`);
    expect(await user(1)).toEqual({
      image: null,
      meta: { keep: true, heldImageCleared: { pictureId: 1 } },
    });

    expect(await restoreClearedUserImages(db, [1])).toEqual([1]);
    expect(await user(1)).toEqual({ image: 'key-1', meta: { keep: true } });
  });

  it('does not come back while the picture is blocked, and does once it is unblocked', async () => {
    // A minor-held picture blocked by a moderator: the block drops the minor hold.
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "nsfwLevel") VALUES (1, 'key-1', 1, 'Blocked', 32);
      INSERT INTO "User" VALUES (1, 1, NULL, '${marker(1)}');
    `);
    expect(await restoreClearedUserImages(db, [1])).toEqual([]);
    expect(await user(1)).toEqual({ image: null, meta: { heldImageCleared: { pictureId: 1 } } });

    await pg.exec(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1 WHERE id = 1`);
    expect(await restoreClearedUserImages(db, [1])).toEqual([1]);
    expect((await user(1)).image).toBe('key-1');
  });

  it('does not come back for a blocked picture whose csam flag was dismissed, nor an unrated one', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "nsfwLevel") VALUES
        (1, 'key-1', 1, 'Blocked', 32), (2, 'key-2', 2, 'Scanned', 0);
      INSERT INTO "User" VALUES (1, 1, NULL, '${marker(1)}'), (2, 2, NULL, '${marker(2)}');
    `);
    expect(await restoreClearedUserImages(db, [1, 2])).toEqual([]);
    expect((await user(1)).image).toBeNull();
    expect((await user(2)).image).toBeNull();
  });

  it('does not come back for a blocked picture sent for a rescan with its rating locked', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "nsfwLevel", "nsfwLevelLocked", "blockedFor")
        VALUES (1, 'key-1', 1, 'Rescan', 32, true, 'moderated');
      INSERT INTO "User" VALUES (1, 1, NULL, '${marker(1)}');
    `);
    expect(await restoreClearedUserImages(db, [1])).toEqual([]);
    expect(await user(1)).toEqual({ image: null, meta: { heldImageCleared: { pictureId: 1 } } });
  });

  it('marks a stored JSON null meta too', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", "needsReview") VALUES (1, 'key-1', 1, 'csam');
      INSERT INTO "User" VALUES (1, 1, 'key-1', 'null');
    `);
    await clearHeldUserImages(db, [1]);
    expect(await user(1)).toEqual({ image: null, meta: { heldImageCleared: { pictureId: 1 } } });
  });

  it('drops a marker that can no longer apply, and never fails on one it cannot read', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId") VALUES (1, 'key-1', 1), (2, 'key-2', 2), (3, 'key-other', 9),
        (6, 'key-new', 6), (7, 'key-old', 6);
      INSERT INTO "User" VALUES
        (1, 2, NULL, '${marker(1)}'),
        (2, 2, 'set-since', '${marker(2)}'),
        (3, 1, NULL, '${marker('not-a-number')}'),
        (4, 1, NULL, '"a string meta"'),
        (5, 3, NULL, '${marker(3)}'),
        (6, 6, NULL, '${marker(7)}');
    `);
    expect(await restoreClearedUserImages(db, [1, 2, 3, 4, 5, 6])).toEqual([]);
    await dropStaleHeldImageMarkers(db, [1, 2, 3, 4, 5, 6]);
    expect(await user(1)).toEqual({ image: null, meta: {} });
    expect(await user(2)).toEqual({ image: 'set-since', meta: {} });
    expect(await user(3)).toEqual({ image: null, meta: {} });
    expect(await user(4)).toEqual({ image: null, meta: 'a string meta' });
    // A picture that is not the user's own restores nothing.
    expect((await user(5)).image).toBeNull();
    // The user moved on to another picture of their own: nothing restored, marker dropped.
    expect(await user(6)).toEqual({ image: null, meta: {} });
  });
});

describe('a User.image naming a blocked profile picture', () => {
  it('is cleared and marked for each block marker, and nothing else is', async () => {
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
    expect(await user(1)).toEqual({
      image: null,
      meta: { keep: true, heldImageCleared: { pictureId: 1 } },
    });
    expect(await user(2)).toEqual({ image: null, meta: { heldImageCleared: { pictureId: 2 } } });
    expect(await user(3)).toEqual({ image: null, meta: { heldImageCleared: { pictureId: 3 } } });
    // A value naming another key, an unblocked picture, and a user not passed are kept.
    expect(await user(4)).toEqual({ image: 'legacy-other', meta: {} });
    expect(await user(5)).toEqual({ image: 'key-5', meta: {} });
    expect(await user(6)).toEqual({ image: 'key-6', meta: {} });
    // A picture with an empty url names nothing.
    expect(await user(7)).toEqual({ image: 'any-value', meta: {} });
  });

  it('comes back once the block lifts, and not while any marker survives', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor") VALUES (1, 'key-1', 1, 'Blocked', 'tos');
      INSERT INTO "User" VALUES (1, 1, 'key-1', '{}');
    `);
    await clearHeldUserImages(db, [1]);
    await pg.exec(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 1`);
    expect(await restoreClearedUserImages(db, [1])).toEqual([]);
    expect(await user(1)).toEqual({ image: null, meta: { heldImageCleared: { pictureId: 1 } } });
    await pg.exec(`UPDATE "Image" SET "blockedFor" = NULL WHERE id = 1`);
    expect(await restoreClearedUserImages(db, [1])).toEqual([1]);
    expect(await user(1)).toEqual({ image: 'key-1', meta: {} });
  });
});

describe("a cleared User.image whose picture is not the user's own", () => {
  it("is never restored from another user's servable image", async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, url, "userId") VALUES (1, 'key-other', 2);
      INSERT INTO "User" VALUES (1, 1, NULL, '${marker(1)}');
    `);
    expect(await restoreClearedUserImages(db, [1])).toEqual([]);
    expect((await user(1)).image).toBeNull();
  });
});

describe("a User.image naming another of the user's own images", () => {
  const OLD_KEY = '3f6e2a10-9b4c-4d7e-8a21-6c0b5d9e1f42';
  // Upper-case and CDN-wrapped, as a stored url may be; the match lowercases it.
  const staleKey = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${OLD_KEY.toUpperCase()}/width=96`;
  const seed = async (oldImage: string, image: string) =>
    pg.exec(`
      INSERT INTO "Image" (id, url, "userId") VALUES (1, 'key-1', 1);
      INSERT INTO "Image" (id, url, "userId") VALUES (2, '${OLD_KEY}', 1);
      UPDATE "Image" SET ${oldImage} WHERE id = 2;
      INSERT INTO "User" VALUES (1, 1, '${image}', NULL);
    `);

  it.each([
    ['held', `"needsReview" = 'minor'`],
    ['blocked', `"blockedFor" = 'tos'`],
    ['at the Blocked level', `"nsfwLevel" = 32`],
  ])('🔴 is cleared, with no marker, when that image is %s', async (_state, set) => {
    await seed(set, staleKey);
    expect(await clearHeldUserImages(db, [1])).toEqual([1]);
    expect(await user(1)).toEqual({ image: null, meta: null });
    // Nothing puts it back: it is not the profile picture.
    await pg.exec(`UPDATE "Image" SET "needsReview" = NULL, "blockedFor" = NULL, "nsfwLevel" = 1`);
    expect(await restoreClearedUserImages(db, [1])).toEqual([]);
    expect((await user(1)).image).toBeNull();
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
});
