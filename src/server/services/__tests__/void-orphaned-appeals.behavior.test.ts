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
  getAppealExcludedIds,
  canAppealOwnImage,
  isAppealBlockedByHoldMarker,
  isImageAppealRefused,
  ROUTED_APPEAL_REVIEW_DAYS,
  voidOrphanedAppeals,
} from '~/server/services/report.service';

const FILED = '2026-09-01 00:00:00';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
const DAY = 86_400_000;
// Routed recently enough that the review deadline is far off.
const RECENTLY = ago(DAY);

// [appeal id, userId, entityType, entityId, status, entityRemovedAt, buzzTransactionId]
const APPEALS: [number, number, string, number, string, string | null, string | null][] = [
  [1, 11, 'Image', 1001, 'Pending', null, 'appeal-11-1'], // owner deleted it
  [2, 12, 'Image', 1002, 'Pending', null, 'appeal-12-1'], // removed: routed
  [3, 13, 'Image', 1003, 'Pending', null, null], // image still exists
  [4, 14, 'Image', 1004, 'Rejected', null, null], // decided
  [5, 15, 'Model', 2005, 'Pending', null, null], // hard-deleted model, no owner event: quiet
  [6, 16, 'Model', 2006, 'Pending', null, null], // model still exists
  [7, 17, 'Model', 2007, 'Rejected', null, null], // decided model
  [8, 18, 'Image', 1008, 'Pending', RECENTLY, null], // already routed
  // 9-14: the appeal flow excludes the image or its appellant; each is treated like 1, 2 or 15.
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
  [20, 30, 'Image', 1020, 'Pending', null, 'appeal-30-1'], // like 2; appellant under a hold marker
];

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model');
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3));
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "blockedFor" text, "needsReview" text);
    CREATE TABLE "CsamQueueSetAside" ("imageId" int PRIMARY KEY, outcome text NOT NULL);
    CREATE TABLE "EvidenceHold" (id serial PRIMARY KEY, "userId" int NOT NULL, "releaseAt" timestamp(3));
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text, "entityId" int
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "deletedAt" timestamp(3), "deletedBy" int);
    CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
    CREATE TABLE "UserReport" ("userId" int NOT NULL, "reportId" int NOT NULL);
    -- Stand in for the hold-marker view and its kept-image record, which the appeal checks read.
    CREATE TABLE "EvidenceHeldUser" ("userId" int PRIMARY KEY, "heldUntil" timestamp(3));
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "CsamReport" (
      id int PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
    );
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
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
  }) as never);
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.refundMulti.mockResolvedValue(undefined);
  holder.notify.mockResolvedValue(undefined);
  holder.afterPick = null;
  holder.clickhouse = 'normal';
  await holder.db.exec(`
    TRUNCATE "User", "Image", "Model", "Report", "UserReport", "CsamReport", "EvidenceHeldUser", "Appeal",
      "CsamQueueSetAside", "EvidenceHold", "ModActivity";
    INSERT INTO "User" (id, "deletedAt") SELECT g, NULL FROM generate_series(11, 30) g;
    INSERT INTO "EvidenceHeldUser" ("userId") VALUES (30);
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

/** Everything the appellant of `id` can see of it: the row, its notices, and its refund. */
async function seenBy(id: number, fee: string | null) {
  const { status, resolvedReason, resolvedAt, entityRemovedAt } = (await appeals()).get(id)!;
  const notices = vi
    .mocked(holder.notify)
    .mock.calls.map((c) => c[0] as { key: string; details: Record<string, unknown> })
    .filter((n) => n.key.includes(`:${id}:`))
    .map((n) => ({
      key: n.key.replace(`:${id}:`, ':#:'),
      outcome: n.details.outcome,
      refunded: n.details.refunded,
    }));
  return {
    status,
    resolvedReason,
    resolved: resolvedAt !== null,
    routed: entityRemovedAt !== null,
    notices,
    refunded: fee !== null && refundedPrefixes().includes(fee),
  };
}
const feeOf = (id: number) => APPEALS.find(([a]) => a === id)![6];

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
      9: 'void:deleted-by-owner',
      10: 'Pending:routed',
      11: 'Pending:routed',
      12: 'Pending:routed',
      13: 'Pending:routed',
      14: 'Pending:routed',
      15: 'Pending:routed',
      16: 'void:quiet',
      17: 'void:quiet',
      18: 'void:deleted-by-owner',
      19: 'void:quiet',
      20: 'Pending:routed',
    });
    expect(result).toMatchObject({ closedQuietly: 4, closedOwnerDeleted: 3, routedForReview: 8 });
    // Only Pending, unstamped orphans are candidates: decided or existing models are never looked up.
    const modelLookup = vi
      .mocked(clickhouse!.$query)
      .mock.calls.find((c) => /FROM modelEvents/.test((c[0] as TemplateStringsArray).join('?')));
    expect([...(modelLookup?.[1] as number[])].sort()).toEqual([1009, 2005]);

    // Routed images keep their fee held; the quiet group is refunded but never told.
    expect(refundedPrefixes()).toEqual([
      'appeal-11-1',
      'appeal-19-1',
      'appeal-28-1',
      'appeal-29-1',
    ]);
    expect(notifiedUsers()).toEqual([11, 12, 19, 20, 21, 22, 23, 24, 25, 28, 30]);
  });

  // Each pair differs only in that the flow excludes the second appellant (13: reported, 20: held;
  // 9: its image reported, deleted by its owner like 1).
  it.each([
    [2, 13],
    [2, 20],
    [1, 9],
  ])('shows appellant %i and excluded appellant %i the same outcome', async (normal, excluded) => {
    await voidOrphanedAppeals();

    const expected = await seenBy(normal, feeOf(normal));
    expect(expected.notices).toHaveLength(1);
    expect(await seenBy(excluded, feeOf(excluded))).toEqual(expected);
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
    // Decided meanwhile: 1 (owner close), 5 (quiet close), 2 (route).
    // Stamped meanwhile: 9 (owner close), 16 (quiet close), 12 (route).
    holder.afterPick = `
      UPDATE "Appeal" SET status = 'Approved' WHERE id = 1;
      UPDATE "Appeal" SET "entityRemovedAt" = '${RECENTLY}' WHERE id = 9;
      UPDATE "Appeal" SET status = 'Rejected' WHERE id = 5;
      UPDATE "Appeal" SET "entityRemovedAt" = '${RECENTLY}' WHERE id = 16;
      UPDATE "Appeal" SET status = 'Rejected' WHERE id = 2;
      UPDATE "Appeal" SET "entityRemovedAt" = '${RECENTLY}' WHERE id = 12;
    `;
    const routedMeanwhile = async () =>
      (await holder.db.query<{ at: Date }>(`SELECT '${RECENTLY}'::timestamp(3) AS at`)).rows[0].at;

    const result = await voidOrphanedAppeals();
    const rows = await appeals();

    expect(rows.get(1)).toMatchObject({
      status: 'Approved',
      resolvedAt: null,
      resolvedReason: null,
    });
    expect(rows.get(9)).toMatchObject({ status: 'Pending', resolvedAt: null });
    expect(rows.get(5)).toMatchObject({
      status: 'Rejected',
      resolvedAt: null,
      resolvedReason: null,
    });
    expect(rows.get(16)).toMatchObject({ status: 'Pending', resolvedAt: null });
    expect(rows.get(2)).toMatchObject({ status: 'Rejected', entityRemovedAt: null });
    expect(rows.get(12)!.entityRemovedAt).toEqual(await routedMeanwhile());
    expect(refundedPrefixes()).toEqual(['appeal-28-1', 'appeal-29-1']);
    expect(notifiedUsers()).toEqual([20, 21, 23, 24, 25, 28, 30]);
    expect(result).toMatchObject({ closedQuietly: 2, closedOwnerDeleted: 1, routedForReview: 6 });
  });

  // 31 and 32 have waited past the deadline, 32's appellant held; 33 is a day short of it; 34 was
  // decided long ago. Their images are gone, so the sweep's pick never sees them.
  describe('an appeal still unreviewed after the review deadline', () => {
    beforeEach(async () => {
      await holder.db.query(
        `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
           "entityRemovedAt", "buzzTransactionId") VALUES
           (31, 12, 'Image', 1031, 'Pending', $1, $1, now() - make_interval(days => $2, mins => 1), 'appeal-12-2'),
           (32, 30, 'Image', 1032, 'Pending', $1, $1, now() - make_interval(days => $2, mins => 1), 'appeal-30-2'),
           (33, 12, 'Image', 1033, 'Pending', $1, $1, now() - make_interval(days => $2 - 1), 'appeal-12-3'),
           (34, 12, 'Image', 1034, 'Rejected', $1, $1, now() - make_interval(days => $2 * 2), 'appeal-12-4'),
           (35, 12, 'Model', 2035, 'Pending', $1, $1, now() - make_interval(days => $2, mins => 1), 'appeal-12-5')`,
        // Computed in the database, whose clock and zone the deadline is measured in.
        [FILED, ROUTED_APPEAL_REVIEW_DAYS]
      );
    });

    it('is closed, refunded and told, the same for an excluded appellant', async () => {
      const result = await voidOrphanedAppeals();

      const normal = await seenBy(31, 'appeal-12-2');
      expect(normal).toEqual({
        status: 'Void',
        resolvedReason: 'removed-before-review',
        resolved: true,
        routed: true,
        notices: [
          {
            key: 'entity-appeal-content-removed:#:closed-unreviewed',
            outcome: 'closed-unreviewed',
            refunded: true,
          },
        ],
        refunded: true,
      });
      expect(await seenBy(32, 'appeal-30-2')).toEqual(normal);
      expect(result).toMatchObject({ closedUnreviewed: 2 });
    });

    it('leaves one short of the deadline, and one already decided, alone', async () => {
      await voidOrphanedAppeals();
      const rows = await appeals();

      expect(rows.get(33)).toMatchObject({ status: 'Pending', resolvedAt: null });
      expect(rows.get(34)).toMatchObject({
        status: 'Rejected',
        resolvedAt: null,
        resolvedReason: null,
      });
      expect(refundedPrefixes()).not.toContain('appeal-12-3');
      expect(refundedPrefixes()).not.toContain('appeal-12-4');
    });

    // 35 has waited as long as 31, but only images are routed for review today.
    it('leaves a non-image appeal past the deadline alone', async () => {
      await voidOrphanedAppeals();

      expect((await appeals()).get(35)).toMatchObject({ status: 'Pending', resolvedAt: null });
      expect(refundedPrefixes()).not.toContain('appeal-12-5');
    });

    it('refunds and tells each one once', async () => {
      expect(await voidOrphanedAppeals()).toMatchObject({ closedUnreviewed: 2 });
      vi.clearAllMocks();

      const second = await voidOrphanedAppeals();

      expect(second).toMatchObject({ closedUnreviewed: 0 });
      expect(holder.refundMulti).not.toHaveBeenCalled();
      expect(holder.notify).not.toHaveBeenCalled();
    });
  });

  describe('an appeal on an image dismissed from the CSAM review queue', () => {
    // 41 is past the deadline from its filing, 42 a day short; 43's image is flagged but not
    // dismissed; 44 and 45 match the owner check.
    beforeEach(async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor") VALUES
          (1041, 12, 'csam', 'moderated'), (1042, 12, 'csam', 'moderated'),
          (1043, 12, 'csam', 'moderated'), (1044, 21, 'csam', 'moderated'),
          (1045, 15, 'csam', 'moderated');
        INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES
          (1041, 'Dismissed'), (1042, 'Dismissed'), (1044, 'Dismissed'), (1045, 'Dismissed');
        INSERT INTO "EvidenceHold" ("userId", "releaseAt") VALUES (15, now() - interval '1 day');
      `);
      await holder.db.query(
        `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
           "buzzTransactionId") VALUES
           (41, 12, 'Image', 1041, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-12-41'),
           (42, 12, 'Image', 1042, 'Pending', now() - make_interval(days => $1 - 1), now(), 'appeal-12-42'),
           (43, 12, 'Image', 1043, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-12-43'),
           (44, 21, 'Image', 1044, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-21-44'),
           (45, 15, 'Image', 1045, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-15-45')`,
        [ROUTED_APPEAL_REVIEW_DAYS]
      );
    });
    const withheldRows = async () =>
      (
        await holder.db.query<{ entityId: number; userId: number | null }>(
          `SELECT "entityId", "userId" FROM "ModActivity" WHERE activity = 'deferredNoticeWithheld' ORDER BY 1`
        )
      ).rows;
    const flagOf = async (imageId: number) =>
      (
        await holder.db.query<{ needsReview: string | null }>(
          `SELECT "needsReview" FROM "Image" WHERE id = $1`,
          [imageId]
        )
      ).rows[0].needsReview;

    it('is closed, refunded and told as an unreviewed one, counted from its filing', async () => {
      const result = await voidOrphanedAppeals();

      expect(await seenBy(41, 'appeal-12-41')).toEqual({
        status: 'Void',
        resolvedReason: 'removed-before-review',
        resolved: true,
        routed: false,
        notices: [
          {
            key: 'entity-appeal-content-removed:#:closed-unreviewed',
            outcome: 'closed-unreviewed',
            refunded: true,
          },
        ],
        refunded: true,
      });
      expect(result).toMatchObject({ closedDismissedReview: 3, closedUnreviewed: 0 });
    });

    it('is not one the routed-appeal close can see, since nothing stamps its removal', async () => {
      await holder.db.exec(`DELETE FROM "CsamQueueSetAside"`);

      const result = await voidOrphanedAppeals();

      expect(result).toMatchObject({ closedUnreviewed: 0, closedDismissedReview: 0 });
      expect((await appeals()).get(41)).toMatchObject({ status: 'Pending' });
    });

    it('leaves the image and its flag as they are', async () => {
      await voidOrphanedAppeals();

      expect(await flagOf(1041)).toBe('csam');
    });

    it('leaves one a day short, and one not dismissed, Pending', async () => {
      await voidOrphanedAppeals();
      const rows = await appeals();

      expect(rows.get(42)).toMatchObject({ status: 'Pending', resolvedAt: null });
      expect(rows.get(43)).toMatchObject({ status: 'Pending', resolvedAt: null });
      expect(refundedPrefixes()).not.toContain('appeal-12-42');
      expect(refundedPrefixes()).not.toContain('appeal-12-43');
    });

    it('refunds and tells nothing on a second run', async () => {
      await voidOrphanedAppeals();
      vi.clearAllMocks();

      expect(await voidOrphanedAppeals()).toMatchObject({ closedDismissedReview: 0 });
      expect(holder.refundMulti).not.toHaveBeenCalled();
      expect(holder.notify).not.toHaveBeenCalled();
    });

    it('closes and refunds without a notice when the owner check matches', async () => {
      await voidOrphanedAppeals();

      for (const [id, fee] of [
        [44, 'appeal-21-44'],
        [45, 'appeal-15-45'],
      ] as const)
        expect(await seenBy(id, fee)).toMatchObject({
          status: 'Void',
          notices: [],
          refunded: true,
        });
      expect(await withheldRows()).toEqual([
        { entityId: 1044, userId: null },
        { entityId: 1045, userId: null },
      ]);
    });

    it('refunds every one it closed when writing a log row fails', async () => {
      await holder.db.exec(`ALTER TABLE "ModActivity" RENAME TO "ModActivity_gone"`);
      try {
        await voidOrphanedAppeals();
      } finally {
        await holder.db.exec(`ALTER TABLE "ModActivity_gone" RENAME TO "ModActivity"`);
      }

      expect(refundedPrefixes()).toEqual(
        expect.arrayContaining(['appeal-12-41', 'appeal-21-44', 'appeal-15-45'])
      );
    });

    it('refunds every one it closed when a notice fails', async () => {
      holder.notify.mockImplementation((async (n: { key: string }) => {
        if (n.key.includes(':41:')) throw new Error('notifications down');
      }) as never);
      await voidOrphanedAppeals().catch(() => undefined);

      expect(refundedPrefixes()).toEqual(
        expect.arrayContaining(['appeal-12-41', 'appeal-21-44', 'appeal-15-45'])
      );
    });

    describe('whose appellant was removed since the dismissal', () => {
      // 46's image was removed for CSAM; 47's owner has another image removed for CSAM; 48's owner
      // has a CSAM-reason user report; 49's owner is deleted.
      beforeEach(async () => {
        await holder.db.exec(`
          INSERT INTO "User" (id, "deletedAt") VALUES (19, now()) ON CONFLICT (id) DO UPDATE SET "deletedAt" = now();
          INSERT INTO "Image" (id, "userId", "needsReview", "blockedFor") VALUES
            (1046, 16, 'csam', 'CSAM'), (1047, 17, 'csam', 'moderated'), (2047, 17, NULL, 'CSAM'),
            (1048, 18, 'csam', 'moderated'), (1049, 19, 'csam', 'moderated');
          INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES
            (1046, 'Dismissed'), (1047, 'Dismissed'), (1048, 'Dismissed'), (1049, 'Dismissed');
          INSERT INTO "Report" (id, reason) VALUES (9048, 'CSAM');
          INSERT INTO "UserReport" ("userId", "reportId") VALUES (18, 9048);
        `);
        await holder.db.query(
          `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, "createdAt", "updatedAt",
             "buzzTransactionId") VALUES
             (46, 16, 'Image', 1046, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-16-46'),
             (47, 17, 'Image', 1047, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-17-47'),
             (48, 18, 'Image', 1048, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-18-48'),
             (49, 19, 'Image', 1049, 'Pending', now() - make_interval(days => $1, mins => 1), now(), 'appeal-19-49')`,
          [ROUTED_APPEAL_REVIEW_DAYS]
        );
      });

      it('closes the appeal with no refund and no notice', async () => {
        await voidOrphanedAppeals();

        for (const [id, fee] of [
          [46, 'appeal-16-46'],
          [47, 'appeal-17-47'],
          [48, 'appeal-18-48'],
        ] as const)
          expect(await seenBy(id, fee)).toMatchObject({
            status: 'Void',
            notices: [],
            refunded: false,
          });
        expect((await withheldRows()).map((r) => r.entityId)).not.toContain(1046);
        expect(await seenBy(41, 'appeal-12-41')).toMatchObject({ refunded: true });
      });

      it('refunds a deleted appellant without a notice', async () => {
        await voidOrphanedAppeals();

        expect(await seenBy(49, 'appeal-19-49')).toMatchObject({
          status: 'Void',
          notices: [],
          refunded: true,
        });
      });
    });

    it('holds every notice when the check itself fails', async () => {
      await holder.db.exec(`ALTER TABLE "EvidenceHold" RENAME TO "EvidenceHold_gone"`);
      try {
        await voidOrphanedAppeals();
      } finally {
        await holder.db.exec(`ALTER TABLE "EvidenceHold_gone" RENAME TO "EvidenceHold"`);
      }

      expect((await seenBy(41, 'appeal-12-41')).notices).toEqual([]);
      expect((await withheldRows()).map((r) => r.entityId)).toEqual([1041, 1044, 1045]);
    });
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
    // The flow excludes user 21 (fixture); they are refunded and told like user 40.
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
      ['entity-appeal-content-removed:106:closed-owner-deleted', true],
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

