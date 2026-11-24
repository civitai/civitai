import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * `remove-replaced-images` reaps a replaced profile picture once its retention window has passed.
 * An image flagged for CSAM review is kept, and the reap's DELETE re-checks the flag. Driven through the real job and the real `deleteImages`, whose DELETE runs against a
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

const PLAIN_USER = 1; // -> deleted
const SELF_FLAGGED_USER = 7; // the replaced image is flagged for CSAM review -> kept
const READOPTED_USER = 13; // made the replaced image their profile picture again -> kept

const PLAIN = 10;
const SELF_FLAGGED = 17;
const READOPTED = 22;
const GONE = 23; // queued, but the image was already deleted some other way
const QUEUED = [PLAIN, SELF_FLAGGED, READOPTED, GONE];
const DELETED = [PLAIN];
const HELD = [SELF_FLAGGED];

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
    CREATE TABLE "User" (
      id int PRIMARY KEY, "profilePictureId" int UNIQUE, meta jsonb, "bannedAt" timestamp(3)
    );
    CREATE TABLE "ModActivity" (
      "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3)
    );
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
    -- The DELETE queues each deleted image's stored file here, in the same statement.
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
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
  await holder.db.exec(imageUseTablesSql);
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
  // The re-adoption probe, the DELETE and its kept-image read run on PGlite.
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const onPglite = ['FROM "User"', 'DELETE FROM "Image"', 'SELECT id FROM "Image"'];
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
    '"Image", "User", "CsamReport", "Post", "Model", "JobQueue", "Report", "ImageReport"'
  );
  await holder.db.exec(`
    INSERT INTO "Image" (id, "userId", "needsReview") VALUES
      (${PLAIN}, ${PLAIN_USER}, NULL),
      (${SELF_FLAGGED}, ${SELF_FLAGGED_USER}, 'csam'),
      (${READOPTED}, ${READOPTED_USER}, NULL);
    INSERT INTO "User" (id, "profilePictureId") VALUES (${READOPTED_USER}, ${READOPTED});
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

describe('remove-replaced-images', () => {
  it('keeps a flagged or re-adopted image and deletes the rest', async () => {
    const result = await run();

    const left = await remaining();
    for (const id of [...HELD, READOPTED]) expect(left).toContain(id);
    for (const id of DELETED) expect(left).not.toContain(id);
    expect(result).toEqual({ deleted: DELETED.length, readopted: 1, heldAtDelete: HELD.length });
  });

  it('leaves a kept image queued, so it is checked again later', async () => {
    await run();

    expect(sorted(holder.dequeued)).toEqual(sorted([...DELETED, READOPTED, GONE]));
  });

  it('moves a kept image to the back of the queue, so kept rows cannot fill the batch', async () => {
    await run();

    expect(sorted(holder.restamped)).toEqual(sorted(HELD));
  });

  it('leaves an image its child-safety case keeps in this queue, not as a pending delete', async () => {
    const CASE_KEPT = 40;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId") VALUES (${CASE_KEPT}, ${PLAIN_USER});
      INSERT INTO "Report" (id, reason, status) VALUES (70, 'CSAM', 'Pending');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${CASE_KEPT}, 70);
    `);
    dbMock.dbRead.jobQueue.findMany.mockResolvedValue([{ entityId: CASE_KEPT }]);

    await run();

    expect(await remaining()).toContain(CASE_KEPT);
    // Still queued here, so the re-adoption check runs again before it goes.
    expect(holder.restamped).toEqual([CASE_KEPT]);
    const { rows } = await holder.db.query(`SELECT 1 FROM "JobQueue" WHERE type = 'PendingDelete'`);
    expect(rows).toEqual([]);
  });
});
