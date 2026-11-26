import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

// The real SQL of an orchestrator 429 on an image-scan submit: the failure stamp ingestImage
// writes, and the ingest-images cron's read of it for the Pending age-out. The unit suites
// mock both statements, so a typo in either JSON path would pass them.

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
  IMAGE_SCANNING_PENDING_TIMEOUT: 60,
});

const { ingestImage } = await import('~/server/services/image.service');
const { ingestImages } = await import('~/server/jobs/image-ingestion');

let pg: PGlite;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text, type text DEFAULT 'image', width int, height int, meta jsonb,
      "scanRequestedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL, "scanJobs" jsonb
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
});

const failWith = (status: number, retryAfter?: number) =>
  mockCreateImageIngestionRequest.mockResolvedValue({
    data: undefined,
    error: { title: 'Too Many Requests', status },
    status,
    retryAfter,
    useImageScanning: false,
  });

const insert = (id: number, createdAt: string, scanJobs: object | null) =>
  pg.query(
    `INSERT INTO "Image" (id, url, width, height, "createdAt", "scanRequestedAt", ingestion, "scanJobs")
     VALUES ($1, $2, 100, 100, $3, $4, 'Pending', $5)`,
    [id, `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${id}/a.png`, createdAt, ago(10 * 60 * 1000), scanJobs]
  );

const row = async (id: number) =>
  (
    await pg.query<{ ingestion: string; scanJobs: any }>(
      `SELECT ingestion, "scanJobs" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const ingest = (id: number) =>
  ingestImage({
    image: {
      id,
      url: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${id}/a.png`,
      type: 'image',
      width: 100,
      height: 100,
    },
  });

describe('the 429 failure stamp, in SQL', () => {
  it('keeps the retry count and the start of the 429 run across repeated 429s', async () => {
    await insert(1, ago(0), { retryCount: 2 });
    failWith(429, 60);

    await ingest(1);
    const first = (await row(1)).scanJobs;
    await ingest(1);
    const second = (await row(1)).scanJobs;

    expect(first.retryCount).toBe(2);
    expect(first.error.responseStatus).toBe(429);
    expect(typeof first.error.firstRateLimitedAt).toBe('string');
    expect(second.retryCount).toBe(2);
    expect(second.error.firstRateLimitedAt).toBe(first.error.firstRateLimitedAt);
  });

  it('control: a 500 after the 429s counts an attempt and ends the 429 run', async () => {
    await insert(2, ago(0), { retryCount: 2 });
    failWith(429, 60);
    await ingest(2);
    failWith(500);

    await ingest(2);

    const { scanJobs } = await row(2);
    expect(scanJobs.retryCount).toBe(3);
    expect(scanJobs.error.firstRateLimitedAt).toBeUndefined();
  });
});

describe('the Pending age-out over real rows', () => {
  async function runCron(ids: number[]) {
    dbMock.dbRead.jobQueue.findMany.mockResolvedValueOnce(
      ids.map((entityId) => ({ entityId })) as never
    );
    // The exempt upload is re-sent; keep it rate limited.
    failWith(429, 60);
    await ingestImages.run({} as never).result;
  }

  it('spares an upload rate limited for an hour, ages out one rate limited for 7 hours and a 500', async () => {
    const stamp = (since: string) => ({
      retryCount: 0,
      error: { responseStatus: 429, failureClass: 'transient', firstRateLimitedAt: since },
    });
    await insert(10, ago(8 * HOUR), stamp(ago(1 * HOUR)));
    await insert(11, ago(8 * HOUR), stamp(ago(7 * HOUR)));
    await insert(12, ago(8 * HOUR), { retryCount: 0, error: { responseStatus: 500 } });

    await runCron([10, 11, 12]);

    expect((await row(10)).ingestion).toBe('Pending');
    expect((await row(11)).ingestion).toBe('Error');
    expect((await row(12)).ingestion).toBe('Error');
  });
});

