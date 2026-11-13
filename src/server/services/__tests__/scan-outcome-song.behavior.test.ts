import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

/**
 * A song has no tags to audit, so its scan hands the writer the level to store. Everything that can
 * overrule a scan on an image (an appeal, a CSAM flag, a banned owner, a moderation rule, a locked
 * level) must overrule it on a song too.
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
vi.mock('~/server/services/notification.service', () => ({
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
import { getImagesModRules } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const OWNER = 2;
const BANNED = 3;
const PG = 1;
const BLOCKED = 32;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
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
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending'
    );
    CREATE TABLE "EvidenceHeldUser" ("userId" int PRIMARY KEY);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY);
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]',
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3)
    );
  `);
});

const runOnPglite = async (strings: TemplateStringsArray, values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]);
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(getImagesModRules).mockResolvedValue([] as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await runOnPglite(strings, values)).affectedRows ?? 0) as never
  );
  dbMock.dbWrite.appeal.findMany.mockImplementation(
    (async ({ where }: any) =>
      (
        await holder.db.query(
          `SELECT "entityId" FROM "Appeal" WHERE "entityId" = ANY($1) AND "entityType" = 'Image' AND status = 'Pending'`,
          [where.entityId.in]
        )
      ).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('');
    // A song has no tags; reading them would be the image audit running on it.
    if (text.includes('TagsOnImageDetails')) throw new Error('a song must not be tag-audited');
    if (text.includes(' AS held ') || text.includes('"User"'))
      return (await runOnPglite(strings, values)).rows;
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "User", "Appeal", "EvidenceHeldUser", "EvidenceHoldImage", "CsamReport";
    INSERT INTO "User" (id, "bannedAt") VALUES (${OWNER}, NULL), (${BANNED}, now());
  `);
});

const insertSong = (
  id: number,
  over: { userId?: number; ingestion?: string; needsReview?: string | null } = {}
) =>
  holder.db.query(
    `INSERT INTO "Image" (id, "userId", ingestion, "needsReview", metadata)
     VALUES ($1, $2, $3, $4, '{"lyrics":[{"t":3,"text":"la"}]}')`,
    [id, over.userId ?? OWNER, over.ingestion ?? 'Pending', over.needsReview ?? null]
  );

const loaded = (id: number, over: Record<string, unknown> = {}) =>
  ({
    id,
    userId: OWNER,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: null,
    type: 'audio',
    meta: {},
    metadata: { lyrics: [{ t: 3, text: 'la' }] },
    postId: null,
    nsfwLevelLocked: false,
    nsfwLevel: 0,
    ingestion: 'Pending',
    blockedFor: null,
    needsReview: null,
    ...over,
  } as unknown as ScanImage);

const row = async (id: number) =>
  (
    await holder.db.query<{
      ingestion: string;
      nsfwLevel: number;
      blockedFor: string | null;
      needsReview: string | null;
      metadata: unknown;
      minor: boolean;
    }>(
      `SELECT ingestion, "nsfwLevel", "blockedFor", "needsReview", metadata, minor FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const scanClean = (image: ScanImage) =>
  resolveScanOutcome({ image, workflowId: 'wf', fixed: { nsfwLevel: PG } });
const scanMinors = (image: ScanImage) =>
  resolveScanOutcome({
    image,
    workflowId: 'wf',
    fixed: { nsfwLevel: BLOCKED, blockedFor: 'tos', minor: true },
  });

describe('a song scan', () => {
  it('stores a clean song as Scanned at the level it was given', async () => {
    await insertSong(1);

    const outcome = await scanClean(loaded(1));

    expect(outcome).toMatchObject({ ingestion: 'Scanned', nsfwLevel: PG, blockedFor: null });
    expect(await row(1)).toMatchObject({ ingestion: 'Scanned', nsfwLevel: PG, blockedFor: null });
  });

  it('blocks a song the scan flagged, with the reason', async () => {
    await insertSong(2);

    const outcome = await scanMinors(loaded(2));

    expect(outcome).toMatchObject({ ingestion: 'Blocked', blockedFor: 'tos' });
    expect(await row(2)).toMatchObject({
      ingestion: 'Blocked',
      nsfwLevel: BLOCKED,
      blockedFor: 'tos',
    });
  });

  it('records a song blocked for minors as minor, and a clean one as not', async () => {
    await insertSong(12);
    await insertSong(13);

    await scanMinors(loaded(12));
    await scanClean(loaded(13));

    expect((await row(12)).minor).toBe(true);
    expect((await row(13)).minor).toBe(false);
  });

  it('leaves the lyrics already written to the row alone', async () => {
    await insertSong(3);

    await scanClean(loaded(3, { metadata: {} }));

    expect((await row(3)).metadata).toEqual({ lyrics: [{ t: 3, text: 'la' }] });
  });

  it('stores the metadata it was given with the verdict', async () => {
    await insertSong(11);
    const metadata = { duration: 30, lyrics: [{ t: 4, text: 'la' }] };

    await resolveScanOutcome({
      image: loaded(11, { metadata }),
      workflowId: 'wf',
      fixed: { nsfwLevel: PG, metadata },
    });

    expect((await row(11)).metadata).toEqual(metadata);
  });

  it('keeps a moderator-locked level on a clean song', async () => {
    await insertSong(4);

    await scanClean(loaded(4, { nsfwLevelLocked: true, nsfwLevel: 4 }));

    expect(await row(4)).toMatchObject({ ingestion: 'Scanned', nsfwLevel: 4 });
  });

  it('blocks a flagged song even when its level is locked', async () => {
    await insertSong(5);

    await scanMinors(loaded(5, { nsfwLevelLocked: true, nsfwLevel: 4 }));

    expect(await row(5)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
  });

  it('applies a moderation rule that blocks, over a clean scan', async () => {
    vi.mocked(getImagesModRules).mockResolvedValue([
      {
        id: 9,
        action: 'Block',
        reason: 'rule',
        definition: { type: 'content', match: 'forbidden', target: ['prompt'] },
      },
    ] as never);
    await insertSong(6);

    const outcome = await scanClean(loaded(6, { meta: { prompt: 'a forbidden song' } }));

    expect(outcome.ingestion).toBe('Blocked');
    expect(await row(6)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ message: expect.stringContaining('songs') }),
      })
    );
  });

  it('keeps a song under appeal blocked and in the appeals queue after a clean scan', async () => {
    await insertSong(7, { ingestion: 'Blocked', needsReview: 'appeal' });
    await holder.db.exec(`INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', 7)`);
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'tos', "nsfwLevel" = 32 WHERE id = 7`);

    const outcome = await scanClean(
      loaded(7, { ingestion: 'Blocked', blockedFor: 'tos', nsfwLevel: 32, needsReview: 'appeal' })
    );

    expect(outcome.ingestion).toBe('Blocked');
    expect(await row(7)).toMatchObject({
      ingestion: 'Blocked',
      nsfwLevel: BLOCKED,
      needsReview: 'appeal',
    });
  });

  it("keeps a CSAM review flag on a clean song's row", async () => {
    await insertSong(8, { needsReview: 'csam' });

    await scanClean(loaded(8, { needsReview: 'csam' }));

    expect((await row(8)).needsReview).toBe('csam');
  });

  it("keeps a block on a banned owner's song after a clean scan", async () => {
    await insertSong(10, { userId: BANNED, ingestion: 'Blocked' });
    await holder.db.exec(
      `UPDATE "Image" SET "blockedFor" = 'moderated', "nsfwLevel" = 32 WHERE id = 10`
    );

    const outcome = await scanClean(
      loaded(10, { userId: BANNED, ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: 32 })
    );

    expect(outcome.ingestion).toBe('Blocked');
    expect(await row(10)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
  });
});
