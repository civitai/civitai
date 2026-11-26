import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ModRules from '~/server/utils/mod-rules';
import type * as NotificationService from '~/server/services/notification.service';

/**
 * A CSAM block is lifted or re-labelled only by a moderator's CSAM review. No scan verdict does it:
 * not a clean audit, an audit block for another reason, a moderation rule or the rating block.
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
  resetBlockedNsfwLevel: vi.fn(async () => undefined),
  refreshImageLevelCaches: vi.fn(async () => undefined),
  dropBlockedImageDeleteQueue: vi.fn(async () => undefined),
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
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

import {
  markImageScanError,
  resolveScanOutcome,
  reviewKeyAfterSkipSql,
  type ScanImage,
} from '../image-scan-pipeline';
import { rescanImageById } from '../image-rescan.service';
import { IMAGE_RESCAN_RETRY_LIMIT } from '~/server/services/image-scan-failure';
import { PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';
import {
  liftedBlockedForSql,
  liftedIngestionSql,
  liftedNeedsReviewSql,
  liftedNsfwLevelSql,
  scanKeepsRowSql,
  unblockedMetadataSql,
} from '~/server/common/image-visibility';
import { blockImageFromRating } from '../image-scan-result.service';
import { unblockAccountDeletionImages } from '../account-deletion-images';
import { blockBannedUserImages } from '~/server/services/user.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { auditPostImageMeta, includesInappropriate } from '~/utils/metadata/audit';
import {
  addImageTools,
  getImagesModRules,
  feedThumbnailFields,
  feedViewer,
  ingestImageById,
  refreshImageLevelCaches,
  requeueUnverifiedImages,
  resetBlockedNsfwLevel,
} from '~/server/services/image.service';
import { evaluateRules } from '~/server/utils/mod-rules';
import { createNotification } from '~/server/services/notification.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { ModerationRuleAction } from '~/shared/utils/prisma/enums';

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  tagNsfwLevel: 1,
  /** Set to an image id: that row turns CSAM-blocked right after the scan's fresh read of it. */
  csamLandsAfterRead: null as number | null,
  /** Set to an image id: its owner is banned, with the media block, right after the fresh read. */
  banLandsAfterRead: null as number | null,
}));

const OWNER = 8;
// Its own owner: an owner with a CSAM block is held, which would keep any block of theirs.
const OTHER_OWNER = 9;
const CSAM = 61;
const OTHER = 62;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL REFERENCES "User"(id),
      "postId" int,
      type text NOT NULL DEFAULT 'image',
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus",
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending'
    );
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
  vi.mocked(auditPostImageMeta).mockReturnValue({ success: true } as never);
  vi.mocked(getImagesModRules).mockResolvedValue([]);
  vi.mocked(evaluateRules).mockReturnValue(undefined);
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
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    if (text.includes(' AS kept ')) return (await runOnPglite(strings, values)).rows;
    if (text.includes('FROM "Image" i WHERE i.id')) {
      const { rows } = await runOnPglite(strings, values);
      if (holder.csamLandsAfterRead != null)
        await holder.db.query(
          `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM', "nsfwLevel" = 32 WHERE id = $1`,
          [holder.csamLandsAfterRead]
        );
      if (holder.banLandsAfterRead != null) {
        const id = holder.banLandsAfterRead;
        await holder.db.query(
          `UPDATE "User" SET "bannedAt" = now() WHERE id = (SELECT "userId" FROM "Image" WHERE id = $1)`,
          [id]
        );
        await holder.db.query(
          `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated', "nsfwLevel" = 32 WHERE id = $1`,
          [id]
        );
      }
      return rows;
    }
    if (
      text.includes('UPDATE "Image"') ||
      text.includes('SELECT "blockedFor" FROM "Image"') ||
      text.includes('SELECT ingestion, "blockedFor", "nsfwLevel" FROM "Image"')
    )
      return (await runOnPglite(strings, values)).rows;
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  holder.tagNsfwLevel = 1;
  holder.csamLandsAfterRead = null;
  holder.banLandsAfterRead = null;
  await holder.db.exec(`
    TRUNCATE "Image", "User", "CsamReport";
    INSERT INTO "User" (id, "bannedAt") VALUES (${OWNER}, NULL), (${OTHER_OWNER}, NULL);
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel") VALUES
      (${CSAM}, ${OWNER}, 'Blocked', 'CSAM', 32),
      (${OTHER}, ${OTHER_OWNER}, 'Blocked', 'moderated', 32);
    -- Reported over a year ago and archived, owner not banned: only the CSAM reason keeps the block.
    INSERT INTO "CsamReport" ("userId", images, "reportSentAt", "archivedAt")
      VALUES (${OWNER}, '[{"id": ${CSAM}}]', now() - interval '2 years', now() - interval '2 years');
  `);
});

