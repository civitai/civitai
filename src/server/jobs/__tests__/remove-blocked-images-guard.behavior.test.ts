import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * `remove-blocked-images` reads its holds once at the start of a run, then deletes for as long as its
 * lock allows. `purgeHoldGuard` re-states those holds on the DELETE itself, so a flag set while the
 * run is underway still stops it. Driven through the real `deleteImages`, whose DELETE runs against a
 * Postgres stand-in here, so both the predicate and its composition are exercised.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: async () => ({ backend: 'b2Image' }),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import * as imageService from '~/server/services/image.service';
import {
  blockedQueueBatchSql,
  reviewHeldBlockedImagesSql,
  purgeHoldGuard,
} from '~/server/jobs/image-ingestion';
import { feedbackCaptureDeleteGuard } from '~/server/jobs/purge-feedback-captures';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const NO_COPY = { holdForTrainingCopy: false };

const PLAIN_USER = 1;
const REPORTED_USER = 2; // named on an unsent report
const FLAGGED_USER = 63; // one of whose images is flagged for CSAM review

// Image ids, named for the case each one pins.
const PLAIN = 10; // blocked -> deleted
const APPEALED = 11; // flagged for appeal -> kept
const FLAGGED = 12; // moderator-only review flag -> kept
const UNBLOCKED = 13; // no longer blocked -> kept
const REPORTED = 14; // owner named on an unsent report -> deleted
const OTHER_FLAG = 17; // a review flag that is not a hold -> deleted
const CSAM_BLOCKED = 18; // blocked for CSAM -> kept
const FLAGGED_NEIGHBOUR = 19; // another of FLAGGED_USER's images -> deleted
const ALL = [
  PLAIN,
  APPEALED,
  FLAGGED,
  UNBLOCKED,
  REPORTED,
  OTHER_FLAG,
  CSAM_BLOCKED,
  FLAGGED_NEIGHBOUR,
];
const DELETED = [PLAIN, REPORTED, OTHER_FLAG, FLAGGED_NEIGHBOUR];
const KEPT = ALL.filter((id) => !DELETED.includes(id));

