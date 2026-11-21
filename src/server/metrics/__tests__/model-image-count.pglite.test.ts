import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  countNextHour,
  HOUR_MS,
  recountVersions,
  sortedBatches,
  WATERMARK_KEY,
} from '~/server/metrics/model-image-count';
import {
  backfillStatus,
  finalizeBatch,
  PROGRESS_KEY,
  revertBatch,
  stageRange,
  startBackfill,
} from '~/server/metrics/model-image-count-backfill';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the hourly count, the recount and the backfill against an in-process Postgres through the
 * real Prisma client, so the counting SQL, the transactions and the watermark are the real ones.
 */
const SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending','Scanned','Error','Blocked','NotFound','PendingManualAssignment','Rescan');
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
  CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "postId" int, "userId" int NOT NULL,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "nsfwLevel" int NOT NULL DEFAULT 1, "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
    "needsReview" text, "acceptableMinor" boolean NOT NULL DEFAULT false,
    "tosViolation" boolean NOT NULL DEFAULT false, "blockedFor" text, minor boolean,
    metadata jsonb, "scanJobs" jsonb
  );
  CREATE TABLE "ImageResourceNew" ("imageId" int, "modelVersionId" int, PRIMARY KEY ("imageId", "modelVersionId"));
  CREATE TABLE "ModelVersionMetric" (
    "modelVersionId" int PRIMARY KEY, "imageCount" int NOT NULL DEFAULT 0,
    "updatedAt" timestamp(3) NOT NULL DEFAULT now()
  );
  CREATE TABLE "ModelMetricDaily" (
    "modelId" int, "modelVersionId" int, type text, date date, count int,
    PRIMARY KEY ("modelId", "modelVersionId", type, date)
  );
  CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb);
`;

const OWNER = 1;
const FAN = 2;
const V = 10; // a version of model 100, owned by OWNER
const W = Date.UTC(2026, 10, 1); // the watermark hour

let h: Awaited<ReturnType<typeof startPglitePrisma>>;
const q = (sql: string) => h.pg.exec(sql);
const ts = (ms: number) => `'${new Date(ms).toISOString()}'`;
const imageCount = async (versionId = V) =>
  (
    await h.pg.query<{ imageCount: number }>(
      `SELECT "imageCount" FROM "ModelVersionMetric" WHERE "modelVersionId" = $1`,
      [versionId]
    )
  ).rows[0]?.imageCount ?? null;
const watermark = async () =>
  (
    await h.pg.query<{ value: { hour: number; paused?: boolean } }>(
      `SELECT value FROM "KeyValue" WHERE key = $1`,
      [WATERMARK_KEY]
    )
  ).rows[0]?.value;

/** An image by `userId` on a post published at `publishedAt`, using version V. */
let nextId = 1;
async function image(publishedAt: number | null, userId = FAN, columns = '') {
  const id = nextId++;
  await q(`
    INSERT INTO "Post" VALUES (${id}, ${publishedAt === null ? 'NULL' : ts(publishedAt)});
    INSERT INTO "Image" (id, "postId", "userId") VALUES (${id}, ${id}, ${userId});
    ${columns ? `UPDATE "Image" SET ${columns} WHERE id = ${id};` : ''}
    INSERT INTO "ImageResourceNew" VALUES (${id}, ${V});
  `);
  return id;
}

beforeAll(async () => {
  h = await startPglitePrisma(SCHEMA);
});
afterAll(async () => {
  await h?.stop();
});
beforeEach(async () => {
  nextId = 1;
  await q(`
    TRUNCATE "Model", "ModelVersion", "Post", "Image", "ImageResourceNew", "ModelVersionMetric", "ModelMetricDaily", "KeyValue";
    INSERT INTO "Model" VALUES (100, ${OWNER});
    INSERT INTO "ModelVersion" VALUES (${V}, 100), (11, 100);
  `);
  const prisma = h.prisma as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    const c = client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    for (const method of ['$queryRaw', '$executeRaw', '$transaction'])
      c[method].mockImplementation((...args: unknown[]) => prisma[method](...args));
  }
});

const setWatermark = (value: object) =>
  q(`INSERT INTO "KeyValue" VALUES ('${WATERMARK_KEY}', '${JSON.stringify(value)}')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

