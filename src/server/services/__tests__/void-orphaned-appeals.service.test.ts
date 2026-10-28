import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as NotificationService from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { isSafeToRetry } from '@civitai/buzz';

/**
 * An appeal whose entity has been deleted can never be reviewed from the entity queue. The sweep
 * sorts each one: deleted by its owner -> closed, refunded and told; removed any other way -> kept
 * open for review and told; defensive closes are silent.
 */

const { mockRefundMultiAccountTransaction, mockRefundTransaction, mockCreateNotification, ch } =
  vi.hoisted(() => ({
    mockRefundMultiAccountTransaction: vi.fn(),
    mockRefundTransaction: vi.fn(),
    mockCreateNotification: vi.fn(),
    ch: { client: undefined as { $query: ReturnType<typeof vi.fn> } | undefined },
  }));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
  refundTransaction: mockRefundTransaction,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  get clickhouse() {
    return ch.client;
  },
}));

import {
  closeAppealsDeletedByOwner,
  getAppealCount,
  resolveEntityAppeal,
  voidOrphanedAppeals,
} from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const appealedAt = new Date('2026-09-01T00:00:00.500Z');
const appealedAtSec = Math.floor(appealedAt.getTime() / 1000);
const afterAppeal = appealedAtSec + 3600;

type Orphan = {
  id: number;
  userId: number;
  entityType: EntityType;
  entityId: number;
  buzzTransactionId: string | null;
  createdAt: Date;
  userDeleted: boolean;
};

const orphan = (o: Partial<Orphan> & Pick<Orphan, 'id' | 'userId' | 'entityId'>): Orphan => ({
  entityType: EntityType.Image,
  buzzTransactionId: null,
  createdAt: appealedAt,
  userDeleted: false,
  ...o,
});

// 1: owner deleted it after appealing, paid a fee. 2: moderation removal, paid a fee.
// 3: model removed, legacy fee id. 4: defensive close (image), paid a fee. 5: account deleted.
const ownerDeleted = orphan({
  id: 1,
  userId: 10,
  entityId: 100,
  buzzTransactionId: 'appeal-10-1700000000000',
});
const removed = orphan({
  id: 2,
  userId: 20,
  entityId: 200,
  buzzTransactionId: 'appeal-20-1700000000000',
});
const removedModel = orphan({
  id: 3,
  userId: 30,
  entityType: EntityType.Model,
  entityId: 300,
  buzzTransactionId: 'legacy-txn-id',
});
const defensive = orphan({
  id: 4,
  userId: 40,
  entityId: 400,
  buzzTransactionId: 'appeal-40-1700000000000',
});
const deletedUser = orphan({ id: 5, userId: 50, entityId: 500, userDeleted: true });

let orphans: Orphan[];
let defensiveImageIds: number[];
let defensiveUserIds: number[];
// ClickHouse hands 64-bit columns back as strings.
let imageDeletes: { entityId: string; userId: string; t: string }[];
let modelDeletes: { entityId: string; userId: string; t: string }[];
// Ids a concurrent moderator resolved after the pick: no claim statement returns them.
let resolvedMeanwhile: number[];

const ev = (entityId: number, userId: number, t: number) => ({
  entityId: String(entityId),
  userId: String(userId),
  t: String(t),
});

const rawCalls = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.map((c) => ({
    sql: (c[0] as TemplateStringsArray).join('?'),
    values: c.slice(1),
  }));
const pick = () => rawCalls().find(({ sql }) => /FROM "Appeal" a/.test(sql))!;
const updates = () => rawCalls().filter(({ sql }) => /UPDATE "Appeal"/.test(sql));
const voidUpdates = () => updates().filter(({ sql }) => /'Void'::"AppealStatus"/.test(sql));
const removedUpdate = () => updates().find(({ sql }) => /"entityRemovedAt" = now\(\)/.test(sql));
const idsIn = (values: unknown[]) => values.find((v) => Array.isArray(v)) as number[] | undefined;
const closeContaining = (id: number) =>
  voidUpdates().find(({ values }) => idsIn(values)?.includes(id));

function claim(values: unknown[]) {
  const ids = idsIn(values) ?? [];
  return orphans
    .filter((o) => ids.includes(o.id) && !resolvedMeanwhile.includes(o.id))
    .map(({ id, userId, entityType, entityId, buzzTransactionId }) => ({
      id,
      userId,
      entityType,
      entityId,
      buzzTransactionId,
    }));
}

