import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  crucibleCoverListedWhere,
  crucibleScannedSql,
} from '~/server/services/crucible-visibility.sql';
import { entityImageVisibilityConditions } from '~/server/services/image-visibility.service';

/**
 * Entity (bounty) image visibility and the crucible cover rule, run against PGlite: an image rated
 * Blocked is left out for other viewers, and one at the highest browsable level is kept.
 */

const OWNER = 5;
const OTHER = 6;
const XXX = 16;
const BLOCKED = 32;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "CrucibleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "blockedFor" text,
      "modelRestricted" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Crucible" (
      id int PRIMARY KEY, "imageId" int, ingestion "CrucibleIngestionStatus" NOT NULL DEFAULT 'Scanned'
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`DELETE FROM "Image"; DELETE FROM "Crucible";`);
  await db.exec(`
    INSERT INTO "Image" (id, "userId", "nsfwLevel") VALUES (1, ${OWNER}, ${XXX}), (2, ${OWNER}, ${BLOCKED});
    INSERT INTO "Crucible" (id, "imageId") VALUES (1, 1), (2, 2);
  `);
});

const run = async (sql: Prisma.Sql) =>
  (await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id);

const entityImageIds = (viewer: { userId?: number; isModerator?: boolean }) =>
  run(
    Prisma.sql`SELECT i.id FROM "Image" i WHERE ${Prisma.join(
      entityImageVisibilityConditions(viewer),
      ' AND '
    )} ORDER BY i.id`
  );

describe('entityImageVisibilityConditions', () => {
  it('serves another viewer, or a signed-out one, only the browsable image', async () => {
    expect(await entityImageIds({ userId: OTHER })).toEqual([1]);
    expect(await entityImageIds({})).toEqual([1]);
  });

  it('serves the uploader and moderators both', async () => {
    expect(await entityImageIds({ userId: OWNER })).toEqual([1, 2]);
    expect(await entityImageIds({ userId: OTHER, isModerator: true })).toEqual([1, 2]);
  });
});

describe('crucible cover rule', () => {
  it('lists only the crucible whose cover is at a browsable level', async () => {
    expect(
      await run(
        Prisma.sql`SELECT c.id FROM "Crucible" c JOIN "Image" i ON i.id = c."imageId" WHERE ${crucibleScannedSql} ORDER BY c.id`
      )
    ).toEqual([1]);
  });

  it('has the Prisma twin leave out a Blocked cover too', () => {
    expect(crucibleCoverListedWhere.nsfwLevel.notIn).toContain(BLOCKED);
  });
});