/** The image as `loadImageForScan` hands it over. */
const loaded = async (id: number) => {
  const row = (
    await holder.db.query<{
      userId: number;
      ingestion: string;
      blockedFor: string | null;
      nsfwLevel: number;
      nsfwLevelLocked: boolean;
    }>(
      `SELECT "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];
  return {
    id,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: null,
    type: 'image',
    meta: { prompt: 'a landscape' },
    metadata: {},
    postId: null,
    needsReview: null,
    ...row,
  } as unknown as ScanImage;
};

const imageRow = async (id: number) =>
  (
    await holder.db.query<{ ingestion: string; blockedFor: string | null; nsfwLevel: number }>(
      `SELECT ingestion, "blockedFor", "nsfwLevel" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const scan = async (id: number) =>
  resolveScanOutcome({ image: await loaded(id), workflowId: 'wf', prompt: 'a landscape' });

const STILL_CSAM = { ingestion: 'Blocked', blockedFor: 'CSAM', nsfwLevel: 32 };

/** Leaves the reasons but lifts the block, so a block call that writes nothing reads as one. */
const unblockBoth = () =>
  holder.db.exec(
    `UPDATE "Image" SET ingestion = 'Rescan', "nsfwLevel" = 0 WHERE id IN (${CSAM}, ${OTHER})`
  );

describe('a scan of a CSAM-blocked image', () => {
  it('keeps the block when the audit comes back clean', async () => {
    const outcome = await scan(CSAM);

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    expect(outcome).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM', nsfwLevel: 32 });
    // Control.
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'AiNotVerified' WHERE id = ${OTHER}`);
    await scan(OTHER);
    expect(await imageRow(OTHER)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
  });

  it('keeps the CSAM reason when the audit blocks for another reason', async () => {
    holder.tagNsfwLevel = 16;
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['tos-term'],
    } as never);

    await scan(CSAM);
    await scan(OTHER);

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    // Control: the audit's block does reach the row.
    expect((await imageRow(OTHER)).blockedFor).toBe('tos-term');
  });

  it('keeps the CSAM reason when a moderation rule blocks it', async () => {
    vi.mocked(getImagesModRules).mockResolvedValue([{ id: 1 }] as never);
    vi.mocked(evaluateRules).mockReturnValue({
      id: 1,
      action: ModerationRuleAction.Block,
      reason: 'rule',
    } as never);
    await holder.db.exec(
      `UPDATE "Image" SET "blockedFor" = NULL, ingestion = 'Rescan' WHERE id = ${OTHER}`
    );

    await scan(CSAM);
    await scan(OTHER);

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    // Control: the rule's reason does reach a row without a CSAM block.
    expect((await imageRow(OTHER)).blockedFor).toBe('moderated');
    // Only a moderator's CSAM review decides the block: no rule notice, no rule metadata.
    expect(vi.mocked(createNotification).mock.calls.map(([n]) => n.key)).toEqual([
      `image-block:${OTHER}`,
    ]);
    const ruleIds = await holder.db.query<{ id: number; ruleId: string | null }>(
      `SELECT id, metadata->>'ruleId' AS "ruleId" FROM "Image" WHERE id IN (${CSAM}, ${OTHER}) ORDER BY id`
    );
    expect(ruleIds.rows).toEqual([
      { id: CSAM, ruleId: null },
      { id: OTHER, ruleId: '1' },
    ]);
  });

  it('keeps the block while an appeal is pending, when the block landed after the load', async () => {
    dbMock.dbWrite.appeal.findMany.mockResolvedValue([{ entityId: CSAM }] as never);
    // Loaded under an earlier block; the CSAM reason was written after the load, before the verdict.
    const image = { ...(await loaded(CSAM)), ingestion: 'Rescan', blockedFor: 'moderated' };
    await holder.db.exec(`UPDATE "Image" SET ingestion = 'Rescan' WHERE id = ${CSAM}`);

    const outcome = await resolveScanOutcome({
      image: image as ScanImage,
      workflowId: 'wf',
      prompt: 'a landscape',
    });

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    expect(outcome).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'CSAM',
      reviewKey: 'appeal',
    });
  });

  it('keeps the block once a rescan request has moved it to Rescan', async () => {
    await holder.db.exec(`UPDATE "Image" SET ingestion = 'Rescan' WHERE id = ${CSAM}`);

    await scan(CSAM);

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
  });

  it('keeps a CSAM block that lands after the scan read the row', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET ingestion = 'Rescan', "blockedFor" = NULL, "nsfwLevel" = 0 WHERE id = ${CSAM}`
    );
    holder.csamLandsAfterRead = CSAM;

    const outcome = await scan(CSAM);

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    // A Scanned outcome would queue the image for Knights review and signal its owner.
    expect(outcome).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM', nsfwLevel: 32 });
  });
});

describe('a ban that lands after the scan read the row', () => {
  it('keeps the media block when the audit comes back clean', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET ingestion = 'Rescan', "blockedFor" = NULL, "nsfwLevel" = 0 WHERE id = ${OTHER}`
    );
    holder.banLandsAfterRead = OTHER;

    const outcome = await scan(OTHER);

    const BANNED = { ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: 32 };
    expect(await imageRow(OTHER)).toEqual(BANNED);
    // A Scanned outcome would queue the image for Knights review and signal its owner.
    expect(outcome).toMatchObject(BANNED);
  });
});

describe('the rating block', () => {
  it('keeps a stored CSAM reason and the short-circuit reports it', async () => {
    await blockImageFromRating({ imageId: CSAM, blockedReason: 'tos' });
    await blockImageFromRating({ imageId: OTHER, blockedReason: 'tos' });

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    // Control: the rating's reason does reach a row without a CSAM block.
    expect((await imageRow(OTHER)).blockedFor).toBe('tos');
    const stamped = await holder.db.query<{ updatedAt: Date | null }>(
      `SELECT "updatedAt" FROM "Image" WHERE id = ${OTHER}`
    );
    expect(stamped.rows[0].updatedAt, 'the rating block did not stamp updatedAt').not.toBeNull();

    const outcome = await resolveScanOutcome({
      image: await loaded(CSAM),
      blocked: { reason: 'tos' },
      workflowId: 'wf',
    });
    expect(outcome.blockedFor).toBe('CSAM');
  });

  // Decision: the reason reported for a rating block comes from the row as stored when the scan
  // finishes, never the loaded copy. A lift made while the scan ran must not report the old block.
  it('🔴 reports the rating reason, not the loaded CSAM, when the block was lifted mid-scan', async () => {
    await blockImageFromRating({ imageId: CSAM, blockedReason: 'tos' });
    const image = await loaded(CSAM);
    // A moderator lifts the CSAM block after the scan loaded the image.
    await holder.db.query(
      `UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL, "nsfwLevel" = 1 WHERE id = $1`,
      [CSAM]
    );
    const outcome = await resolveScanOutcome({
      image,
      blocked: { reason: 'tos' },
      workflowId: 'wf',
    });
    expect(image.blockedFor).toBe('CSAM');
    expect(outcome.blockedFor).toBe('tos');
  });

  it('🔴 keeps the loaded CSAM reason when the read of the row fails', async () => {
    await blockImageFromRating({ imageId: CSAM, blockedReason: 'tos' });
    const image = await loaded(CSAM);
    const route = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      strings.join('').includes('SELECT i."blockedFor" FROM "Image" i')
        ? Promise.reject(new Error('primary unavailable'))
        : route(strings, ...values)) as never);
    const outcome = await resolveScanOutcome({
      image,
      blocked: { reason: 'tos' },
      workflowId: 'wf',
    });
    expect(outcome.blockedFor).toBe('CSAM');
  });

  // The orchestrator's rating can carry no reason (`mediaRating.blockedReason` undefined).
  it('blocks but keeps the stored reason when the rating gives none', async () => {
    await unblockBoth();

    await blockImageFromRating({ imageId: CSAM });
    await blockImageFromRating({ imageId: OTHER });

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    expect(await imageRow(OTHER)).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
  });

  it('clears the reason on an explicit null, except a CSAM one', async () => {
    await unblockBoth();

    await blockImageFromRating({ imageId: CSAM, blockedReason: null });
    await blockImageFromRating({ imageId: OTHER, blockedReason: null });

    expect(await imageRow(CSAM)).toEqual(STILL_CSAM);
    expect(await imageRow(OTHER)).toEqual({
      ingestion: 'Blocked',
      blockedFor: null,
      nsfwLevel: 32,
    });
  });
});

describe('a scan of an image with a locked rating', () => {
  const LOCKED = 63;
  const PG13 = 2;
  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked")
      VALUES (${LOCKED}, ${OTHER_OWNER}, 'Rescan', NULL, ${PG13}, TRUE);
    `);
  });

  it('is blocked at the Blocked level when the audit blocks it', async () => {
    holder.tagNsfwLevel = 16;
    vi.mocked(auditPostImageMeta).mockReturnValue({
      success: false,
      blockedFor: ['tos-term'],
    } as never);

    await scan(LOCKED);

    expect(await imageRow(LOCKED)).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'tos-term',
      nsfwLevel: 32,
    });
  });

  it('is blocked at the Blocked level when a moderation rule blocks it', async () => {
    vi.mocked(getImagesModRules).mockResolvedValue([{ id: 1 }] as never);
    vi.mocked(evaluateRules).mockReturnValue({
      id: 1,
      action: ModerationRuleAction.Block,
      reason: 'rule',
    } as never);

    await scan(LOCKED);

    expect(await imageRow(LOCKED)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: 32 });
    expect((await imageRow(LOCKED)).blockedFor).not.toBeNull();
  });

  it('keeps the locked rating over the scan rating on a verdict that does not block (control)', async () => {
    holder.tagNsfwLevel = 8;

    await scan(LOCKED);

    expect(await imageRow(LOCKED)).toEqual({
      ingestion: 'Scanned',
      blockedFor: null,
      nsfwLevel: PG13,
    });
  });
});

/**
 * An account deleted with the grace option has its images blocked with breadcrumbs, and a restore
 * puts back whatever the breadcrumbs recorded. A block written over a grace block in the meantime
 * must outlive that restore; a write that would lift a grace block leaves the row alone.
 */
/** Grace-blocked, then written to by the writer under test. */
const GRACED = 71;
/** Grace-blocked and left alone: the restore must put it back, or the restore never ran. */
const CONTROL = 72;
/** Never grace-blocked. */
const PLAIN = 73;

const BREADCRUMBS = `'{"accountDeletionPriorIngestion": "Scanned", "accountDeletionPriorBlockedFor": null, "accountDeletionPriorNeedsReview": null}'`;