beforeEach(() => {
  vi.clearAllMocks();
  orphans = [ownerDeleted, removed, removedModel, defensive, deletedUser];
  defensiveImageIds = [400];
  defensiveUserIds = [];
  resolvedMeanwhile = [];
  imageDeletes = [
    ev(100, 10, afterAppeal),
    // A moderator's removal of image 200 is not its owner's.
    ev(200, 999, afterAppeal),
  ];
  modelDeletes = [];

  dbMock.dbWrite.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (/FROM "Appeal" a/.test(sql)) return Promise.resolve(orphans);
    if (/jsonb_array_elements/.test(sql))
      return Promise.resolve(
        (idsIn(values) ?? []).filter((id) => defensiveImageIds.includes(id)).map((id) => ({ id }))
      );
    if (/"UserReport"/.test(sql))
      return Promise.resolve(
        (idsIn(values) ?? []).filter((id) => defensiveUserIds.includes(id)).map((id) => ({ id }))
      );
    if (/UPDATE "Appeal"/.test(sql)) return Promise.resolve(claim(values));
    return Promise.resolve([]);
  }) as never);

  ch.client = {
    $query: vi.fn((strings: TemplateStringsArray | string) => {
      const sql = typeof strings === 'string' ? strings : strings.join('?');
      if (/FROM images/.test(sql)) return Promise.resolve(imageDeletes);
      if (/FROM modelEvents/.test(sql)) return Promise.resolve(modelDeletes);
      return Promise.resolve([]);
    }),
  };

  mockRefundMultiAccountTransaction.mockResolvedValue(undefined);
  mockRefundTransaction.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
});

const notified = (userId: number) =>
  mockCreateNotification.mock.calls.map((c) => c[0]).filter((n) => n.userId === userId);
const refundedPrefixes = () =>
  mockRefundMultiAccountTransaction.mock.calls.map((c) => c[0].externalTransactionIdPrefix);