describe('the count', () => {
  // The anonymous branch of getImagesForModelVersion (image.service.ts), at every level (PR #9948).
  it('counts only images a signed-out gallery shows', async () => {
    await setWatermark({ hour: W });
    const at = W + 10 * 60_000;
    await image(at); // counts
    await image(at); // counts
    await image(null); // unpublished
    await image(at, FAN, `"needsReview" = 'minor'`);
    await image(at, FAN, `ingestion = 'Blocked'`);
    await image(at, FAN, `ingestion = 'Pending'`);
    await image(at, FAN, `"blockedFor" = 'tos'`);
    await image(at, FAN, `"nsfwLevel" = 0`);
    await image(at, FAN, `"nsfwLevel" = 32`);
    await image(at, FAN, `"tosViolation" = true`);
    await image(at, FAN, `"acceptableMinor" = true`);
    await image(at, FAN, `ingestion = 'Pending', "nsfwLevelLocked" = true`); // a mod's rating stands in for the scan
    await image(at, FAN, `minor = true, "nsfwLevel" = 4`); // minor-restricted at R and up
    await image(at, FAN, `minor = true, "nsfwLevel" = 1`); // a minor flag at PG is shown

    expect(await countNextHour(W + 25 * HOUR_MS)).toMatchObject({ hour: W, images: 4 });
    expect(await imageCount()).toBe(4);
  });

  // Decided 2026-11-21 (PR #9948): the owner's own showcase images count. The writer this replaces
  // excluded them; do not restore that exclusion without a new product decision.
  it("counts the model owner's own images", async () => {
    await setWatermark({ hour: W });
    await image(W + 10 * 60_000, OWNER);
    await image(W + 10 * 60_000, FAN);
    expect(await countNextHour(W + 25 * HOUR_MS)).toMatchObject({ images: 2 });
  });
});

describe('countNextHour', () => {
  it('counts each hour exactly once and advances the watermark with it', async () => {
    await setWatermark({ hour: W });
    await image(W + 5 * 60_000);
    await image(W + HOUR_MS + 5 * 60_000);
    await image(W + 2 * HOUR_MS + 5 * 60_000); // not due yet
    const now = W + 26 * HOUR_MS;

    expect(await countNextHour(now)).toMatchObject({ hour: W, images: 1 });
    expect(await countNextHour(now)).toMatchObject({ hour: W + HOUR_MS, images: 1 });
    expect(await countNextHour(now)).toEqual({ skipped: 'nothing due' });
    expect(await imageCount()).toBe(2);
    expect((await watermark())?.hour).toBe(W + 2 * HOUR_MS);
  });

  it('waits a day after the hour closes', async () => {
    await setWatermark({ hour: W });
    await image(W + 5 * 60_000);
    expect(await countNextHour(W + 25 * HOUR_MS - 1)).toEqual({ skipped: 'nothing due' });
    expect(await imageCount()).toBe(null);
  });

  it('adds to the existing count rather than replacing it', async () => {
    await setWatermark({ hour: W });
    await q(`INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (${V}, 40)`);
    await image(W + 5 * 60_000);
    await countNextHour(W + 25 * HOUR_MS);
    expect(await imageCount()).toBe(41);
  });

  it('does nothing while paused or before the backfill writes the watermark', async () => {
    await image(W + 5 * 60_000);
    expect(await countNextHour(W + 25 * HOUR_MS)).toMatchObject({ skipped: expect.any(String) });
    await setWatermark({ hour: W, paused: true });
    expect(await countNextHour(W + 25 * HOUR_MS)).toEqual({ skipped: 'paused' });
    expect(await imageCount()).toBe(null);
    expect((await watermark())?.hour).toBe(W);
  });
});

