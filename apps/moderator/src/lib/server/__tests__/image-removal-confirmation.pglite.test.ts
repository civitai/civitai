import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A removal that repeats the reason an approved appeal overturned is held for a second moderator
 * (hq 868md4kuv). These run the real hold, the real migration and the real confirm/decline against
 * Postgres; only the side effects outside the database are faked.
 */

vi.setConfig({ hookTimeout: 60_000 });

const {
  dbHandle,
  recordModActivity,
  insertModActivity,
  applyBlockSideEffects,
  setReportStatus,
  chQuery,
} = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  recordModActivity: vi.fn(async () => undefined),
  insertModActivity: vi.fn(async (_input: object, _db?: unknown) => 1),
  applyBlockSideEffects: vi.fn(async () => undefined),
  setReportStatus: vi.fn(async (_input: { id: number }) => ({ ok: true, changed: true })),
  chQuery: vi.fn(async (): Promise<object[]> => []),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: chQuery }) }));
vi.mock('../image-moderation-effects', () => ({
  applyBlockSideEffects,
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ insertModActivity, recordModActivity }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../reports.service', () => ({ setReportStatus }));

const { blockImage, isBannedOwnerBlocked } = await import('../image-moderation.service');
const { confirmRemoval, declineRemoval } = await import('../image-removal-confirmation.service');

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../../packages/civitai-db-schema/prisma/migrations/20261031130000_image_removal_confirmation/migration.sql',
      import.meta.url
    )
  ),
  'utf8'
);
const JOINERS_MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../../packages/civitai-db-schema/prisma/migrations/20271208130000_image_removal_confirmation_joiners/migration.sql',
      import.meta.url
    )
  ),
  'utf8'
);

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "bannedAt" TIMESTAMP(3));
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT,
  "url" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0
);
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT 'please',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" INTEGER,
  "resolvedReason" TEXT,
  "resolvedMessage" TEXT
);
CREATE TABLE "AppealDecisionRecord" ("appealId" INTEGER UNIQUE, "removalLabel" TEXT);
CREATE TABLE "ModActivity" (id SERIAL PRIMARY KEY, "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, activity TEXT, "createdAt" TIMESTAMP(3) DEFAULT now());
CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
CREATE TABLE "Report" (id INTEGER PRIMARY KEY, status "ReportStatus" NOT NULL, reason TEXT NOT NULL DEFAULT 'NSFW');
CREATE TABLE "ImageReport" ("imageId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);
INSERT INTO "Report" (id, status) VALUES (7, 'Pending'), (8, 'Processing');
INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (50, 7), (50, 8);
`;

const REQUESTER = 2;
const CONFIRMER = 3;
const APPROVER = 4;
const JOINER = 5;
const IMAGE = 50;

let db: PGlite;

const approve = async (opts: { label?: string | null; resolvedAt?: string } = {}) => {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId", "status", "resolvedAt", "resolvedBy")
     VALUES (9, 'Image', $1, 'Approved', $2, $3) RETURNING id`,
    [IMAGE, opts.resolvedAt ?? '2026-10-14 16:59:45', APPROVER]
  );
  if (opts.label !== null)
    await db.query(`INSERT INTO "AppealDecisionRecord" VALUES ($1, $2)`, [
      rows[0].id,
      opts.label ?? 'animatedMinorNsfw',
    ]);
  return rows[0].id;
};

const image = async () =>
  (
    await db.query<{ ingestion: string; blockedFor: string | null }>(
      `SELECT ingestion, "blockedFor" FROM "Image" WHERE id = $1`,
      [IMAGE]
    )
  ).rows[0];

const confirmations = async () =>
  (
    await db.query<{
      id: number;
      status: string;
      requestedById: number;
      decidedById: number | null;
      reportIds: number[];
      joinedByIds: number[];
      violationType: string | null;
    }>(
      `SELECT id, status, "requestedById", "decidedById", "reportIds", "joinedByIds", "violationType"
       FROM "ImageRemovalConfirmation" ORDER BY id`
    )
  ).rows;

