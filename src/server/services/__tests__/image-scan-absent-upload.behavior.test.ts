import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

// A scan that fails on an image whose upload the store says does not exist will never succeed,
// whatever the orchestrator's reason says, so the ingest cron must not keep re-sending it.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

setEnv({
  S3_IMAGE_B2_ENDPOINT: 'https://b2.example',
  S3_IMAGE_B2_ACCESS_KEY: 'ia',
  S3_IMAGE_B2_SECRET_KEY: 'is',
});
const store = { absent: new Set<string>(), down: false };
const s3Send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (
  command: unknown
) => {
  if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected S3 command');
  if (store.down) throw Object.assign(new Error('503'), { $metadata: { httpStatusCode: 503 } });
  if (store.absent.has(command.input.Key ?? ''))
    throw Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
  return { ContentLength: 1024 };
}) as never);
afterAll(() => s3Send.mockRestore());

const { markImageScanError } = await import('~/server/services/image-scan-pipeline');

const KEY = '0a0b0c0d-0000-4000-8000-0000000000dd';
const IMAGE_ID = 31;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id int PRIMARY KEY, url text, type text DEFAULT 'image',
      ingestion "ImageIngestionStatus" NOT NULL, "scanJobs" jsonb, "userId" int,
      "blockedFor" text, "needsReview" text);
  `);
  const raw = pgliteRaw(pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbRead.image.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await pg.query(`SELECT url FROM "Image" WHERE id = $1`, [where.id])).rows[0] ??
      null) as never
  );
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE "Image"`);
  await pg.query(
    `INSERT INTO "Image" (id, url, ingestion, "userId") VALUES ($1, $2, 'Pending', 1)`,
    [IMAGE_ID, KEY]
  );
  store.absent.clear();
  store.down = false;
});

/** A hash-step failure whose reason reads as infra churn. */
const fail = () =>
  markImageScanError({
    workflowId: 'wf-1',
    imageId: IMAGE_ID,
    status: 'failed',
    failureType: 'job-failed',
    failedSteps: ['mediaHash'],
    reason: 'Failed to download media. Giving up after 3 attempts',
  });

const storedClass = async () =>
  (
    await pg.query<{ failureClass: string }>(
      `SELECT "scanJobs"->'error'->>'failureClass' AS "failureClass" FROM "Image" WHERE id = $1`,
      [IMAGE_ID]
    )
  ).rows[0].failureClass;

describe('a scan failure on an image whose upload is not in the store', () => {
  it('is recorded permanent, the class the cron stops retrying', async () => {
    store.absent.add(KEY);
    const { failureClass } = await fail();
    expect(failureClass).toBe('permanent');
    expect(await storedClass()).toBe('permanent');
  });

  it('control: stays transient while the upload exists', async () => {
    expect((await fail()).failureClass).toBe('transient');
    expect(await storedClass()).toBe('transient');
  });

  it('control: stays transient when the store cannot be read', async () => {
    store.absent.add(KEY);
    store.down = true;
    expect((await fail()).failureClass).toBe('transient');
  });
});