const BASE_SCHEMA = `
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text NOT NULL DEFAULT 'u',
      "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL,
      "needsReview" text,
      "blockedFor" text,
      minor boolean NOT NULL DEFAULT false,
      metadata jsonb,
      "updatedAt" timestamp(3),
      "cascadeParentId" int
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb DEFAULT '{}', "bannedAt" timestamp(3));
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text, "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      title text,
      detail text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "publishedAt" timestamp(3),
      "modelVersionId" int,
      "collectionId" int,
      metadata jsonb
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]',
      details jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "AppealDecisionRecord" (
      "imageId" int NOT NULL,
      "imageUrl" text,
      "blockedFor" text,
      decision text NOT NULL,
      "decidedAt" timestamptz NOT NULL DEFAULT now(),
      "removalLabel" text,
      "removalNsfw" text,
      "aiNsfwLevel" int,
      "trainingCopyState" text
    );
    CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'BlockedImageDelete', 'ImageScan', 'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TABLE "JobQueue" (
      type "JobQueueType" NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      data jsonb,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      PRIMARY KEY ("entityType", "entityId", type)
    );
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(BASE_SCHEMA);
  await holder.db.exec(imageUseTablesSql);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const flat = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...(values as never[]))
      : (strings as Prisma.Sql);
    if (!/DELETE FROM "Image"|"JobQueue"/.test(flat.text)) return [];
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);

  // Only what a delete queues: the blocked-image queue's own rows are seeded once, below.
  await holder.db.exec(`
    DELETE FROM "JobQueue" WHERE type IN ('ImageStorageDelete', 'UpdateNsfwLevel', 'PendingDelete');
    TRUNCATE "Image", "CsamReport", "AppealDecisionRecord", "Post", "Model";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview", "blockedFor") VALUES
      (${PLAIN}, ${PLAIN_USER}, 'Blocked', NULL, NULL),
      (${APPEALED}, ${PLAIN_USER}, 'Blocked', 'appeal', NULL),
      (${FLAGGED}, ${FLAGGED_USER}, 'Blocked', 'csam', NULL),
      (${UNBLOCKED}, ${PLAIN_USER}, 'Scanned', NULL, NULL),
      (${REPORTED}, ${REPORTED_USER}, 'Blocked', NULL, NULL),
      (${OTHER_FLAG}, ${PLAIN_USER}, 'Blocked', 'minor', NULL),
      (${CSAM_BLOCKED}, ${PLAIN_USER}, 'Blocked', NULL, 'CSAM'),
      (${FLAGGED_NEIGHBOUR}, ${FLAGGED_USER}, 'Blocked', NULL, NULL);
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${REPORTED_USER}, NULL, NULL, '{}');
  `);
});

const remaining = async () =>
  (await holder.db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map(
    (r) => r.id
  );
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('purgeHoldGuard on the delete', () => {
  it('deletes only images no flag keeps at the moment of the delete', async () => {
    const deleted = await imageService.deleteImages(ALL, {
      actor: { system: 'test' },
      onlyWhere: purgeHoldGuard(NO_COPY),
    });

    expect(sorted(deleted.map((r) => r.id))).toEqual(DELETED);
    expect(await remaining()).toEqual(KEPT);
    // A kept image's own side effects must not run: it is still live in the database.
    const deindexed = vi
      .mocked(imagesMetricsSearchIndex.queueUpdate)
      .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
    expect(sorted(deindexed)).toEqual(DELETED);
  });

  it('leaves rows outside the delete selection', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel") VALUES
        (140, ${PLAIN_USER}, 'Error', 'moderated', 32),
        (141, ${PLAIN_USER}, 'Error', NULL, 0);
    `);

    const deleted = await imageService.deleteImages([140, 141], {
      actor: { system: 'test' },
      onlyWhere: purgeHoldGuard(NO_COPY),
    });

    expect(deleted).toEqual([]);
    expect((await remaining()).filter((id) => id === 140 || id === 141)).toEqual([140, 141]);
  });

  it('applies the guard to every batch, not only the first', async () => {
    const extra = Array.from({ length: 150 }, (_, i) => 1000 + i);
    const lastFlagged = extra[extra.length - 1];
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview")
      SELECT g, ${PLAIN_USER}, 'Blocked', CASE WHEN g = ${lastFlagged} THEN 'csam' END
      FROM generate_series(${extra[0]}, ${lastFlagged}) g;
    `);

    await imageService.deleteImages(extra, {
      actor: { system: 'test' },
      onlyWhere: purgeHoldGuard(NO_COPY),
    });

    expect((await remaining()).filter((id) => id >= extra[0])).toEqual([lastFlagged]);
  });

  describe('the appeal training-copy hold', () => {
    beforeEach(async () => {
      await holder.db.exec(`
        INSERT INTO "AppealDecisionRecord" ("imageId", decision, "removalLabel") VALUES
          (${PLAIN}, 'Rejected', 'spam'),
          (${REPORTED}, 'Rejected', 'realisticMinorNsfw');
      `);
    });

    it('keeps a rejected image waiting for its copy when the copy job is configured', async () => {
      await imageService.deleteImages(ALL, {
        actor: { system: 'test' },
        onlyWhere: purgeHoldGuard({ holdForTrainingCopy: true }),
      });

      expect(await remaining()).toEqual(sorted([PLAIN, ...KEPT]));
    });

    it('holds nothing for it when the copy job is not configured', async () => {
      await imageService.deleteImages(ALL, {
        actor: { system: 'test' },
        onlyWhere: purgeHoldGuard(NO_COPY),
      });

      expect(await remaining()).toEqual(KEPT);
    });
  });

  // The positive control for the cases above: without the guard the same call deletes every fixture
  // row but those a child-safety case keeps, so what they keep is the guard's doing.
  it('deletes every listed image but those in a child-safety case when no guard is given', async () => {
    await imageService.deleteImages(ALL, { actor: { system: 'test' } });

    expect(await remaining()).toEqual([FLAGGED, CSAM_BLOCKED]);
  });
});

// Feedback page captures are kept only by the delete's own child-safety case check.
describe('the feedback capture purge on the delete', () => {
  const CLEAN_CAPTURE = 30;
  const FLAGGED_CAPTURE = 31;
  beforeEach(async () => {
    await holder.db.exec(`
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "createdAt" timestamp(3) NOT NULL DEFAULT now();
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview", "createdAt") VALUES
        (${CLEAN_CAPTURE}, ${FEEDBACK_CAPTURE_OWNER_ID}, 'Scanned', NULL, now() - interval '40 days'),
        (${FLAGGED_CAPTURE}, ${FEEDBACK_CAPTURE_OWNER_ID}, 'Scanned', 'csam', now() - interval '40 days');
    `);
  });

  it('deletes an expired capture and keeps one flagged for CSAM review', async () => {
    const deleted = await imageService.deleteImages([CLEAN_CAPTURE, FLAGGED_CAPTURE], {
      actor: { system: 'purge-feedback-captures' },
      onlyWhere: feedbackCaptureDeleteGuard(new Date(Date.now() - 30 * 24 * 3600 * 1000)),
    });

    expect(deleted.map((r) => r.id)).toEqual([CLEAN_CAPTURE]);
    const left = (await remaining()).filter((id) => id === CLEAN_CAPTURE || id === FLAGGED_CAPTURE);
    expect(left).toEqual([FLAGGED_CAPTURE]);
  });
});

describe('reviewHeldBlockedImagesSql, the batch exclusion', () => {
  it('returns every Blocked image under a pending review or a CSAM block, and nothing else', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview", "blockedFor") VALUES
        (111, ${PLAIN_USER}, 'Blocked', NULL, 'moderated'),
        (112, ${PLAIN_USER}, 'Scanned', NULL, 'CSAM');
    `);

    const { rows } = await holder.db.query<{ id: number }>(
      reviewHeldBlockedImagesSql.text,
      reviewHeldBlockedImagesSql.values as unknown[]
    );

    expect(sorted(rows.map((r) => r.id))).toEqual(sorted([APPEALED, FLAGGED, CSAM_BLOCKED]));
  });

  it('matches the shared hold selection', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview", "blockedFor", "nsfwLevel") VALUES
        (130, ${PLAIN_USER}, 'Error', NULL, 'CSAM', 32),
        (131, ${PLAIN_USER}, 'Error', 'appeal', NULL, 32),
        (132, ${PLAIN_USER}, 'Error', 'appeal', NULL, 0);
    `);

    const { rows } = await holder.db.query<{ id: number }>(
      reviewHeldBlockedImagesSql.text,
      reviewHeldBlockedImagesSql.values as unknown[]
    );

    expect(sorted(rows.map((r) => r.id))).toEqual(
      sorted([APPEALED, FLAGGED, CSAM_BLOCKED, 130, 131])
    );
  });
});

// The held sets have no size bound, and Prisma's engine caps a statement's bind variables
// (`BIND_LIMIT`), so each set must travel as one array parameter whatever its size.
describe('the blocked-image queue reads, with a held set past the bind-variable limit', () => {
  const BIND_LIMIT = 32767;
  const HELD = Array.from({ length: 40_000 }, (_, i) => 990_000_000 + i);
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const ON_CUTOFF = 990040001; // queued at exactly the cutoff, so its retention has run out
  const run = (sql: Prisma.Sql) => {
    expect(sql.values.length).toBeLessThanOrEqual(BIND_LIMIT);
    return holder.db.query<{ entityId: number; createdAt: Date }>(sql.text, sql.values as never[]);
  };

  beforeAll(async () => {
    await holder.db.exec(`
      INSERT INTO "JobQueue" (type, "entityType", "entityId", "createdAt")
        SELECT 'BlockedImageDelete', 'Image', id, now() - interval '30 days' + (id - 990000000) * interval '1 second'
        FROM generate_series(990000000, 990039999) id;
      INSERT INTO "JobQueue" (type, "entityType", "entityId", "createdAt") VALUES
        ('BlockedImageDelete', 'Image', 1, now() - interval '20 days'),
        ('BlockedImageDelete', 'Image', 2, now() - interval '10 days'),
        ('BlockedImageDelete', 'Image', 3, now() - interval '40 days'),
        ('BlockedImageDelete', 'Image', 990040000, now()),
        ('ImageScan', 'Image', 990000001, now() - interval '30 days'),
        ('BlockedImageDelete', 'Post', 990000002, now() - interval '30 days');
    `);
    await holder.db.query(
      `INSERT INTO "JobQueue" (type, "entityType", "entityId", "createdAt")
        VALUES ('BlockedImageDelete', 'Image', ${ON_CUTOFF}, $1)`,
      [cutoff]
    );
    // Planned with statistics, as the live table is; without them the planner guesses one row.
    await holder.db.exec(`ANALYZE "JobQueue"`);
  });

  it('leaves every held id out of the batch, oldest first', async () => {
    const { rows } = await run(blockedQueueBatchSql(HELD, 2));

    expect(rows.map((r) => r.entityId)).toEqual([3, 1]);
  });

  // A prepared statement goes to a generic plan after five runs on one connection, where the array
  // is a parameter rather than a constant: `<> ALL` then compares it against every row it scans.
  it('never compares the held array per row, even under a generic plan', async () => {
    const generic = async (sql: Prisma.Sql) => {
      await holder.db.exec(`SET plan_cache_mode = force_generic_plan`);
      try {
        await holder.db.exec(`DEALLOCATE ALL`);
        await holder.db.query(`PREPARE q AS ${sql.text}`);
        const args = sql.values.map((v) =>
          Array.isArray(v)
            ? `'{${v.join(',')}}'`
            : `'${v instanceof Date ? v.toISOString() : String(v)}'`
        );
        const { rows } = await holder.db.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN EXECUTE q(${args.join(', ')})`
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await holder.db.exec(`DEALLOCATE ALL; RESET plan_cache_mode`);
      }
    };
    const perRow = /(ANY|ALL) \(\$\d+\)/;

    // Positive control: the plain array filter, generically planned, is the per-row comparison.
    const control = await generic(
      Prisma.sql`SELECT "entityId" FROM "JobQueue" WHERE "entityId" <> ALL(${HELD}::int[])`
    );
    expect(control).toMatch(perRow);

    const plan = await generic(blockedQueueBatchSql(HELD, 15000));
    expect(plan).toContain('Function Scan on unnest');
    expect(plan).not.toMatch(perRow);
  });

  it('leaves nothing out of the batch when nothing is held', async () => {
    const { rows } = await run(blockedQueueBatchSql([], 50_000));

    expect(rows).toHaveLength(HELD.length + 5);
    expect(rows[0].entityId).toBe(3);
  });
});
