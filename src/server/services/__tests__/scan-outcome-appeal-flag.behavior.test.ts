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
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import { auditPostImageMeta } from '~/utils/metadata/audit';
import { getImagesModRules } from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { poiWords } from '@civitai/mod-utils/prompt-audit/lists';
import { tagsNeedingReview } from '~/libs/tags';

type Verdict = 'clean' | 'poi' | 'minor' | 'tag' | 'newUser' | 'block' | 'hold';

/** The automated tags that make the audit pick each review key. */
const TAGS: Record<Verdict, { name: string; nsfwLevel: number }[]> = {
  clean: [{ name: 'landscape', nsfwLevel: 1 }],
  poi: [{ name: poiWords[0], nsfwLevel: 1 }],
  minor: [{ name: tagsNeedingReview[0], nsfwLevel: 1 }],
  tag: [{ name: 'tag', nsfwLevel: 32 }],
  // An nsfw image from a new account, with nothing else to review.
  newUser: [{ name: 'tag', nsfwLevel: 4 }],
  // The prompt audit blocks it (set in `rescan`), which it does only to an nsfw image.
  block: [{ name: 'tag', nsfwLevel: 16 }],
  // A moderation rule holds it (set in `rescan`).
  hold: [{ name: 'landscape', nsfwLevel: 1 }],
};

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  tagLevel: 1,
  /** Set: the audit sees this verdict's tags instead of one tag at `tagLevel`. */
  verdict: null as string | null,
}));

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
    -- The scan write re-checks the owner's ban.
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]',
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3)
    );
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
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
  vi.mocked(auditPostImageMeta).mockReturnValue({ success: true } as never);
  vi.mocked(getImagesModRules).mockResolvedValue([] as never);
  holder.tagLevel = 1;
  holder.verdict = null;
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
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('');
    // The scan's fresh read of the row runs on the real row in every test; the grid's ban/hold
    // check does too.
    if (
      text.includes('FROM "Image" i WHERE i.id') ||
      (holder.verdict && text.includes(' AS kept '))
    ) {
      const flat = Prisma.sql(strings, ...(values as never[]));
      return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
    }
    if (text.includes('TagsOnImageDetails'))
      return holder.verdict
        ? TAGS[holder.verdict as Verdict].map((tag, i) => ({
            id: 10 + i,
            type: 'Label',
            confidence: 90,
            ...tag,
          }))
        : [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: holder.tagLevel, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: holder.verdict === 'newUser' }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal", "CsamReport", "User";
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

  it('keeps its own review flag, not appeal, on an image with no pending appeal of its own', async () => {
    await scan(FLAGGED);

    expect(await imageRow(FLAGGED)).toMatchObject({ needsReview: 'minor', ingestion: 'Scanned' });
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
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['prompt'],
    } as never);
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
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['prompt'],
    } as never);

    await scan(CSAM_SCANNED);

    expect(await imageRow(CSAM_SCANNED)).toMatchObject({
      needsReview: 'csam',
      ingestion: 'Blocked',
    });
  });
});

/**
 * Decision (civitai/civitai#10152): a scan that does not block never clears or lowers an image's review. It keeps 'csam'
 * and 'appeal', lets a pending appeal's 'appeal' take any other key, and otherwise fills an empty
 * `needsReview` or raises the stored key by IMAGE_REVIEW_PRECEDENCE. A blocking scan settles every
 * review but 'csam', and 'appeal' while one is pending, as every block does; a row holding a CSAM
 * block never takes 'appeal'. `minor` and `poi` are only ever set by a scan, never
 * cleared. If you are about to make a clean rescan clear a review again, that is the behaviour
 * these rows exist to stop.
 */
const GRID_ID = 1;

type Stored = {
  needsReview?: string | null;
  minor?: boolean;
  poi?: boolean;
  appeal?: boolean;
  /** The review the scan loaded, when it changed after the load. Default: the stored one. */
  loadedReview?: string | null;
  /** A hold blocked the image after the scan loaded it unblocked. */
  bannedAfterLoad?: boolean;
  /**
   * The image is held by a CSAM block: one the scan loaded, or one set after it loaded the image; or
   * the scan loaded one that a moderator lifted before its write.
   */
  csamBlocked?: 'loaded' | 'afterLoad' | 'liftedAfterLoad';
  /**
   * The CSAM report listing the image was sent and archived over a year ago. The CSAM block is kept
   * from the scan either way.
   */
  reportReleased?: boolean;
  /** The pending appeal was filed after the scan read the image's appeals. */
  appealAfterRead?: boolean;
};