beforeEach(async () => {
  vi.clearAllMocks();
  chQuery.mockResolvedValue([]);
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
  await db.exec(JOINERS_MIGRATION);
  await db.query(`INSERT INTO "User" VALUES ($1, 'req'), ($2, 'conf'), ($3, 'appr')`, [
    REQUESTER,
    CONFIRMER,
    APPROVER,
  ]);
  await db.query(
    `INSERT INTO "Image" (id, "userId", url, ingestion, "nsfwLevel") VALUES ($1, 9, 'u', 'Scanned', 4)`,
    [IMAGE]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('a removal of an image approved on appeal', () => {
  it('is held, not applied, when it repeats the overturned reason', async () => {
    const appealId = await approve();

    const result = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
      reportIds: [7],
    });

    expect(result.held).toMatchObject({
      imageId: IMAGE,
      created: true,
      appeal: { appealId, approvedByUsername: 'appr' },
    });
    expect(await image()).toEqual({ ingestion: 'Scanned', blockedFor: null });
    expect(applyBlockSideEffects).not.toHaveBeenCalled();
    expect(await confirmations()).toEqual([
      expect.objectContaining({
        status: 'Pending',
        requestedById: REQUESTER,
        reportIds: [7],
        violationType: 'animatedMinorNsfw',
      }),
    ]);
  });

  it('applies when the reason differs from the overturned one', async () => {
    await approve();

    const result = await blockImage({ imageId: IMAGE, userId: REQUESTER, violationType: 'gore' });

    expect(result.held).toBeUndefined();
    expect(await image()).toEqual({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(await confirmations()).toEqual([]);
  });

  it('is held when the moderator gives no reason, since it cannot be shown to differ', async () => {
    await approve();
    const result = await blockImage({ imageId: IMAGE, userId: REQUESTER });
    expect(result.held).toBeDefined();
    expect((await image()).ingestion).toBe('Scanned');
  });

  // The CDN access sync reads a block as a takedown only once its ModActivity row exists, so the two
  // must commit together: a sync run between them would deny without ever retracting.
  describe('the takedown audit row, written for real', () => {
    const actual = async () =>
      (await vi.importActual<typeof import('../mod-activity')>('../mod-activity'))
        .insertModActivity;
    const auditRows = async () =>
      (
        await db.query<{ activity: string }>(
          `SELECT activity FROM "ModActivity" WHERE "entityId" = $1`,
          [IMAGE]
        )
      ).rows;

    it('commits with the block, through its transaction', async () => {
      const insert = await actual();
      let isTransaction: boolean | undefined;
      insertModActivity.mockImplementationOnce(async (input, client) => {
        // One PGlite connection runs a plain-client write inside the open transaction too, so the
        // rows alone cannot tell the two apart: the client has to be the transaction.
        isTransaction = (client as { isTransaction?: boolean }).isTransaction;
        return insert(input as never, client as never);
      });
      await blockImage({ imageId: IMAGE, userId: REQUESTER, violationType: 'gore' });
      expect((await image()).ingestion).toBe('Blocked');
      expect(await auditRows()).toEqual([{ activity: 'review' }]);
      expect(isTransaction).toBe(true);
    });

    it('rolls back with the block when a later write in it fails', async () => {
      const insert = await actual();
      insertModActivity.mockImplementationOnce(async (input, client) => {
        await insert(input as never, client as never);
        throw new Error('a later write failed');
      });
      await expect(
        blockImage({ imageId: IMAGE, userId: REQUESTER, violationType: 'gore' })
      ).rejects.toThrow('a later write failed');
      expect((await image()).ingestion).toBe('Scanned');
      expect(await auditRows()).toEqual([]);
    });
  });

  it('applies when the image has no approved appeal', async () => {
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId", "status") VALUES (9, 'Image', $1, 'Rejected')`,
      [IMAGE]
    );
    const result = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
    });
    expect(result.held).toBeUndefined();
    expect((await image()).ingestion).toBe('Blocked');
  });

  it('applies for a moderator who may confirm re-removals', async () => {
    await approve();
    const result = await blockImage({
      imageId: IMAGE,
      userId: CONFIRMER,
      violationType: 'animatedMinorNsfw',
      skipAppealCheck: true,
    });
    expect(result.held).toBeUndefined();
    expect((await image()).ingestion).toBe('Blocked');
  });

  it('joins the pending request, adding its reports, rather than filing a second one', async () => {
    await approve();
    await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
      reportIds: [7],
    });
    const second = await blockImage({
      imageId: IMAGE,
      userId: CONFIRMER,
      violationType: 'animatedMinorNsfw',
      reportIds: [8, 7],
    });
    expect(second.held?.created).toBe(false);
    const rows = await confirmations();
    expect(rows).toHaveLength(1);
    expect([...rows[0].reportIds].sort()).toEqual([7, 8]);
  });

  it('records a moderator whose removal joins the request once, and never the requester', async () => {
    await approve();
    const remove = (userId: number) =>
      blockImage({ imageId: IMAGE, userId, violationType: 'animatedMinorNsfw', reportIds: [7] });
    await remove(REQUESTER);
    await remove(JOINER);
    await remove(REQUESTER);
    await remove(JOINER);

    expect((await confirmations())[0]).toMatchObject({
      requestedById: REQUESTER,
      joinedByIds: [JOINER],
    });
  });

  it('moves a pending request to the latest appeal when a new removal joins it', async () => {
    await approve();
    await blockImage({ imageId: IMAGE, userId: REQUESTER, violationType: 'animatedMinorNsfw' });
    // The image came down and went back up on a second approved appeal; the old request lingered.
    const latest = await approve({ resolvedAt: '2026-10-15 09:00:00' });
    const joined = await blockImage({
      imageId: IMAGE,
      userId: APPROVER,
      violationType: 'animatedMinorNsfw',
    });
    expect(joined.held?.created).toBe(false);

    // Confirming weighs the appeal the joining removal was checked against, so it runs.
    const [row] = await confirmations();
    expect(await confirmRemoval({ id: row.id, userId: CONFIRMER })).toMatchObject({
      status: 'Confirmed',
    });
    expect(
      (await db.query<{ appealId: number }>(`SELECT "appealId" FROM "ImageRemovalConfirmation"`))
        .rows[0].appealId
    ).toBe(latest);
    expect((await image()).ingestion).toBe('Blocked');
  });

  it('holds an image under an account-deletion grace block, which is not a removal', async () => {
    await approve();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated',
         metadata = '{"accountDeletionPriorIngestion": "Scanned"}' WHERE id = $1`,
      [IMAGE]
    );
    const result = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
    });
    expect(result.held).toBeDefined();
  });

  it('applies to an image that is already removed rather than holding it', async () => {
    await approve();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = $1`,
      [IMAGE]
    );
    const result = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
    });
    expect(result.held).toBeUndefined();
    expect(await confirmations()).toEqual([]);
  });

  describe('without a recorded label, it reads the overturned removal from ClickHouse', () => {
    it('holds the same reason as the last removal before the approval', async () => {
      await approve({ label: null });
      chQuery.mockResolvedValue([
        { imageId: IMAGE, time: '2026-09-20 17:30:11', label: 'schoolNsfw' },
        // After the approval: a later removal, not the one the appeal overturned.
        { imageId: IMAGE, time: '2026-10-14 18:59:16', label: 'gore' },
      ]);
      const same = await blockImage({
        imageId: IMAGE,
        userId: REQUESTER,
        violationType: 'schoolNsfw',
      });
      expect(same.held).toBeDefined();
    });

    it('applies a different reason', async () => {
      await approve({ label: null });
      chQuery.mockResolvedValue([
        { imageId: IMAGE, time: '2026-09-20 17:30:11', label: 'schoolNsfw' },
      ]);
      const other = await blockImage({ imageId: IMAGE, userId: REQUESTER, violationType: 'gore' });
      expect(other.held).toBeUndefined();
    });

    it('trusts the time-bounded read over a recorded label from a later removal', async () => {
      // The nightly fill recorded the latest removal, which came after the approval.
      await approve({ label: 'gore' });
      chQuery.mockResolvedValue([
        { imageId: IMAGE, time: '2026-09-20 17:30:11', label: 'schoolNsfw' },
        { imageId: IMAGE, time: '2026-10-14 18:59:16', label: 'gore' },
      ]);
      const same = await blockImage({
        imageId: IMAGE,
        userId: REQUESTER,
        violationType: 'schoolNsfw',
      });
      expect(same.held).toBeDefined();
    });

    it('holds when the overturned removal carries no label, whatever the record says', async () => {
      await approve({ label: 'gore' });
      chQuery.mockResolvedValue([{ imageId: IMAGE, time: '2026-09-20 17:30:11', label: null }]);
      const result = await blockImage({
        imageId: IMAGE,
        userId: REQUESTER,
        violationType: 'schoolNsfw',
      });
      expect(result.held).toBeDefined();
    });

    it('holds when ClickHouse cannot answer', async () => {
      await approve({ label: null });
      chQuery.mockRejectedValue(new Error('down'));
      const result = await blockImage({ imageId: IMAGE, userId: REQUESTER, violationType: 'gore' });
      expect(result.held).toBeDefined();
      expect((await image()).ingestion).toBe('Scanned');
    });
  });
});

