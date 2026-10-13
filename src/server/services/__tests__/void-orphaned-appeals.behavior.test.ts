import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as NotificationService from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { clickhouse } from '~/server/clickhouse/client';

/** The orphan sweep's SQL run against PGlite, so precedence and filter mistakes in the queries fail a test. Buzz, notifications and ClickHouse are mocked. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  refundMulti: vi.fn(),
  notify: vi.fn(),
  db: null as unknown as PGlite,
  // Runs once, right after the candidate pick: a moderator acting between the pick and the claims.
  afterPick: null as string | null,
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
// Must match APPEALS rows 1 and 9: each appellant deleted the image after filing.
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    $query: vi.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        /FROM images/.test(strings.join('?'))
          ? [
              { entityId: '1001', userId: '11', t: String(Date.UTC(2026, 8, 2) / 1000) },
              { entityId: '1009', userId: '19', t: String(Date.UTC(2026, 8, 2) / 1000) },
            ]
          : []
      )
    ),
  },
}));

import { voidOrphanedAppeals } from '~/server/services/report.service';

const FILED = '2026-09-01 00:00:00';

// [appeal id, userId, entityType, entityId, status, entityRemovedAt, buzzTransactionId]
const APPEALS: [number, number, string, number, string, string | null, string | null][] = [
  [1, 11, 'Image', 1001, 'Pending', null, 'appeal-11-1'], // owner deleted it
  [2, 12, 'Image', 1002, 'Pending', null, 'appeal-12-1'], // removed: routed
  [3, 13, 'Image', 1003, 'Pending', null, null], // image still exists
  [4, 14, 'Image', 1004, 'Rejected', null, null], // decided
  [5, 15, 'Model', 2005, 'Pending', null, null], // removed model: routed
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
  [17, 27, 'Model', 1009, 'Pending', null, null], // model sharing a reported image's id
];

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3));
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "blockedFor" text);
    CREATE TABLE "Model" (id int PRIMARY KEY);
    CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
    CREATE TABLE "UserReport" ("userId" int NOT NULL, "reportId" int NOT NULL);
    CREATE TABLE "CsamReport" (id int PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Appeal" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "entityType" text NOT NULL,
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
  await holder.db.exec(`
    TRUNCATE "User", "Image", "Model", "Report", "UserReport", "CsamReport", "Appeal";
    INSERT INTO "User" (id, "deletedAt") SELECT g, NULL FROM generate_series(11, 27) g;
    UPDATE "User" SET "deletedAt" = now() WHERE id = 26;
    INSERT INTO "Image" (id, "userId", "blockedFor") VALUES
      (1003, 13, NULL),
      (5014, 24, 'CSAM'),
      (5015, 25, 'moderated');
    INSERT INTO "Model" (id) VALUES (2006);
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
       VALUES ($1, $2, $3, $4, $5::"AppealStatus", $6, $6, $7, $8)`,
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
      5: 'Pending:routed',
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
      17: 'Pending:routed',
    });
    expect(result).toMatchObject({ closedQuietly: 6, closedOwnerDeleted: 1, routedForReview: 5 });
    // Only Pending, unstamped orphans are candidates: decided or existing models are never looked up.
    const modelLookup = vi
      .mocked(clickhouse!.$query)
      .mock.calls.find((c) => /FROM modelEvents/.test((c[0] as TemplateStringsArray).join('?')));
    expect([...(modelLookup?.[1] as number[])].sort()).toEqual([1009, 2005]);

    // Routed fees stay held; the quiet group is refunded but never told.
    expect(refundedPrefixes()).toEqual(['appeal-11-1', 'appeal-19-1', 'appeal-23-1']);
    expect(notifiedUsers()).toEqual([11, 12, 15, 22, 25, 27]);
  });

  it('stamps closed appeals resolved and leaves routed ones unresolved', async () => {
    const before = (await appeals()).get(8)!.entityRemovedAt;
    await voidOrphanedAppeals();
    const rows = await appeals();

    for (const id of [1, 9, 16]) expect(rows.get(id)!.resolvedAt).not.toBeNull();
    for (const id of [2, 5]) expect(rows.get(id)!.resolvedAt).toBeNull();
    expect(rows.get(8)!.entityRemovedAt).toEqual(before);
    expect(before).not.toBeNull();
  });

  it('leaves alone every appeal decided or routed between the pick and the claims', async () => {
    // One row per claim statement and guard: owner close and quiet close on status and on the
    // stamp, and the review route on status and on the stamp.
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
    expect(refundedPrefixes()).toEqual([]);
    expect(notifiedUsers()).toEqual([15, 25, 27]);
    expect(result).toMatchObject({ closedQuietly: 4, closedOwnerDeleted: 0, routedForReview: 3 });
  });

  it('does nothing on a second run', async () => {
    await voidOrphanedAppeals();
    const first = await appeals();

    const second = await voidOrphanedAppeals();

    expect(second).toMatchObject({ closedQuietly: 0, closedOwnerDeleted: 0, routedForReview: 0 });
    expect(await appeals()).toEqual(first);
  });
});