/** Stores the image as a rescan finds it, runs the verdict `verdict` on it, and reads it back. */
const rescan = async (verdict: Verdict, stored: Stored = {}) => {
  holder.verdict = verdict;
  if (verdict === 'block')
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['prompt'],
    } as never);
  if (verdict === 'hold')
    vi.mocked(getImagesModRules).mockResolvedValue([
      {
        id: 9,
        definition: { type: 'tag', tags: ['landscape'], match: 'any' },
        action: 'Hold',
        reason: 'r',
      },
    ] as never);
  await holder.db.query(
    // Owned by the loaded image's owner: a row with no owner reads as held, which keeps any block.
    `INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel", "needsReview", minor, poi) VALUES ($1, 2, 'Rescan', 1, $2, $3, $4)`,
    [GRID_ID, stored.needsReview ?? null, stored.minor ?? false, stored.poi ?? false]
  );
  if (stored.appeal)
    await holder.db.query(`INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', $1)`, [
      GRID_ID,
    ]);
  if (stored.bannedAfterLoad)
    await holder.db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated', "nsfwLevel" = 32 WHERE id = $1;`,
      [GRID_ID]
    );
  if (stored.bannedAfterLoad)
    await holder.db.query(`INSERT INTO "User" (id, "bannedAt") VALUES (2, now())`);
  // A lifted block leaves the stored row as inserted: unblocked.
  if (stored.csamBlocked && stored.csamBlocked !== 'liftedAfterLoad')
    await holder.db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM', "nsfwLevel" = 32 WHERE id = $1;`,
      [GRID_ID]
    );
  if (stored.reportReleased)
    await holder.db.query(
      `INSERT INTO "CsamReport" ("userId", images, "reportSentAt", "archivedAt")
       VALUES (2, jsonb_build_array(jsonb_build_object('id', $1::int)), now() - interval '2 years', now() - interval '18 months')`,
      [GRID_ID]
    );
  if (stored.appealAfterRead) {
    // The scan's read of pending appeals finds none; the appeal is filed before its write.
    dbMock.dbWrite.appeal.findMany.mockResolvedValueOnce([] as never);
    await holder.db.query(`INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', $1)`, [
      GRID_ID,
    ]);
  }
  const image = {
    id: GRID_ID,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt: 'a landscape' },
    metadata: {},
    postId: null,
    nsfwLevelLocked: false,
    ...(stored.csamBlocked === 'loaded' || stored.csamBlocked === 'liftedAfterLoad'
      ? { ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'CSAM' }
      : { ingestion: 'Rescan', nsfwLevel: 1, blockedFor: null }),
    needsReview:
      stored.loadedReview !== undefined ? stored.loadedReview : stored.needsReview ?? null,
    minor: stored.minor ?? false,
    poi: stored.poi ?? false,
  } as unknown as ScanImage;
  await resolveScanOutcome({ image, workflowId: 'wf', prompt: 'a landscape' });
  return (
    await holder.db.query<{ needsReview: string | null; minor: boolean; poi: boolean }>(
      `SELECT "needsReview", minor, poi FROM "Image" WHERE id = $1`,
      [GRID_ID]
    )
  ).rows[0];
};