describe('voidOrphanedAppeals', () => {
  it('picks candidates only among Pending appeals not already routed for review', async () => {
    await voidOrphanedAppeals({ limit: 7 });

    const { sql, values } = pick();
    expect(sql).toMatch(/a\.status = 'Pending'::"AppealStatus"/);
    expect(sql).toMatch(/a\."entityRemovedAt" IS NULL/);
    expect(sql).toMatch(
      /a\."entityType" = 'Image' AND NOT EXISTS \(SELECT 1 FROM "Image" i WHERE i\.id = a\."entityId"\)/
    );
    // A soft-deleted model row is as gone as a hard-deleted one.
    expect(sql).toMatch(
      /a\."entityType" = 'Model' AND NOT EXISTS \(SELECT 1 FROM "Model" m WHERE m\.id = a\."entityId" AND m\."deletedAt" IS NULL\)/
    );
    // The owner rule needs the filing time, and the quiet rule the account state.
    expect(sql).toMatch(/a\."createdAt"/);
    expect(sql).toMatch(/\(u\."deletedAt" IS NOT NULL\) AS "userDeleted"/);
    expect(sql).toMatch(/LIMIT \?/);
    expect(values).toEqual([7]);
  });

  it('claims every group by id and only while still Pending and unstamped', async () => {
    await voidOrphanedAppeals();

    expect(updates()).toHaveLength(3);
    for (const { sql, values } of updates()) {
      expect(sql).toMatch(/WHERE id = ANY\(\?\)/);
      expect(sql).toMatch(/status = 'Pending'::"AppealStatus" AND "entityRemovedAt" IS NULL/);
      expect(sql).toMatch(/RETURNING/);
      expect(idsIn(values)?.length).toBeGreaterThan(0);
    }
  });

  it('keeps a moderation-removed appeal Pending, stamps it, and tells the user it will be reviewed', async () => {
    const result = await voidOrphanedAppeals();

    const stamp = removedUpdate();
    expect(stamp).toBeDefined();
    expect(stamp!.sql).not.toMatch(/'Void'/);
    expect(idsIn(stamp!.values)).toEqual([removed.id]);

    // Never voided, and the fee stays held for the moderator's decision.
    for (const { values } of voidUpdates()) expect(idsIn(values)).not.toContain(removed.id);
    expect(refundedPrefixes()).not.toContain(removed.buzzTransactionId);
    expect(mockRefundTransaction).not.toHaveBeenCalledWith(
      removed.buzzTransactionId,
      expect.anything()
    );

    expect(notified(removed.userId)).toEqual([
      expect.objectContaining({
        type: 'entity-appeal-content-removed',
        key: `entity-appeal-content-removed:${removed.id}:under-review`,
        details: {
          entityType: EntityType.Image,
          entityId: removed.entityId,
          outcome: 'under-review',
          refunded: false,
        },
      }),
    ]);
    expect(result).toMatchObject({ routedForReview: 1 });
  });

  it('closes a deleted model appeal quietly instead of routing it, whoever deleted the model', async () => {
    // Model appeals are flag disputes: no ClickHouse owner event, so nobody owner-deleted it.
    const byModerator = orphan({
      id: 7,
      userId: 70,
      entityType: EntityType.Model,
      entityId: 700,
      buzzTransactionId: 'appeal-70-1700000000000',
      modelDeletedByAppellant: false,
    });
    orphans = [byModerator, removedModel, removed];

    const result = await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.values)).toEqual([removed.id]);
    const quiet = closeContaining(byModerator.id);
    expect(idsIn(quiet!.values)?.sort()).toEqual([removedModel.id, byModerator.id]);
    expect(quiet!.values).toContain(null);
    expect(refundedPrefixes()).toContain(byModerator.buzzTransactionId);
    expect(notified(byModerator.userId)).toEqual([]);
    expect(notified(removedModel.userId)).toEqual([]);
    expect(result).toMatchObject({ closedQuietly: 2, closedOwnerDeleted: 0, routedForReview: 1 });
  });

  it('closes an owner-deleted appeal as Void with a reason, refunds it, and tells the user', async () => {
    const result = await voidOrphanedAppeals();

    const ownerClose = closeContaining(ownerDeleted.id);
    expect(idsIn(ownerClose!.values)).toEqual([ownerDeleted.id]);
    expect(ownerClose!.values).toContain('deleted-by-owner');

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: ownerDeleted.buzzTransactionId }),
      { shouldRetry: isSafeToRetry }
    );
    expect(notified(ownerDeleted.userId)).toEqual([
      expect.objectContaining({
        type: 'entity-appeal-content-removed',
        key: `entity-appeal-content-removed:${ownerDeleted.id}:closed-owner-deleted`,
        details: {
          entityType: EntityType.Image,
          entityId: ownerDeleted.entityId,
          outcome: 'closed-owner-deleted',
          refunded: true,
        },
      }),
    ]);
    expect(result).toMatchObject({ closedOwnerDeleted: 1 });
  });

  it('closes an owner-deleted appeal with no fee without calling Buzz', async () => {
    orphans = [{ ...ownerDeleted, buzzTransactionId: null }];

    const result = await voidOrphanedAppeals();

    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(notified(ownerDeleted.userId)[0]?.details).toMatchObject({ refunded: false });
    expect(result).toMatchObject({ closedOwnerDeleted: 1, refunded: 0, refundFailed: 0 });
  });

  it("only counts a delete as the owner's when the appellant made it at or after filing", async () => {
    imageDeletes = [ev(100, 10, appealedAtSec - 1)];
    await voidOrphanedAppeals();
    expect(idsIn(removedUpdate()!.values)).toContain(ownerDeleted.id);

    vi.clearAllMocks();
    imageDeletes = [ev(100, 10, appealedAtSec)];
    await voidOrphanedAppeals();
    expect(closeContaining(ownerDeleted.id)?.values).toContain('deleted-by-owner');
  });

  it('asks ClickHouse only for delete events of the candidate entities', async () => {
    modelDeletes = [ev(300, 30, afterAppeal)];

    await voidOrphanedAppeals();

    const queries = ch.client!.$query.mock.calls.map((c) => ({
      sql: (c[0] as TemplateStringsArray).join('?'),
      values: c.slice(1),
    }));
    const images = queries.find(({ sql }) => /FROM images/.test(sql))!;
    expect(images.sql).toMatch(/type = 'Delete' AND imageId IN \(\?\)/);
    expect(images.values).toEqual([[ownerDeleted.entityId, removed.entityId]]);
    const models = queries.find(({ sql }) => /FROM modelEvents/.test(sql))!;
    expect(models.sql).toMatch(/type IN \('Delete', 'PermanentDelete'\) AND modelId IN \(\?\)/);
    expect(models.values).toEqual([[removedModel.entityId]]);

    expect(closeContaining(removedModel.id)?.values).toContain('deleted-by-owner');
    expect(mockRefundTransaction.mock.calls[0]?.[0]).toBe('legacy-txn-id');
  });

  it('does not match a delete event to an appeal on another entity type with the same id', async () => {
    // Image 100 was deleted by user 10; their appeal on model 100 must not read that as theirs.
    const modelSameId = orphan({ id: 6, userId: 10, entityType: EntityType.Model, entityId: 100 });
    orphans = [modelSameId, removed];

    await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.values)).toEqual([removed.id]);
    expect(idsIn(closeContaining(modelSameId.id)!.values)).toEqual([modelSameId.id]);
  });

  it('closes the defensive-close group quietly, refunding but not notifying', async () => {
    const result = await voidOrphanedAppeals();

    const quiet = closeContaining(defensive.id);
    expect(idsIn(quiet!.values)?.sort()).toEqual([removedModel.id, defensive.id, deletedUser.id]);
    expect(quiet!.values).toContain(null);
    expect(refundedPrefixes()).toContain(defensive.buzzTransactionId);
    expect(notified(defensive.userId)).toEqual([]);
    expect(notified(deletedUser.userId)).toEqual([]);
    expect(result).toMatchObject({ closedQuietly: 3, refunded: 3, refundFailed: 0 });
  });

  it('looks up only image appeals by image id', async () => {
    // A model sharing the reported image's id is not that image.
    const modelSameId = orphan({ id: 6, userId: 60, entityType: EntityType.Model, entityId: 400 });
    orphans = [defensive, modelSameId];

    await voidOrphanedAppeals();

    const imageQuery = rawCalls().find(({ sql }) => /jsonb_array_elements/.test(sql))!;
    expect(idsIn(imageQuery.values)).toEqual([defensive.entityId]);
    expect(removedUpdate()).toBeUndefined();
    expect(closeContaining(modelSameId.id)?.values).toContain(null);
  });

  it('closes quietly when the appellant is the one reported', async () => {
    defensiveImageIds = [];
    defensiveUserIds = [removed.userId];

    await voidOrphanedAppeals();

    const userQuery = rawCalls().find(({ sql }) => /"UserReport"/.test(sql))!;
    expect(userQuery.sql).toMatch(/cr\."userId" = c\.id/);
    expect(userQuery.sql).toMatch(/ur\."userId" = c\.id/);
    expect(closeContaining(removed.id)?.values).toContain(null);
    expect(notified(removed.userId)).toEqual([]);
  });

  it('routes everything not quietly closed for review when ClickHouse is unavailable', async () => {
    ch.client = undefined;

    await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.values)?.sort()).toEqual([ownerDeleted.id, removed.id]);
    expect(closeContaining(removedModel.id)?.values).toContain(null);
    expect(notified(ownerDeleted.userId)[0]?.details.outcome).toBe('under-review');
  });

  it('routes for review when the ClickHouse lookup throws', async () => {
    ch.client!.$query.mockRejectedValue(new Error('ch down'));

    await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.values)).toContain(ownerDeleted.id);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'void-orphaned-appeals', error: 'ch down' })
    );
  });

  it('refunds and notifies only rows its own statement claimed', async () => {
    // A moderator resolved these after the pick: no claim statement hands them back.
    resolvedMeanwhile = [ownerDeleted.id, removed.id, defensive.id];

    const result = await voidOrphanedAppeals();

    expect(refundedPrefixes()).toEqual([]);
    expect(notified(ownerDeleted.userId)).toEqual([]);
    expect(notified(removed.userId)).toEqual([]);
    expect(notified(removedModel.userId)).toEqual([]);
    expect(result).toMatchObject({ closedOwnerDeleted: 0, closedQuietly: 2, routedForReview: 0 });
  });

  it('keeps going and records the appeal when a refund fails', async () => {
    mockRefundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    const result = await voidOrphanedAppeals();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ appealId: ownerDeleted.id })
    );
    expect(notified(ownerDeleted.userId)[0]?.details).toMatchObject({ refunded: false });
    expect(result).toMatchObject({ refundFailed: 2 });
  });

  it('does nothing when there are no orphans', async () => {
    orphans = [];

    const result = await voidOrphanedAppeals();

    expect(updates()).toEqual([]);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(result).toMatchObject({ closedOwnerDeleted: 0, routedForReview: 0 });
  });
});