describe('countNextHour under concurrency', () => {
  it('writes nothing when another run advanced the watermark after this one read it', async () => {
    await setWatermark({ hour: W + HOUR_MS }); // the primary: hour W is already counted
    await image(W + 5 * 60_000);
    const read = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    const real = read.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    // A replica that has not yet seen the other run's advance.
    read.mockImplementation((...args: unknown[]) =>
      String((args[0] as { strings?: string[] }).strings ?? args[0]).includes('"KeyValue"')
        ? Promise.resolve([{ value: { hour: W } }])
        : real(...args)
    );
    expect(await countNextHour(W + 26 * HOUR_MS)).toEqual({ skipped: 'watermark moved' });
    expect(await imageCount()).toBe(null);
  });

  it('skips the run while the replica is more than 10 minutes behind', async () => {
    await setWatermark({ hour: W });
    await image(W + 5 * 60_000);
    const read = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    const real = read.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    read.mockImplementation((...args: unknown[]) =>
      String((args[0] as { strings?: string[] }).strings ?? args[0]).includes('pg_is_in_recovery')
        ? Promise.resolve([{ lag: 601 }])
        : real(...args)
    );
    expect(await countNextHour(W + 26 * HOUR_MS)).toEqual({ skipped: 'replica 601s behind' });
    expect(await imageCount()).toBe(null);
    expect((await watermark())?.hour).toBe(W);
  });

  it('puts an image published exactly on the hour in that hour only', async () => {
    await setWatermark({ hour: W });
    await image(W + HOUR_MS);
    expect(await countNextHour(W + 26 * HOUR_MS)).toMatchObject({ hour: W, images: 0 });
    expect(await countNextHour(W + 26 * HOUR_MS)).toMatchObject({ hour: W + HOUR_MS, images: 1 });
    expect(await imageCount()).toBe(1);
  });
});

describe('sortedBatches', () => {
  it('drops zeros and splits ascending batches of 100', () => {
    const counts = Array.from({ length: 250 }, (_, i) => ({
      modelVersionId: 250 - i,
      count: i % 5,
    }));
    const batches = sortedBatches(counts);
    const flat = batches.flat();
    expect(batches.map((b) => b.length)).toEqual([100, 100]);
    expect(flat.every((c) => c.count > 0)).toBe(true);
    expect(flat.map((c) => c.modelVersionId)).toEqual(
      [...flat.map((c) => c.modelVersionId)].sort((a, b) => a - b)
    );
  });
});

describe('recountVersions', () => {
  it('sets the count to everything published before the watermark', async () => {
    await setWatermark({ hour: W });
    await q(`INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (${V}, 99)`);
    await image(W - HOUR_MS);
    await image(W - 2 * HOUR_MS);
    await image(W + 5 * 60_000); // the job's, not yet counted
    expect(await recountVersions([V])).toEqual([{ modelVersionId: V, count: 2 }]);
    expect(await imageCount()).toBe(2);
  });

  it('sets a stale count with nothing countable to 0', async () => {
    await setWatermark({ hour: W });
    await q(`INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (11, 9)`);
    expect(await recountVersions([11])).toEqual([{ modelVersionId: 11, count: 0 }]);
    expect(await imageCount(11)).toBe(0);
  });
});

