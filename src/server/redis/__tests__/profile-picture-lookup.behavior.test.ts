import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

let db: PGlite;

const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = Prisma.sql(strings, ...values);
  return (await db.query(sql.text, sql.values)).rows;
};

const { lookupProfilePictures } = await import('~/server/redis/caches');

const OWNER = 1;
const OTHER = 2;
const NO_PICTURE = 3;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment');
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1,
      hash text, "userId" int NOT NULL, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      type "MediaType" NOT NULL DEFAULT 'image', width int, height int, metadata jsonb, "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int);
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  dbMock.dbRead.$queryRaw.mockImplementation(queryRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(queryRaw as never);
  await db.exec(`
    TRUNCATE "Image", "User";
    INSERT INTO "Image" (id, url, "userId", ingestion) VALUES
      (10, 'owner-avatar', ${OWNER}, 'Scanned'),
      (20, 'other-avatar', ${OTHER}, 'Scanned');
    INSERT INTO "User" (id, "profilePictureId") VALUES
      (${OWNER}, 10), (${OTHER}, 20), (${NO_PICTURE}, NULL);
  `);
});

const setIngestion = (imageId: number, ingestion: string) =>
  db.query(`UPDATE "Image" SET ingestion = $1::"ImageIngestionStatus" WHERE id = $2`, [
    ingestion,
    imageId,
  ]);

describe('profile picture lookup', () => {
  it('returns the picture of a user whose avatar is not Blocked', async () => {
    const result = await lookupProfilePictures([OWNER, OTHER]);

    expect(result[OWNER]).toMatchObject({ id: 10, url: 'owner-avatar', userId: OWNER });
    expect(result[OTHER]).toMatchObject({ id: 20, url: 'other-avatar', userId: OTHER });
  });

  it('returns no picture for a user whose avatar is Blocked, as for a user with none', async () => {
    await setIngestion(10, 'Blocked');

    const result = await lookupProfilePictures([OWNER, OTHER, NO_PICTURE]);

    expect(result).not.toHaveProperty(String(OWNER));
    expect(result).not.toHaveProperty(String(NO_PICTURE));
    expect(result[OTHER]).toMatchObject({ id: 20 });
  });

  it('returns no picture for a user whose avatar is flagged for review', async () => {
    await db.query(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 10`);

    const result = await lookupProfilePictures([OWNER, OTHER]);

    expect(result).not.toHaveProperty(String(OWNER));
    expect(result[OTHER]).toMatchObject({ id: 20 });
  });

  it.each(['Pending', 'Error'])(
    'returns no picture for a user whose avatar is %s, as for a user with none',
    async (state) => {
      await setIngestion(10, state);
      const result = await lookupProfilePictures([OWNER, OTHER], true);
      expect(result).not.toHaveProperty(String(OWNER));
      expect(result[OTHER]).toMatchObject({ id: 20 });
    }
  );

  it('returns a picture still pending its scan once a moderator has rated it', async () => {
    await setIngestion(10, 'Pending');
    await db.query(`UPDATE "Image" SET "nsfwLevelLocked" = true WHERE id = 10`);
    expect((await lookupProfilePictures([OWNER], true))[OWNER]).toMatchObject({ id: 10 });
  });
});
