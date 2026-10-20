import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

/**
 * A block on a banned owner's image is the ban's decision, so a clean scan result that lands
 * afterwards keeps it. An owner who is not banned keeps today's behaviour: the scan decides.
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

const BANNED = 7;
const ACTIVE = 8;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL REFERENCES "User"(id),
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
  `);
});

const runOnPglite = async (strings: TemplateStringsArray, values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]);
};

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await runOnPglite(strings, values)).affectedRows ?? 0) as never
  );
  dbMock.dbWrite.appeal.findMany.mockResolvedValue([] as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 1, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    if (text.includes('"User"')) return (await runOnPglite(strings, values)).rows;
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "User";
    INSERT INTO "User" (id, "bannedAt") VALUES (${BANNED}, now()), (${ACTIVE}, NULL);
  `);
});

const insertImage = (
  id: number,
  userId: number,
  ingestion: string,
  blockedFor: string | null,
  nsfwLevel = ingestion === 'Blocked' ? 32 : 0
) =>
  holder.db.query(
    `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel") VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, ingestion, blockedFor, nsfwLevel]
  );

/** The image as `loadImageForScan` handed it over, possibly before the row changed under it. */
const loaded = (id: number, userId: number, ingestion: string, blockedFor: string | null) =>
  ({
    id,
    userId,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: null,
    type: 'image',
    meta: { prompt: 'a landscape' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: ingestion === 'Blocked' ? 32 : 0,
    ingestion,
    blockedFor,
    needsReview: null,
  } as unknown as ScanImage);

const imageRow = async (id: number) =>
  (
    await holder.db.query<{ ingestion: string; blockedFor: string | null; nsfwLevel: number }>(
      `SELECT ingestion, "blockedFor", "nsfwLevel" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const scan = (image: ScanImage) =>
  resolveScanOutcome({ image, workflowId: 'wf', prompt: 'a landscape' });

describe("a clean scan landing on a banned owner's blocked image", () => {
  it('keeps the image blocked', async () => {
    await insertImage(1, BANNED, 'Blocked', 'moderated');

    const outcome = await scan(loaded(1, BANNED, 'Blocked', 'moderated'));

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(1)).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
  });

  it('keeps a block the ban wrote after the scan loaded the image', async () => {
    await insertImage(2, BANNED, 'Blocked', 'moderated');

    const outcome = await scan(loaded(2, BANNED, 'Pending', null));

    expect(outcome).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(await imageRow(2)).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
  });

  it("keeps the row's own block reason", async () => {
    await insertImage(3, BANNED, 'Blocked', 'tos');

    await scan(loaded(3, BANNED, 'Blocked', 'tos'));

    expect((await imageRow(3)).blockedFor).toBe('tos');
  });

  it('keeps a block carried by the ingestion state alone', async () => {
    await insertImage(11, BANNED, 'Blocked', null, 0);

    const outcome = await scan(loaded(11, BANNED, 'Blocked', null));

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(11)).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
  });

  it('records a block with no reason as moderated', async () => {
    await insertImage(6, BANNED, 'Blocked', null);

    const outcome = await scan(loaded(6, BANNED, 'Blocked', null));

    expect(outcome.blockedFor).toBe('moderated');
    expect((await imageRow(6)).blockedFor).toBe('moderated');
  });

  // One marker per row, so each of them alone keeps the block.
  it.each([
    ['a failed scan moved it to Error, keeping its reason', 'Error', 'tos', 0],
    ['a rescan request moved it to Rescan, keeping its level', 'Rescan', null, 32],
  ] as const)('keeps the block after %s', async (_, ingestion, blockedFor, nsfwLevel) => {
    await insertImage(9, BANNED, ingestion, blockedFor, nsfwLevel);

    const outcome = await scan(loaded(9, BANNED, ingestion, blockedFor));

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(9)).toEqual({
      ingestion: 'Blocked',
      blockedFor: blockedFor ?? 'moderated',
      nsfwLevel: 32,
    });
  });
});

describe('a clean scan that should still lift or leave the image visible', () => {
  it("clears a blocked image's block when its owner is not banned (moderator rescan)", async () => {
    // Another owner's banned, blocked image, stored first: the check reads the scanned image.
    await insertImage(10, BANNED, 'Blocked', 'moderated');
    await insertImage(4, ACTIVE, 'Blocked', 'moderated');

    const outcome = await scan(loaded(4, ACTIVE, 'Blocked', 'moderated'));

    expect(outcome.ingestion).toBe('Scanned');
    expect(await imageRow(4)).toEqual({ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1 });
  });

  it("publishes a banned owner's image that the ban left up", async () => {
    await insertImage(5, BANNED, 'Pending', null);

    const outcome = await scan(loaded(5, BANNED, 'Pending', null));

    expect(outcome.ingestion).toBe('Scanned');
    expect(await imageRow(5)).toEqual({ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1 });
  });
});
