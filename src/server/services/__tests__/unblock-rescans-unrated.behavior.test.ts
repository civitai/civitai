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

const { resetBlockedNsfwLevel } = await import('../image.service');

const UNTAGGED = 1; // blocked before its scan landed: no tags at all
const TAGGED = 2; // blocked after a scan: an R tag is live
const REVIEW_TAGS_ONLY = 3; // its only tags are review tags the unblock disabled
const STILL_BLOCKED = 4; // a CSAM block the unblock did not lift

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "nsfwLevel" int NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "blockedFor" text
    );
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "nsfwLevel" int, disabled boolean);
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
  // Each row as the unblock UPDATE leaves it: Scanned, block reason cleared, still at Blocked (32)
  // and locked. The CSAM row keeps its block.
  await db.exec(`
    DELETE FROM "Image"; DELETE FROM "TagsOnImageDetails"; DELETE FROM "JobQueue";
    INSERT INTO "Image" VALUES
      (${UNTAGGED}, 'Scanned', 32, true, NULL),
      (${TAGGED}, 'Scanned', 32, true, NULL),
      (${REVIEW_TAGS_ONLY}, 'Scanned', 32, true, NULL),
      (${STILL_BLOCKED}, 'Blocked', 32, true, 'CSAM');
    INSERT INTO "TagsOnImageDetails" VALUES (${TAGGED}, 4, false), (${REVIEW_TAGS_ONLY}, 4, true);
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

describe('resetBlockedNsfwLevel', () => {
  it.each([
    ['has no tags', UNTAGGED],
    ['has only disabled review tags', REVIEW_TAGS_ONLY],
  ])('sends an unblocked image that %s back to the scanner', async (_, id) => {
    await resetBlockedNsfwLevel([UNTAGGED, TAGGED, REVIEW_TAGS_ONLY, STILL_BLOCKED]);
    expect(await state(id)).toEqual({ ingestion: 'Rescan', nsfwLevel: 0, queued: true });
  });

  it('rates an unblocked image from its live tags and leaves it Scanned (control)', async () => {
    await resetBlockedNsfwLevel([UNTAGGED, TAGGED, REVIEW_TAGS_ONLY, STILL_BLOCKED]);
    expect(await state(TAGGED)).toEqual({ ingestion: 'Scanned', nsfwLevel: 4, queued: false });
  });

  it('does not send an image that is still blocked to the scanner', async () => {
    await resetBlockedNsfwLevel([STILL_BLOCKED]);
    expect(await state(STILL_BLOCKED)).toMatchObject({ ingestion: 'Blocked', queued: false });
  });
});
