import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

const holder = vi.hoisted(() => ({
  holdRule: false,
  /** Runs just before the scan's verdict write. */
  beforeVerdict: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditPostImageMeta: vi.fn((): { success: boolean; blockedFor?: string[] } => ({
    success: true,
  })),
  includesInappropriate: vi.fn(() => false),
  includesPoi: vi.fn(() => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () =>
    holder.holdRule
      ? [
          {
            id: 7,
            definition: { type: 'tag', tags: ['tag'], match: 'any' },
            action: 'Hold',
            reason: 'r',
          },
        ]
      : []
  ),
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
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { legacyJudgeRatingSeedSql } from '~/server/common/judge-rating';
import { auditPostImageMeta } from '~/utils/metadata/audit';

/**
 * A collection judge's rating (`metadata.judgeRating`) is a floor under the scan's level. The
 * scan's writes to "Image" run against a real row; the scan's other reads are stubbed.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ID = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const BLOCKED = 32;

/** The level the scan's tags rate the image at. */
let scanTagLevel = X;

const judgeRated = (nsfwLevel: number) => ({
  judgeRating: { userId: 900, nsfwLevel, collectionId: 10, ratedAt: '2026-01-01T00:00:00.000Z' },
});

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus" NOT NULL,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "JobQueue" (
      type "JobQueueType" NOT NULL, "entityType" "EntityType" NOT NULL, "entityId" int NOT NULL,
      PRIMARY KEY ("entityType", "entityId", type)
    );
  `);
});
afterAll(() => db.close());

type Row = {
  /** The stored state; default Rescan. */
  ingestion?: string;
  nsfwLevel: number;
  nsfwLevelLocked?: boolean;
  metadata?: object | null;
  needsReview?: string | null;
  scanJobs?: object | null;
};

/** Stores `stored` and returns the image as the scan loaded it (`loaded`, default the same). */
async function arrange(stored: Row, loaded: Row = stored) {
  await db.exec(`DELETE FROM "Image"; DELETE FROM "JobQueue";`);
  await db.query(
    `INSERT INTO "Image" (id, ingestion, "nsfwLevel", "nsfwLevelLocked", metadata, "needsReview", "scanJobs")
     VALUES ($1, $7, $2, $3, $4, $5, $6)`,
    [
      ID,
      stored.nsfwLevel,
      stored.nsfwLevelLocked ?? false,
      stored.metadata ?? null,
      stored.needsReview ?? null,
      stored.scanJobs ?? null,
      stored.ingestion ?? 'Rescan',
    ]
  );
  return {
    id: ID,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a lighthouse' },
    postId: null,
    ingestion: 'Rescan',
    nsfwLevelLocked: false,
    metadata: null,
    ...loaded,
  } as unknown as ScanImage;
}

const scan = async (image: ScanImage) => {
  const outcome = await resolveScanOutcome({ image, workflowId: 'wf', prompt: 'p' });
  const { rows } = await db.query<{
    nsfwLevel: number;
    ingestion: string;
    metadata: Record<string, unknown> | null;
  }>(`SELECT "nsfwLevel", ingestion, metadata FROM "Image" WHERE id = $1`, [ID]);
  return { outcome, row: rows[0] };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auditPostImageMeta).mockReturnValue({
    success: true,
    blockedFor: [],
    softBlockedFor: [],
  });
  holder.holdRule = false;
  scanTagLevel = X;
  const raw = pgliteRaw(db);
  holder.beforeVerdict = undefined;
  // The scan's reads and writes of the image row itself go to the real row.
  const isImageWrite = (strings: unknown) =>
    Array.isArray(strings) &&
    ['UPDATE "Image"', '"judgeFloor"', 'INSERT INTO "JobQueue"'].some((t) =>
      (strings as string[]).join('').includes(t)
    );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (!isImageWrite(strings)) return 0;
    if (strings.join('').includes('"needsReview" = CASE')) await holder.beforeVerdict?.();
    return raw.executeRaw(strings, ...values);
  }) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (isImageWrite(strings)) return raw.queryRaw(strings, ...values);
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: scanTagLevel, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

describe('resolveScanOutcome with a collection judge rating', () => {
  it('raises the level past the judge when the scan rates higher', async () => {
    scanTagLevel = X;
    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(R) }));

    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: X });
    expect(outcome.nsfwLevel).toBe(X);
  });

  it('stays at the judge level when the scan rates lower', async () => {
    scanTagLevel = PG13;
    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(R) }));

    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: R });
    expect(outcome.nsfwLevel).toBe(R);
  });

  it('runs the checks at the judge level when the tags rate lower', async () => {
    scanTagLevel = PG13;
    // The prompt fails the audit, which only runs for an NSFW level.
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['prompt'],
      softBlockedFor: [],
    });
    const { outcome, row } = await scan(await arrange({ nsfwLevel: X, metadata: judgeRated(X) }));

    expect(row).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
    expect(outcome.ingestion).toBe('Blocked');
  });

  it('runs the checks at the tag level when there is no judge rating', async () => {
    scanTagLevel = PG13;
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['prompt'],
      softBlockedFor: [],
    });
    const { row } = await scan(await arrange({ nsfwLevel: PG13 }));

    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: PG13 });
  });

  it('raises and rescans for a rating written after the checks ran', async () => {
    scanTagLevel = PG13;
    holder.beforeVerdict = () =>
      db.query(`UPDATE "Image" SET metadata = $1 WHERE id = $2`, [judgeRated(X), ID]);
    const { outcome, row } = await scan(await arrange({ nsfwLevel: PG13 }));

    // The rescan applies the floor once its checks have run there.
    expect(row).toMatchObject({ nsfwLevel: PG13, ingestion: 'Rescan' });
    expect(outcome).toMatchObject({ nsfwLevel: PG13, ingestion: 'Rescan' });
  });

  // An appeal review is the scan's own to keep or drop (it needs a pending appeal); csam is kept by
  // every write.
  it('keeps a csam review when the floor raises a minor-flagged image', async () => {
    for (const needsReview of ['csam']) {
      scanTagLevel = PG13;
      const { row } = await scan(
        await arrange({
          nsfwLevel: PG13,
          metadata: judgeRated(R),
          needsReview,
          scanJobs: { hasMinor: true },
        })
      );
      expect(row).toMatchObject({ nsfwLevel: R });
      const { rows } = await db.query<{ needsReview: string }>(
        `SELECT "needsReview" FROM "Image" WHERE id = $1`,
        [ID]
      );
      expect(rows[0].needsReview).toBe(needsReview);
    }
  });

  it('does not send a held image back for a rescan when the floor write fails', async () => {
    scanTagLevel = PG13;
    holder.holdRule = true;
    holder.beforeVerdict = () =>
      db.query(`UPDATE "Image" SET metadata = $1 WHERE id = $2`, [judgeRated(X), ID]);
    const passthrough = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (strings.join('').includes('RETURNING "nsfwLevel", ingestion')) throw new Error('boom');
      return passthrough(strings, ...values);
    }) as never);

    const { row } = await scan(await arrange({ nsfwLevel: PG13 }));

    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: PG13 });
  });

  it('still sends the image back for a rescan when the floor write fails above the checked level', async () => {
    scanTagLevel = PG13;
    holder.beforeVerdict = () =>
      db.query(`UPDATE "Image" SET metadata = $1 WHERE id = $2`, [judgeRated(X), ID]);
    const passthrough = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (strings.join('').includes('RETURNING "nsfwLevel", ingestion')) throw new Error('boom');
      return passthrough(strings, ...values);
    }) as never);

    const { row } = await scan(await arrange({ nsfwLevel: PG13 }));

    expect(row).toMatchObject({ ingestion: 'Rescan', nsfwLevel: PG13 });
    const { rows } = await db.query(`SELECT * FROM "JobQueue" WHERE "entityId" = $1`, [ID]);
    expect(rows).toHaveLength(1);
  });

  it('keeps a legacy rating (no judge recorded) as the floor', async () => {
    scanTagLevel = R;
    const image = await arrange({ nsfwLevel: X });
    // The legacy rating is the one the self-heal and the backfill write, built by their shared
    // helper against this row, so the fixture can't drift from the seed.
    // judge-collection-rating.pglite.test.ts, "a rescan that rates lower ends at the level the
    // judges applied, still unapproved", reproduces the floor SQL against the same seed.
    await pgliteRaw(db).executeRaw`
      UPDATE "Image" SET metadata = ${legacyJudgeRatingSeedSql('Image', Prisma.sql`10`)}
      WHERE id = ${ID}
    `;
    const { rows } = await db.query<{ metadata: { judgeRating: { legacy: boolean } } }>(
      `SELECT metadata FROM "Image" WHERE id = $1`,
      [ID]
    );
    expect(rows[0].metadata.judgeRating).toMatchObject({ legacy: true, nsfwLevel: X });

    const { outcome, row } = await scan(image);

    expect(row.nsfwLevel).toBe(X);
    expect(outcome.nsfwLevel).toBe(X);
  });

  it('keeps a moderator lock over both the scan and the judge', async () => {
    scanTagLevel = X;
    const locked = { nsfwLevel: PG13, nsfwLevelLocked: true, metadata: judgeRated(R) };
    const { row } = await scan(await arrange(locked));

    expect(row.nsfwLevel).toBe(PG13);
  });

  it('blocks on an audit block, whatever the judge rated', async () => {
    vi.mocked(auditPostImageMeta).mockReturnValueOnce({
      success: false,
      blockedFor: ['prompt'],
      softBlockedFor: [],
    });
    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(X) }));

    expect(row).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
    expect(outcome.nsfwLevel).toBe(BLOCKED);
  });

  // A hidden image (original lost) is NotFound. These run the real scan writes against the real row:
  // no verdict, floor or rescan write may move it back toward public; a block still lands.
  describe('an image hidden as NotFound', () => {
    it('stays NotFound under a clean verdict', async () => {
      scanTagLevel = PG13;
      const { outcome, row } = await scan(
        await arrange({ nsfwLevel: PG13, ingestion: 'NotFound' })
      );

      expect(row).toMatchObject({ ingestion: 'NotFound' });
      expect(outcome.ingestion).toBe('NotFound');
    });

    it('stays NotFound when a judge floor would send it back for a rescan', async () => {
      scanTagLevel = PG13;
      holder.beforeVerdict = () =>
        db.query(`UPDATE "Image" SET metadata = $1 WHERE id = $2`, [judgeRated(X), ID]);
      const { outcome, row } = await scan(
        await arrange({ nsfwLevel: PG13, ingestion: 'NotFound' })
      );

      expect(row).toMatchObject({ ingestion: 'NotFound', nsfwLevel: PG13 });
      expect(outcome.ingestion).toBe('NotFound');
    });

    it('is still blocked by an audit block', async () => {
      vi.mocked(auditPostImageMeta).mockReturnValueOnce({
        success: false,
        blockedFor: ['prompt'],
        softBlockedFor: [],
      });
      const { outcome, row } = await scan(await arrange({ nsfwLevel: R, ingestion: 'NotFound' }));

      expect(row).toMatchObject({ ingestion: 'Blocked', nsfwLevel: BLOCKED });
      expect(outcome.ingestion).toBe('Blocked');
    });
  });

  it('ignores a judge rating that is not a level', async () => {
    scanTagLevel = PG13;
    const { row } = await scan(
      await arrange({ nsfwLevel: 0, metadata: { judgeRating: { nsfwLevel: BLOCKED } } })
    );

    expect(row.nsfwLevel).toBe(PG13);
  });

  it('writes the scan level as before when there is no judge rating', async () => {
    for (const level of [PG13, X]) {
      scanTagLevel = level;
      const { outcome, row } = await scan(await arrange({ nsfwLevel: R }));
      expect(row.nsfwLevel).toBe(level);
      expect(outcome.nsfwLevel).toBe(level);
    }
  });

  it('keeps the judge rating when a moderation rule annotates the metadata', async () => {
    holder.holdRule = true;
    scanTagLevel = PG13;
    // The scan loaded the image before the judge rated it.
    const { row } = await scan(
      await arrange({ nsfwLevel: R, metadata: judgeRated(R) }, { nsfwLevel: PG13, metadata: null })
    );

    expect(row.metadata).toMatchObject({ ...judgeRated(R), ruleId: 7 });
    expect(row.nsfwLevel).toBe(R);
  });

  it('writes only the rule keys over the stored row, never the loaded copy', async () => {
    holder.holdRule = true;
    // The scan loaded an older copy of the metadata than the row now holds.
    const { row } = await scan(
      await arrange(
        { nsfwLevel: R, metadata: { ...judgeRated(R), youtubeVideoId: 'new' } },
        { nsfwLevel: R, metadata: { judgeRating: { nsfwLevel: PG13 }, youtubeVideoId: 'old' } }
      )
    );

    expect(row.metadata).toEqual({
      ...judgeRated(R),
      youtubeVideoId: 'new',
      ruleId: 7,
      ruleReason: 'r',
    });
  });

  it('keeps the landed verdict when the floor write fails', async () => {
    scanTagLevel = PG13;
    const passthrough = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (strings.join('').includes('RETURNING "nsfwLevel", ingestion')) throw new Error('boom');
      return passthrough(strings, ...values);
    }) as never);

    const { outcome, row } = await scan(await arrange({ nsfwLevel: R, metadata: judgeRated(R) }));

    expect(outcome.ingestion).toBe('Scanned');
    expect(row).toMatchObject({ ingestion: 'Scanned', nsfwLevel: PG13 });
  });
});
