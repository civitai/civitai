import { PGlite } from '@electric-sql/pglite';
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

import { markImageScanError, resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import { blockImageFromRating } from '../image-scan-result.service';
import { unblockAccountDeletionImages } from '../account-deletion-images';
import { blockBannedUserImages } from '~/server/services/user.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { auditPostImageMeta } from '~/utils/metadata/audit';
import { getImagesModRules } from '~/server/services/image.service';
import { evaluateRules } from '~/server/utils/mod-rules';
import { createNotification } from '~/server/services/notification.service';
import { ModerationRuleAction } from '~/shared/utils/prisma/enums';

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  tagNsfwLevel: 1,
  /** Set to an image id: that row turns CSAM-blocked right after the scan's fresh read of it. */
  csamLandsAfterRead: null as number | null,
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
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
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
    if (text.includes(' AS held ')) return (await runOnPglite(strings, values)).rows;
    if (text.includes('"User"')) {
      const { rows } = await runOnPglite(strings, values);
      if (holder.csamLandsAfterRead != null)
        await holder.db.query(
          `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM', "nsfwLevel" = 32 WHERE id = $1`,
          [holder.csamLandsAfterRead]
        );
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
  await holder.db.exec(`
    TRUNCATE "Image", "User", "EvidenceHeldUser", "EvidenceHoldImage", "CsamReport";
    INSERT INTO "User" (id, "bannedAt") VALUES (${OWNER}, NULL), (${OTHER_OWNER}, NULL);
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel") VALUES
      (${CSAM}, ${OWNER}, 'Blocked', 'CSAM', 32),
      (${OTHER}, ${OTHER_OWNER}, 'Blocked', 'moderated', 32);
    -- Reported over a year ago and archived: no account hold is left to keep the block, only its
    -- CSAM reason.
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
    // Control: the same clean scan lifts a block with any other reason.
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

const BREADCRUMBS = `'{"accountDeletionPriorIngestion": "Scanned", "accountDeletionPriorBlockedFor": null}'`;

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
          OR (metadata -> 'accountDeletionPriorBlockedFor') IS NOT NULL) AS breadcrumb
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
      const route = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation()!;
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
      // Blocked without breadcrumbs: only the grace block is kept. Pins the existing error write on
      // other blocked rows, not a judgement on it.
      await holder.db.exec(
        `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = ${PLAIN}`
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
      // Control: the error write does reach a blocked row that is not grace-blocked.
      expect((await graceRow(PLAIN)).ingestion).toBe('Error');
    });
  });
});