describe('getAppealCount', () => {
  it('does not count an appeal waiting on review after its content was removed', async () => {
    const startDate = new Date('2026-09-01T00:00:00Z');
    await getAppealCount({
      userId: 1,
      status: [AppealStatus.Pending, AppealStatus.Rejected],
      startDate,
    });

    expect(dbMock.dbRead.appeal.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 1,
        status: { in: [AppealStatus.Pending, AppealStatus.Rejected] },
        createdAt: { gte: startDate },
        category: null,
        NOT: { status: AppealStatus.Pending, entityRemovedAt: { not: null } },
      }),
    });
  });

  it('does not count a request to unlock a locked setting', async () => {
    await getAppealCount({ userId: 1, status: [AppealStatus.Rejected] });

    expect(dbMock.dbRead.appeal.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: [
          {
            OR: [
              { context: { equals: Prisma.AnyNull } },
              { NOT: { context: { path: ['kind'], equals: 'lock-review' } } },
            ],
          },
        ],
      }),
    });
  });
});

describe('resolveEntityAppeal', () => {
  // Removed-content appeals are decided on the moderator app's page; a resolve by entity id must not claim one.
  it('does not claim an appeal whose content was removed', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([]);

    await resolveEntityAppeal({
      ids: [1],
      entityType: EntityType.Image,
      status: AppealStatus.Approved,
      userId: 9,
    } as Parameters<typeof resolveEntityAppeal>[0]);

    expect(dbMock.dbWrite.appeal.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityId: { in: [1] },
          status: AppealStatus.Pending,
          entityType: EntityType.Image,
          entityRemovedAt: null,
          category: null,
        },
      })
    );
  });
});