const graceRow = async (id: number) =>
  (
    await holder.db.query<{
      ingestion: string;
      blockedFor: string | null;
      nsfwLevel: number;
      breadcrumb: boolean;
    }>(
      `SELECT ingestion, "blockedFor", "nsfwLevel",
        ((metadata -> 'accountDeletionPriorIngestion') IS NOT NULL
          OR (metadata -> 'accountDeletionPriorBlockedFor') IS NOT NULL
          OR (metadata -> 'accountDeletionPriorNeedsReview') IS NOT NULL) AS breadcrumb
      FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const GRACE_BLOCK = {
  ingestion: 'Blocked',
  blockedFor: 'moderated',
  nsfwLevel: 32,
  breadcrumb: true,
};
const RESTORED = { ingestion: 'Scanned', blockedFor: null, breadcrumb: false };

const restore = async () => {
  await unblockAccountDeletionImages(OWNER);
  // Positive control: the restore ran and reverted the grace block nothing else wrote over.
  expect(
    await graceRow(CONTROL),
    'the restore did not revert the untouched grace block'
  ).toMatchObject(RESTORED);
};

describe('a restore and the recorded review flag, on the real statement', () => {
  const crumbs = (review: string | null) =>
    `'{"accountDeletionPriorIngestion": "Scanned", "accountDeletionPriorBlockedFor": null, "accountDeletionPriorNeedsReview": ${
      review === null ? 'null' : `"${review}"`
    }}'`;
  const reviewsOf = async (ids: number[]) =>
    (
      await holder.db.query<{ id: number; needsReview: string | null; ingestion: string }>(
        `SELECT id, "needsReview", ingestion FROM "Image" WHERE id = ANY($1) ORDER BY id`,
        [ids]
      )
    ).rows;

  it('keeps the higher of the current and the recorded review, and logs the one it drops', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "needsReview", metadata) VALUES
        (81, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('poi')}),
        (82, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('minor')}),
        (83, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('appeal')}),
        (84, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('modRule')}),
        (85, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('tag')}),
        (86, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('remixSource')}),
        (87, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('newUser')}),
        (88, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('not-a-review')}),
        (89, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('csam')}),
        (90, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs(null)}),
        (91, ${OWNER}, 'Blocked', 'moderated', 32, 'csam', ${crumbs('minor')}),
        (92, ${OWNER}, 'Blocked', 'moderated', 32, 'poi', ${crumbs('minor')}),
        (93, ${OWNER}, 'Blocked', 'moderated', 32, 'minor', ${crumbs('newUser')}),
        (94, ${OWNER}, 'Blocked', 'moderated', 32, 'newUser', ${crumbs('poi')}),
        (95, ${OWNER}, 'Blocked', 'moderated', 32, 'tag', ${crumbs('tag')}),
        (96, ${OWNER}, 'Blocked', 'moderated', 32, 'appeal', ${crumbs('csam')}),
        (98, ${OWNER}, 'Blocked', 'moderated', 32, 'minor', '{"accountDeletionPriorIngestion": "Scanned", "accountDeletionPriorBlockedFor": null}'),
        (99, ${OWNER}, 'Blocked', 'moderated', 32, 'poi', ${crumbs(null)}),
        (100, ${OWNER}, 'Blocked', 'moderated', 32, 'tag', ${crumbs('not-a-review')}),
        (101, ${OWNER}, 'Blocked', 'moderated', 32, 'minor', ${crumbs('appeal')}),
        (102, ${OWNER}, 'Blocked', 'moderated', 32, 'poi', ${crumbs('appeal')}),
        (103, ${OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('appeal')});
      -- 83's and 101's appeals are still Pending; 102's and 103's were decided during the window.
      INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES
        ('Image', 83, 'Pending'), ('Image', 101, 'Pending'), ('Image', 102, 'Approved'), ('Image', 103, 'Rejected');
    `);
    dbMock.dbWrite.appeal.findMany.mockImplementation(
      (async ({ where }: { where: { entityId: { in: number[] } } }) =>
        (
          await holder.db.query<{ entityId: number }>(
            `SELECT "entityId" FROM "Appeal" WHERE status = 'Pending' AND "entityId" = ANY($1)`,
            [where.entityId.in]
          )
        ).rows) as never
    );

    await unblockAccountDeletionImages(OWNER);

    const rows = await reviewsOf([
      81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 98, 99, 100, 101, 102, 103,
    ]);
    // Control: every row was restored, so the review flags below are the restore's doing.
    expect(rows.map((row) => row.ingestion)).toEqual(Array(22).fill('Scanned'));
    expect(rows.map((row) => [row.id, row.needsReview])).toEqual([
      // Nothing set since: every listed review but csam comes back.
      [81, 'poi'],
      [82, 'minor'],
      [83, 'appeal'],
      [84, 'modRule'],
      [85, 'tag'],
      [86, 'remixSource'],
      [87, 'newUser'],
      // A value outside the list, a recorded csam (dismissed, or the block would have kept it) and
      // a JSON null write nothing.
      [88, null],
      [89, null],
      [90, null],
      // A current csam is never overwritten.
      [91, 'csam'],
      // Otherwise the higher of the two stays.
      [92, 'minor'],
      [93, 'minor'],
      [94, 'poi'],
      [95, 'tag'],
      [96, 'appeal'],
      // Nothing usable recorded (no key, JSON null, a value outside the list): the current flag stays.
      [98, 'minor'],
      [99, 'poi'],
      [100, 'tag'],
      // An approval must not publish an image a minor or poi review is still owed on.
      [101, 'minor'],
      [102, 'poi'],
      // A recorded appeal decided during the window has no queue left to clear it.
      [103, null],
    ]);

    const logged = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry as { message?: string; payload?: { reviews: { imageId: number }[] } })
      .filter((entry) => entry.message === 'kept the higher of two competing review flags')
      .flatMap((entry) => entry.payload?.reviews ?? []);
    expect(logged.sort((a, b) => a.imageId - b.imageId)).toEqual([
      { imageId: 91, kept: 'csam', dropped: 'minor' },
      { imageId: 92, kept: 'minor', dropped: 'poi' },
      { imageId: 93, kept: 'minor', dropped: 'newUser' },
      { imageId: 94, kept: 'poi', dropped: 'newUser' },
      { imageId: 101, kept: 'minor', dropped: 'appeal', pendingAppeal: true },
    ]);
  });

  it('leaves an account deleted again blocked, and restores it once it is not', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "needsReview", metadata) VALUES
        (97, ${OTHER_OWNER}, 'Blocked', 'moderated', 32, NULL, ${crumbs('minor')});
      UPDATE "User" SET "deletedAt" = now() WHERE id = ${OTHER_OWNER};
    `);

    const deleted = await unblockAccountDeletionImages(OTHER_OWNER);
    // The claim finds nothing, so the reversal reads as drained: restore-user-images then drops the
    // worklist entry, and a later restore queues it again.
    expect(deleted).toMatchObject({ unblocked: 0, drained: true });
    expect(await reviewsOf([97])).toEqual([{ id: 97, needsReview: null, ingestion: 'Blocked' }]);

    await holder.db.exec(`UPDATE "User" SET "deletedAt" = NULL WHERE id = ${OTHER_OWNER}`);
    await unblockAccountDeletionImages(OTHER_OWNER);
    expect(await reviewsOf([97])).toEqual([{ id: 97, needsReview: 'minor', ingestion: 'Scanned' }]);
  });
});

