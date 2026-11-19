import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelsRaw } from '~/server/services/model.service';
import {
  hotRankSnapshotSql,
  toHotRankRows,
  type HotRankSnapshotArrays,
} from '~/server/jobs/model-hot-rank-snapshot.sql';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * The snapshot's rank is only worth measuring if it is the Hot feed's order. These run the job's
 * query and getModelsRaw over the same rows, so a new default filter in the feed (or a dropped one
 * in the job) fails here rather than silently splitting the two.
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

const FREE = 1;
const MIXED = 2; // one paid version, one free Public version
const ALL_PAID = 3; // permanent gate
const TIMED = 4; // timed gate whose end date is not set yet: paid, not permanent
const FREE_ONLY_PRIVATE = 5; // paid Public version, free Private version
const ARCHIVED = 6;
const TAKEN_DOWN = 7;
const DRAFT = 8;
const PRIVATE = 9;
const UNSCORED = 10; // the feed shows it, first
const POI = 11;
const MINOR = 12;
const TIED_WITH_FREE = 13; // same score as FREE: the modelId tiebreak decides
const UNSCANNED = 14; // nsfwLevel 0: no viewer's browsing level shows it
const BLOCKED_ONLY = 15; // only the Blocked bit
const TAKEN_DOWN_IDS = [TAKEN_DOWN]; // the model controller drops these after the feed query