describe('getAppealExcludedIds against Postgres', () => {
  // The fixture flags 21 (filed on), 23 (reported for the right reason), 24 (an image blocked for it)
  // and 30 (held), and the images 1009 (object entry) and 1010 (bare). 22, 25 and 1011 are controls.
  it('flags exactly the owners and images each leg covers', async () => {
    const { images, users } = await getAppealExcludedIds({
      imageIds: [1009, 1010, 1011],
      userIds: [21, 22, 23, 24, 25, 30],
    });

    expect([...images].sort()).toEqual([1009, 1010]);
    expect([...users].sort()).toEqual([21, 23, 24, 30]);
  });
});

describe('isAppealBlockedByHoldMarker against Postgres', () => {
  it('blocks an owner under a hold marker and an image a hold kept, and nothing else', async () => {
    await holder.db.exec(`
      INSERT INTO "EvidenceHeldUser" ("userId") VALUES (61);
      INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (9001, 62);
    `);
    try {
      expect(await isAppealBlockedByHoldMarker({ imageId: 9000, userId: 61 })).toBe(true);
      expect(await isAppealBlockedByHoldMarker({ imageId: 9001, userId: 63 })).toBe(true);
      // The control: neither the owner nor the image.
      expect(await isAppealBlockedByHoldMarker({ imageId: 9000, userId: 63 })).toBe(false);
    } finally {
      await holder.db.exec(`TRUNCATE "EvidenceHeldUser", "EvidenceHoldImage"`);
    }
  });

  it('blocks when the check cannot be read', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([] as never);

    expect(await isAppealBlockedByHoldMarker({ imageId: 9000, userId: 63 })).toBe(true);
  });
});