describe('the account-deletion grace block', () => {
  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", metadata) VALUES
        (${GRACED}, ${OWNER}, 'Blocked', 'moderated', 32, ${BREADCRUMBS}),
        (${CONTROL}, ${OWNER}, 'Blocked', 'moderated', 32, ${BREADCRUMBS}),
        (${PLAIN}, ${OWNER}, 'Scanned', NULL, 1, NULL);
    `);
  });

  describe('a block written during the grace period outlives the restore', () => {
    it('from a scan verdict', async () => {
      holder.tagNsfwLevel = 16;
      vi.mocked(auditPostImageMeta).mockReturnValue({
        success: false,
        blockedFor: ['tos-term'],
      } as never);

      await scan(GRACED);
      await restore();

      expect(await graceRow(GRACED)).toEqual({
        ingestion: 'Blocked',
        blockedFor: 'tos-term',
        nsfwLevel: 32,
        breadcrumb: false,
      });
    });

    it('from a CSAM scan verdict', async () => {
      holder.tagNsfwLevel = 16;
      vi.mocked(auditPostImageMeta).mockReturnValue({
        success: false,
        blockedFor: ['CSAM'],
      } as never);

      await scan(GRACED);

      expect(await graceRow(GRACED)).toEqual({
        ingestion: 'Blocked',
        blockedFor: 'CSAM',
        nsfwLevel: 32,
        breadcrumb: false,
      });
      await restore();
      expect((await graceRow(GRACED)).blockedFor).toBe('CSAM');
    });

    it('from a moderation rule', async () => {
      vi.mocked(getImagesModRules).mockResolvedValue([{ id: 1 }] as never);
      vi.mocked(evaluateRules).mockReturnValue({
        id: 1,
        action: ModerationRuleAction.Block,
        reason: 'rule',
      } as never);

      await scan(GRACED);
      await restore();

      expect(await graceRow(GRACED)).toMatchObject({ ingestion: 'Blocked', breadcrumb: false });
    });

    it('from the rating block', async () => {
      await blockImageFromRating({ imageId: GRACED, blockedReason: 'tos' });
      await restore();

      expect(await graceRow(GRACED)).toEqual({
        ingestion: 'Blocked',
        blockedFor: 'tos',
        nsfwLevel: 32,
        breadcrumb: false,
      });
    });

    it('from a ban, which also keeps every grace-blocked image blocked', async () => {
      // A reason and level the ban's own block would not write, so keeping them is visible; and a
      // metadata value that is not an object, which must not fail the whole statement.
      await holder.db.exec(`
        UPDATE "Image" SET "blockedFor" = 'tos', "nsfwLevel" = 16 WHERE id = ${CONTROL};
        UPDATE "Image" SET metadata = '"x"'::jsonb WHERE id = ${PLAIN};
      `);

      await blockBannedUserImages(OWNER);
      // The ban leaves a grace-blocked row as it was, without its breadcrumbs, and blocks the rest.
      expect(await graceRow(GRACED)).toEqual({ ...GRACE_BLOCK, breadcrumb: false });
      expect(await graceRow(CONTROL)).toEqual({
        ingestion: 'Blocked',
        blockedFor: 'tos',
        nsfwLevel: 16,
        breadcrumb: false,
      });
      expect(await graceRow(PLAIN)).toEqual({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        nsfwLevel: 32,
        breadcrumb: false,
      });

      // With no breadcrumb left the restore has nothing to claim; the assertions above are the guard.
      await unblockAccountDeletionImages(OWNER);
      expect(await graceRow(GRACED)).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
      });
    });
  });

  describe('a write that would lift a grace block leaves the row alone', () => {
    it('a clean scan verdict', async () => {
      const outcome = await scan(GRACED);

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
      // A Scanned outcome would queue the image for review and signal its owner.
      expect(outcome).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        nsfwLevel: 32,
      });
      // Control: the same clean verdict lifts a row that is not grace-blocked, and drops a breadcrumb
      // it carries, so a later block written over it cannot inherit one.
      await holder.db.exec(
        `UPDATE "Image" SET ingestion = 'Rescan', metadata = ${BREADCRUMBS} WHERE id = ${PLAIN}`
      );
      await scan(PLAIN);
      expect(await graceRow(PLAIN)).toMatchObject({
        ingestion: 'Scanned',
        blockedFor: null,
        breadcrumb: false,
      });
    });

    it('a clean scan verdict, which still keeps the image hash', async () => {
      await holder.db.exec(`UPDATE "Image" SET "pHash" = 5 WHERE id = ${GRACED}`);

      await resolveScanOutcome({
        image: await loaded(GRACED),
        pHash: BigInt(77),
        workflowId: 'wf',
        prompt: 'a landscape',
      });

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
      const { rows } = await holder.db.query<{ pHash: string | null }>(
        `SELECT "pHash"::text AS "pHash" FROM "Image" WHERE id = ${GRACED}`
      );
      expect(rows[0].pHash).toBe('77');
    });

    it('a clean scan verdict on a grace block whose recorded state is JSON null', async () => {
      await holder.db.exec(
        `UPDATE "Image" SET metadata = '{"accountDeletionPriorIngestion": null}' WHERE id = ${GRACED}`
      );

      await scan(GRACED);

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
    });

    it('a clean scan verdict for an image loaded before the grace block', async () => {
      const stale = {
        ...(await loaded(GRACED)),
        ingestion: 'Pending',
        blockedFor: null,
        nsfwLevel: 0,
      };

      const outcome = await resolveScanOutcome({
        image: stale as ScanImage,
        workflowId: 'wf',
        prompt: 'a landscape',
      });

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
      expect(outcome).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    });

    it('a clean scan verdict while an appeal is pending, which only keeps the block', async () => {
      dbMock.dbWrite.appeal.findMany.mockResolvedValue([{ entityId: GRACED }] as never);

      await scan(GRACED);

      // Keeping the grace block is not a new block: the breadcrumbs stay for the restore.
      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
    });

    it('a clean scan verdict for a banned owner, which only keeps the block', async () => {
      await holder.db.exec(`
        UPDATE "User" SET "bannedAt" = now() WHERE id = ${OWNER};
        UPDATE "Image" SET ingestion = 'Rescan', "blockedFor" = 'moderated' WHERE id = ${PLAIN};
      `);

      await scan(GRACED);
      await scan(PLAIN);

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
      // Control: the ban branch did fire, keeping the block on a row that is not grace-blocked.
      expect(await graceRow(PLAIN)).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
      });
    });

    it('reports the image blocked when the skipped row cannot be read back', async () => {
      const route = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown>;
      vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) =>
        strings.join('').includes('SELECT ingestion, "blockedFor", "nsfwLevel" FROM "Image"')
          ? Promise.reject(new Error('read failed'))
          : route(strings, ...values)) as never);

      const outcome = await scan(GRACED);

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
      expect(outcome).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        nsfwLevel: 32,
      });
    });

    it('a scan error', async () => {
      await holder.db.exec(
        `UPDATE "Image" SET ingestion = 'Pending', "blockedFor" = NULL WHERE id = ${PLAIN}`
      );
      const fail = (imageId: number) =>
        markImageScanError({
          workflowId: 'wf',
          imageId,
          status: 'failed',
          failureType: 'x',
          failedSteps: [],
        });

      await fail(GRACED);
      await fail(PLAIN);

      expect(await graceRow(GRACED)).toEqual(GRACE_BLOCK);
      // Control: the error write does reach a row that is not grace-blocked.
      expect((await graceRow(PLAIN)).ingestion).toBe('Error');
    });
  });
});

describe('scan result writes', () => {
  // One owner per row (100 + its id), so no row's state reaches another through its owner.
  const W_CSAM = 1;
  const W_MODERATED = 2;
  const W_BANNED_OWNER = 3;
  const W_AI_UNVERIFIED = 4;
  const W_FLAGGED = 5;
  const W_LEVEL_ONLY = 6;
  const W_TAKEN_DOWN = 7;
  const W_AI_FLAGGED = 8;
  const W_PENDING = 9;
  const sx = { minor: false, poi: false };

  beforeEach(async () => {
    sx.minor = false;
    sx.poi = false;
    const base = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation()!;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const rows = await (base as (...a: unknown[]) => Promise<unknown>)(strings, ...values);
      const [first] = (rows ?? []) as Record<string, unknown>[];
      return first && 'hasResource' in first ? [{ ...first, minor: sx.minor, poi: sx.poi }] : rows;
    }) as never);
    await holder.db.exec(`
      TRUNCATE "ModActivity";
      INSERT INTO "User" (id) SELECT 100 + g FROM generate_series(1, 9) g;
      UPDATE "User" SET "bannedAt" = now() WHERE id = 100 + ${W_BANNED_OWNER};
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "needsReview", minor) VALUES
        (${W_CSAM}, 100 + ${W_CSAM}, 'Blocked', 'CSAM', 32, NULL, false),
        (${W_MODERATED}, 100 + ${W_MODERATED}, 'Blocked', 'moderated', 32, NULL, false),
        (${W_BANNED_OWNER}, 100 + ${W_BANNED_OWNER}, 'Blocked', 'moderated', 32, NULL, false),
        (${W_AI_UNVERIFIED}, 100 + ${W_AI_UNVERIFIED}, 'Blocked', 'AiNotVerified', 32, NULL, false),
        (${W_FLAGGED}, 100 + ${W_FLAGGED}, 'Error', NULL, 32, 'minor', false),
        (${W_TAKEN_DOWN}, 100 + ${W_TAKEN_DOWN}, 'Error', NULL, 32, NULL, false),
        (${W_AI_FLAGGED}, 100 + ${W_AI_FLAGGED}, 'Error', 'AiNotVerified', 32, NULL, true),
        (${W_PENDING}, 100 + ${W_PENDING}, 'Pending', NULL, 0, NULL, false);
      INSERT INTO "ModActivity" ("entityType", "entityId", activity) VALUES ('image', ${W_TAKEN_DOWN}, 'review');
    `);
  });

  type Row = {
    ingestion: string;
    blockedFor: string | null;
    nsfwLevel: number;
    needsReview: string | null;
    minor: boolean;
    scanJobs: { retryCount?: number; error?: unknown } | null;
  };
  const imageRow = async (id: number) =>
    (
      await holder.db.query<Row>(
        `SELECT ingestion, "blockedFor", "nsfwLevel", "needsReview", minor, "scanJobs" FROM "Image" WHERE id = $1`,
        [id]
      )
    ).rows[0];

  const loaded = async (id: number) => {
    const row = (
      await holder.db.query(
        `SELECT "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", "needsReview" FROM "Image" WHERE id = $1`,
        [id]
      )
    ).rows[0] as Record<string, unknown>;
    return {
      id,
      createdAt: new Date('2025-12-01T00:00:00.000Z'),
      scannedAt: null,
      type: 'image',
      meta: { prompt: 'a landscape' },
      metadata: {},
      postId: null,
      ...row,
    } as unknown as ScanImage;
  };

  const toError = (...ids: number[]) =>
    holder.db.query(`UPDATE "Image" SET ingestion = 'Error' WHERE id = ANY($1::int[])`, [ids]);

  const scan = async (id: number) =>
    resolveScanOutcome({ image: await loaded(id), workflowId: 'wf', prompt: 'a landscape' });

  const failScan = (imageId: number) =>
    markImageScanError({
      workflowId: 'wf',
      imageId,
      status: 'failed',
      failureType: 'job-failed',
      failedSteps: ['scan'],
    });

  describe('an error result', () => {
    it.each([
      ['1', W_CSAM],
      ['2', W_MODERATED],
      ['3', W_BANNED_OWNER],
      ['4', W_AI_UNVERIFIED],
    ])('keeps the stored ingestion and counts the attempt (%s)', async (_label, id) => {
      const before = await imageRow(id);
      await failScan(id);
      const after = await imageRow(id);
      expect(after.ingestion).toBe('Blocked');
      expect({ blockedFor: after.blockedFor, nsfwLevel: after.nsfwLevel }).toEqual({
        blockedFor: before.blockedFor,
        nsfwLevel: before.nsfwLevel,
      });
      expect(after.scanJobs?.retryCount).toBe(1);
      expect(after.scanJobs?.error).toMatchObject({ failureType: 'job-failed' });
    });

    it('still writes as before for a plain row', async () => {
      await failScan(W_PENDING);
      expect(await imageRow(W_PENDING)).toMatchObject({ ingestion: 'Error' });
    });
  });

  describe('a clean result', () => {
    it.each([
      ['1', W_MODERATED, true],
      ['2', W_MODERATED, false],
      ['3', W_FLAGGED, false],
      ['4', W_TAKEN_DOWN, false],
      ['5', W_AI_FLAGGED, false],
    ])('leaves the row as it was (%s)', async (_label, id, errored) => {
      if (errored) await toError(id);
      const before = await imageRow(id);
      const outcome = await scan(id);
      const after = await imageRow(id);
      expect({ ...after, scanJobs: null }).toEqual({ ...before, scanJobs: null });
      expect(outcome.ingestion).toBe(before.ingestion);
    });

    it('matches the existing write (1)', async () => {
      await toError(W_CSAM);
      const outcome = await scan(W_CSAM);
      expect(await imageRow(W_CSAM)).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'CSAM',
        nsfwLevel: 32,
      });
      expect(outcome).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM' });
    });

    it('matches the existing write (2)', async () => {
      await toError(W_BANNED_OWNER);
      await scan(W_BANNED_OWNER);
      expect(await imageRow(W_BANNED_OWNER)).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
      });
    });

    it('matches the existing write (3)', async () => {
      await holder.db.exec(
        `INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel") VALUES (${W_LEVEL_ONLY}, 100 + ${W_LEVEL_ONLY}, 'Error', 32)`
      );
      dbMock.dbWrite.appeal.findMany.mockResolvedValue([{ entityId: W_LEVEL_ONLY }] as never);
      await holder.db.exec(
        `INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', ${W_LEVEL_ONLY})`
      );
      await scan(W_LEVEL_ONLY);
      expect(await imageRow(W_LEVEL_ONLY)).toMatchObject({
        ingestion: 'Blocked',
        needsReview: 'appeal',
      });
      await holder.db.exec('TRUNCATE "Appeal"');
    });

    it.each([['1', W_AI_UNVERIFIED]])(
      'writes a clean result as before (%s)',
      async (_label, id) => {
        await toError(id);
        const outcome = await scan(id);
        expect(await imageRow(id)).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
        expect(outcome.ingestion).toBe('Scanned');
      }
    );

    it('still lands a stricter result', async () => {
      await toError(W_MODERATED);
      holder.tagNsfwLevel = 16;
      vi.mocked(auditPostImageMeta).mockReturnValue({
        success: false,
        blockedFor: ['tos-term'],
      } as never);
      await scan(W_MODERATED);
      expect(await imageRow(W_MODERATED)).toMatchObject({
        ingestion: 'Blocked',
        blockedFor: 'tos-term',
      });
    });

    it('adds what the scan found and clears nothing', async () => {
      await toError(W_MODERATED, W_FLAGGED);
      sx.minor = true;
      await scan(W_MODERATED);
      await scan(W_FLAGGED);
      expect(await imageRow(W_MODERATED)).toMatchObject({
        ingestion: 'Error',
        blockedFor: 'moderated',
        nsfwLevel: 32,
        minor: true,
      });
      expect(await imageRow(W_FLAGGED)).toMatchObject({
        ingestion: 'Error',
        needsReview: 'minor',
        minor: true,
      });
    });

    it('writes nothing to the attempt count', async () => {
      await toError(W_MODERATED);
      await holder.db.exec(
        `UPDATE "Image" SET "scanJobs" = '{"retryCount": 2}' WHERE id = ${W_MODERATED}`
      );
      await scan(W_MODERATED);
      await scan(W_MODERATED);
      expect((await imageRow(W_MODERATED)).scanJobs).toEqual({ retryCount: 2 });
    });
  });

  describe('the shared definition', () => {
    it('matches exactly the rows the write keeps', async () => {
      await toError(W_CSAM, W_MODERATED, W_BANNED_OWNER, W_AI_UNVERIFIED);
      await holder.db.exec(`
        INSERT INTO "User" (id) VALUES (120), (121), (122), (123);
        INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel", "needsReview", "nsfwLevelLocked") VALUES
          (20, 120, 'Error', 32, 'csam', false),
          (21, 121, 'Error', 32, 'appeal', false),
          (22, 122, 'Error', 32, NULL, true),
          (23, 123, 'Error', 32, NULL, false);
        INSERT INTO "ModActivity" ("entityType", "entityId", activity) VALUES ('image', 23, 'bulkRemove');
      `);
      const flat = scanKeepsRowSql('i');
      const { rows } = await holder.db.query<{ id: number }>(
        `SELECT i.id FROM "Image" i WHERE ${flat.text} ORDER BY i.id`,
        flat.values as unknown[]
      );
      expect(rows.map((r) => r.id)).toEqual([
        W_CSAM,
        W_MODERATED,
        W_BANNED_OWNER,
        W_FLAGGED,
        W_TAKEN_DOWN,
        W_AI_FLAGGED,
        20,
        21,
        22,
        23,
        CSAM,
        OTHER,
      ]);
    });
  });
  describe('cases', () => {
    const queued = async () =>
      (
        await holder.db.query<{ entityId: number }>(
          `SELECT "entityId" FROM "JobQueue" WHERE type = 'CdnAccessSync' ORDER BY "entityId"`
        )
      ).rows.map((r) => r.entityId);
    const set = (id: number, columns: string) =>
      holder.db.exec(`UPDATE "Image" SET ${columns} WHERE id = ${id}`);
    const QUEUE_FN = `CREATE OR REPLACE FUNCTION queue_cdn_access_sync(entity_id integer, entity_type text, payload jsonb)
      RETURNS void AS $q$ BEGIN
        INSERT INTO "JobQueue" ("entityId", "entityType", type) VALUES (entity_id, entity_type, 'CdnAccessSync')
        ON CONFLICT DO NOTHING;
      END; $q$ LANGUAGE plpgsql;`;

    beforeAll(async () => {
      await holder.db.exec(`
        ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS url text, ADD COLUMN IF NOT EXISTS width int,
          ADD COLUMN IF NOT EXISTS height int, ADD COLUMN IF NOT EXISTS meta jsonb;
        CREATE TABLE IF NOT EXISTS "JobQueue" ("entityId" int, "entityType" text, type text,
          UNIQUE ("entityType", "entityId", type));
      `);
    });

    beforeEach(async () => {
      await holder.db.exec(`TRUNCATE "JobQueue"; ${QUEUE_FN}`);
      await holder.db.exec(
        `UPDATE "Image" SET url = 'https://example.invalid/' || id || '.jpeg', type = 'image'`
      );
      sent.length = 0;
      const outerExec = vi.mocked(dbMock.dbWrite.$executeRaw).getMockImplementation()!;
      vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const flat = Prisma.sql(strings, ...(values as never[]));
        const at = /WHERE id = \$(\d+)/.exec(flat.text);
        // The refused submit's own write: recorded, not applied, so the row stays as the test set it.
        if (flat.text.includes('"scanRequestedAt" =') && at) {
          sent.push(flat.values[Number(at[1]) - 1] as number);
          return 1;
        }
        return (outerExec as (...a: unknown[]) => Promise<unknown>)(strings, ...values);
      }) as never);
      const outer = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation()!;
      vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const text = strings.join('');
        if (text.includes('queue_cdn_access_sync') || text.includes("meta->>'prompt' as prompt"))
          return (await runOnPglite(strings, values)).rows;
        if (text.includes('TagsOnImageDetails')) return [];
        const rows = await (outer as (...a: unknown[]) => Promise<unknown>)(strings, ...values);
        if (banAfterRead.id != null && text.includes('FROM "Image" i WHERE i.id')) {
          await holder.db.query(
            `UPDATE "User" SET "bannedAt" = now() WHERE id = (SELECT "userId" FROM "Image" WHERE id = $1)`,
            [banAfterRead.id]
          );
          await holder.db.query(
            `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'AiNotVerified', "nsfwLevel" = 32 WHERE id = $1`,
            [banAfterRead.id]
          );
          banAfterRead.id = null;
        }
        return rows;
      }) as never);
    });

    /** Set to an image id: that row changes right after the fresh read. */
    const banAfterRead = { id: null as number | null };
    const MOD = { id: 1, isModerator: true } as never;
    const addTools = (imageId: number) =>
      addImageTools({ data: [{ imageId, toolId: 1 }] as never, user: MOD });
    /** Ids whose scan submit was reached: the url guard refuses every fixture url before any send. */
    const sent: number[] = [];
    const submitted = () => [...sent];

    describe('group 1', () => {
      it('case 1', async () => {
        await set(W_AI_UNVERIFIED, 'minor = true');
        await addTools(W_AI_UNVERIFIED);
        expect(await imageRow(W_AI_UNVERIFIED)).toMatchObject({
          ingestion: 'Blocked',
          blockedFor: 'AiNotVerified',
        });
        expect(submitted()).toEqual([]);
      });

      it('case 2', async () => {
        await addTools(W_AI_UNVERIFIED);
        expect(await imageRow(W_AI_UNVERIFIED)).toMatchObject({
          ingestion: 'Pending',
          blockedFor: null,
        });
        await vi.waitFor(() => expect(submitted()).toEqual([W_AI_UNVERIFIED]));
      });

      it('case 3', async () => {
        await set(W_AI_FLAGGED, 'minor = false');
        await addTools(W_AI_FLAGGED);
        expect(await imageRow(W_AI_FLAGGED)).toMatchObject({
          ingestion: 'Pending',
          blockedFor: null,
        });
        await set(W_AI_UNVERIFIED, `"needsReview" = 'appeal'`);
        expect(await requeueUnverifiedImages([W_AI_UNVERIFIED])).toEqual([]);
        expect((await imageRow(W_AI_UNVERIFIED)).ingestion).toBe('Blocked');
      });

      it('case 4', async () => {
        // Changed after the caller's read.
        await set(W_AI_UNVERIFIED, `"blockedFor" = 'moderated'`);
        expect(await requeueUnverifiedImages([W_AI_UNVERIFIED])).toEqual([]);
        expect(await imageRow(W_AI_UNVERIFIED)).toMatchObject({
          ingestion: 'Blocked',
          blockedFor: 'moderated',
        });
      });
    });

    describe('group 2', () => {
      it('case 1', async () => {
        await set(W_PENDING, `"blockedFor" = 'moderated'`);
        await failScan(W_PENDING);
        expect((await imageRow(W_PENDING)).ingestion).toBe('Error');
        expect(await queued()).toEqual([W_PENDING]);
      });

      it('case 2', async () => {
        await failScan(W_PENDING);
        expect((await imageRow(W_PENDING)).ingestion).toBe('Error');
        expect(await queued()).toEqual([]);
      });

      it('case 3', async () => {
        await set(W_PENDING, `"blockedFor" = 'moderated'`);
        await holder.db
          .exec(`CREATE OR REPLACE FUNCTION queue_cdn_access_sync(entity_id integer, entity_type text, payload jsonb)
          RETURNS void AS $q$ BEGIN RAISE EXCEPTION 'queue down'; END; $q$ LANGUAGE plpgsql;`);
        await expect(failScan(W_PENDING)).resolves.toMatchObject({ retryCount: 1 });
        expect((await imageRow(W_PENDING)).ingestion).toBe('Error');
        expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            name: 'scan-error-cdn-sync',
            imageId: W_PENDING,
          })
        );
      });

      it('case 4', async () => {
        await toError(W_MODERATED);
        await scan(W_MODERATED);
        expect((await imageRow(W_MODERATED)).ingestion).toBe('Error');
        expect(await queued()).toEqual([W_MODERATED]);
      });

      it('case 5', async () => {
        await set(W_MODERATED, `ingestion = 'Rescan'`);
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Scanned',
          blockedFor: null,
        });
        expect(await queued()).toEqual([W_MODERATED]);
      });

      it('case 6', async () => {
        await scan(W_PENDING);
        expect((await imageRow(W_PENDING)).ingestion).toBe('Scanned');
        expect(await queued()).toEqual([]);
      });
    });

    describe('group 3', () => {
      const keyAfter = async (id: number, key: string | null) => {
        const frag = reviewKeyAfterSkipSql(key);
        const flat = Prisma.sql`UPDATE "Image" SET "needsReview" = ${frag} WHERE id = ${id} RETURNING "needsReview"`;
        return (
          await holder.db.query<{ needsReview: string | null }>(flat.text, flat.values as unknown[])
        ).rows[0].needsReview;
      };

      it.each([
        ['1', W_PENDING, '', 'minor', 'minor'],
        ['2', W_PENDING, `"needsReview" = 'appeal'`, 'minor', 'appeal'],
        ['3', W_PENDING, `"needsReview" = 'poi'`, 'csam', 'poi'],
        ['4', W_MODERATED, '', 'minor', null],
        ['5', W_MODERATED, '', 'poi', null],
        ['6', W_MODERATED, `ingestion = 'Error'`, 'minor', null],
        ['7', W_FLAGGED, `"needsReview" = NULL, ingestion = 'Blocked'`, 'minor', null],
        ['8', W_MODERATED, '', 'csam', 'csam'],
        ['9', W_MODERATED, '', 'appeal', 'appeal'],
        ['10', W_FLAGGED, `"needsReview" = NULL`, 'poi', 'poi'],
        ['11', W_PENDING, '', null, null],
      ])('case %s', async (_label, id, columns, key, expected) => {
        if (columns) await set(id, columns);
        expect(await keyAfter(id, key)).toBe(expected);
      });
    });

    describe('group 4', () => {
      it('case 1', async () => {
        await set(W_MODERATED, `ingestion = 'NotFound'`);
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'NotFound',
          blockedFor: 'moderated',
          nsfwLevel: 32,
        });
      });

      it('case 2', async () => {
        await set(W_PENDING, 'ingestion = \'Error\', "nsfwLevel" = 32');
        await holder.db.exec(
          `INSERT INTO "ModActivity" ("entityType", "entityId", activity) VALUES ('post', ${W_PENDING}, 'review')`
        );
        await scan(W_PENDING);
        expect((await imageRow(W_PENDING)).ingestion).toBe('Scanned');
      });

      it('case 3', async () => {
        await toError(W_MODERATED);
        sx.poi = true;
        await scan(W_MODERATED);
        expect(
          (
            await holder.db.query<{ poi: boolean }>(`SELECT poi FROM "Image" WHERE id = $1`, [
              W_MODERATED,
            ])
          ).rows[0].poi
        ).toBe(true);
      });

      it('case 4', async () => {
        await set(W_MODERATED, `metadata = '{"${PRIOR_INGESTION_KEY}": "Scanned"}'`);
        sx.minor = true;
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({ ingestion: 'Blocked', minor: false });
      });

      it('case 6', async () => {
        await set(W_AI_FLAGGED, `"needsReview" = NULL`);
        vi.mocked(includesInappropriate).mockReturnValue('poi' as never);
        try {
          await scan(W_AI_FLAGGED);
        } finally {
          vi.mocked(includesInappropriate).mockReturnValue(false as never);
        }
        expect(await imageRow(W_AI_FLAGGED)).toMatchObject({
          ingestion: 'Error',
          blockedFor: 'AiNotVerified',
          needsReview: 'poi',
        });
      });

      it('case 5', async () => {
        banAfterRead.id = W_PENDING;
        sx.minor = true;
        await scan(W_PENDING);
        expect(await imageRow(W_PENDING)).toMatchObject({
          ingestion: 'Blocked',
          blockedFor: 'AiNotVerified',
          minor: false,
        });
      });
    });

    describe('group 5', () => {
      const rescan = async (id: number) => {
        await rescanImageById({ id });
        expect(submitted()).toContain(id);
      };

      it('case 1', async () => {
        await rescan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Rescan',
          blockedFor: 'moderated',
          nsfwLevel: 32,
        });
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Scanned',
          blockedFor: null,
        });
      });

      it('case 2', async () => {
        await toError(W_MODERATED);
        await rescan(W_MODERATED);
        expect((await imageRow(W_MODERATED)).ingestion).toBe('Rescan');
      });

      it.each([
        ['1', W_CSAM, ''],
        ['2', W_BANNED_OWNER, ''],
        ['3', W_AI_UNVERIFIED, ''],
        ['4', W_MODERATED, 'minor = true'],
        ['5', W_MODERATED, `"needsReview" = 'appeal'`],
        ['6', W_MODERATED, `metadata = '{"${PRIOR_INGESTION_KEY}": "Scanned"}'`],
        ['7', W_FLAGGED, ''],
        ['8', W_MODERATED, `ingestion = 'Pending'`],
        ['9', CSAM, ''],
      ])('case 3.%s', async (_label, id, columns) => {
        if (columns) await set(id, columns);
        const before = await imageRow(id);
        await rescan(id);
        expect((await imageRow(id)).ingestion).toBe(before.ingestion);
      });

      it('case 4', async () => {
        await ingestImageById({ id: W_MODERATED });
        expect(submitted()).toEqual([W_MODERATED]);
        expect((await imageRow(W_MODERATED)).ingestion).toBe('Blocked');
      });

      it('case 5', async () => {
        await rescan(W_MODERATED);
        await failScan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({ ingestion: 'Rescan' });
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Scanned',
          blockedFor: null,
        });
      });

      it('case 6', async () => {
        await rescan(W_MODERATED);
        await set(W_MODERATED, `"scanJobs" = '{"retryCount": ${IMAGE_RESCAN_RETRY_LIMIT - 2}}'`);
        await failScan(W_MODERATED);
        expect((await imageRow(W_MODERATED)).ingestion).toBe('Rescan');
        await holder.db.exec('TRUNCATE "JobQueue"');
        await failScan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Error',
          blockedFor: 'moderated',
        });
        expect(await queued()).toEqual([W_MODERATED]);
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Error',
          blockedFor: 'moderated',
        });
      });

      it('case 8', async () => {
        await set(
          W_MODERATED,
          `"scanJobs" = '{"retryCount": ${IMAGE_RESCAN_RETRY_LIMIT}, "workflowId": "w0"}'`
        );
        await rescan(W_MODERATED);
        expect((await imageRow(W_MODERATED)).scanJobs).toEqual({ retryCount: 0, workflowId: 'w0' });
        await scan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Scanned',
          blockedFor: null,
        });
      });

      it('case 9', async () => {
        await set(W_MODERATED, `"scanJobs" = '{"retryCount": ${IMAGE_RESCAN_RETRY_LIMIT}}'`);
        await rescan(W_MODERATED);
        await failScan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({ ingestion: 'Rescan' });
      });

      it('case 10', async () => {
        await set(
          W_MODERATED,
          `minor = true, "scanJobs" = '{"retryCount": ${IMAGE_RESCAN_RETRY_LIMIT}}'`
        );
        await rescan(W_MODERATED);
        expect(await imageRow(W_MODERATED)).toMatchObject({
          ingestion: 'Blocked',
          scanJobs: { retryCount: IMAGE_RESCAN_RETRY_LIMIT },
        });
      });

      it('case 7', async () => {
        await set(W_PENDING, `ingestion = 'Rescan', "blockedFor" = 'AiNotVerified'`);
        await failScan(W_PENDING);
        expect((await imageRow(W_PENDING)).ingestion).toBe('Error');
      });
    });
  });
});