const ALL_LEVELS = allBrowsingLevelsFlag;

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
      "modelId" int PRIMARY KEY, "userId" int DEFAULT 1, "lastVersionAt" timestamp DEFAULT now(),
      status "ModelStatus" DEFAULT 'Published', availability "Availability" DEFAULT 'Public',
      mode "ModelModifier", "nsfwLevel" int DEFAULT 1, minor bool DEFAULT false,
      poi bool DEFAULT false, "downloadCount" int DEFAULT 0, "thumbsUpCount" int DEFAULT 0,
      "thumbsDownCount" int DEFAULT 0, "commentCount" int DEFAULT 0,
      "collectedCount" int DEFAULT 0, "tippedAmountCount" int DEFAULT 0, "hotScore" int
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, status "ModelStatus",
      availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "PaidAccess" (
      "entityType" text, "entityId" int, "endsAt" timestamp, "timeframeDays" int,
      PRIMARY KEY ("entityType", "entityId")
    );
    INSERT INTO "Model" (id, name) SELECT g, 'm' || g FROM generate_series(1, 15) g;
    INSERT INTO "ModelMetric" ("modelId", "hotScore", status, availability, mode, poi, minor, "nsfwLevel") VALUES
      (${FREE}, 900, 'Published', 'Public', NULL, false, false, 1),
      (${MIXED}, 800, 'Published', 'Public', NULL, false, false, 1),
      (${ALL_PAID}, 700, 'Published', 'Public', NULL, false, false, 1),
      (${TIMED}, 600, 'Published', 'Public', NULL, false, false, 1),
      (${FREE_ONLY_PRIVATE}, 500, 'Published', 'Public', NULL, false, false, 1),
      (${ARCHIVED}, 1000, 'Published', 'Public', 'Archived', false, false, 1),
      (${TAKEN_DOWN}, 950, 'Published', 'Public', 'TakenDown', false, false, 1),
      (${DRAFT}, 980, 'Draft', 'Public', NULL, false, false, 1),
      (${PRIVATE}, 970, 'Published', 'Private', NULL, false, false, 1),
      (${UNSCORED}, NULL, 'Published', 'Public', NULL, false, false, 1),
      (${POI}, 400, 'Published', 'Public', NULL, true, false, 1),
      (${MINOR}, 300, 'Published', 'Public', NULL, false, true, 4),
      (${TIED_WITH_FREE}, 900, 'Published', 'Public', NULL, false, false, 1),
      (${UNSCANNED}, 2000, 'Published', 'Public', NULL, false, false, 0),
      (${BLOCKED_ONLY}, 1900, 'Published', 'Public', NULL, false, false, 32);
    INSERT INTO "ModelVersion" (id, "modelId", status, availability) VALUES
      (10, ${FREE}, 'Published', 'Public'),
      (20, ${MIXED}, 'Published', 'Public'), (21, ${MIXED}, 'Published', 'Public'),
      (30, ${ALL_PAID}, 'Published', 'Public'),
      (40, ${TIMED}, 'Published', 'Public'),
      (50, ${FREE_ONLY_PRIVATE}, 'Published', 'Public'),
      (51, ${FREE_ONLY_PRIVATE}, 'Published', 'Private'),
      (110, ${POI}, 'Published', 'Public'),
      (120, ${MINOR}, 'Published', 'Public'),
      (130, ${TIED_WITH_FREE}, 'Published', 'Public'),
      (140, ${UNSCANNED}, 'Published', 'Public'),
      (150, ${BLOCKED_ONLY}, 'Published', 'Public');
    INSERT INTO "PaidAccess" ("entityType", "entityId", "endsAt", "timeframeDays") VALUES
      ('ModelVersion', 21, NULL, NULL),
      ('ModelVersion', 30, NULL, NULL),
      ('ModelVersion', 40, NULL, 7),
      ('ModelVersion', 50, NULL, NULL);
  `);
});
afterAll(() => db.close());
beforeEach(() => {
  capturedQueries.length = 0;
});

async function hotFeedIds(input: Record<string, unknown> = {}) {
  capturedQueries.length = 0;
  await getModelsRaw({
    input: {
      browsingLevel: ALL_LEVELS,
      take: 50,
      sort: 'Hot',
      period: 'AllTime',
      ...input,
    } as never,
  });
  const q = capturedQueries[0];
  const { rows } = await db.query<{ id: number }>(q.text, q.values as never[]);
  return rows.map((r) => r.id).filter((id) => !TAKEN_DOWN_IDS.includes(id));
}

async function snapshot() {
  const { rows } = await db.query<HotRankSnapshotArrays>(
    hotRankSnapshotSql.text,
    hotRankSnapshotSql.values as never[]
  );
  return toHotRankRows(rows[0], '2026-11-19', 0, Infinity);
}

describe('model Hot rank snapshot vs the Hot feed', () => {
  it('ranks exactly the models the Hot feed shows, in the same order', async () => {
    const rows = await snapshot();
    expect(rows.map((r) => r.modelId)).toEqual(await hotFeedIds());
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
  });

  it('keeps the poi and minor models out exactly where the feed hides them', async () => {
    const rows = await snapshot();
    expect(rows.filter((r) => !r.poi).map((r) => r.modelId)).toEqual(
      await hotFeedIds({ disablePoi: true })
    );
    expect(rows.filter((r) => !r.minor).map((r) => r.modelId)).toEqual(
      await hotFeedIds({ disableMinor: true })
    );
  });

  it('keeps the models Hide Paid keeps, counting only Public free versions', async () => {
    const rows = await snapshot();
    expect(rows.filter((r) => r.hidePaidKeeps).map((r) => r.modelId)).toEqual(
      await hotFeedIds({ hidePaid: true })
    );
  });

  it('marks paid models, and permanent only for a gate with no timeframe', async () => {
    const byId = new Map((await snapshot()).map((r) => [r.modelId, r]));
    const flags = (id: number) => {
      const r = byId.get(id)!;
      return [r.paid, r.paidPermanent, r.hidePaidKeeps];
    };
    expect(flags(FREE)).toEqual([0, 0, 1]);
    expect(flags(MIXED)).toEqual([1, 1, 1]);
    expect(flags(ALL_PAID)).toEqual([1, 1, 0]);
    expect(flags(TIMED)).toEqual([1, 0, 0]);
    expect(flags(FREE_ONLY_PRIVATE)).toEqual([1, 1, 0]);
    expect(byId.get(UNSCORED)?.hotScore).toBeNull();
  });
});

describe('toHotRankRows', () => {
  it('numbers ranks across batches from the top of the whole snapshot', () => {
    const n = 5;
    const arrays: HotRankSnapshotArrays = {
      modelIds: [11, 12, 13, 14, 15],
      hotScores: [null, 4, 3, 2, 1],
      nsfwLevels: Array(n).fill(1),
      availabilities: Array(n).fill('Public'),
      pois: Array(n).fill(false),
      minors: Array(n).fill(false),
      paids: [true, false, false, false, false],
      paidPermanents: Array(n).fill(false),
      hidePaidKeeps: Array(n).fill(true),
    };
    const batches = [0, 2, 4].map((start) => toHotRankRows(arrays, '2026-11-19', start, start + 2));
    expect(batches.map((b) => b.map((r) => [r.modelId, r.rank]))).toEqual([
      [
        [11, 1],
        [12, 2],
      ],
      [
        [13, 3],
        [14, 4],
      ],
      [[15, 5]],
    ]);
    expect(batches[0][0].paid).toBe(1);
  });
});
