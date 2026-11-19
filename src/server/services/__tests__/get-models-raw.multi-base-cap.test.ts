import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelsRaw } from '~/server/services/model.service';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Filtering the feed by several base models sums the model's per-base-model rows. Those rows can
 * overlap: a user who liked a version in each base is counted in both, and a row for a base the
 * model no longer has keeps its old counts. The card must never read above the model's own total.
 *
 * The feed query is captured from getModelsRaw and run, as built, against PGlite.
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

const STALE = 1; // live in Turbo; a frozen Krea 2 row from before its versions moved
const SHARED_LIKERS = 2; // 15 users liked a version in each base
const SLICE = 3; // also has an unselected base, so its two-base sum is below its total
const SINGLE = 4; // Turbo only

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
      poi bool DEFAULT false, "downloadCount" int NOT NULL, "thumbsUpCount" int NOT NULL,
      "thumbsDownCount" int DEFAULT 0, "commentCount" int DEFAULT 0,
      "collectedCount" int DEFAULT 0, "tippedAmountCount" int DEFAULT 0
    );
    CREATE TABLE "ModelBaseModelMetric" (
      "modelId" int, "baseModel" text, "downloadCount" int NOT NULL, "thumbsUpCount" int NOT NULL,
      "imageCount" int DEFAULT 0, status "ModelStatus" DEFAULT 'Published',
      availability "Availability" DEFAULT 'Public', mode "ModelModifier",
      "nsfwLevel" int DEFAULT 1, minor bool DEFAULT false, poi bool DEFAULT false,
      PRIMARY KEY ("modelId", "baseModel")
    );
    INSERT INTO "Model" (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd');
    INSERT INTO "ModelMetric" ("modelId", "lastVersionAt", "downloadCount", "thumbsUpCount") VALUES
      (1, '2026-01-04', 48885, 2460),
      (2, '2026-01-03', 150, 40),
      (3, '2026-01-02', 1015, 105),
      (4, '2026-01-01', 60000, 100);
    INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "downloadCount", "thumbsUpCount") VALUES
      (1, 'Krea 2', 38495, 2201), (1, 'Krea 2 Turbo', 48885, 2460),
      (2, 'Krea 2', 100, 30), (2, 'Krea 2 Turbo', 50, 25),
      (3, 'Krea 2', 10, 3), (3, 'Krea 2 Turbo', 5, 2), (3, 'SDXL 1.0', 1000, 100),
      (4, 'Krea 2 Turbo', 60000, 100);
  `);
});
afterAll(() => db.close());
beforeEach(() => {
  capturedQueries.length = 0;
});

type Row = { id: number; rank: { downloadCount: number; thumbsUpCount: number } };

async function feed(sort: string, extra: { take?: number; cursor?: string } = {}) {
  const { cursor: _c, ...parsed } = getAllModelsSchema.parse({
    browsingLevel: 1,
    sort,
    baseModels: ['Krea 2', 'Krea 2 Turbo'],
  });
  await getModelsRaw({
    input: { ...parsed, take: extra.take ?? 10, cursor: extra.cursor } as never,
    _forceBaseModelMetrics: true,
  });
  const q = capturedQueries[0];
  const { rows } = await db.query<Row & { cursorId: string }>(q.text, q.values as never[]);
  return rows;
}

const counts = (rows: Row[]) =>
  Object.fromEntries(
    rows.map((r) => [r.id, [r.rank.downloadCount, r.rank.thumbsUpCount]] as const)
  );

// Newest drives from ModelMetric (LATERAL sum); the stat sorts use the aggregate subquery.
describe.each(['Newest', 'Most Downloaded', 'Highest Rated'])(
  'two base models selected, sorted %s',
  (sort) => {
    it('never shows more than the model total, and keeps the slice when it is smaller', async () => {
      expect(counts(await feed(sort))).toEqual({
        [STALE]: [48885, 2460], // raw sum: 87380 / 4661
        [SHARED_LIKERS]: [150, 40], // raw likes sum: 55
        [SLICE]: [15, 5], // the two selected bases, not the model's 1015 / 105
        [SINGLE]: [60000, 100],
      });
    });
  }
);

describe('ordering on the capped counts', () => {
  it('ranks a model by its capped downloads, not the inflated sum', async () => {
    const ids = (await feed('Most Downloaded')).map((r) => r.id);
    expect(ids).toEqual([SINGLE, STALE, SHARED_LIKERS, SLICE]);
  });

  it('pages on the same capped values the first page was sorted by', async () => {
    // The query fetches take + 1; the extra row's cursorId is where the next page starts.
    const page = await feed('Most Downloaded', { take: 1 });
    expect(page.map((r) => r.id)).toEqual([SINGLE, STALE]);
    capturedQueries.length = 0;
    const next = await feed('Most Downloaded', { take: 1, cursor: page[1].cursorId });
    expect(capturedQueries[0].text).toContain('UNION ALL'); // the split-cursor branch
    expect(next.map((r) => r.id)).toEqual([STALE, SHARED_LIKERS]);
  });
});
