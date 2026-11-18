import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { imageReviewedSql } from '~/server/common/image-visibility';

// The real writes that replace or drop scanJobs.error / lastFailure, run in SQL: each must keep a
// permanent failure on record, or a locked rating on the Error row would count as reviewed.

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
const { markImageScanError } = await import('~/server/services/image-scan-pipeline');

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
  dbMock.dbRead.jobQueue.findMany.mockReset();
});

const url = (id: number) => `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${id}/a.png`;
const permanent = { failureType: 'send-fail', failureClass: 'permanent', reason: 'bad media' };
const transient = { failureType: 'send-fail', failureClass: 'transient', reason: 'try again' };

/** An image with a locked rating, queued for the ingest cron. */
const insert = async (
  id: number,
  scanJobs: object,
  { ingestion = 'Error', requestedAgo = 30 * 60 * 1000, createdAgo = 2 * HOUR } = {}
) => {
  await pg.query(
    `INSERT INTO "Image" (id, url, width, height, "createdAt", "scanRequestedAt", ingestion, "scanJobs")
     VALUES ($1, $2, 100, 100, $3, $4, $5, $6)`,
    [id, url(id), ago(createdAgo), ago(requestedAgo), ingestion, scanJobs]
  );
  await pg.query(
    `INSERT INTO "JobQueue" (type, "entityType", "entityId") VALUES ('ImageScan', 'Image', $1)`,
    [id]
  );
};

type Failure = { failureClass?: string };
type StoredScanJobs = { error?: Failure; lastFailure?: Failure; permanentFailure?: boolean };

const stored = async (id: number) => {
  const reviewed = imageReviewedSql();
  return (
    await pg.query<{ ingestion: string; scanJobs: StoredScanJobs; reviewed: boolean }>(
      `SELECT ingestion, "scanJobs", ${reviewed.text} AS reviewed FROM "Image" i WHERE id = $${
        reviewed.values.length + 1
      }`,
      [...reviewed.values, id]
    )
  ).rows[0];
};

const runCron = async (ids: number[]) => {
  dbMock.dbRead.jobQueue.findMany.mockResolvedValueOnce(
    ids.map((entityId) => ({ entityId })) as never
  );
  await ingestImages.run({} as never).result;
};

const submit = (id: number) =>
  ingestImage({ image: { id, url: url(id), type: 'image', width: 100, height: 100 } });
const submitSucceeds = () =>
  mockCreateImageIngestionRequest.mockResolvedValue({
    data: { id: 'wf-resubmit' },
    error: undefined,
    status: 200,
    useImageScanning: false,
  });
const submitFails = (status: number) =>
  mockCreateImageIngestionRequest.mockResolvedValue({
    data: undefined,
    error: { title: 'Server Error', status },
    status,
    useImageScanning: false,
  });
const callbackFails = (id: number) =>
  markImageScanError({
    workflowId: 'wf-late',
    imageId: id,
    status: 'failed',
    failureType: 'job-failed',
    failedSteps: [],
    reason: 'connection reset',
  });

describe('a permanent scan failure on a row with a locked rating', () => {
  it('survives the cron flipping an exhausted Rescan row to Error', async () => {
    await insert(
      1,
      { retryCount: 9, workflowId: 'wf-first', lastFailure: permanent },
      { ingestion: 'Rescan', requestedAgo: 2 * HOUR }
    );

    await runCron([1]);

    const row = await stored(1);
    expect(row.ingestion).toBe('Error');
    expect(row.scanJobs.lastFailure).toBeUndefined();
    expect(row.scanJobs.permanentFailure).toBe(true);
    expect(row.reviewed).toBe(false);
  });

  it('survives the cron aging a Pending row out to Error', async () => {
    await insert(
      2,
      { retryCount: 0, workflowId: 'wf-first', lastFailure: permanent },
      { ingestion: 'Pending', createdAgo: 8 * HOUR }
    );

    await runCron([2]);

    const row = await stored(2);
    expect(row.ingestion).toBe('Error');
    expect(row.scanJobs.lastFailure).toBeUndefined();
    expect(row.scanJobs.permanentFailure).toBe(true);
    expect(row.reviewed).toBe(false);
  });

  it('survives a second re-submit replacing lastFailure', async () => {
    await insert(3, { retryCount: 1, error: transient, lastFailure: permanent });
    submitSucceeds();

    await submit(3);

    const row = await stored(3);
    expect(row.scanJobs.lastFailure?.failureClass).toBe('transient');
    expect(row.scanJobs.permanentFailure).toBe(true);
    expect(row.reviewed).toBe(false);
  });

  it('survives a later submit failure replacing error', async () => {
    await insert(4, { retryCount: 1, error: permanent });
    submitFails(500);

    await submit(4);

    const row = await stored(4);
    expect(row.ingestion).toBe('Error');
    expect(row.scanJobs.error?.failureClass).not.toBe('permanent');
    expect(row.scanJobs.permanentFailure).toBe(true);
    expect(row.reviewed).toBe(false);
  });

  it('survives a later scan callback failure replacing error', async () => {
    await insert(5, { retryCount: 1, error: permanent });

    await callbackFails(5);

    const row = await stored(5);
    expect(row.scanJobs.error?.failureClass).not.toBe('permanent');
    expect(row.scanJobs.permanentFailure).toBe(true);
    expect(row.reviewed).toBe(false);
  });
});

describe('control: a history of transient failures only', () => {
  it('stays reviewable through the same writes', async () => {
    await insert(6, { retryCount: 1, error: transient });
    submitSucceeds();
    await submit(6);
    await callbackFails(6);
    submitFails(500);
    await submit(6);

    const row = await stored(6);
    expect(row.ingestion).toBe('Error');
    expect(row.scanJobs.permanentFailure).toBeUndefined();
    expect(row.reviewed).toBe(true);
  });
});