describe('an Error row re-submitted successfully, over real rows', () => {
  const succeed = () =>
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: { id: 'wf-resubmit' },
      error: undefined,
      status: 200,
      useImageScanning: false,
    });
  // A reason the classifier does not recognise, so only the stored class can make it transient.
  const transientFailure = {
    failureType: 'send-fail',
    failureClass: 'transient',
    reason: 'unrecognised reply',
  };
  const insertError = async (
    id: number,
    scanJobs: object,
    { requestedAgo = 30 * 60 * 1000, ingestion = 'Error', createdAgo = 2 * HOUR } = {}
  ) => {
    await pg.query(
      `INSERT INTO "Image" (id, url, width, height, "createdAt", "scanRequestedAt", ingestion, "scanJobs")
       VALUES ($1, $2, 100, 100, $3, $4, $5, $6)`,
      [
        id,
        `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${id}/a.png`,
        ago(createdAgo),
        ago(requestedAgo),
        ingestion,
        scanJobs,
      ]
    );
    await pg.query(
      `INSERT INTO "JobQueue" (type, "entityType", "entityId") VALUES ('ImageScan', 'Image', $1)`,
      [id]
    );
  };
  const queued = async (id: number) =>
    (await pg.query(`SELECT 1 FROM "JobQueue" WHERE "entityId" = $1`, [id])).rows.length > 0;
  const runCron = async (ids: number[]) => {
    dbMock.dbRead.jobQueue.findMany.mockResolvedValueOnce(
      ids.map((entityId) => ({ entityId })) as never
    );
    await ingestImages.run({} as never).result;
  };

  beforeEach(() => dbMock.dbRead.jobQueue.findMany.mockReset());

  it('stays queued past the unknown cap while its re-submitted scan is in flight', async () => {
    await insertError(20, { retryCount: 12, error: transientFailure });
    succeed();

    await runCron([20]);
    expect(mockCreateImageIngestionRequest).toHaveBeenCalledTimes(1);
    await runCron([20]);

    expect(await queued(20)).toBe(true);
    const { scanJobs } = await row(20);
    expect(scanJobs.retryCount).toBe(12);
    // A cleared error is what ends a 429 run's age-out exemption.
    expect(scanJobs.error).toBeUndefined();
  });

  it('keeps its class through a second re-submit', async () => {
    await insertError(
      22,
      { retryCount: 12, workflowId: 'wf-first', lastFailure: transientFailure },
      { requestedAgo: 90 * 60 * 1000 }
    );
    succeed();

    await runCron([22]);
    expect(mockCreateImageIngestionRequest).toHaveBeenCalledTimes(1);
    await runCron([22]);

    expect(await queued(22)).toBe(true);
  });

  it('control: one past the transient cap is pruned', async () => {
    await insertError(21, { retryCount: 30, error: transientFailure });

    await runCron([21]);

    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    expect(await queued(21)).toBe(false);
  });

  it('control: the same row with no failure on record takes the unknown cap and is pruned', async () => {
    await insertError(23, { retryCount: 12 });

    await runCron([23]);

    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    expect(await queued(23)).toBe(false);
  });

  it('waits the full delay, not the transient one, while a re-submitted scan is in flight', async () => {
    await insertError(24, {
      retryCount: 12,
      workflowId: 'wf-first',
      lastFailure: transientFailure,
    });
    succeed();

    await runCron([24]);

    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    expect(await queued(24)).toBe(true);
  });

  it('an aged-out Pending row drops the earlier failure and takes the unknown cap', async () => {
    await insertError(
      25,
      { retryCount: 12, workflowId: 'wf-first', lastFailure: transientFailure },
      { ingestion: 'Pending', createdAgo: 8 * HOUR }
    );

    await runCron([25]);
    const { ingestion, scanJobs } = await row(25);
    expect(ingestion).toBe('Error');
    expect(scanJobs.lastFailure).toBeUndefined();
    await runCron([25]);

    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    expect(await queued(25)).toBe(false);
  });

  it('an exhausted Rescan row drops the earlier failure and is not re-sent once re-queued', async () => {
    await insertError(
      26,
      { retryCount: 9, workflowId: 'wf-first', lastFailure: transientFailure },
      { ingestion: 'Rescan', requestedAgo: 2 * HOUR }
    );

    await runCron([26]);
    const { ingestion, scanJobs } = await row(26);
    expect(ingestion).toBe('Error');
    expect(scanJobs.lastFailure).toBeUndefined();
    // The scan-queue trigger re-queues a row whose ingestion becomes Error.
    await pg.query(
      `INSERT INTO "JobQueue" (type, "entityType", "entityId") VALUES ('ImageScan', 'Image', 26)`
    );
    await runCron([26]);

    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    expect(await queued(26)).toBe(false);
  });
});