describe('feed thumbnail fields', () => {
  const CREATOR = 5;
  // Marked by a Blocked rating alone: its owner keeps it.
  const marked = { url: 't', nsfwLevel: 16, blockMarked: true, ownerMediaAllowed: true };
  const viewers = {
    signedOut: {},
    other: { user: { id: 6 }, asOwner: true },
    owner: { user: { id: CREATOR }, asOwner: true },
    moderator: { user: { id: 7, isModerator: true }, asModerator: true },
    ownerNarrow: { user: { id: CREATOR }, asOwner: false },
  };
  const fields = (
    viewer: Parameters<typeof feedViewer>[0],
    thumbnail = marked as typeof marked | object
  ) => {
    const v = feedViewer(viewer);
    return feedThumbnailFields(thumbnail as typeof marked, 1, CREATOR, {
      ownerId: v.id,
      isModerator: v.isModerator,
    });
  };

  it.each([
    ['1', viewers.signedOut, undefined],
    ['2', viewers.other, undefined],
    ['3', viewers.owner, 't'],
    ['4', viewers.moderator, 't'],
    ['5', viewers.ownerNarrow, undefined],
  ])('case %s', (_label, viewer, url) => {
    expect(fields(viewer)).toEqual({ nsfwLevel: 16, thumbnailUrl: url });
  });

  it('case 6', () => {
    expect(fields(viewers.signedOut, { url: 't', nsfwLevel: 16 })).toEqual({
      nsfwLevel: 16,
      thumbnailUrl: undefined,
    });
    expect(fields(viewers.signedOut, { url: 't', nsfwLevel: 16, blockMarked: false })).toEqual({
      nsfwLevel: 16,
      thumbnailUrl: 't',
    });
  });

  it('a blocked thumbnail goes to a moderator only, its owner included', () => {
    for (const blocked of [
      { url: 't', nsfwLevel: 16, blockMarked: true, ownerMediaAllowed: false },
      // Cached before the flag was read: counts as not allowed.
      { url: 't', nsfwLevel: 16, blockMarked: true },
    ]) {
      expect(fields(viewers.owner, blocked).thumbnailUrl).toBeUndefined();
      expect(fields(viewers.moderator, blocked).thumbnailUrl).toBe('t');
    }
  });
});

