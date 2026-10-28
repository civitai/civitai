import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, refundAppealFee, createNotification, recordModActivity } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  refundAppealFee: vi.fn(async (_appeal: unknown) => true),
  createNotification: vi.fn(async (_n: unknown) => undefined),
  recordModActivity: vi.fn(async (_a: unknown) => undefined),
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
vi.mock('../image-moderation-effects', () => ({ refundAppealFee }));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('../mod-activity', () => ({ recordModActivity }));

const { countRemovedAppeals, getRemovedAppeals, resolveRemovedAppeal } = await import(
  '../removed-appeals.service'
);

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-09-01',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT,
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "blockedFor" TEXT);
CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "reason" TEXT NOT NULL);
CREATE TABLE "UserReport" ("userId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);
CREATE TABLE "CsamReport" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "images" JSONB NOT NULL DEFAULT '[]');
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER PRIMARY KEY);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "activity" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

const MOD = 900;
let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  refundAppealFee.mockResolvedValue(true);
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" ("id", "username") VALUES (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four');
    INSERT INTO "Appeal" ("id", "userId", "entityType", "entityId", "status", "appealMessage",
      "buzzTransactionId", "entityRemovedAt") VALUES
      (11, 1, 'Image', 101, 'Pending', 'please', 'appeal-1-1', '2026-09-20'),
      (12, 2, 'Model', 202, 'Pending', 'mine', NULL, '2026-09-10'),
      (13, 3, 'Image', 303, 'Pending', 'still here', 'appeal-3-1', NULL),
      (14, 4, 'Image', 404, 'Rejected', 'decided', NULL, '2026-09-05');
    INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId", "createdAt") VALUES
      (50, 'review', 'image', 101, '2026-09-01 10:00'),
      (50, 'review', 'model', 101, '2026-09-01 11:00'),
      (51, 'setNsfwLevel', 'image', 303, '2026-09-01 12:00');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const appeal = async (id: number) =>
  (
    await db.query<{
      status: string;
      resolvedBy: number | null;
      resolvedAt: Date | null;
      resolvedMessage: string | null;
      resolvedReason: string | null;
      internalNotes: string | null;
    }>(
      `SELECT "status", "resolvedBy", "resolvedAt", "resolvedMessage", "resolvedReason", "internalNotes"
       FROM "Appeal" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];

const notices = () => createNotification.mock.calls.map((c) => c[0]);

describe('getRemovedAppeals', () => {
  it('lists only Pending appeals whose content was removed, longest-waiting first', async () => {
    const { items, hasMore } = await getRemovedAppeals({ limit: 10 });

    expect(items.map((i) => i.id)).toEqual([12, 11]);
    expect(hasMore).toBe(false);
    expect(items[1]).toMatchObject({
      userId: 1,
      username: 'one',
      entityType: 'Image',
      entityId: 101,
      appealMessage: 'please',
      hasFee: true,
    });
    expect(items[0]).toMatchObject({ hasFee: false });
  });

  it("carries each entity's moderation record, matched on type as well as id", async () => {
    const { items } = await getRemovedAppeals({ limit: 10 });

    const image = items.find((i) => i.id === 11)!;
    expect(image.history.map((h) => h.activity)).toEqual(['review']);
    expect(image.history[0]).toMatchObject({ moderatorId: 50 });
    expect(items.find((i) => i.id === 12)!.history).toEqual([]);
  });

  it('says when there are more than the page shows', async () => {
    const { items, hasMore } = await getRemovedAppeals({ limit: 1 });

    expect(items.map((i) => i.id)).toEqual([12]);
    expect(hasMore).toBe(true);
  });

  it('counts the same set the page lists', async () => {
    expect(await countRemovedAppeals()).toBe(2);
  });

  // Each is like 11 but for one thing the main app's appeal exclusion flags. 26 is the control: its
  // owner has a report and a block, neither of the kind that counts.
  it('leaves out an appeal the main app excludes, and nothing else', async () => {
    await db.exec(`
      INSERT INTO "Report" ("id", "reason") VALUES (1, 'CSAM'), (2, 'TOSViolation');
      INSERT INTO "UserReport" ("userId", "reportId") VALUES (22, 1), (26, 2);
      INSERT INTO "CsamReport" ("id", "userId", "images") VALUES
        (1, 21, '[]'), (2, NULL, '[{"id": 504}]'), (3, NULL, '[505]');
      INSERT INTO "Image" ("id", "userId", "blockedFor") VALUES (900, 23, 'CSAM'), (901, 26, 'moderated');
      INSERT INTO "EvidenceHeldUser" ("userId") VALUES (27);
      INSERT INTO "Appeal" ("id", "userId", "entityType", "entityId", "entityRemovedAt") VALUES
        (21, 21, 'Image', 501, '2026-09-21'),
        (22, 22, 'Image', 502, '2026-09-21'),
        (23, 23, 'Image', 503, '2026-09-21'),
        (24, 24, 'Image', 504, '2026-09-21'),
        (25, 25, 'Image', 505, '2026-09-21'),
        (26, 26, 'Image', 506, '2026-09-21'),
        (27, 27, 'Image', 507, '2026-09-21'),
        (28, 28, 'Model', 504, '2026-09-21');
    `);

    const { items } = await getRemovedAppeals({ limit: 20 });

    expect(items.map((i) => i.id)).toEqual([12, 11, 26, 28]);
    expect(await countRemovedAppeals()).toBe(4);
  });
});

describe('resolveRemovedAppeal', () => {
  // The same answer as an appeal another moderator decided, so an id posted by hand learns nothing.
  it('decides nothing on an appeal the list leaves out', async () => {
    await db.exec(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (1)`);

    const closed = await resolveRemovedAppeal({
      appealId: 11,
      decision: 'Approved',
      moderatorId: MOD,
    });

    expect(closed).toBeNull();
    expect(await appeal(11)).toMatchObject({ status: 'Pending', resolvedBy: null });
    expect(refundAppealFee).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('approves: records the ruling, refunds, and tells the user the removal was a mistake', async () => {
    const closed = await resolveRemovedAppeal({
      appealId: 11,
      decision: 'Approved',
      resolvedReason: 'false-positive',
      internalNotes: 'note',
      resolvedMessage: 'Sorry.',
      moderatorId: MOD,
    });

    expect(closed).toEqual({ refunded: true, refundFailed: false });
    expect(await appeal(11)).toMatchObject({
      status: 'Approved',
      resolvedBy: MOD,
      resolvedMessage: 'Sorry.',
      resolvedReason: 'false-positive',
      internalNotes: 'note',
    });
    expect((await appeal(11)).resolvedAt).not.toBeNull();
    expect(refundAppealFee).toHaveBeenCalledWith({
      id: 11,
      buzzTransactionId: 'appeal-1-1',
      entityType: 'Image',
      entityId: 101,
    });
    expect(notices()).toEqual([
      {
        userId: 1,
        type: 'entity-appeal-content-removed',
        category: 'Other',
        key: 'entity-appeal-content-removed:11:reviewed-approved',
        details: {
          entityType: 'Image',
          entityId: 101,
          outcome: 'reviewed-approved',
          refunded: true,
          resolvedMessage: 'Sorry.',
        },
      },
    ]);
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: MOD,
      entityType: 'image',
      entityId: 101,
      activity: 'resolveAppeal',
    });
  });

  it('rejects: keeps the fee and tells the user the removal stands', async () => {
    await resolveRemovedAppeal({
      appealId: 11,
      decision: 'Rejected',
      resolvedReason: 'upheld',
      moderatorId: MOD,
    });

    expect(await appeal(11)).toMatchObject({ status: 'Rejected', resolvedReason: 'upheld' });
    expect(refundAppealFee).not.toHaveBeenCalled();
    expect(notices()[0]).toMatchObject({
      key: 'entity-appeal-content-removed:11:reviewed-rejected',
      details: { outcome: 'reviewed-rejected', refunded: false },
    });
  });

  it('closes as owner-deleted: Void with the owner reason, refunded, told', async () => {
    await db.query(`UPDATE "Appeal" SET "buzzTransactionId" = 'appeal-2-1' WHERE "id" = 12`);

    await resolveRemovedAppeal({ appealId: 12, decision: 'OwnerDeleted', moderatorId: MOD });

    expect(await appeal(12)).toMatchObject({
      status: 'Void',
      resolvedBy: MOD,
      resolvedReason: 'deleted-by-owner',
    });
    expect(refundAppealFee).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }));
    expect(notices()[0]).toMatchObject({
      userId: 2,
      key: 'entity-appeal-content-removed:12:closed-owner-deleted',
      details: { entityType: 'Model', outcome: 'closed-owner-deleted' },
    });
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'model', entityId: 202 })
    );
  });

  it('says the fee was not refunded when the refund failed', async () => {
    refundAppealFee.mockResolvedValue(false);

    await resolveRemovedAppeal({
      appealId: 11,
      decision: 'Approved',
      resolvedReason: 'false-positive',
      moderatorId: MOD,
    });

    expect(notices()[0]).toMatchObject({ details: { refunded: false } });
  });

  it('tells the moderator when a fee could not be refunded', async () => {
    refundAppealFee.mockResolvedValue(false);

    expect(
      await resolveRemovedAppeal({ appealId: 12, decision: 'OwnerDeleted', moderatorId: MOD })
    ).toEqual({ refunded: false, refundFailed: false });
    expect(
      await resolveRemovedAppeal({
        appealId: 11,
        decision: 'Approved',
        resolvedReason: 'false-positive',
        moderatorId: MOD,
      })
    ).toEqual({ refunded: false, refundFailed: true });
  });

  it('refuses an appeal still in the entity queue, or already decided', async () => {
    for (const appealId of [13, 14]) {
      const closed = await resolveRemovedAppeal({
        appealId,
        decision: 'Approved',
        resolvedReason: 'false-positive',
        moderatorId: MOD,
      });
      expect(closed).toBeNull();
    }

    expect(await appeal(13)).toMatchObject({ status: 'Pending', resolvedBy: null });
    expect(await appeal(14)).toMatchObject({ status: 'Rejected', resolvedBy: null });
    expect(refundAppealFee).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('lets only one of two moderators resolving at once close it', async () => {
    const results = await Promise.all([
      resolveRemovedAppeal({
        appealId: 11,
        decision: 'Approved',
        resolvedReason: 'false-positive',
        moderatorId: MOD,
      }),
      resolveRemovedAppeal({
        appealId: 11,
        decision: 'Rejected',
        resolvedReason: 'upheld',
        moderatorId: MOD + 1,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    expect(refundAppealFee.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
