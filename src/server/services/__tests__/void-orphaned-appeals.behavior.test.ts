import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as NotificationService from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { clickhouse } from '~/server/clickhouse/client';

/** The orphan sweep's SQL run against PGlite, so precedence and filter mistakes in the queries fail a test. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  refundMulti: vi.fn(),
  notify: vi.fn(),
  db: null as unknown as PGlite,
  // SQL run once after the pick query, standing in for a moderator acting before the claims.
  afterPick: null as string | null,
  clickhouse: 'normal' as 'normal' | 'throw' | 'empty',
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction: holder.refundMulti,
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: holder.notify,
}));
// Must match APPEALS rows 1 and 9: each appellant deleted the image after filing. A model delete
// is read from `Model.deletedBy`, so this fake answers only the two delete-event queries.
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    $query: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (holder.clickhouse === 'throw') return Promise.reject(new Error('clickhouse down'));
      if (holder.clickhouse === 'empty') return Promise.resolve([]);
      if (/FROM images WHERE type = 'Delete' AND imageId IN/.test(sql))
        return Promise.resolve([
          { entityId: '1001', userId: '11', t: String(Date.UTC(2026, 8, 2) / 1000) },
          { entityId: '1009', userId: '19', t: String(Date.UTC(2026, 8, 2) / 1000) },
        ]);
      if (/FROM modelEvents WHERE type IN \('Delete', 'PermanentDelete'\) AND modelId IN/.test(sql))
        return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ClickHouse query: ${sql}`));
    }),
  },
}));

import {
  closeAppealsDeletedByOwner,
  closeAppealsOnDeletedModel,
  voidOrphanedAppeals,
} from '~/server/services/report.service';

const FILED = '2026-09-01 00:00:00';

// [appeal id, userId, entityType, entityId, status, entityRemovedAt, buzzTransactionId]
const APPEALS: [number, number, string, number, string, string | null, string | null][] = [
  [1, 11, 'Image', 1001, 'Pending', null, 'appeal-11-1'], // owner deleted it
  [2, 12, 'Image', 1002, 'Pending', null, 'appeal-12-1'], // removed: routed
  [3, 13, 'Image', 1003, 'Pending', null, null], // image still exists
  [4, 14, 'Image', 1004, 'Rejected', null, null], // decided
  [5, 15, 'Model', 2005, 'Pending', null, null], // hard-deleted model, no owner event: quiet
  [6, 16, 'Model', 2006, 'Pending', null, null], // model still exists
  [7, 17, 'Model', 2007, 'Rejected', null, null], // decided model
  [8, 18, 'Image', 1008, 'Pending', '2026-09-10 00:00:00', null], // already routed
  [9, 19, 'Image', 1009, 'Pending', null, 'appeal-19-1'], // in a report (object entry), also owner-deleted
  [10, 20, 'Image', 1010, 'Pending', null, null], // image in a report, bare entry
  [11, 21, 'Image', 1011, 'Pending', null, null], // appellant has a report filed on them
  [12, 22, 'Image', 1012, 'Pending', null, null], // appellant reported, wrong reason
  [13, 23, 'Image', 1013, 'Pending', null, 'appeal-23-1'], // appellant reported, right reason
  [14, 24, 'Image', 1014, 'Pending', null, null], // appellant has another image blocked for it
  [15, 25, 'Image', 1015, 'Pending', null, null], // appellant's other image blocked for another reason
  [16, 26, 'Image', 1016, 'Pending', null, null], // deleted account
  [17, 27, 'Model', 1009, 'Pending', null, null], // hard-deleted model sharing a reported image's id: quiet
  [18, 28, 'Model', 2018, 'Pending', null, 'appeal-28-1'], // model soft-deleted by its owner
  [19, 29, 'Model', 2019, 'Pending', null, 'appeal-29-1'], // model soft-deleted by a moderator: quiet
];

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model');
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3));
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "blockedFor" text);
    CREATE TABLE "Model" (id int PRIMARY KEY, "deletedAt" timestamp(3), "deletedBy" int);
    CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
    CREATE TABLE "UserReport" ("userId" int NOT NULL, "reportId" int NOT NULL);
    -- Stands in for the hold-marker view the appeal exclusion reads.
    CREATE TABLE "EvidenceHeldUser" ("userId" int PRIMARY KEY, "heldUntil" timestamp(3));
    CREATE TABLE "CsamReport" (id int PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Appeal" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL,
      "createdAt" timestamp(3) NOT NULL,
      "updatedAt" timestamp(3) NOT NULL,
      "resolvedAt" timestamp(3),
      "resolvedReason" text,
      "buzzTransactionId" text,
      "entityRemovedAt" timestamp(3)
    );
  `);

  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await holder.db.query(flat.text, flat.values as unknown[]);
    if (holder.afterPick && /FROM "Appeal" a/.test(flat.text)) {
      await holder.db.exec(holder.afterPick);
      holder.afterPick = null;
    }
    return rows;
  }) as never);
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.refundMulti.mockResolvedValue(undefined);
  holder.notify.mockResolvedValue(undefined);
  holder.afterPick = null;
  holder.clickhouse = 'normal';
  await holder.db.exec(`
    TRUNCATE "User", "Image", "Model", "Report", "UserReport", "CsamReport", "Appeal";
    INSERT INTO "User" (id, "deletedAt") SELECT g, NULL FROM generate_series(11, 29) g;
    UPDATE "User" SET "deletedAt" = now() WHERE id = 26;
    INSERT INTO "Image" (id, "userId", "blockedFor") VALUES
      (1003, 13, NULL),
      (5014, 24, 'CSAM'),
      (5015, 25, 'moderated');
    INSERT INTO "Model" (id, "deletedAt", "deletedBy") VALUES
      (2006, NULL, NULL),
      (2018, '2026-09-02 00:00:00', 28),
      (2019, '2026-09-02 00:00:00', 999);
    INSERT INTO "Report" (id, reason) VALUES (1, 'TOSViolation'), (2, 'CSAM');
    INSERT INTO "UserReport" ("userId", "reportId") VALUES (22, 1), (23, 2);
    INSERT INTO "CsamReport" (id, "userId", images) VALUES
      (1, NULL, '[{"id": 1009}]'),
      (2, NULL, '[1010]'),
      (3, 21, '[]');
  `);
  for (const [id, userId, entityType, entityId, status, removedAt, fee] of APPEALS)
    await holder.db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
         "entityRemovedAt", "buzzTransactionId")
       VALUES ($1, $2, $3::"EntityType", $4, $5::"AppealStatus", $6, $6, $7, $8)`,
      [id, userId, entityType, entityId, status, FILED, removedAt, fee]
    );
});

async function appeals() {
  const { rows } = await holder.db.query<{
    id: number;
    status: string;
    resolvedReason: string | null;
    resolvedAt: Date | null;
    entityRemovedAt: Date | null;
  }>(
    `SELECT id, status, "resolvedReason", "resolvedAt", "entityRemovedAt" FROM "Appeal" ORDER BY id`
  );
  return new Map(rows.map((r) => [r.id, r]));
}

const refundedPrefixes = () =>
  vi
    .mocked(holder.refundMulti)
    .mock.calls.map(
      (c) => (c[0] as { externalTransactionIdPrefix: string }).externalTransactionIdPrefix
    )
    .sort();
const notifiedUsers = () =>
  vi
    .mocked(holder.notify)
    .mock.calls.map((c) => (c[0] as { userId: number }).userId)
    .sort((a, b) => a - b);

describe('voidOrphanedAppeals against Postgres', () => {
  it('sorts every orphan by the one condition that distinguishes it', async () => {
    const result = await voidOrphanedAppeals();
    const rows = await appeals();
    const state = (id: number) => {
      const r = rows.get(id)!;
      if (r.status === 'Void') return `void:${r.resolvedReason ?? 'quiet'}`;
      return r.entityRemovedAt && id !== 8 ? `${r.status}:routed` : r.status;
    };

    expect(Object.fromEntries(APPEALS.map(([id]) => [id, state(id)]))).toEqual({
      1: 'void:deleted-by-owner',
      2: 'Pending:routed',
      3: 'Pending',
      4: 'Rejected',
      5: 'void:quiet',
      6: 'Pending',
      7: 'Rejected',
      8: 'Pending',
      9: 'void:quiet',
      10: 'void:quiet',
      11: 'void:quiet',
      12: 'Pending:routed',
      13: 'void:quiet',
      14: 'void:quiet',
      15: 'Pending:routed',
      16: 'void:quiet',
      17: 'void:quiet',
      18: 'void:deleted-by-owner',
      19: 'void:quiet',
    });
    expect(result).toMatchObject({ closedQuietly: 9, closedOwnerDeleted: 2, routedForReview: 3 });
    // Only Pending, unstamped orphans are candidates: decided or existing models are never looked up.
    const modelLookup = vi
      .mocked(clickhouse!.$query)
      .mock.calls.find((c) => /FROM modelEvents/.test((c[0] as TemplateStringsArray).join('?')));
    expect([...(modelLookup?.[1] as number[])].sort()).toEqual([1009, 2005]);

    // Routed images keep their fee held; the quiet group is refunded but never told.
    expect(refundedPrefixes()).toEqual([
      'appeal-11-1',
      'appeal-19-1',
      'appeal-23-1',
      'appeal-28-1',
      'appeal-29-1',
    ]);
    expect(notifiedUsers()).toEqual([11, 12, 22, 25, 28]);
  });

  it.each(['throw', 'empty'] as const)(
    'still closes a model its appellant soft-deleted when ClickHouse is %s',
    async (mode) => {
      holder.clickhouse = mode;

      const result = await voidOrphanedAppeals();
      const rows = await appeals();

      expect(rows.get(18)).toMatchObject({ status: 'Void', resolvedReason: 'deleted-by-owner' });
      expect(rows.get(19)).toMatchObject({ status: 'Void', resolvedReason: null });
      expect(rows.get(19)!.entityRemovedAt).toBeNull();
      expect(refundedPrefixes()).toContain('appeal-28-1');
      expect(result.closedOwnerDeleted).toBeGreaterThanOrEqual(1);
    }
  );

  it('stamps closed appeals resolved and leaves routed ones unresolved', async () => {
    const before = (await appeals()).get(8)!.entityRemovedAt;
    await voidOrphanedAppeals();
    const rows = await appeals();

    for (const id of [1, 5, 9, 16, 17, 18, 19]) expect(rows.get(id)!.resolvedAt).not.toBeNull();
    for (const id of [5, 17, 19]) expect(rows.get(id)!.entityRemovedAt).toBeNull();
    for (const id of [2, 12, 15]) expect(rows.get(id)!.resolvedAt).toBeNull();
    expect(rows.get(8)!.entityRemovedAt).toEqual(before);
    expect(before).not.toBeNull();
  });

  it('leaves alone every appeal decided or routed between the pick and the claims', async () => {
    // Close and route each guard on status and on the stamp.
    // Decided meanwhile: 1 (owner close), 13 (quiet close), 2 (route). Stamped meanwhile: 9 (quiet close), 12 (route).
    holder.afterPick = `
      UPDATE "Appeal" SET status = 'Approved' WHERE id = 1;
      UPDATE "Appeal" SET "entityRemovedAt" = '2026-09-20 00:00:00' WHERE id = 9;
      UPDATE "Appeal" SET status = 'Rejected' WHERE id = 13;
      UPDATE "Appeal" SET status = 'Rejected' WHERE id = 2;
      UPDATE "Appeal" SET "entityRemovedAt" = '2026-09-20 00:00:00' WHERE id = 12;
    `;
    const routedMeanwhile = async () =>
      (await holder.db.query<{ at: Date }>(`SELECT '2026-09-20 00:00:00'::timestamp(3) AS at`))
        .rows[0].at;

    const result = await voidOrphanedAppeals();
    const rows = await appeals();

    expect(rows.get(1)).toMatchObject({
      status: 'Approved',
      resolvedAt: null,
      resolvedReason: null,
    });
    expect(rows.get(9)).toMatchObject({ status: 'Pending', resolvedAt: null });
    expect(rows.get(13)).toMatchObject({
      status: 'Rejected',
      resolvedAt: null,
      resolvedReason: null,
    });
    expect(rows.get(2)).toMatchObject({ status: 'Rejected', entityRemovedAt: null });
    expect(rows.get(12)!.entityRemovedAt).toEqual(await routedMeanwhile());
    expect(refundedPrefixes()).toEqual(['appeal-28-1', 'appeal-29-1']);
    expect(notifiedUsers()).toEqual([25, 28]);
    expect(result).toMatchObject({ closedQuietly: 7, closedOwnerDeleted: 1, routedForReview: 1 });
  });

  it('does nothing on a second run', async () => {
    await voidOrphanedAppeals();
    const first = await appeals();

    const second = await voidOrphanedAppeals();

    expect(second).toMatchObject({ closedQuietly: 0, closedOwnerDeleted: 0, routedForReview: 0 });
    expect(await appeals()).toEqual(first);
  });
});

describe('closeAppealsDeletedByOwner against Postgres', () => {
  it("closes only the deleting owner's Pending appeals on exactly the deleted entities", async () => {
    await holder.db.exec(`
      INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
        "buzzTransactionId") VALUES
        (101, 40, 'Image', 7001, 'Pending', '2026-09-01', '2026-09-01', 'appeal-40-1'),
        (102, 40, 'Image', 7002, 'Rejected', '2026-09-01', '2026-09-01', NULL),
        (103, 41, 'Image', 7001, 'Pending', '2026-09-01', '2026-09-01', NULL),
        (104, 40, 'Model', 7001, 'Pending', '2026-09-01', '2026-09-01', NULL),
        (105, 40, 'Image', 7003, 'Pending', '2026-09-01', '2026-09-01', NULL),
        (106, 21, 'Image', 7004, 'Pending', '2026-09-01', '2026-09-01', 'appeal-21-1');
      -- The sweep routed it between the delete and this close: the owner still deleted it.
      INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
        "entityRemovedAt") VALUES (107, 40, 'Image', 7005, 'Pending', '2026-09-01', '2026-09-01', now());
    `);

    await closeAppealsDeletedByOwner({
      entityType: 'Image',
      entityIds: [7001, 7002, 7005],
      ownerId: 40,
    });
    // User 21 is a defensive close (fixture): refunded, not told.
    await closeAppealsDeletedByOwner({ entityType: 'Image', entityIds: [7004], ownerId: 21 });

    const rows = await appeals();
    expect(rows.get(101)).toMatchObject({ status: 'Void', resolvedReason: 'deleted-by-owner' });
    expect(rows.get(101)!.resolvedAt).not.toBeNull();
    expect(rows.get(102)).toMatchObject({ status: 'Rejected', resolvedReason: null });
    for (const id of [103, 104, 105]) expect(rows.get(id)).toMatchObject({ status: 'Pending' });
    expect(rows.get(106)).toMatchObject({ status: 'Void', resolvedReason: 'deleted-by-owner' });
    expect(rows.get(107)).toMatchObject({ status: 'Void', resolvedReason: 'deleted-by-owner' });
    expect(refundedPrefixes()).toEqual(['appeal-21-1', 'appeal-40-1']);
    const notices = vi
      .mocked(holder.notify)
      .mock.calls.map((c) => c[0] as { key: string; details: { refunded: boolean } });
    expect(notices.map((n) => [n.key, n.details.refunded]).sort()).toEqual([
      ['entity-appeal-content-removed:101:closed-owner-deleted', true],
      ['entity-appeal-content-removed:107:closed-owner-deleted', false],
    ]);
  });
});

describe('closeAppealsOnDeletedModel against Postgres', () => {
  it("closes and refunds every appellant's Pending appeal on that model, quietly", async () => {
    await holder.db.exec(`
      INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
        "buzzTransactionId") VALUES
        (201, 40, 'Model', 8001, 'Pending', '2026-09-01', '2026-09-01', 'appeal-40-2'),
        (202, 41, 'Model', 8001, 'Rejected', '2026-09-01', '2026-09-01', NULL),
        (203, 42, 'Model', 8002, 'Pending', '2026-09-01', '2026-09-01', NULL),
        (204, 43, 'Image', 8001, 'Pending', '2026-09-01', '2026-09-01', NULL);
    `);

    await closeAppealsOnDeletedModel({ modelId: 8001 });

    const rows = await appeals();
    expect(rows.get(201)).toMatchObject({ status: 'Void', resolvedReason: null });
    expect(rows.get(201)!.resolvedAt).not.toBeNull();
    expect(rows.get(201)!.entityRemovedAt).toBeNull();
    expect(rows.get(202)).toMatchObject({ status: 'Rejected' });
    for (const id of [203, 204]) expect(rows.get(id)).toMatchObject({ status: 'Pending' });
    expect(refundedPrefixes()).toEqual(['appeal-40-2']);
    expect(holder.notify).not.toHaveBeenCalled();
  });

  it('closes nothing for a model that is not deleted', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "deletedAt", "deletedBy") VALUES (8003, NULL, NULL), (8004, now(), 1);
      INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
        "buzzTransactionId") VALUES
        (205, 44, 'Model', 8003, 'Pending', '2026-09-01', '2026-09-01', 'appeal-44-1'),
        (206, 45, 'Model', 8004, 'Pending', '2026-09-01', '2026-09-01', NULL);
    `);

    await closeAppealsOnDeletedModel({ modelId: 8003 });
    await closeAppealsOnDeletedModel({ modelId: 8004 });

    const rows = await appeals();
    expect(rows.get(205)).toMatchObject({ status: 'Pending', resolvedAt: null });
    expect(rows.get(206)).toMatchObject({ status: 'Void' });
    expect(refundedPrefixes()).toEqual([]);
  });

  it('never throws when the database does', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('db down'));

    await expect(closeAppealsOnDeletedModel({ modelId: 8001 })).resolves.toBeUndefined();
  });
});
