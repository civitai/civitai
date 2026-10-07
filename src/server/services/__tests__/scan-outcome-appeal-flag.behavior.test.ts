import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

/**
 * The appeals queue lists images by `needsReview = 'appeal'`, and the blocked-image purge spares only
 * those rows. A rescan that rewrites the flag while the Appeal is still Pending leaves an appeal
 * nobody can reach on an image the purge is free to delete.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditMetaData: vi.fn(() => ({ success: true })),
  includesInappropriate: vi.fn(() => false),
  includesPoi: vi.fn(() => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () => []),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const APPEALED = 41;
const FLAGGED = 42;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus",
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      status text NOT NULL DEFAULT 'Pending'
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('');
    if (text.includes('"Appeal"')) {
      const flat = Prisma.sql(strings, ...(values as never[]));
      return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
    }
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 1, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal";
    INSERT INTO "Image" (id, ingestion, "blockedFor", "nsfwLevel", "needsReview") VALUES
      (${APPEALED}, 'Blocked', 'moderated', 32, 'appeal'),
      (${FLAGGED}, 'Rescan', NULL, 4, 'minor');
    INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', ${APPEALED});
  `);
});

const scanImage = (id: number, ingestion: string) =>
  ({
    id,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a landscape' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion,
  } as unknown as ScanImage);

/** Pending image appeals the queue cannot see: the closing condition of the ticket, as a query. */
const strandedAppeals = async () =>
  (
    await holder.db.query<{ id: number; needsReview: string | null }>(
      `SELECT a."entityId" AS id, i."needsReview"
       FROM "Appeal" a JOIN "Image" i ON i.id = a."entityId"
       WHERE a."entityType" = 'Image' AND a.status = 'Pending'
         AND i."needsReview" IS DISTINCT FROM 'appeal'`
    )
  ).rows;

const imageRow = async (id: number) =>
  (
    await holder.db.query<{ needsReview: string | null; ingestion: string }>(
      `SELECT "needsReview", ingestion FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe('a clean rescan', () => {
  it('does not leave a pending appeal the appeals queue cannot reach', async () => {
    await resolveScanOutcome({ image: scanImage(APPEALED, 'Blocked'), workflowId: 'wf' });

    expect(await strandedAppeals()).toEqual([]);
  });

  it('keeps an image under appeal blocked until the appeal is decided', async () => {
    // A rescan request clears the block first, so the scan cannot rely on the row still saying Blocked.
    await holder.db.exec(
      `UPDATE "Image" SET ingestion = 'Rescan', "blockedFor" = NULL WHERE id = ${APPEALED}`
    );

    const outcome = await resolveScanOutcome({
      image: scanImage(APPEALED, 'Rescan'),
      workflowId: 'wf',
    });

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(APPEALED)).toEqual({ needsReview: 'appeal', ingestion: 'Blocked' });
  });

  it('still clears another review flag on an image with no appeal', async () => {
    await resolveScanOutcome({ image: scanImage(FLAGGED, 'Rescan'), workflowId: 'wf' });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Scanned' });
  });
});