describe('deciding a held removal', () => {
  const hold = async () => {
    await approve();
    const { held } = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
      reportIds: [7, 8],
    });
    return held!.confirmationId;
  };

  it('refuses the requester confirming their own removal', async () => {
    const id = await hold();

    const result = await confirmRemoval({ id, userId: REQUESTER });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('another moderator') });
    expect((await confirmations())[0].status).toBe('Pending');
    expect((await image()).ingestion).toBe('Scanned');
  });

  it('runs the removal as the requester once another moderator confirms', async () => {
    const id = await hold();

    expect(await confirmRemoval({ id, userId: CONFIRMER })).toEqual({
      ok: true,
      status: 'Confirmed',
    });

    expect(await image()).toEqual({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(await confirmations()).toEqual([
      expect.objectContaining({ status: 'Confirmed', decidedById: CONFIRMER }),
    ]);
    // The removal is the requester's; the confirmation is the confirmer's.
    expect(applyBlockSideEffects).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: REQUESTER, violationType: 'animatedMinorNsfw' })
    );
    expect(insertModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: REQUESTER, activity: 'review' }),
      expect.anything()
    );
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CONFIRMER, activity: 'confirmRemoval' })
    );
    expect(
      setReportStatus.mock.calls.map(([a]) => [a.id, (a as { noReward?: boolean }).noReward])
    ).toEqual([
      [7, false],
      [8, false],
    ]);
  });

  it("closes the reports unpaid for a banned owner's grace-blocked image", async () => {
    await approve();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated',
         metadata = '{"accountDeletionPriorIngestion": "Scanned"}' WHERE id = $1`,
      [IMAGE]
    );
    await db.query(
      `INSERT INTO "User" ("id", "bannedAt") SELECT "userId", now() FROM "Image" WHERE id = $1
       ON CONFLICT ("id") DO UPDATE SET "bannedAt" = now()`,
      [IMAGE]
    );
    const { held } = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
      reportIds: [7, 8],
    });

    await confirmRemoval({ id: held!.confirmationId, userId: CONFIRMER });

    expect(await image()).toEqual({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(
      setReportStatus.mock.calls.map(([a]) => [a.id, (a as { noReward?: boolean }).noReward])
    ).toEqual([
      [7, true],
      [8, true],
    ]);
  });

  it('leaves a report a moderator reviewed since the hold as it is', async () => {
    const id = await hold();
    await db.query(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 8`);

    await confirmRemoval({ id, userId: CONFIRMER });

    expect(setReportStatus.mock.calls.map(([a]) => a.id)).toEqual([7]);
    // The write itself is guarded too, for a review landing between this read and the write.
    expect(setReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatuses: ['Pending', 'Processing'] })
    );
  });

  it('actions only the kept reports that are on this image', async () => {
    await db.exec(`
      INSERT INTO "Report" (id, status) VALUES (9, 'Pending');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (51, 9);
    `);
    await approve();
    const { held } = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
      reportIds: [7, 9],
    });

    await confirmRemoval({ id: held!.confirmationId, userId: CONFIRMER });

    expect(setReportStatus.mock.calls.map(([a]) => a.id)).toEqual([7]);
  });

  const fileSinceHold = () =>
    db.exec(`
      INSERT INTO "Report" (id, status, reason) VALUES (10, 'Pending', 'TOSViolation'), (11, 'Pending', 'NSFW');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (50, 10), (50, 11);
    `);
  const actioned = () => setReportStatus.mock.calls.map(([a]) => a.id);

  it.each(['api.removeImages', 'site.setTosViolation'])(
    'held from %s, also actions a TOS report filed since the hold, but no other new report',
    async (source) => {
      await approve();
      const { held } = await blockImage({
        imageId: IMAGE,
        userId: REQUESTER,
        violationType: 'animatedMinorNsfw',
        reportIds: [7, 8],
        source,
      });
      await fileSinceHold();

      await confirmRemoval({ id: held!.confirmationId, userId: CONFIRMER });

      expect(actioned()).toEqual([7, 8, 10]);
    }
  );

  it('on a moderator block, leaves a TOS report filed since the hold for review', async () => {
    const id = await hold();
    await fileSinceHold();

    await confirmRemoval({ id, userId: CONFIRMER });

    expect(actioned()).toEqual([7, 8]);
  });

  it('voided because a ban removed the image meanwhile: closes the kept reports unpaid, no others', async () => {
    await approve();
    const { held } = await blockImage({
      imageId: IMAGE,
      userId: REQUESTER,
      violationType: 'animatedMinorNsfw',
      reportIds: [7, 8],
      source: 'api.removeImages',
    });
    await fileSinceHold();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = $1`,
      [IMAGE]
    );
    await db.query(
      `INSERT INTO "User" ("id", "bannedAt") SELECT "userId", now() FROM "Image" WHERE id = $1
       ON CONFLICT ("id") DO UPDATE SET "bannedAt" = now()`,
      [IMAGE]
    );

    expect(await confirmRemoval({ id: held!.confirmationId, userId: CONFIRMER })).toMatchObject({
      status: 'Void',
    });

    expect(
      setReportStatus.mock.calls.map(([a]) => [a.id, (a as { noReward?: boolean }).noReward])
    ).toEqual([
      [7, true],
      [8, true],
    ]);
  });

  it('stays Pending, its reports untouched, when the payout read for a voided confirm fails', async () => {
    const id = await hold();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = $1`,
      [IMAGE]
    );
    // The banned-owner read is the only query on the Void path that reads "bannedAt".
    await db.exec(`ALTER TABLE "User" RENAME COLUMN "bannedAt" TO "bannedAtGone"`);

    await expect(confirmRemoval({ id, userId: CONFIRMER })).rejects.toThrow(/bannedAt/);

    await db.exec(`ALTER TABLE "User" RENAME COLUMN "bannedAtGone" TO "bannedAt"`);
    expect(await confirmations()).toEqual([
      expect.objectContaining({ status: 'Pending', decidedById: null }),
    ]);
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  describe("after another moderator's removal joined it", () => {
    const holdAndJoin = async () => {
      const id = await hold();
      await blockImage({
        imageId: IMAGE,
        userId: JOINER,
        violationType: 'animatedMinorNsfw',
        reportIds: [7],
      });
      return id;
    };

    it('refuses the joining moderator confirming it', async () => {
      const id = await holdAndJoin();

      expect(await confirmRemoval({ id, userId: JOINER })).toEqual({
        ok: false,
        error: expect.stringContaining('joined this request'),
      });
      expect((await confirmations())[0].status).toBe('Pending');
      expect((await image()).ingestion).toBe('Scanned');
    });

    it('still refuses the requester', async () => {
      const id = await holdAndJoin();

      expect(await confirmRemoval({ id, userId: REQUESTER })).toMatchObject({ ok: false });
      expect((await confirmations())[0].status).toBe('Pending');
    });

    it('lets a moderator who had no part in it confirm', async () => {
      const id = await holdAndJoin();

      expect(await confirmRemoval({ id, userId: CONFIRMER })).toEqual({
        ok: true,
        status: 'Confirmed',
      });
      expect((await image()).ingestion).toBe('Blocked');
    });
  });

  it('runs the removal once when two moderators confirm', async () => {
    const id = await hold();
    await confirmRemoval({ id, userId: CONFIRMER });
    const again = await confirmRemoval({ id, userId: APPROVER });
    expect(again.ok).toBe(false);
    expect(applyBlockSideEffects).toHaveBeenCalledTimes(1);
  });

  it('voids the request without removing again when the image was removed meanwhile', async () => {
    const id = await hold();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = $1`,
      [IMAGE]
    );
    expect(await confirmRemoval({ id, userId: CONFIRMER })).toMatchObject({
      ok: true,
      status: 'Void',
    });
    expect(applyBlockSideEffects).not.toHaveBeenCalled();
    // The image is down, so the reports the removal answered are done with.
    expect(setReportStatus.mock.calls.map(([a]) => a.id)).toEqual([7, 8]);
  });

  it.each(['CSAM', 'TOS,csam'])(
    'leaves the reports open when the image was removed for CSAM (%s) meanwhile',
    async (blockedFor) => {
      const id = await hold();
      await db.query(`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = $2 WHERE id = $1`, [
        IMAGE,
        blockedFor,
      ]);

      expect(await confirmRemoval({ id, userId: CONFIRMER })).toMatchObject({ ok: true });

      expect((await image()).ingestion).toBe('Blocked');
      expect(setReportStatus).not.toHaveBeenCalled();
    }
  );

  it('answers the reports when the image was removed meanwhile for reasons without CSAM (control)', async () => {
    const id = await hold();
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'TOS,Moderated' WHERE id = $1`,
      [IMAGE]
    );

    expect(await confirmRemoval({ id, userId: CONFIRMER })).toMatchObject({ ok: true });

    expect(setReportStatus).toHaveBeenCalled();
  });

  it.each([
    ['TOS,Moderated', true],
    ['TOS,csam', false],
  ])(
    "reads a banned owner's image blocked for %s as banned-owner blocked: %s",
    async (blockedFor, expected) => {
      await db.query(`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = $2 WHERE id = $1`, [
        IMAGE,
        blockedFor,
      ]);
      await db.query(
        `INSERT INTO "User" ("id", "bannedAt") SELECT "userId", now() FROM "Image" WHERE id = $1
       ON CONFLICT ("id") DO UPDATE SET "bannedAt" = now()`,
        [IMAGE]
      );

      expect(await isBannedOwnerBlocked(IMAGE)).toBe(expected);
    }
  );

  it('voids the request, leaving the image up, when a later appeal was approved', async () => {
    const id = await hold();
    await approve({ resolvedAt: '2026-10-15 09:00:00' });

    expect(await confirmRemoval({ id, userId: CONFIRMER })).toEqual({
      ok: true,
      status: 'Void',
      note: 'A later appeal was approved',
    });
    expect((await image()).ingestion).toBe('Scanned');
    expect(applyBlockSideEffects).not.toHaveBeenCalled();
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('leaves the image up when declined', async () => {
    const id = await hold();
    expect(await declineRemoval({ id, userId: CONFIRMER, note: 'appeal stands' })).toEqual({
      ok: true,
      status: 'Declined',
    });
    expect((await image()).ingestion).toBe('Scanned');
    expect(await confirmations()).toEqual([
      expect.objectContaining({ status: 'Declined', decidedById: CONFIRMER }),
    ]);
    expect(await confirmRemoval({ id, userId: CONFIRMER })).toMatchObject({ ok: false });
  });
});
