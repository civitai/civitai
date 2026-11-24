import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ModRules from '~/server/utils/mod-rules';
import type * as NotificationService from '~/server/services/notification.service';

/**
 * A block on a banned owner's image is the ban's decision, so a clean scan result that lands
 * afterwards keeps it. An owner who is not banned keeps today's behaviour: the scan decides.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditPostImageMeta: vi.fn(() => ({ success: true })),
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
vi.mock('~/server/utils/mod-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof ModRules>()),
  evaluateRules: vi.fn(() => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(async () => undefined),
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
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { includesInappropriate } from '~/utils/metadata/audit';
import { getImagesModRules } from '~/server/services/image.service';
import { evaluateRules } from '~/server/utils/mod-rules';
import { createNotification } from '~/server/services/notification.service';
import { ModerationRuleAction } from '~/shared/utils/prisma/enums';

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  tagNsfwLevel: 1,
  newUser: false,
  newUserAsked: [] as unknown[],
}));

const BANNED = 7;
const ACTIVE = 8;
const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
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
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]',
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3)
    );
    CREATE TYPE "EntityType" AS ENUM ('Image');
    -- Read by a blocking scan's write: a pending appeal keeps its review.
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" ("entityType" "EntityType", "entityId" int, status "AppealStatus");
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
      return [
        { id: 10, name: 'tag', type: 'Label', nsfwLevel: holder.tagNsfwLevel, confidence: 90 },
      ];
    if (text.includes('is_new_user')) {
      holder.newUserAsked.push(values[0]);
      return [{ isNewUser: holder.newUser }];
    }
    // The ban check's statement: its SQL arrives as a nested value, not in `strings`.
    if (text.includes(' AS kept ')) {
      return (await runOnPglite(strings, values)).rows;
    }
    if (
      text.includes('FROM "Image" i WHERE i.id') ||
      text.includes('SELECT ingestion, "blockedFor", "nsfwLevel" FROM "Image"') ||
      text.includes('SELECT "blockedFor" FROM "Image"')
    )
      return (await runOnPglite(strings, values)).rows;
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  holder.tagNsfwLevel = 1;
  holder.newUser = false;
  holder.newUserAsked = [];
  await holder.db.exec(`
    TRUNCATE "Image", "User", "CsamReport";
    INSERT INTO "User" (id, "bannedAt")
      VALUES (${BANNED}, now()), (${ACTIVE}, NULL),
        (${CAPTURE}, NULL);
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
  it('clean scan case 1', async () => {
    // Another owner's banned, blocked image, stored first: the check reads the scanned image.
    await insertImage(10, BANNED, 'Blocked', 'moderated');
    await insertImage(4, ACTIVE, 'Blocked', 'AiNotVerified');

    const outcome = await scan(loaded(4, ACTIVE, 'Blocked', 'AiNotVerified'));

    expect(outcome.ingestion).toBe('Scanned');
    expect(await imageRow(4)).toEqual({ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1 });
  });

  it('clean scan case 2', async () => {
    await insertImage(10, BANNED, 'Blocked', 'moderated');
    await insertImage(40, ACTIVE, 'Blocked', 'moderated');

    const outcome = await scan(loaded(40, ACTIVE, 'Blocked', 'moderated'));

    expect(outcome.ingestion).toBe('Blocked');
    expect(await imageRow(40)).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
  });

  it("publishes a banned owner's image that the ban left up", async () => {
    await insertImage(5, BANNED, 'Pending', null);

    const outcome = await scan(loaded(5, BANNED, 'Pending', null));

    expect(outcome.ingestion).toBe('Scanned');
    expect(await imageRow(5)).toEqual({ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1 });
  });
});

describe('a feedback page capture', () => {
  it('keeps a prior block its own state holds across a clean scan', async () => {
    await insertImage(30, CAPTURE, 'Blocked', 'CSAM');
    const outcome = await scan(loaded(30, CAPTURE, 'Blocked', 'CSAM'));
    expect(outcome.ingestion).toBe('Blocked');
    expect((await imageRow(30)).ingestion).toBe('Blocked');
  });

  it('capture case 1', async () => {
    await insertImage(31, CAPTURE, 'Blocked', 'AiNotVerified');
    const outcome = await scan(loaded(31, CAPTURE, 'Blocked', 'AiNotVerified'));
    expect(outcome.ingestion).toBe('Scanned');
  });

  it('capture case 2', async () => {
    await insertImage(41, CAPTURE, 'Blocked', 'moderated');
    const outcome = await scan(loaded(41, CAPTURE, 'Blocked', 'moderated'));
    expect(outcome.ingestion).toBe('Blocked');
    expect((await imageRow(41)).ingestion).toBe('Blocked');
  });

  it('gets the content review key an ordinary owner would', async () => {
    vi.mocked(includesInappropriate).mockImplementation(() => 'poi' as never);
    await insertImage(32, CAPTURE, 'Pending', null);
    await insertImage(33, ACTIVE, 'Pending', null);

    let capture, ordinary;
    try {
      capture = await scan(loaded(32, CAPTURE, 'Pending', null));
      ordinary = await scan(loaded(33, ACTIVE, 'Pending', null));
    } finally {
      vi.mocked(includesInappropriate).mockImplementation(() => false);
    }

    expect(ordinary.reviewKey).toBe('poi');
    expect(capture.reviewKey).toBe('poi');
    const row = (
      await holder.db.query<{ needsReview: string | null }>(
        `SELECT "needsReview" FROM "Image" WHERE id = 32`
      )
    ).rows[0];
    expect(row).toEqual({ needsReview: 'poi' });
  });

  it('is never queued as a new user, where a new owner is (control)', async () => {
    holder.tagNsfwLevel = 4;
    holder.newUser = true;
    await insertImage(34, CAPTURE, 'Pending', null);
    await insertImage(35, ACTIVE, 'Pending', null);

    const capture = await scan(loaded(34, CAPTURE, 'Pending', null));
    const ordinary = await scan(loaded(35, ACTIVE, 'Pending', null));

    expect(ordinary.reviewKey).toBe('newUser');
    expect(capture.reviewKey).toBeNull();
    expect(holder.newUserAsked).toEqual([ACTIVE]);
  });

  it('blocked by a moderation rule notifies no one, where an owner is told (control)', async () => {
    vi.mocked(getImagesModRules).mockResolvedValue([{ id: 1 }] as never);
    vi.mocked(evaluateRules).mockReturnValue({
      id: 1,
      action: ModerationRuleAction.Block,
      reason: 'rule',
    } as never);
    await insertImage(36, CAPTURE, 'Pending', null);
    await insertImage(37, ACTIVE, 'Pending', null);
    try {
      expect((await scan(loaded(36, CAPTURE, 'Pending', null))).ingestion).toBe('Blocked');
      expect((await scan(loaded(37, ACTIVE, 'Pending', null))).ingestion).toBe('Blocked');
    } finally {
      vi.mocked(getImagesModRules).mockResolvedValue([]);
      vi.mocked(evaluateRules).mockReturnValue(undefined);
    }

    expect(vi.mocked(createNotification).mock.calls.map(([n]) => n.userId)).toEqual([ACTIVE]);
  });
});
