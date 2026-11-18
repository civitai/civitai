import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModels, getModelsRaw } from '~/server/services/model.service';
import {
  bustGatedModelIdsCache,
  getAllPaidModelIds,
  queryAllPaidModelIds,
} from '~/server/services/paid-access.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Hide Paid hides a model only when it has nothing free to show: a model with one paid version and
 * one free Published version stays in the feed. The feed query and the all-paid id set are captured
 * as built and run against PGlite.
 */

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({
  capturedQueries: [] as { text: string; values: unknown[] }[],
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { text: string; values: unknown[] }) => {
      capturedQueries.push(query);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

const FREE = 1; // one free version
const MIXED = 2; // newest version paid, older one free
const ALL_PAID = 3; // every Published version paid
const PAID_PLUS_DRAFT = 4; // the only ungated version is a Draft
const EXPIRED = 5; // its only gate ended yesterday
const TIMED_LIVE = 6; // a timed gate whose end date was never set
const FREE_ONLY_PRIVATE = 7; // the only free version is Private

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Private');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, name text, "sfwName" text, "coverImageId" int, "sfwCoverImageId" int,
      type text, "sfwOnly" bool DEFAULT false, nsfw bool DEFAULT false,
      "createdAt" timestamp DEFAULT now(), "publishedAt" timestamp DEFAULT now(),
      locked bool DEFAULT false, meta jsonb
    );
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, "userId" int DEFAULT 1, "lastVersionAt" timestamp,
      status "ModelStatus" DEFAULT 'Published', availability "Availability" DEFAULT 'Public',
      mode "ModelModifier", "nsfwLevel" int DEFAULT 1, minor bool DEFAULT false,
      poi bool DEFAULT false, "downloadCount" int DEFAULT 0, "thumbsUpCount" int DEFAULT 0,
      "thumbsDownCount" int DEFAULT 0, "commentCount" int DEFAULT 0,
      "collectedCount" int DEFAULT 0, "tippedAmountCount" int DEFAULT 0
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, status "ModelStatus",
      availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "PaidAccess" (
      "entityType" text, "entityId" int, "endsAt" timestamp, "timeframeDays" int,
      PRIMARY KEY ("entityType", "entityId")
    );
    INSERT INTO "Model" (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e'), (6, 'f'), (7, 'g');
    INSERT INTO "ModelMetric" ("modelId", "lastVersionAt") VALUES
      (1, '2026-01-06'), (2, '2026-01-05'), (3, '2026-01-04'),
      (4, '2026-01-03'), (5, '2026-01-02'), (6, '2026-01-01'), (7, '2025-12-31');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (10, ${FREE}, 'Published'),
      (20, ${MIXED}, 'Published'), (21, ${MIXED}, 'Published'),
      (30, ${ALL_PAID}, 'Published'), (31, ${ALL_PAID}, 'Published'),
      (40, ${PAID_PLUS_DRAFT}, 'Published'), (41, ${PAID_PLUS_DRAFT}, 'Draft'),
      (50, ${EXPIRED}, 'Published'),
      (60, ${TIMED_LIVE}, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status, availability) VALUES
      (70, ${FREE_ONLY_PRIVATE}, 'Published', 'Public'),
      (71, ${FREE_ONLY_PRIVATE}, 'Published', 'Private');
    INSERT INTO "PaidAccess" ("entityType", "entityId", "endsAt", "timeframeDays") VALUES
      ('ModelVersion', 21, NULL, NULL),
      ('ModelVersion', 30, NULL, NULL),
      ('ModelVersion', 31, now() + interval '3 days', 7),
      ('ModelVersion', 40, NULL, NULL),
      ('ModelVersion', 50, now() - interval '1 day', 7),
      ('ModelVersion', 60, NULL, 7),
      ('ModelVersion', 70, NULL, NULL);
  `);
});
afterAll(() => db.close());
beforeEach(() => {
  capturedQueries.length = 0;
});

async function feedIds(input: Record<string, unknown>) {
  await getModelsRaw({
    input: { browsingLevel: 1, take: 20, sort: 'Newest', period: 'AllTime', ...input } as never,
  });
  const q = capturedQueries[0];
  const { rows } = await db.query<{ id: number }>(q.text, q.values as never[]);
  return rows.map((r) => r.id).sort();
}

describe('getModelsRaw with hidePaid', () => {
  // A feed pinned to ids shows Private versions too, unless it asks for Public ones only.
  it('counts a Private free version only where the feed shows Private versions', async () => {
    expect(await feedIds({ hidePaid: true, ids: [FREE_ONLY_PRIVATE] })).toEqual([
      FREE_ONLY_PRIVATE,
    ]);
    capturedQueries.length = 0;
    await getModelsRaw({
      input: {
        browsingLevel: 1,
        take: 20,
        sort: 'Newest',
        period: 'AllTime',
        hidePaid: true,
        ids: [FREE_ONLY_PRIVATE],
      } as never,
      publicVersionsOnly: true,
    });
    const q = capturedQueries[0];
    expect((await db.query(q.text, q.values as never[])).rows).toEqual([]);
  });

  // Signed out the feed shows Public versions only, so a Private free version cannot keep a model.
  it('keeps a model with a free Published version and hides the ones with none', async () => {
    expect(await feedIds({ hidePaid: true })).toEqual([FREE, MIXED, EXPIRED]);
  });

  it('shows every model with the filter off', async () => {
    expect(await feedIds({})).toEqual([
      FREE,
      MIXED,
      ALL_PAID,
      PAID_PLUS_DRAFT,
      EXPIRED,
      TIMED_LIVE,
      FREE_ONLY_PRIVATE,
    ]);
  });
});

/** Answers `dbRead.$queryRaw` from PGlite, as the tagged template Prisma would send it. */
function queryRawFromPglite() {
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    const { rows } = await db.query<{ modelId: number }>(sql.text, sql.values as never[]);
    return rows;
  }) as never);
}

describe('the all-paid set (Prisma getModels path)', () => {
  beforeEach(() => {
    queryRawFromPglite();
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
    redisMock.redis.packed.get.mockClear();
  });

  it('lists the gated models with no free Published version', async () => {
    expect((await queryAllPaidModelIds()).sort()).toEqual([
      ALL_PAID,
      PAID_PLUS_DRAFT,
      TIMED_LIVE,
      FREE_ONLY_PRIVATE,
    ]);
  });

  it('is what getModels excludes under hidePaid', async () => {
    dbMock.dbRead.model.findMany.mockClear();
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    await getModels({
      input: { hidePaid: true, take: 10, period: 'AllTime', browsingLevel: 1 } as never,
      select: { id: true },
    });
    expect(dbMock.dbRead.model.findMany).toHaveBeenCalledTimes(1);
    const where = dbMock.dbRead.model.findMany.mock.calls.at(-1)?.[0]?.where as { AND?: unknown[] };
    const notIn = (where.AND ?? []).flatMap((c) => {
      const ids = (c as { id?: { notIn?: number[] } }).id?.notIn;
      return ids ? [ids] : [];
    });
    expect(notIn.map((ids) => [...ids].sort())).toEqual([
      [ALL_PAID, PAID_PLUS_DRAFT, TIMED_LIVE, FREE_ONLY_PRIVATE],
    ]);
  });

  it('is busted under the key it is cached under', async () => {
    await getAllPaidModelIds();
    const readKey = redisMock.redis.packed.get.mock.calls[0]?.[0];
    redisMock.redis.packed.get.mockClear();
    await bustGatedModelIdsCache();
    expect(readKey).toContain('AllPaidModelIds');
    expect(redisMock.redis.packed.get.mock.calls.map((c) => c[0])).toContain(readKey);
  });
});
