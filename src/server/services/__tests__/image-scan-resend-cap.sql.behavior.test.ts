import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { IMAGE_SCAN_TRANSIENT_RETRY_LIMIT } from '~/server/services/image-scan-failure';

// An Error row whose re-submitted scan never calls back must still spend its retry ceiling, run
// through the real submit writer and the real ingest cron in SQL.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockCreateImageIngestionRequest } = vi.hoisted(() => ({
  mockCreateImageIngestionRequest: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createImageIngestionRequest: mockCreateImageIngestionRequest,
}));
// The cron's writes run only in prod, and with isProd on `~/env/client` demands NEXT_PUBLIC_* at
// import; it is the module that throws, so it is not spread.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isProd: true,
}));
setEnv({
  IMAGE_SCANNING_MAX_PER_RUN: 100,
  IMAGE_SCANNING_RETRY_DELAY: 5,
  IMAGE_SCANNING_PENDING_TIMEOUT: 60 * 24 * 365,
});

const { ingestImage } = await import('~/server/services/image.service');
const { ingestImages } = await import('~/server/jobs/image-ingestion');

let pg: PGlite;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text, type text DEFAULT 'image', width int, height int, meta jsonb,
      "scanRequestedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL, "scanJobs" jsonb, "userId" int,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT TRUE, metadata jsonb
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityType" text, "entityId" int);
    CREATE TABLE "Article" (id int PRIMARY KEY, status "ArticleStatus");
    CREATE TABLE "JobQueue" (type "JobQueueType", "entityType" "EntityType", "entityId" int);
  `);
  const raw = pgliteRaw(pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE "Image", "JobQueue"`);
  mockCreateImageIngestionRequest.mockReset();
  mockCreateImageIngestionRequest.mockResolvedValue({
    data: { id: 'wf-resubmit' },
    error: undefined,
    status: 200,
    useImageScanning: false,
  });
  dbMock.dbRead.jobQueue.findMany.mockReset();
});

const url = (id: number) => `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${id}/a.png`;
const transient = { failureType: 'job-failed', failureClass: 'transient', reason: 'timeout' };

const insert = async (id: number, ingestion: string, scanJobs: object) => {
  await pg.query(
    `INSERT INTO "Image" (id, url, width, height, "createdAt", "scanRequestedAt", ingestion, "scanJobs")
     VALUES ($1, $2, 100, 100, $3, $4, $5, $6)`,
    [id, url(id), ago(48 * HOUR), ago(2 * HOUR), ingestion, scanJobs]
  );
  await pg.query(
    `INSERT INTO "JobQueue" (type, "entityType", "entityId") VALUES ('ImageScan', 'Image', $1)`,
    [id]
  );
};

const retryCount = async (id: number) =>
  (
    await pg.query<{ n: number | null }>(
      `SELECT ("scanJobs"->>'retryCount')::int AS n FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0].n;

const queued = async (id: number) =>
  (await pg.query(`SELECT 1 FROM "JobQueue" WHERE "entityId" = $1`, [id])).rows.length > 0;

/** One hourly cron run in which the last scan never called back. */
const runCronAnHourLater = async (id: number) => {
  await pg.query(`UPDATE "Image" SET "scanRequestedAt" = $1 WHERE id = $2`, [ago(2 * HOUR), id]);
  const rows = (await queued(id)) ? [{ entityId: id }] : [];
  dbMock.dbRead.jobQueue.findMany.mockResolvedValueOnce(rows as never);
  await ingestImages.run({} as never).result;
};

const submit = (id: number) =>
  ingestImage({ image: { id, url: url(id), type: 'image', width: 100, height: 100 } });

describe('an Error row re-sent after a scan that never called back', () => {
  it('stops being re-sent once its re-sends reach the transient ceiling', async () => {
    const start = IMAGE_SCAN_TRANSIENT_RETRY_LIMIT - 2;
    await insert(1, 'Error', { retryCount: start, workflowId: 'wf-lost', lastFailure: transient });

    for (let run = 0; run < 6; run++) await runCronAnHourLater(1);

    expect(mockCreateImageIngestionRequest).toHaveBeenCalledTimes(2);
    expect(await retryCount(1)).toBe(IMAGE_SCAN_TRANSIENT_RETRY_LIMIT);
    expect(await queued(1)).toBe(false);
  });

  it('counts a re-send of an Error row with no scanJobs at all', async () => {
    await insert(2, 'Error', {});
    await pg.query(`UPDATE "Image" SET "scanJobs" = NULL WHERE id = 2`);

    await submit(2);

    expect(await retryCount(2)).toBe(1);
  });
});

describe('control: re-sends that do not count', () => {
  it('a recorded failure is not counted a second time by the re-send that follows it', async () => {
    await insert(3, 'Error', { retryCount: 3, error: transient });

    await submit(3);

    expect(await retryCount(3)).toBe(3);
  });

  it('a Pending re-send keeps its retryCount', async () => {
    await insert(4, 'Pending', { retryCount: 2, workflowId: 'wf-lost', lastFailure: transient });

    await submit(4);

    expect(await retryCount(4)).toBe(2);
  });

  it('a Rescan re-send keeps its retryCount', async () => {
    await insert(5, 'Rescan', { retryCount: 2, workflowId: 'wf-lost', lastFailure: transient });

    await submit(5);

    expect(await retryCount(5)).toBe(2);
  });
});

const submitFails = (status: number) =>
  mockCreateImageIngestionRequest.mockResolvedValueOnce({
    data: undefined,
    error: { title: 'Server Error', status },
    status,
    useImageScanning: false,
  });

describe('an Error row whose lost scan is followed by a failed submit', () => {
  it('stops being re-sent when lost scans alternate with 429 submits', async () => {
    const start = IMAGE_SCAN_TRANSIENT_RETRY_LIMIT - 2;
    await insert(6, 'Error', { retryCount: start, workflowId: 'wf-lost', lastFailure: transient });

    for (let run = 0; run < 8; run++) {
      if (run % 2 === 0) submitFails(429);
      await runCronAnHourLater(6);
    }

    expect(mockCreateImageIngestionRequest).toHaveBeenCalledTimes(3);
    expect(await retryCount(6)).toBe(IMAGE_SCAN_TRANSIENT_RETRY_LIMIT);
    expect(await queued(6)).toBe(false);
  });

  it('counts both the lost scan and a failed submit', async () => {
    await insert(7, 'Error', { retryCount: 5, workflowId: 'wf-lost', lastFailure: transient });
    submitFails(500);

    await submit(7);

    expect(await retryCount(7)).toBe(7);
  });
});

describe('control: failed submits that count as before', () => {
  it('a 429 after a recorded failure spends nothing', async () => {
    await insert(8, 'Error', { retryCount: 5, error: transient });
    submitFails(429);

    await submit(8);

    expect(await retryCount(8)).toBe(5);
  });

  it('a failed Pending submit counts once', async () => {
    await insert(9, 'Pending', { retryCount: 1, workflowId: 'wf-lost', lastFailure: transient });
    submitFails(500);

    await submit(9);

    expect(await retryCount(9)).toBe(2);
  });
});
