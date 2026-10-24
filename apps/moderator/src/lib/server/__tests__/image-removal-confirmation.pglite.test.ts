import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
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

const { dbHandle, recordModActivity, applyBlockSideEffects, setReportStatus, chQuery } = vi.hoisted(
  () => ({
    dbHandle: { current: null as unknown },
    recordModActivity: vi.fn(async () => undefined),
    applyBlockSideEffects: vi.fn(async () => undefined),
    setReportStatus: vi.fn(async (_input: { id: number }) => ({ ok: true, changed: true })),
    chQuery: vi.fn(async (): Promise<object[]> => []),
  })
);

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
vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../reports.service', () => ({ setReportStatus }));

const { blockImage } = await import('../image-moderation.service');
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

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
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
`;

const REQUESTER = 2;
const CONFIRMER = 3;
const APPROVER = 4;
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
      violationType: string | null;
    }>(
      `SELECT id, status, "requestedById", "decidedById", "reportIds", "violationType"
       FROM "ImageRemovalConfirmation" ORDER BY id`
    )
  ).rows;

beforeEach(async () => {
  vi.clearAllMocks();
  chQuery.mockResolvedValue([]);
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
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
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: REQUESTER, activity: 'review' })
    );
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CONFIRMER, activity: 'confirmRemoval' })
    );
    expect(setReportStatus.mock.calls.map(([a]) => a.id)).toEqual([7, 8]);
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
