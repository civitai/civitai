import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * After an unblock resets an image's rating and recomputes it from its tags, an image with no
 * live tags is left unrated: it goes back to the scanner instead of staying Scanned at level 0.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

const { rerateLiftedImages } = await import('../image.service');

const UNTAGGED = 1; // blocked before its scan landed: no tags at all
const TAGGED = 2; // blocked after a scan: an R tag is live
const REVIEW_TAGS_ONLY = 3; // its only tags are review tags the unblock disabled
const STILL_BLOCKED = 4; // a CSAM block the unblock did not lift
const REASON_KEPT = 5; // Scanned, but a block reason is still on the row
const OUT_OF_RETRIES = 6; // untagged, and its scans already ran out of retries
const PRIOR_REVIEW = 7; // untagged, and a moderator already reviewed it
const OTHER_ACTIVITY = 8; // untagged; its only mod activity rows are not image reviews

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "nsfwLevel" int NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "blockedFor" text, "scanJobs" jsonb
    );
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "nsfwLevel" int, disabled boolean);
    CREATE TABLE "ModActivity" ("entityType" text, "entityId" int, activity text);
    CREATE TABLE "JobQueue" (
      type "JobQueueType", "entityType" "EntityType", "entityId" int,
      PRIMARY KEY (type, "entityType", "entityId")
    );
    -- update_nsfw_levels_new's shape: rate unlocked Scanned rows from their live tags; a row with
    -- none is left as it is.
    CREATE FUNCTION update_nsfw_levels_new(image_ids int[]) RETURNS void AS $$
      UPDATE "Image" i SET "nsfwLevel" = t.level
      FROM (SELECT "imageId", max("nsfwLevel") AS level FROM "TagsOnImageDetails"
            WHERE "imageId" = ANY(image_ids) AND NOT disabled GROUP BY "imageId") t
      WHERE i.id = t."imageId" AND NOT i."nsfwLevelLocked" AND i.ingestion = 'Scanned'
        AND i."blockedFor" IS NULL;
    $$ LANGUAGE sql;
  `);
  const raw = pgliteRaw(db);
  const write = dbMock.dbWrite as unknown as Record<string, ReturnType<typeof vi.fn>>;
  write.$executeRaw.mockImplementation(raw.executeRaw);
  // Reads by the caches the recompute refreshes are not under test.
  write.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('').includes('UPDATE "Image"') ? raw.queryRaw(strings, ...values) : []
  );
  write.$executeRawUnsafe.mockImplementation(async (text: string) => {
    await db.exec(text);
    return 0;
  });
});
afterAll(() => db.close());

beforeEach(async () => {
  // Each row as a lift leaves it: Scanned, block reason cleared, off Blocked and unlocked. The CSAM
  // row keeps its block.
  await db.exec(`
    DELETE FROM "Image"; DELETE FROM "TagsOnImageDetails"; DELETE FROM "JobQueue";
    DELETE FROM "ModActivity";
    INSERT INTO "Image" (id, ingestion, "nsfwLevel", "nsfwLevelLocked", "blockedFor", "scanJobs") VALUES
      (${UNTAGGED}, 'Scanned', 0, false, NULL, NULL),
      (${TAGGED}, 'Scanned', 0, false, NULL, NULL),
      (${REVIEW_TAGS_ONLY}, 'Scanned', 0, false, NULL, NULL),
      (${STILL_BLOCKED}, 'Blocked', 32, true, 'CSAM', NULL),
      (${REASON_KEPT}, 'Scanned', 0, false, 'Moderated', NULL),
      (${OUT_OF_RETRIES}, 'Scanned', 0, false, NULL, '{"retryCount": 9}'),
      (${PRIOR_REVIEW}, 'Scanned', 0, false, NULL, NULL),
      (${OTHER_ACTIVITY}, 'Scanned', 0, false, NULL, NULL);
    INSERT INTO "TagsOnImageDetails" VALUES (${TAGGED}, 4, false), (${REVIEW_TAGS_ONLY}, 4, true);
    INSERT INTO "ModActivity" VALUES ('image', ${PRIOR_REVIEW}, 'review'),
      ('image', ${OTHER_ACTIVITY}, 'block'), ('report', ${OTHER_ACTIVITY}, 'review');
  `);
});

async function state(id: number) {
  const { rows } = await db.query<{ ingestion: string; nsfwLevel: number; queued: boolean }>(
    `SELECT ingestion, "nsfwLevel",
       EXISTS (SELECT 1 FROM "JobQueue" WHERE "entityId" = $1) AS queued
     FROM "Image" WHERE id = $1`,
    [id]
  );
  return rows[0];
}

describe('rerateLiftedImages', () => {
  it('sends an unblocked image the scanner never tagged back to the scanner', async () => {
    await rerateLiftedImages([UNTAGGED, TAGGED, REVIEW_TAGS_ONLY, STILL_BLOCKED]);
    expect(await state(UNTAGGED)).toEqual({ ingestion: 'Rescan', nsfwLevel: 0, queued: true });
  });

  it('keeps a moderator ruling: an image whose tags a moderator disabled is not rescanned', async () => {
    await rerateLiftedImages([UNTAGGED, TAGGED, REVIEW_TAGS_ONLY, STILL_BLOCKED]);
    expect(await state(REVIEW_TAGS_ONLY)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 0,
      queued: false,
    });
  });

  it('does not re-audit an image a moderator reviewed before: no rescan, nothing queued', async () => {
    await rerateLiftedImages([PRIOR_REVIEW]);
    expect(await state(PRIOR_REVIEW)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 0,
      queued: false,
    });
  });

  it('still rescans an image whose only mod activity is not an image review (control)', async () => {
    await rerateLiftedImages([OTHER_ACTIVITY]);
    expect(await state(OTHER_ACTIVITY)).toEqual({
      ingestion: 'Rescan',
      nsfwLevel: 0,
      queued: true,
    });
  });

  it('rates an unblocked image from its live tags and leaves it Scanned (control)', async () => {
    await rerateLiftedImages([UNTAGGED, TAGGED, REVIEW_TAGS_ONLY, STILL_BLOCKED]);
    expect(await state(TAGGED)).toEqual({ ingestion: 'Scanned', nsfwLevel: 4, queued: false });
  });

  it('does not send an image that still carries a block reason to the scanner', async () => {
    await rerateLiftedImages([REASON_KEPT]);
    expect(await state(REASON_KEPT)).toMatchObject({ ingestion: 'Scanned', queued: false });
  });

  it('marks an unrated image out of scan retries Error, with nothing queued', async () => {
    await rerateLiftedImages([OUT_OF_RETRIES]);
    expect(await state(OUT_OF_RETRIES)).toEqual({
      ingestion: 'Error',
      nsfwLevel: 0,
      queued: false,
    });
  });

  it('leaves an image already queued for a scan queued once', async () => {
    await db.exec(`INSERT INTO "JobQueue" VALUES ('ImageScan', 'Image', ${UNTAGGED})`);
    await rerateLiftedImages([UNTAGGED]);
    const { rows } = await db.query(`SELECT 1 FROM "JobQueue" WHERE "entityId" = $1`, [UNTAGGED]);
    expect(rows).toHaveLength(1);
    expect(await state(UNTAGGED)).toMatchObject({ ingestion: 'Rescan' });
  });

  it("keeps a moderator's rating locked since the lift", async () => {
    await db.exec(
      `UPDATE "Image" SET "nsfwLevel" = 16, "nsfwLevelLocked" = true WHERE id = ${TAGGED}`
    );
    await rerateLiftedImages([TAGGED, REVIEW_TAGS_ONLY]);
    expect(await state(TAGGED)).toEqual({ ingestion: 'Scanned', nsfwLevel: 16, queued: false });
  });

  it('does not send an image that is still blocked to the scanner', async () => {
    await rerateLiftedImages([STILL_BLOCKED]);
    expect(await state(STILL_BLOCKED)).toMatchObject({ ingestion: 'Blocked', queued: false });
  });
});
