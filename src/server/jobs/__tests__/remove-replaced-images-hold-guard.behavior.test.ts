import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * `remove-replaced-images` reaps a replaced profile picture once its retention window has passed.
 * An account under any hold keeps its images, so the reap's DELETE re-checks every hold on the
 * owner. Driven through the real job and the real `deleteImages`, whose DELETE runs against a
 * Postgres stand-in here, so the guard and its composition into the statement are both exercised.
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
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getB2ImageS3Client: () => ({ send: async () => ({}) }),
}));
vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: async () => ({ backend: 'b2Image' }),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
// The job deletes only on prod, and on prod the client env requires this.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'http://localhost:3000';
});
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: true, isPreview: false }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { removeReplacedImages } from '~/server/jobs/remove-replaced-images';

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  dequeued: [] as number[],
  restamped: [] as number[],
}));

const HOLD_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
);

// Owners, each with one replaced image in the queue, named for the case it pins.
const PLAIN_USER = 1; // no hold -> deleted
const REPORT_USER = 2; // named on an open report -> kept
const REVIEW_USER = 3; // another of their images is flagged for CSAM review -> kept
const BLOCKED_USER = 4; // another of their images is CSAM-blocked, on no sent report -> kept
const LISTED_USER = 5; // another of their images is listed on a holding report -> kept
const MARKED_USER = 6; // an active hold marker -> kept
const PLACEHOLDER_OWNER = -1; // -> kept
// The replaced image itself is flagged for CSAM review -> kept. Its flag also holds the account, so
// this pins the outcome, not the row-level re-check, which only matters for a flag landing mid-DELETE.
const SELF_FLAGGED_USER = 7;
const LAPSED_USER = 8; // their report was sent and archived over a year ago -> deleted
const OTHER_FLAG_USER = 10; // another image has a review flag that is not CSAM -> deleted
const RELEASED_USER = 11; // their hold marker was released -> deleted
const LAPSED_LISTED_USER = 12; // a CSAM-blocked image listed on their own lapsed sent report -> deleted
const READOPTED_USER = 13; // made the replaced image their profile picture again -> kept
const REPORT_SUBJECT = 9; // owns nothing; the subject of the report listing LISTED_USER's image

const PLAIN = 10;
const REPORT = 11;
const REVIEW = 12;
const BLOCKED = 13;
const LISTED = 14;
const MARKED = 15;
const PLACEHOLDER = 16;
const SELF_FLAGGED = 17;
const LAPSED = 18;
const OTHER_FLAG = 19;
const RELEASED = 20;
const LAPSED_LISTED = 21;
const READOPTED = 22;
const GONE = 23; // queued, but the image was already deleted some other way
const QUEUED = [
  PLAIN,
  REPORT,
  REVIEW,
  BLOCKED,
  LISTED,
  MARKED,
  PLACEHOLDER,
  SELF_FLAGGED,
  LAPSED,
  OTHER_FLAG,
  RELEASED,
  LAPSED_LISTED,
  READOPTED,
  GONE,
];
const DELETED = [PLAIN, LAPSED, OTHER_FLAG, RELEASED, LAPSED_LISTED];
const HELD = [REPORT, REVIEW, BLOCKED, LISTED, MARKED, PLACEHOLDER, SELF_FLAGGED];

// Not queued: the images that put their owner under a hold, or that stand beside one.
const REVIEW_OTHER = 30;
const BLOCKED_OTHER = 31;
const LISTED_OTHER = 32;
const OTHER_FLAG_OTHER = 33;
const LAPSED_LISTED_OTHER = 34;

const SCHEMA = `
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text NOT NULL DEFAULT 'u',
      "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text,
      "blockedFor" text,
      metadata jsonb,
      "updatedAt" timestamp(3),
      "cascadeParentId" int
    );
    -- The image's comment threads, which an image delete detaches when a held author is in one.
    CREATE TABLE "Thread" (
      id serial PRIMARY KEY, "imageId" int, "parentThreadId" int, "rootThreadId" int,
      "commentId" int, metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (id serial PRIMARY KEY, "userId" int NOT NULL, "threadId" int NOT NULL);
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int UNIQUE);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
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
`;

const reset = (tables: string) =>
  holder.db.exec(`
    SET session_replication_role = replica;
    TRUNCATE ${tables};
    SET session_replication_role = DEFAULT;
  `);

beforeAll(async () => {
  setEnv({ DATABASE_IS_PROD: true });
  holder.db = new PGlite();
  await holder.db.exec(SCHEMA);
  await holder.db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  // Off, so the guard is what keeps a held image rather than the marker's delete trigger, and so
  // the report fixtures write no markers of their own.
  await holder.db.exec(`
    ALTER TABLE "Image" DISABLE TRIGGER "Image_evidence_hold";
    ALTER TABLE "CsamReport" DISABLE TRIGGER "CsamReport_evidence_hold";
  `);
});

