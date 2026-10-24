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
