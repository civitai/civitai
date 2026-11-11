import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

const { checkMatureSafeBitDrift, MATURE_SAFE_BIT_DRIFT_CAP } = await import(
  '~/server/jobs/check-mature-safe-bit-drift'
);
const { imageDerivedVersionLevels, updateModelVersionNsfwLevels } = await import(
  '~/server/services/nsfwLevels.service'
);

/** The drift SQL and the rollups run against a Postgres stand-in through the mocked clients. */
let db: PGlite;

async function start() {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Model', 'ModelVersion');
    CREATE TYPE "JobQueueType" AS ENUM ('UpdateNsfwLevel');
    CREATE TABLE "JobQueue" ("entityId" int, "entityType" "EntityType", type "JobQueueType",
      PRIMARY KEY ("entityId", "entityType", type));
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int DEFAULT 7, status text DEFAULT 'Published',
      nsfw boolean, "nsfwLevel" int, "sfwName" text);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, status text DEFAULT 'Published',
      "nsfwLevel" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int, "userId" int, "publishedAt" timestamp);
    CREATE TABLE "Image" (id serial PRIMARY KEY, "postId" int, "nsfwLevel" int, index int);
  `);
  const run = (async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(run);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(run);
}

const model = (id: number, nsfw: boolean, nsfwLevel: number, sfwName: string | null = null) =>
  db.query(`INSERT INTO "Model" (id, nsfw, "nsfwLevel", "sfwName") VALUES ($1, $2, $3, $4)`, [
    id,
    nsfw,
    nsfwLevel,
    sfwName,
  ]);
const version = (id: number, modelId: number, nsfwLevel: number, status = 'Published') =>
  db.query(`INSERT INTO "ModelVersion" VALUES ($1, $2, $3, $4)`, [id, modelId, status, nsfwLevel]);

const queued = async () =>
  (
    await db.query<{ entityId: number; entityType: string }>(
      `SELECT "entityId", "entityType" FROM "JobQueue" ORDER BY "entityType", "entityId"`
    )
  ).rows;

beforeEach(async () => {
  vi.clearAllMocks();
  await start();
});
afterEach(async () => {
  await db.close();
});

describe('check-mature-safe-bit-drift', () => {
  it('queues mature versions and face-less mature models that carry a safe bit, and nothing else', async () => {
    await model(1, true, 61); // drifted model, drifted version
    await version(10, 1, 1);
    await version(11, 1, 60);
    await version(12, 1, 1, 'Draft'); // not Published
    await model(2, true, 62, 'Safe name'); // the safe bit is its face's cover
    await version(20, 2, 60);
    await model(3, false, 1); // not mature
    await version(30, 3, 1);
    await model(4, true, 60); // mature version drifted, model level fine
    await version(40, 4, 2);

    const result = await checkMatureSafeBitDrift.run({}).result;

    expect(await queued()).toEqual([
      { entityId: 1, entityType: 'Model' },
      { entityId: 10, entityType: 'ModelVersion' },
      { entityId: 40, entityType: 'ModelVersion' },
    ]);
    expect(result).toEqual({ versionCount: 2, modelCount: 1, enqueued: 3 });
  });

  it('alerts and queues nothing above the cap', async () => {
    await model(1, true, 60);
    for (let id = 1; id <= MATURE_SAFE_BIT_DRIFT_CAP + 1; id++) await version(1000 + id, 1, 1);

    const result = await checkMatureSafeBitDrift.run({}).result;

    expect(await queued()).toEqual([]);
    expect(result).toMatchObject({ versionCount: MATURE_SAFE_BIT_DRIFT_CAP + 1, enqueued: 0 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'mature-safe-bit-drift' })
    );
  });

  it('queues at the cap', async () => {
    await model(1, true, 60);
    for (let id = 1; id <= MATURE_SAFE_BIT_DRIFT_CAP; id++) await version(1000 + id, 1, 1);

    await checkMatureSafeBitDrift.run({}).result;

    expect(await queued()).toHaveLength(MATURE_SAFE_BIT_DRIFT_CAP);
  });
});

describe('imageDerivedVersionLevels', () => {
  it('reads the level the version rollup stores for a non-mature model', async () => {
    await model(1, false, 0);
    await version(10, 1, 0);
    await db.query(`INSERT INTO "Post" VALUES (1, 10, 7, now()), (2, 10, 8, now())`);
    // The owner's first 20 rated images count: Blocked (32), unrated (0), the 21st and another
    // user's post do not.
    for (let index = 0; index < 20; index++)
      await db.query(`INSERT INTO "Image" ("postId", "nsfwLevel", index) VALUES (1, $1, $2)`, [
        index === 0 ? 2 : 1,
        index,
      ]);
    await db.query(
      `INSERT INTO "Image" ("postId", "nsfwLevel", index) VALUES (1, 32, 0), (1, 0, 0), (1, 8, 99), (2, 4, 0)`
    );

    const derived = await imageDerivedVersionLevels([10]);
    await updateModelVersionNsfwLevels([10]);
    const stored = (await db.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "ModelVersion"`))
      .rows[0].nsfwLevel;

    expect(derived.get(10)).toBe(3);
    expect(stored).toBe(3);
  });
});