describe('backfill', () => {
  const res = { on: vi.fn() };
  const stage = (start: number, end: number, dryRun = false) =>
    stageRange({ start, end, batchSize: 2, concurrency: 1, dryRun, runContext: res });

  it('stages history, swaps it in, hands the job the next hour, and reverts', async () => {
    const now = W + 24 * HOUR_MS + 30 * 60_000; // so w0 = W
    await q(
      `INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (${V}, 7), (11, 5)`
    );
    await image(W - 3 * HOUR_MS);
    await image(W - 2 * HOUR_MS);
    await image(W - HOUR_MS, FAN, `"needsReview" = 'minor'`);
    await image(W + 5 * 60_000); // after w0: the job's

    const progress = await startBackfill(now);
    expect(progress).toMatchObject({ w0: W, j0: 4 });
    expect(await stage(1, 4, true)).toMatchObject({ staged: 2 });
    expect(await stage(1, 2)).toMatchObject({ staged: 2 });
    await expect(stage(2, 3)).rejects.toThrow('overlaps');
    await expect(finalizeBatch(100)).rejects.toThrow('Unstaged image ids: [[3,4]]');
    await stage(3, 4);

    expect(await finalizeBatch(1)).toEqual({ versions: 1, finished: false });
    expect(await finalizeBatch(1)).toEqual({ versions: 1, finished: false });
    expect(await finalizeBatch(1)).toEqual({ versions: 0, finished: true });
    expect(await imageCount(V)).toBe(2);
    expect(await imageCount(11)).toBe(0); // frozen, nothing staged
    expect(await watermark()).toEqual({ hour: W });
    await expect(finalizeBatch(100)).rejects.toThrow('Already finalized');

    expect(await countNextHour(W + 25 * HOUR_MS)).toMatchObject({ hour: W, images: 1 });
    expect(await imageCount(V)).toBe(3);

    // A version first counted by the job after finalize had no count before it.
    await q(`INSERT INTO "ModelVersion" VALUES (12, 100);
             INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (12, 3)`);
    expect(await revertBatch(100)).toEqual({ versions: 3, finished: true });
    expect(await imageCount(12)).toBe(0);
    expect(await imageCount(V)).toBe(7);
    expect(await imageCount(11)).toBe(5);
    expect((await watermark())?.paused).toBe(true);
    expect((await backfillStatus()).gaps).toEqual([]);
  });

  it('restages a gap left by a failed chunk, without colliding with the call it fell out of', async () => {
    for (let i = 0; i < 4; i++) await image(W - HOUR_MS);
    await startBackfill(W + 24 * HOUR_MS);
    const read = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    const real = read.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    let chunks = 0;
    read.mockImplementation((...args: unknown[]) =>
      // The first chunk (dataProcessor's [1, 3]) fails; dataProcessor logs it and carries on.
      String((args[0] as { strings?: string[] }).strings ?? args[0]).includes('ImageResourceNew') &&
      ++chunks === 1
        ? Promise.reject(new Error('replica hiccup'))
        : real(...args)
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await stage(1, 4)).toMatchObject({ staged: 1 });
    log.mockRestore();
    read.mockImplementation(real);
    expect((await backfillStatus()).gaps).toEqual([[1, 3]]);
    expect(await stage(1, 3)).toMatchObject({ staged: 3 });
    expect((await backfillStatus()).gaps).toEqual([]);
    await finalizeBatch(100);
    expect(await imageCount()).toBe(4);
  });

  it('reverts a version finalize left unchanged, taking back what the job added since', async () => {
    await q(`INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (${V}, 1)`);
    await image(W - HOUR_MS); // staged total 1 == the frozen 1
    await image(W + 5 * 60_000);
    await startBackfill(W + 24 * HOUR_MS + 30 * 60_000);
    await stage(1, 2);
    await finalizeBatch(100);
    await countNextHour(W + 25 * HOUR_MS);
    expect(await imageCount()).toBe(2);
    await revertBatch(100);
    expect(await imageCount()).toBe(1);
  });

  it('reverts mid-finalize without touching versions finalize has not reached, then refuses to finalize', async () => {
    await q(
      `INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount") VALUES (${V}, 7), (11, 5)`
    );
    await image(W - HOUR_MS);
    await startBackfill(W + 24 * HOUR_MS);
    await stage(1, 1);
    expect(await finalizeBatch(1)).toEqual({ versions: 1, finished: false }); // V only
    expect(await imageCount(V)).toBe(1);

    expect(await revertBatch(100)).toMatchObject({ finished: true });
    expect(await imageCount(V)).toBe(7);
    expect(await imageCount(11)).toBe(5); // still frozen, never visited
    await expect(finalizeBatch(100)).rejects.toThrow('A revert has started');
  });

  it('refuses to finalize once the job owns the counts', async () => {
    await image(W - HOUR_MS);
    await startBackfill(W + 24 * HOUR_MS);
    await stage(1, 1);
    await setWatermark({ hour: W });
    await expect(finalizeBatch(100)).rejects.toThrow('Watermark exists');
    expect(
      (await h.pg.query(`SELECT 1 FROM "KeyValue" WHERE key = $1`, [PROGRESS_KEY])).rows
    ).toHaveLength(1);
  });
});
