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
import { auditMetaData } from '~/utils/metadata/audit';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, tagLevel: 1 }));

const APPEALED = 41;
const FLAGGED = 42;
const DECIDED = 43;
const VISIBLE = 44;
const LEGACY = 45;
const BLOCKED_ONLY = 46;
const CSAM_BLOCKED = 47;
const CSAM_SCANNED = 48;

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
    -- Enums as in prod, so a literal outside the enum fails here too.
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending'
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(auditMetaData).mockReturnValue({ success: true } as never);
  holder.tagLevel = 1;
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.appeal.findMany.mockImplementation(
    (async ({ where }: any) =>
      // Built from the keys present, so a filter the code drops widens the match as in Prisma.
      (
        await holder.db.query(
          `SELECT "entityId" FROM "Appeal" WHERE "entityId" = ANY($1)` +
            (where.entityType ? ` AND "entityType" = '${where.entityType}'` : '') +
            (where.status ? ` AND status = '${where.status}'` : ''),
          [where.entityId.in]
        )
      ).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: holder.tagLevel, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal";
    INSERT INTO "Image" (id, ingestion, "blockedFor", "nsfwLevel", "needsReview") VALUES
      (${APPEALED}, 'Blocked', 'moderated', 32, 'appeal'),
      (${FLAGGED}, 'Rescan', NULL, 4, 'minor'),
      (${DECIDED}, 'Blocked', 'moderated', 32, NULL),
      (${VISIBLE}, 'Scanned', NULL, 1, 'appeal'),
      (${LEGACY}, 'Scanned', 'moderated', 4, 'appeal'),
      (${BLOCKED_ONLY}, 'Blocked', NULL, 4, 'appeal'),
      (${CSAM_BLOCKED}, 'Blocked', 'moderated', 32, 'csam'),
      (${CSAM_SCANNED}, 'Scanned', NULL, 1, 'csam');
    -- FLAGGED shares its id with a post's appeal; DECIDED's own appeal is already closed.
    INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES
      ('Image', ${APPEALED}, 'Pending'),
      ('Post', ${FLAGGED}, 'Pending'),
      ('Image', ${DECIDED}, 'Rejected'),
      ('Image', ${VISIBLE}, 'Pending'),
      ('Image', ${LEGACY}, 'Pending'),
      ('Image', ${BLOCKED_ONLY}, 'Pending');
  `);
});

type ScanFields = { ingestion: string; nsfwLevel: number; blockedFor: string | null };
type LoadedFields = ScanFields & { needsReview: string | null };

/** The image as `loadImageForScan` would hand it over, read from the stand-in row. */
const scanImage = async (id: number, over: Partial<LoadedFields> = {}) => {
  const row = (
    await holder.db.query<LoadedFields>(
      `SELECT ingestion, "nsfwLevel", "blockedFor", "needsReview" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];
  return {
    id,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a landscape' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    ...row,
    ...over,
  } as unknown as ScanImage;
};

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
    await holder.db.query<ScanFields & { needsReview: string | null }>(
      `SELECT "needsReview", ingestion, "blockedFor", "nsfwLevel" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const scan = async (id: number) =>
  resolveScanOutcome({ image: await scanImage(id), workflowId: 'wf', prompt: 'a landscape' });

describe('a clean rescan', () => {
  it('does not leave a pending appeal the appeals queue cannot reach', async () => {
    await scan(APPEALED);

    expect(await strandedAppeals()).toEqual([]);
  });

  it('keeps an image under appeal blocked after its rescan request cleared the block', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET ingestion = 'Rescan', "blockedFor" = NULL WHERE id = ${APPEALED}`
    );

    const outcome = await scan(APPEALED);

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(APPEALED)).toEqual({
      needsReview: 'appeal',
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
  });

  it("keeps the image's own block reason", async () => {
    await holder.db.exec(
      `UPDATE "Image" SET "blockedFor" = 'AiNotVerified' WHERE id = ${APPEALED}`
    );

    await scan(APPEALED);

    expect((await imageRow(APPEALED)).blockedFor).toBe('AiNotVerified');
  });

  it.each([
    ['a legacy block reason on a scanned row', LEGACY],
    ['a Blocked ingestion alone', BLOCKED_ONLY],
  ])('treats %s as a block to keep', async (_, id) => {
    const outcome = await scan(id);

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(id)).toMatchObject({ needsReview: 'appeal', ingestion: 'Blocked' });
  });

  it('does not block an image that was visible while under appeal', async () => {
    const outcome = await scan(VISIBLE);

    expect(outcome.ingestion).toBe('Scanned');
    expect(await imageRow(VISIBLE)).toEqual({
      needsReview: 'appeal',
      ingestion: 'Scanned',
      blockedFor: null,
      nsfwLevel: 1,
    });
  });

  it('still clears another review flag on an image with no pending appeal of its own', async () => {
    await scan(FLAGGED);

    expect(await imageRow(FLAGGED)).toMatchObject({ needsReview: null, ingestion: 'Scanned' });
  });

  it('does not put an image whose appeal was already decided back in the appeals queue', async () => {
    await scan(DECIDED);

    expect((await imageRow(DECIDED)).needsReview).toBeNull();
  });
});

describe('a rescan that blocks an image under appeal', () => {
  beforeEach(() => {
    // The prompt audit only blocks an nsfw image.
    holder.tagLevel = 16;
    vi.mocked(auditMetaData).mockReturnValue({ success: false, blockedFor: ['prompt'] } as never);
  });

  it("records the scan's own block reason on an image that was already blocked", async () => {
    await scan(APPEALED);

    expect(await imageRow(APPEALED)).toEqual({
      needsReview: 'appeal',
      ingestion: 'Blocked',
      blockedFor: 'prompt',
      nsfwLevel: 32,
    });
  });

  it("keeps the appeal and the scan's own block reason", async () => {
    await scan(VISIBLE);

    expect(await imageRow(VISIBLE)).toEqual({
      needsReview: 'appeal',
      ingestion: 'Blocked',
      blockedFor: 'prompt',
      nsfwLevel: 32,
    });
  });
});

describe('a rescan of an image carrying the moderator-only review flag', () => {
  it.each([
    ['a blocked image', CSAM_BLOCKED],
    ['a visible image', CSAM_SCANNED],
  ])('keeps the flag on %s', async (_, id) => {
    const outcome = await scan(id);

    expect(outcome.reviewKey).toBe('csam');
    expect((await imageRow(id)).needsReview).toBe('csam');
  });

  it('keeps the flag over a pending appeal', async () => {
    await holder.db.exec(
      `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Image', ${CSAM_BLOCKED}, 'Pending')`
    );

    const outcome = await scan(CSAM_BLOCKED);

    expect(outcome.reviewKey).toBe('csam');
    expect(await imageRow(CSAM_BLOCKED)).toMatchObject({
      needsReview: 'csam',
      ingestion: 'Blocked',
    });
  });

  it('keeps a flag that landed after the image was loaded', async () => {
    const loaded = await scanImage(CSAM_SCANNED, { needsReview: null });

    await resolveScanOutcome({ image: loaded, workflowId: 'wf', prompt: 'a landscape' });

    expect((await imageRow(CSAM_SCANNED)).needsReview).toBe('csam');
  });

  it('keeps the flag when the scan blocks the image', async () => {
    holder.tagLevel = 16;
    vi.mocked(auditMetaData).mockReturnValue({ success: false, blockedFor: ['prompt'] } as never);

    await scan(CSAM_SCANNED);

    expect(await imageRow(CSAM_SCANNED)).toMatchObject({
      needsReview: 'csam',
      ingestion: 'Blocked',
    });
  });
});