describe('the review a scan verdict leaves', () => {
  // Control for every row below: on an image with no review, each verdict writes its own key.
  it.each([
    ['clean', null],
    ['poi', 'poi'],
    ['minor', 'minor'],
    ['tag', 'tag'],
    ['newUser', 'newUser'],
    ['hold', 'modRule'],
  ] as const)('a %s verdict on an image with no review writes %s', async (verdict, expected) => {
    expect((await rescan(verdict)).needsReview).toBe(expected);
  });

  it.each([
    // Raised: the verdict's key ranks above the stored one.
    ['tag', 'minor', 'minor'],
    ['newUser', 'minor', 'minor'],
    ['poi', 'minor', 'minor'],
    ['newUser', 'tag', 'tag'],
    // Kept: the stored key ranks at or above the verdict's.
    ['minor', 'poi', 'minor'],
    ['minor', 'tag', 'minor'],
    ['tag', 'newUser', 'tag'],
    ['minor', 'minor', 'minor'],
    // A rule Hold ranks like any other verdict.
    ['tag', 'hold', 'modRule'],
    ['minor', 'hold', 'minor'],
    // Raised: a review automation set ranks like any other.
    ['modRule', 'minor', 'minor'],
    ['modRule', 'poi', 'poi'],
    ['remixSource', 'tag', 'tag'],
    ['remixSource', 'poi', 'poi'],
    // Kept: a review only a moderator clears, even under a key ranked above it.
    ['appeal', 'minor', 'appeal'],
    ['appeal', 'poi', 'appeal'],
    ['csam', 'poi', 'csam'],
    // Kept: a clean verdict clears nothing.
    ['minor', 'clean', 'minor'],
    ['poi', 'clean', 'poi'],
    ['tag', 'clean', 'tag'],
    ['newUser', 'clean', 'newUser'],
    ['remixSource', 'clean', 'remixSource'],
    ['modRule', 'clean', 'modRule'],
  ] as const)('stored %s, %s verdict: %s', async (stored, verdict, expected) => {
    expect((await rescan(verdict, { needsReview: stored })).needsReview).toBe(expected);
  });

  // Including reviews ranked above 'appeal' and reviews a scan otherwise never replaces.
  it.each(['tag', 'minor', 'poi', 'modRule', 'remixSource'])(
    'a pending appeal takes a stored %s review',
    async (stored) => {
      expect((await rescan('minor', { needsReview: stored, appeal: true })).needsReview).toBe(
        'appeal'
      );
    }
  );

  it.each([
    ['loaded with the image', 'csam'],
    ['set after the scan loaded the image', null],
  ])('a pending appeal never takes a csam review %s', async (_, loadedReview) => {
    expect(
      (await rescan('clean', { needsReview: 'csam', appeal: true, loadedReview })).needsReview
    ).toBe('csam');
  });

  // A block settles every review but csam, and appeal while one is pending, as every other block
  // does: lifting the block would read that review as a decision.
  it.each([
    ['minor', null],
    ['modRule', null],
    ['csam', 'csam'],
  ])('a blocking verdict on a stored %s review leaves %s', async (stored, expected) => {
    const row = await rescan('block', { needsReview: stored, minor: true });
    const { ingestion } = (
      await holder.db.query<{ ingestion: string }>(`SELECT ingestion FROM "Image" WHERE id = $1`, [
        GRID_ID,
      ])
    ).rows[0];
    // Control: the verdict blocked the image.
    expect(ingestion).toBe('Blocked');
    expect(row).toMatchObject({ needsReview: expected, minor: true });
  });

  // A ban that blocks the row after the scan loaded it leaves it blocked: the same settle applies,
  // whatever the verdict found.
  it.each([
    [null, 'minor'],
    ['tag', 'minor'],
    ['minor', 'clean'],
  ])('a row a ban kept blocked, stored %s, %s verdict: no review', async (stored, verdict) => {
    const row = await rescan(verdict as Verdict, {
      needsReview: stored,
      bannedAfterLoad: true,
    });
    const { ingestion } = (
      await holder.db.query<{ ingestion: string }>(`SELECT ingestion FROM "Image" WHERE id = $1`, [
        GRID_ID,
      ])
    ).rows[0];
    // Control: the ban kept the row blocked.
    expect(ingestion).toBe('Blocked');
    expect(row.needsReview).toBeNull();
  });

  // A CSAM block holds the row Blocked whatever the verdict, so its review settles as any block's.
  it.each(
    (
      [
        ['loaded', 'held'],
        ['afterLoad', 'held'],
        ['loaded', 'released'],
        ['afterLoad', 'released'],
      ] as const
    ).flatMap(([when, owner]) =>
      (
        [
          [null, 'minor'],
          [null, 'poi'],
          [null, 'tag'],
          [null, 'hold'],
          ['tag', 'minor'],
          ['newUser', 'poi'],
          ['modRule', 'minor'],
          ['minor', 'clean'],
          ['poi', 'clean'],
        ] as const
      ).map(([stored, verdict]) => [when, owner, stored, verdict] as const)
    )
  )(
    'a CSAM block %s, owner %s, stored %s, %s verdict: no review',
    async (when, owner, stored, verdict) => {
      const row = await rescan(verdict as Verdict, {
        needsReview: stored,
        csamBlocked: when,
        reportReleased: owner === 'released',
      });
      const { ingestion, blockedFor } = (
        await holder.db.query<{ ingestion: string; blockedFor: string }>(
          `SELECT ingestion, "blockedFor" FROM "Image" WHERE id = $1`,
          [GRID_ID]
        )
      ).rows[0];
      // Control: the CSAM block held.
      expect({ ingestion, blockedFor }).toEqual({ ingestion: 'Blocked', blockedFor: 'CSAM' });
      expect(row.needsReview).toBeNull();
    }
  );

  it('a CSAM-blocked image keeps its csam review', async () => {
    expect(
      (await rescan('minor', { needsReview: 'csam', csamBlocked: 'loaded' })).needsReview
    ).toBe('csam');
  });

  it('a blocking verdict writes appeal for a pending appeal the scan did not read', async () => {
    const row = await rescan('block', { needsReview: 'minor', appealAfterRead: true });
    // Control: the scan's read found no pending appeal, so only the write-time check finds it.
    expect(dbMock.dbWrite.appeal.findMany).toHaveBeenCalled();
    expect(await dbMock.dbWrite.appeal.findMany.mock.results[0].value).toEqual([]);
    expect(row.needsReview).toBe('appeal');
  });

  // Control for the row above: a decided appeal does not keep a non-appeal review.
  it('a blocking verdict settles a review whose appeal was decided', async () => {
    await holder.db.query(
      `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Image', $1, 'Rejected')`,
      [GRID_ID]
    );
    expect((await rescan('block', { needsReview: 'minor' })).needsReview).toBeNull();
  });

  // An appeal being filed writes its review before its Appeal row commits.
  it('a blocking verdict keeps a stored appeal review', async () => {
    expect((await rescan('block', { needsReview: 'appeal' })).needsReview).toBe('appeal');
  });

  it.each([null, 'minor', 'appeal'])(
    'a CSAM block, stored %s, with a pending appeal: no appeal review',
    async (stored) => {
      const row = await rescan('clean', {
        needsReview: stored,
        appeal: true,
        csamBlocked: 'loaded',
        reportReleased: true,
      });
      expect(row.needsReview).toBeNull();
    }
  );

  // Decision (civitai/civitai#10577): the appeal branch keeps the block the row holds NOW, never the
  // loaded copy's. A moderator's lift while the scan ran must stand.
  it('🔴 a CSAM block lifted while the scan ran stays lifted under an appeal', async () => {
    const row = await rescan('clean', {
      needsReview: 'appeal',
      appeal: true,
      csamBlocked: 'liftedAfterLoad',
    });
    const stored = (
      await holder.db.query<{ blockedFor: string | null; ingestion: string; nsfwLevel: number }>(
        `SELECT "blockedFor", ingestion, "nsfwLevel" FROM "Image" WHERE id = $1`,
        [GRID_ID]
      )
    ).rows[0];
    expect(stored.blockedFor).toBeNull();
    expect(stored.ingestion).not.toBe('Blocked');
    expect(stored.nsfwLevel).not.toBe(32);
    expect(row.needsReview).toBe('appeal');
  });

  it('a blocking verdict on a csam review under appeal keeps csam', async () => {
    expect((await rescan('block', { needsReview: 'csam', appeal: true })).needsReview).toBe('csam');
  });

  it('a blocking verdict on an image under appeal writes appeal', async () => {
    expect((await rescan('block', { needsReview: 'minor', appeal: true })).needsReview).toBe(
      'appeal'
    );
  });

  it('a clean verdict leaves the minor and poi flags set', async () => {
    expect(await rescan('clean', { minor: true, poi: true })).toMatchObject({
      minor: true,
      poi: true,
    });
  });
});