/**
 * Decision (account-restore parity, #10248): the grace block records the rating and rating lock it
 * replaces with Blocked. A restore puts the recorded rating back only when it was locked or was
 * itself Blocked: a moderator's lock comes back locked, and a row kept by a block marker (a
 * takedown, `minor`, a lock at Blocked) comes back with its marker. Every other row is re-rated
 * from its current tags, so a tag enabled during the window, and the 'minor' review the re-rate
 * assigns, are not lost. A row with nothing recorded is re-rated as before.
 */
describe('a restore puts back the rating the grace block replaced', () => {
  const graced = (prior: {
    ingestion: string;
    blockedFor?: string | null;
    level?: number;
    locked?: boolean;
  }) =>
    `'${JSON.stringify({
      accountDeletionPriorIngestion: prior.ingestion,
      accountDeletionPriorBlockedFor: prior.blockedFor ?? null,
      accountDeletionPriorNeedsReview: null,
      ...(prior.level === undefined
        ? {}
        : {
            accountDeletionPriorNsfwLevel: prior.level,
            accountDeletionPriorNsfwLevelLocked: !!prior.locked,
          }),
    })}'`;
  const rating = async (id: number) =>
    (
      await holder.db.query<{ ingestion: string; nsfwLevel: number; nsfwLevelLocked: boolean }>(
        `SELECT ingestion, "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE id = $1`,
        [id]
      )
    ).rows[0];
  const keptByScan = async (id: number) => {
    const flat = scanKeepsRowSql('i');
    const { rows } = await holder.db.query<{ kept: boolean }>(
      `SELECT ${flat.text} AS kept FROM "Image" i WHERE i.id = $${flat.values.length + 1}`,
      [...(flat.values as unknown[]), id]
    );
    return rows[0].kept;
  };
  /** The reset's own first statement, so a row it is handed loses its level and lock as in prod. */
  const resetLikeProd = () =>
    vi.mocked(resetBlockedNsfwLevel).mockImplementation(async (ids, options) => {
      await holder.db.query(
        `UPDATE "Image" SET "nsfwLevel" = 0, "nsfwLevelLocked" = false
         WHERE id = ANY($1) AND "nsfwLevel" = 32 AND ($2 OR NOT "nsfwLevelLocked")`,
        [Array.isArray(ids) ? ids : [ids], !options?.unlockedOnly]
      );
    });
  const resetIds = () => vi.mocked(resetBlockedNsfwLevel).mock.calls.flatMap(([ids]) => ids);

  it.each([
    [
      'a moderator takedown',
      111,
      false,
      `INSERT INTO "ModActivity" ("entityType", "entityId", activity) VALUES ('image', 111, 'bulkRemove');`,
    ],
    ['the minor flag', 112, false, `UPDATE "Image" SET minor = true WHERE id = 112;`],
    ['a rating lock at Blocked', 113, true, ''],
  ])('an Error row kept at Blocked by %s comes back kept', async (_, id, locked, arm) => {
    resetLikeProd();
    await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
          (${id}, ${OWNER}, 'Blocked', 'moderated', 32, ${locked}, ${graced({
      ingestion: 'Error',
      level: 32,
      locked,
    })});
        ${arm}
      `);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(id)).toEqual({
      ingestion: 'Error',
      nsfwLevel: 32,
      nsfwLevelLocked: locked,
    });
    expect(await keptByScan(id), 'the restored row lost the marker a scan keeps it by').toBe(true);
    expect(resetIds()).not.toContain(id);
  });

  it("brings a moderator's rating lock back locked at its level; an unlocked rating is re-rated with it as a floor", async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (114, ${OWNER}, 'Blocked', 'moderated', 32, true, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: true,
    })}),
        (115, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 8,
      locked: false,
    })});
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(114)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 4,
      nsfwLevelLocked: true,
    });
    // Unlocked and not Blocked: handed to the re-rate (its level after it is pinned with real tags in
    // 're-rates an unlocked rating from the tags as they are now').
    expect(resetIds()).not.toContain(114);
    expect(resetIds()).toContain(115);
    // Not re-rated, so the caches that read the level are refreshed for it here.
    expect(vi.mocked(refreshImageLevelCaches).mock.calls.flat(2)).toContain(114);
    const { rows } = await holder.db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "Image" WHERE id IN (114, 115)`
    );
    expect(rows.map((row) => row.metadata)).toEqual([{}, {}]);
  });

  it('re-rates an unlocked rating from the tags as they are now, never below it, with the minor review', async () => {
    const recompute = readFileSync(
      new URL(
        '../../../../packages/civitai-db-schema/prisma/programmability/update_nsfw_level.sql',
        import.meta.url
      ),
      'utf8'
    )
      .split('---')
      .find((part) => part.includes('FUNCTION update_nsfw_levels_new('));
    expect(recompute, 'update_nsfw_levels_new not found in its programmability file').toBeTruthy();
    // resetBlockedNsfwLevel's own statements: the reset, then the recompute it runs.
    vi.mocked(resetBlockedNsfwLevel).mockImplementation(async (ids) => {
      const list = Array.isArray(ids) ? ids : [ids];
      await holder.db.query(
        `UPDATE "Image" SET "nsfwLevel" = 0, "nsfwLevelLocked" = false WHERE id = ANY($1) AND "nsfwLevel" = 32`,
        [list]
      );
      await holder.db.query(`SELECT update_nsfw_levels_new($1::int[])`, [list]);
    });
    await holder.db.exec(`
      CREATE TABLE IF NOT EXISTS "Tag" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL);
      CREATE TABLE IF NOT EXISTS "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
      TRUNCATE "Tag", "TagsOnImageDetails";
      ${recompute};
      INSERT INTO "Tag" (id, "nsfwLevel") VALUES (1, 1), (2, 8), (3, 4);
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata, "scanJobs") VALUES
        -- PG before the deletion; a moderator enabled an X tag during the window.
        (131, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 1,
      locked: false,
    })}, NULL),
        -- PG-13, and its scan saw a minor: the re-rate gives it the 'minor' review.
        (132, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: false,
    })}, '{"hasMinor": true}'),
        -- Its owner raised it to X over PG tags (unlocked, by design).
        (134, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 8,
      locked: false,
    })}, NULL),
        -- PG before the deletion; an R tag was added during the window.
        (135, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 1,
      locked: false,
    })}, NULL),
        -- Owner-raised to X over PG tags, and its scan saw a minor.
        (136, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 8,
      locked: false,
    })}, '{"hasMinor": true}');
      INSERT INTO "TagsOnImageDetails" ("imageId", "tagId") VALUES
        (131, 1), (131, 2), (132, 3), (134, 1), (135, 1), (135, 3), (136, 1);
    `);

    await unblockAccountDeletionImages(OWNER);

    const { rows } = await holder.db.query<{
      id: number;
      nsfwLevel: number;
      nsfwLevelLocked: boolean;
      needsReview: string | null;
    }>(
      `SELECT id, "nsfwLevel", "nsfwLevelLocked", "needsReview" FROM "Image" WHERE id IN (131, 132, 134, 135, 136) ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 131, nsfwLevel: 8, nsfwLevelLocked: false, needsReview: null },
      { id: 132, nsfwLevel: 4, nsfwLevelLocked: false, needsReview: 'minor' },
      { id: 134, nsfwLevel: 8, nsfwLevelLocked: false, needsReview: null },
      { id: 135, nsfwLevel: 4, nsfwLevelLocked: false, needsReview: null },
      { id: 136, nsfwLevel: 8, nsfwLevelLocked: false, needsReview: 'minor' },
    ]);
    // The caches that read the level are refreshed for exactly the rows the floor raised.
    expect(
      vi
        .mocked(refreshImageLevelCaches)
        .mock.calls.flatMap(([ids]) => ids)
        .sort()
    ).toEqual([134, 136]);
  });

  it('re-rates a row whose rating changed during the window, keeping a moderator lock', async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        -- A moderator rated it X and locked it after the grace block.
        (121, ${OWNER}, 'Blocked', 'moderated', 8, true, ${graced({
      ingestion: 'Scanned',
      level: 1,
      locked: false,
    })}),
        -- Re-rated to R during the window, lock unchanged.
        (129, ${OWNER}, 'Blocked', 'moderated', 4, false, ${graced({
      ingestion: 'Scanned',
      level: 1,
      locked: false,
    })}),
        -- A moderator locked it at Blocked after the grace block.
        (122, ${OWNER}, 'Blocked', 'moderated', 32, true, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: false,
    })}),
        -- Locked before the deletion and re-rated to X during the window without a new record.
        (133, ${OWNER}, 'Blocked', 'moderated', 8, true, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: true,
    })});
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(121)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 8,
      nsfwLevelLocked: true,
    });
    expect(await rating(129)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 4,
      nsfwLevelLocked: false,
    });
    expect(await rating(133)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 8,
      nsfwLevelLocked: true,
    });
    expect(resetIds()).toEqual(expect.arrayContaining([121, 122, 129]));
    expect(vi.mocked(refreshImageLevelCaches).mock.calls.flat(2)).not.toContain(121);
  });

  it('re-rates a row whose recorded rating is not a whole level, or has no lock beside it', async () => {
    resetLikeProd();
    const crumbs = (level: unknown, locked?: boolean) =>
      `'${JSON.stringify({
        accountDeletionPriorIngestion: 'Scanned',
        accountDeletionPriorBlockedFor: null,
        accountDeletionPriorNeedsReview: null,
        accountDeletionPriorNsfwLevel: level,
        ...(locked === undefined ? {} : { accountDeletionPriorNsfwLevelLocked: locked }),
      })}'`;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (123, ${OWNER}, 'Blocked', 'moderated', 32, false, ${crumbs('4', false)}),
        (124, ${OWNER}, 'Blocked', 'moderated', 32, false, ${crumbs(4.5, false)}),
        (125, ${OWNER}, 'Blocked', 'moderated', 32, false, ${crumbs(123456789012, false)}),
        (126, ${OWNER}, 'Blocked', 'moderated', 32, false, ${crumbs(4)}),
        (127, ${OWNER}, 'Blocked', 'moderated', 32, true, ${crumbs(4, true)}),
        -- Unrated before the deletion: re-rated, so the rescan of an unrated image still runs.
        (130, ${OWNER}, 'Blocked', 'moderated', 32, false, ${crumbs(0, false)});
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(resetIds()).toEqual(expect.arrayContaining([123, 124, 125, 126, 130]));
    // Control: a whole level with its lock is put back, not re-rated.
    expect(resetIds()).not.toContain(127);
    expect(await rating(127)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 4,
      nsfwLevelLocked: true,
    });
  });

  it('keeps a Blocked rating a moderator lands between the restore and its reset', async () => {
    vi.mocked(resetBlockedNsfwLevel).mockImplementation(async (ids, options) => {
      const list = Array.isArray(ids) ? ids : [ids];
      // The moderator's rating, committed after the restore statement and before the reset.
      await holder.db.query(
        `UPDATE "Image" SET "nsfwLevel" = 32, "nsfwLevelLocked" = true WHERE id = ANY($1)`,
        [list]
      );
      // The reset's own first statement.
      await holder.db.query(
        `UPDATE "Image" SET "nsfwLevel" = 0, "nsfwLevelLocked" = false
         WHERE id = ANY($1) AND "nsfwLevel" = 32 AND ($2 OR NOT "nsfwLevelLocked")`,
        [list, !options?.unlockedOnly]
      );
    });
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (137, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 1,
      locked: false,
    })});
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(137)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
  });

  it("puts back a moderator's lock when the image was unblocked during the window", async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (138, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 1,
      locked: false,
    })});
      -- A moderator rates it R and locks it during the window (updateImageNsfwLevel).
      UPDATE "Image" SET "nsfwLevel" = 4, "nsfwLevelLocked" = true, metadata = metadata ||
        '{"accountDeletionPriorNsfwLevel": 4, "accountDeletionPriorNsfwLevelLocked": true}'
        WHERE id = 138;
      -- Control: one whose recorded rating is Blocked, which the lift drops.
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (139, ${OWNER}, 'Blocked', 'moderated', 32, true, ${graced({
      ingestion: 'Scanned',
      level: 32,
      locked: true,
    })});
      UPDATE "User" SET "deletedAt" = now() WHERE id = ${OWNER};
    `);
    // Then unblocks it while the owner is still deleted: the lift's own statement.
    const lift = Prisma.sql`UPDATE "Image" SET ingestion = ${liftedIngestionSql},
      "blockedFor" = ${liftedBlockedForSql}, "nsfwLevel" = ${liftedNsfwLevelSql},
      "needsReview" = ${liftedNeedsReviewSql}, metadata = ${unblockedMetadataSql}
      WHERE id IN (138, 139)`;
    await holder.db.query(lift.text, lift.values as unknown[]);
    const { rows: lifted } = await holder.db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "Image" WHERE id = 139`
    );
    expect(lifted[0].metadata).not.toHaveProperty('accountDeletionPriorNsfwLevel');
    expect(lifted[0].metadata).toMatchObject({ accountDeletionPriorIngestion: 'Scanned' });
    expect(await rating(138), 'the lift kept the row blocked').toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
    await holder.db.exec(`UPDATE "User" SET "deletedAt" = NULL WHERE id = ${OWNER}`);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(138)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 4,
      nsfwLevelLocked: true,
    });
  });

  it('keeps a locked recorded rating off a row with a CSAM block, current or recorded', async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (140, ${OWNER}, 'Blocked', 'CSAM', 32, true, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: true,
    })}),
        (141, ${OWNER}, 'Blocked', 'moderated', 32, true, ${graced({
      ingestion: 'Scanned',
      blockedFor: 'CSAM',
      level: 4,
      locked: true,
    })});
    `);

    await unblockAccountDeletionImages(OWNER);

    for (const id of [140, 141])
      expect(await rating(id), `row ${id}`).toEqual({
        ingestion: 'Blocked',
        nsfwLevel: 32,
        nsfwLevelLocked: true,
      });
  });

  it('keeps a lift-kept rating off a row CSAM-blocked after the lift', async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (142, ${OWNER}, 'Blocked', 'moderated', 32, true, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: true,
    })});
      UPDATE "User" SET "deletedAt" = now() WHERE id = ${OWNER};
    `);
    const lift = Prisma.sql`UPDATE "Image" SET ingestion = ${liftedIngestionSql},
      "blockedFor" = ${liftedBlockedForSql}, "nsfwLevel" = ${liftedNsfwLevelSql},
      "needsReview" = ${liftedNeedsReviewSql}, metadata = ${unblockedMetadataSql}
      WHERE id = 142`;
    await holder.db.query(lift.text, lift.values as unknown[]);
    // Control: the lift kept the rating.
    const { rows } = await holder.db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "Image" WHERE id = 142`
    );
    expect(rows[0].metadata).toMatchObject({ accountDeletionPriorNsfwLevel: 4 });
    await holder.db.exec(`
      UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = 142;
      UPDATE "User" SET "deletedAt" = NULL WHERE id = ${OWNER};
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(142)).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
  });

  it('re-rates a row with no rating recorded, as before', async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (116, ${OWNER}, 'Blocked', 'moderated', 32, true, ${graced({ ingestion: 'Scanned' })});
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(resetIds()).toContain(116);
    expect(await rating(116)).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 0,
      nsfwLevelLocked: false,
    });
  });

  it('leaves a CSAM row Blocked at Blocked, whatever it recorded', async () => {
    resetLikeProd();
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata) VALUES
        (117, ${OWNER}, 'Blocked', 'CSAM', 32, false, ${graced({
      ingestion: 'Scanned',
      level: 4,
      locked: false,
    })}),
        -- A CSAM reason only in the record: the restore puts it back, and the row stays Blocked.
        (128, ${OWNER}, 'Blocked', 'moderated', 32, false, ${graced({
      ingestion: 'Scanned',
      blockedFor: 'CSAM',
      level: 4,
      locked: false,
    })});
    `);

    await unblockAccountDeletionImages(OWNER);

    expect(await rating(128)).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: false,
    });
    expect(await rating(117)).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: false,
    });
  });

  it('never writes a recorded appeal review onto a row that keeps a CSAM block', async () => {
    const withAppeal = (ingestion: string, blockedFor: string | null) =>
      `'${JSON.stringify({
        accountDeletionPriorIngestion: ingestion,
        accountDeletionPriorBlockedFor: blockedFor,
        accountDeletionPriorNeedsReview: 'appeal',
      })}'`;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", metadata) VALUES
        (118, ${OWNER}, 'Blocked', 'CSAM', 32, ${withAppeal('Error', 'CSAM')}),
        (119, ${OWNER}, 'Blocked', 'moderated', 32, ${withAppeal('Error', 'CSAM')}),
        (120, ${OWNER}, 'Blocked', 'moderated', 32, ${withAppeal('Scanned', null)});
      INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES
        ('Image', 118, 'Pending'), ('Image', 119, 'Pending'), ('Image', 120, 'Pending');
    `);

    await unblockAccountDeletionImages(OWNER);

    const { rows } = await holder.db.query<{ id: number; needsReview: string | null }>(
      `SELECT id, "needsReview" FROM "Image" WHERE id IN (118, 119, 120) ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 118, needsReview: null },
      { id: 119, needsReview: null },
      // Control: a row without a CSAM block gets its pending appeal's review back.
      { id: 120, needsReview: 'appeal' },
    ]);
  });
});