// The appeal endpoint and the owner's image page refuse on `isImageAppealRefused`; the removed-images
// list on the same report lookup. 1009 is named in a report, 1003 is not.
describe('an image a CSAM report names, against Postgres', () => {
  it('is refused by the shared check, and not offered on the owner’s page', async () => {
    await holder.db.exec(`
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "needsReview" text;
      INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (1009, 71, 'moderated');
      UPDATE "Image" SET "userId" = 71, "blockedFor" = 'moderated' WHERE id = 1003;
    `);

    expect(await isImageAppealRefused({ imageId: 1009, userId: 71 })).toBe(true);
    expect(await canAppealOwnImage({ imageId: 1009, userId: 71 })).toBe(false);
    // The control: the same owner's moderator-blocked image no report names.
    expect(await isImageAppealRefused({ imageId: 1003, userId: 71 })).toBe(false);
    expect(await canAppealOwnImage({ imageId: 1003, userId: 71 })).toBe(true);
  });

  // 21 is filed on and 23 reported for the reason; neither is held. 71 is the control owner.
  it('refuses an ordinary moderator block of an owner the appeal flow excludes', async () => {
    await holder.db.exec(`
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "needsReview" text;
      INSERT INTO "Image" (id, "userId", "blockedFor") VALUES
        (7001, 21, 'moderated'), (7002, 23, 'moderated'), (7003, 71, 'moderated');
    `);

    for (const [imageId, userId] of [
      [7001, 21],
      [7002, 23],
    ]) {
      expect(await isImageAppealRefused({ imageId, userId })).toBe(true);
      expect(await canAppealOwnImage({ imageId, userId })).toBe(false);
    }
    expect(await isImageAppealRefused({ imageId: 7003, userId: 71 })).toBe(false);
    expect(await canAppealOwnImage({ imageId: 7003, userId: 71 })).toBe(true);
  });
});

// A decided appeal shows the same prompt (which then says the decision stands) whether or not the
// image is one the endpoint would otherwise refuse.
describe('an image whose appeal was rejected, against Postgres', () => {
  it('shows the owner the same prompt whether or not a CSAM report names it', async () => {
    await holder.db.exec(`
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "needsReview" text;
      INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (1009, 71, 'moderated');
      UPDATE "Image" SET "userId" = 71, "blockedFor" = 'moderated' WHERE id = 1003;
    `);
    dbMock.dbRead.appeal.findFirst.mockResolvedValue({
      id: 1,
      status: 'Rejected',
      resolvedAt: new Date(),
    } as never);
    try {
      expect(await canAppealOwnImage({ imageId: 1009, userId: 71 })).toBe(
        await canAppealOwnImage({ imageId: 1003, userId: 71 })
      );
      expect(await canAppealOwnImage({ imageId: 1003, userId: 71 })).toBe(true);
    } finally {
      dbMock.dbRead.appeal.findFirst.mockReset();
    }
  });
});