afterAll(async () => {
  await holder.db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.dequeued = [];
  holder.restamped = [];
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);

  // Every queued image is past its window; the retention filter is pinned in the job's own test.
  dbMock.dbRead.jobQueue.findMany.mockResolvedValue(QUEUED.map((entityId) => ({ entityId })));
  // The re-adoption probe, the marker-view probe, the DELETE and its kept-image read run on PGlite.
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const onPglite = [
      'FROM "User"',
      'to_regclass',
      'DELETE FROM "Image"',
      'SELECT id FROM "Image"',
      '"EvidenceHoldImage"',
    ];
    if (!onPglite.some((s) => flat.text.includes(s))) return [];
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('');
    const ids = (values.find(Array.isArray) as number[]) ?? [];
    if (sql.includes('DELETE FROM "JobQueue"')) holder.dequeued.push(...ids);
    if (sql.includes('UPDATE "JobQueue" SET "createdAt"')) holder.restamped.push(...ids);
    return 0;
  }) as never);

  await reset(
    '"Image", "User", "CsamReport", "EvidenceHold", "EvidenceHoldImage", "Post", "EvidenceHoldPost", "Model"'
  );
  await holder.db.exec(`
    INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor", ingestion) VALUES
      (${PLAIN}, ${PLAIN_USER}, NULL, NULL, 'Scanned'),
      (${REPORT}, ${REPORT_USER}, NULL, NULL, 'Scanned'),
      (${REVIEW}, ${REVIEW_USER}, NULL, NULL, 'Scanned'),
      (${BLOCKED}, ${BLOCKED_USER}, NULL, NULL, 'Scanned'),
      (${LISTED}, ${LISTED_USER}, NULL, NULL, 'Scanned'),
      (${MARKED}, ${MARKED_USER}, NULL, NULL, 'Scanned'),
      (${PLACEHOLDER}, ${PLACEHOLDER_OWNER}, NULL, NULL, 'Scanned'),
      (${SELF_FLAGGED}, ${SELF_FLAGGED_USER}, 'csam', NULL, 'Scanned'),
      (${LAPSED}, ${LAPSED_USER}, NULL, NULL, 'Scanned'),
      (${OTHER_FLAG}, ${OTHER_FLAG_USER}, NULL, NULL, 'Scanned'),
      (${RELEASED}, ${RELEASED_USER}, NULL, NULL, 'Scanned'),
      (${LAPSED_LISTED}, ${LAPSED_LISTED_USER}, NULL, NULL, 'Scanned'),
      (${READOPTED}, ${READOPTED_USER}, NULL, NULL, 'Scanned'),
      (${REVIEW_OTHER}, ${REVIEW_USER}, 'csam', NULL, 'Scanned'),
      (${BLOCKED_OTHER}, ${BLOCKED_USER}, NULL, 'CSAM', 'Blocked'),
      (${LISTED_OTHER}, ${LISTED_USER}, NULL, NULL, 'Scanned'),
      (${OTHER_FLAG_OTHER}, ${OTHER_FLAG_USER}, 'minor', NULL, 'Scanned'),
      (${LAPSED_LISTED_OTHER}, ${LAPSED_LISTED_USER}, NULL, 'CSAM', 'Blocked');
    INSERT INTO "User" (id, "profilePictureId") VALUES (${READOPTED_USER}, ${READOPTED});
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images) VALUES
      (${REPORT_USER}, NULL, NULL, '[]'),
      (${REPORT_SUBJECT}, now() - interval '30 days', NULL, '[{"id": ${LISTED_OTHER}}]'),
      (${LAPSED_USER}, now() - interval '400 days', now() - interval '400 days', '[]'),
      (${LAPSED_LISTED_USER}, now() - interval '400 days', now() - interval '400 days',
        '[{"id": ${LAPSED_LISTED_OTHER}}]');
    INSERT INTO "EvidenceHold" ("userId", role, reason, "releasedAt", "releasedById", "releaseReason") VALUES
      (${MARKED_USER}, 'manual', 'review', NULL, NULL, NULL),
      (${RELEASED_USER}, 'manual', 'review', now(), 1, 'done');
  `);
});

const run = () =>
  removeReplacedImages.run({} as Parameters<typeof removeReplacedImages.run>[0]).result as Promise<{
    deleted: number;
    readopted: number;
    heldAtDelete: number;
  }>;
const remaining = async () =>
  (await holder.db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map(
    (r) => r.id
  );
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('remove-replaced-images under an account hold', () => {
  it("keeps every held account's replaced image and deletes the rest", async () => {
    const result = await run();

    const left = await remaining();
    for (const id of [...HELD, READOPTED]) expect(left).toContain(id);
    for (const id of DELETED) expect(left).not.toContain(id);
    expect(result).toEqual({ deleted: DELETED.length, readopted: 1, heldAtDelete: HELD.length });
  });

  it('leaves a held image queued, so it is reaped once the hold ends', async () => {
    await run();

    expect(sorted(holder.dequeued)).toEqual(sorted([...DELETED, READOPTED, GONE]));
  });

  it('moves a held image to the back of the queue, so held rows cannot fill the batch', async () => {
    await run();

    expect(sorted(holder.restamped)).toEqual(sorted(HELD));
  });

  it('holds every image when the marker table exists without its view', async () => {
    await holder.db.exec(`ALTER VIEW "EvidenceHeldUser" RENAME TO "EvidenceHeldUserMoved"`);
    try {
      const result = await run();

      expect(result.deleted).toBe(0);
      for (const id of QUEUED.filter((id) => id !== GONE)) expect(await remaining()).toContain(id);
      expect(sorted(holder.dequeued)).toEqual([READOPTED, GONE]);
      expect(sorted(holder.restamped)).toEqual(
        sorted(QUEUED.filter((id) => id !== READOPTED && id !== GONE))
      );
    } finally {
      await holder.db.exec(`ALTER VIEW "EvidenceHeldUserMoved" RENAME TO "EvidenceHeldUser"`);
    }
  });
});
