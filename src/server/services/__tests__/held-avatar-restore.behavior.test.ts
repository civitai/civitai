import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearHeldUserImages, restoreClearedUserImages } from '~/server/services/held-image-keys';

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  },
} as never;

const marker = (pictureId: unknown) => JSON.stringify({ heldImageCleared: { pictureId } });

beforeEach(async () => {
  await pg?.close();
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1, "userId" int NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      metadata jsonb, "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb,
      "modelRestricted" boolean NOT NULL DEFAULT false
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