describe('closeAppealsDeletedByOwner', () => {
  it('claims only the owner’s Pending appeals on the deleted entities, by id, in one statement', async () => {
    orphans = [ownerDeleted];
    // This claim selects by entity, not appeal id, so the shared fake's id match does not apply.
    const realFake = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      /UPDATE "Appeal"/.test(strings.join('?'))
        ? Promise.resolve(claim([[ownerDeleted.id]]))
        : realFake(strings, ...values)) as never);

    await closeAppealsDeletedByOwner({
      entityType: EntityType.Image,
      entityIds: [100, 101],
      ownerId: 10,
    });

    const [close] = voidUpdates();
    expect(voidUpdates()).toHaveLength(1);
    expect(close.sql).toMatch(/"entityType" = \?::"EntityType"/);
    expect(close.sql).toMatch(/"entityId" = ANY\(\?\)/);
    expect(close.sql).toMatch(/"userId" = \?/);
    expect(close.sql).toMatch(/status = 'Pending'::"AppealStatus"/);
    expect(close.values).toEqual(
      expect.arrayContaining(['deleted-by-owner', EntityType.Image, [100, 101], 10])
    );
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: ownerDeleted.buzzTransactionId }),
      { shouldRetry: isSafeToRetry }
    );
    expect(notified(ownerDeleted.userId)).toEqual([
      expect.objectContaining({
        key: `entity-appeal-content-removed:${ownerDeleted.id}:closed-owner-deleted`,
        details: expect.objectContaining({ outcome: 'closed-owner-deleted', refunded: true }),
      }),
    ]);
  });

  it('does nothing for no ids', async () => {
    await closeAppealsDeletedByOwner({ entityType: EntityType.Image, entityIds: [], ownerId: 10 });

    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('never throws, and records the failure', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('db down'));

    await expect(
      closeAppealsDeletedByOwner({ entityType: EntityType.Image, entityIds: [100], ownerId: 10 })
    ).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'close-appeals-deleted-by-owner', error: 'db down' })
    );
  });
});

describe('closeAppealsDeletedByOwner when the defensive-close lookup fails', () => {
  // The claim has committed: the refund must not depend on a later query, or the appeal is Void,
  // unrefunded, and never swept again.
  it('still refunds every claimed appeal, notifies no one, and logs the appeal ids', async () => {
    const realFake = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = strings.join('?');
      if (/UPDATE "Appeal"/.test(sql)) return Promise.resolve(claim([[ownerDeleted.id]]));
      if (/"CsamReport"/.test(sql)) return Promise.reject(new Error('lookup down'));
      return realFake(strings, ...values);
    }) as never);

    await closeAppealsDeletedByOwner({
      entityType: EntityType.Image,
      entityIds: [100],
      ownerId: 10,
    });

    expect(refundedPrefixes()).toEqual([ownerDeleted.buzzTransactionId]);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'close-appeals-deleted-by-owner',
        appealIds: [ownerDeleted.id],
      })
    );
  });
});
