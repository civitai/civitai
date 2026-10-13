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
 * open for review and told; flagged content or a deleted account -> closed quietly.
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

import { getAppealCount, voidOrphanedAppeals } from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const appealedAt = new Date('2026-09-01T00:00:00Z');
const afterAppeal = Math.floor(appealedAt.getTime() / 1000) + 3600;

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
// 3: model removed, legacy fee id. 4: image in a flagged-content report. 5: account deleted.
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
const flagged = orphan({ id: 4, userId: 40, entityId: 400 });
const deletedUser = orphan({ id: 5, userId: 50, entityId: 500, userDeleted: true });

let orphans: Orphan[];
let flaggedImageIds: number[];
let imageDeletes: { entityId: number; userId: number; t: number }[];
let modelDeletes: { entityId: number; userId: number; t: number }[];

const rawSql = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
const rawCalls = () => dbMock.dbWrite.$queryRaw.mock.calls.map((c) => ({ sql: rawSql(c), c }));
const updates = () => rawCalls().filter(({ sql }) => /UPDATE "Appeal"/.test(sql));
const voidUpdates = () => updates().filter(({ sql }) => /'Void'::"AppealStatus"/.test(sql));
const removedUpdate = () => updates().find(({ sql }) => /"entityRemovedAt" = now\(\)/.test(sql));
// Each claim statement receives its candidate ids as one array parameter.
const idsIn = (c: unknown[]) => c.slice(1).find((v) => Array.isArray(v)) as number[] | undefined;

function claimedRows(ids: number[] | undefined) {
  return orphans
    .filter((o) => ids?.includes(o.id))
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
  orphans = [ownerDeleted, removed, removedModel, flagged, deletedUser];
  flaggedImageIds = [400];
  imageDeletes = [
    { entityId: 100, userId: 10, t: afterAppeal },
    // A moderator's removal of image 200 is not its owner's.
    { entityId: 200, userId: 999, t: afterAppeal },
  ];
  modelDeletes = [];

  dbMock.dbWrite.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (/FROM "Appeal" a/.test(sql) && !/UPDATE/.test(sql)) return Promise.resolve(orphans);
    if (/"CsamReport"/.test(sql)) return Promise.resolve(flaggedImageIds.map((id) => ({ id })));
    if (/UPDATE "Appeal"/.test(sql))
      return Promise.resolve(claimedRows(idsIn([strings, ...values])));
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

describe('voidOrphanedAppeals', () => {
  it('picks candidates only among Pending appeals not already routed for review', async () => {
    await voidOrphanedAppeals();

    const select = rawCalls().find(({ sql }) => /FROM "Appeal" a/.test(sql) && !/UPDATE/.test(sql));
    expect(select?.sql).toMatch(/a\.status = 'Pending'::"AppealStatus"/);
    expect(select?.sql).toMatch(/a\."entityRemovedAt" IS NULL/);
    expect(select?.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "Image"/);
    expect(select?.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "Model"/);
  });

  it('keeps a moderation-removed appeal Pending, stamps it, and tells the user it will be reviewed', async () => {
    const result = await voidOrphanedAppeals();

    const stamp = removedUpdate();
    expect(stamp).toBeDefined();
    expect(stamp!.sql).not.toMatch(/'Void'/);
    expect(stamp!.sql).toMatch(/status = 'Pending'::"AppealStatus"/);
    expect(stamp!.sql).toMatch(/"entityRemovedAt" IS NULL/);
    expect(idsIn(stamp!.c)?.sort()).toEqual([removed.id, removedModel.id]);

    // Never voided, and the fee stays held for the moderator's decision.
    for (const { c } of voidUpdates()) expect(idsIn(c)).not.toContain(removed.id);
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: removed.buzzTransactionId }),
      expect.anything()
    );
    expect(mockRefundTransaction).not.toHaveBeenCalled();

    expect(notified(removed.userId)).toEqual([
      expect.objectContaining({
        type: 'entity-appeal-content-removed',
        key: `entity-appeal-content-removed:${removed.id}`,
        details: expect.objectContaining({ outcome: 'under-review', entityId: removed.entityId }),
      }),
    ]);
    expect(result).toMatchObject({ routedForReview: 2 });
  });

  it('closes an owner-deleted appeal as Void with a reason, refunds it, and tells the user', async () => {
    const result = await voidOrphanedAppeals();

    const ownerClose = voidUpdates().find(({ c }) => idsIn(c)?.includes(ownerDeleted.id));
    expect(ownerClose).toBeDefined();
    expect(idsIn(ownerClose!.c)).toEqual([ownerDeleted.id]);
    expect(ownerClose!.c.slice(1)).toContain('deleted-by-owner');
    // A moderator resolving it between the pick and this statement must win.
    expect(ownerClose!.sql).toMatch(/status = 'Pending'::"AppealStatus"/);

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: ownerDeleted.buzzTransactionId }),
      { shouldRetry: isSafeToRetry }
    );
    expect(notified(ownerDeleted.userId)).toEqual([
      expect.objectContaining({
        type: 'entity-appeal-content-removed',
        details: expect.objectContaining({ outcome: 'closed-owner-deleted', refunded: true }),
      }),
    ]);
    expect(result).toMatchObject({ closedOwnerDeleted: 1, refunded: 1 });
  });

  it("only counts a delete as the owner's when the appellant made it after appealing", async () => {
    imageDeletes = [{ entityId: 100, userId: 10, t: afterAppeal - 7200 }];

    await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.c)).toContain(ownerDeleted.id);
  });

  it('reads model deletes too', async () => {
    modelDeletes = [{ entityId: 300, userId: 30, t: afterAppeal }];

    await voidOrphanedAppeals();

    const ownerClose = voidUpdates().find(({ c }) => idsIn(c)?.includes(removedModel.id));
    expect(ownerClose?.c.slice(1)).toContain('deleted-by-owner');
    expect(mockRefundTransaction.mock.calls[0]?.[0]).toBe('legacy-txn-id');
  });

  it('closes flagged content and deleted accounts quietly, as before', async () => {
    await voidOrphanedAppeals();

    const quiet = voidUpdates().find(({ c }) => idsIn(c)?.includes(flagged.id));
    expect(idsIn(quiet!.c)?.sort()).toEqual([flagged.id, deletedUser.id]);
    expect(quiet!.c.slice(1)).not.toContain('deleted-by-owner');
    expect(notified(flagged.userId)).toEqual([]);
    expect(notified(deletedUser.userId)).toEqual([]);
  });

  it('routes everything not quietly closed for review when ClickHouse is unavailable', async () => {
    ch.client = undefined;

    await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.c)?.sort()).toEqual([
      ownerDeleted.id,
      removed.id,
      removedModel.id,
    ]);
    expect(notified(ownerDeleted.userId)[0]?.details.outcome).toBe('under-review');
  });

  it('routes for review when the ClickHouse lookup throws', async () => {
    ch.client!.$query.mockRejectedValue(new Error('ch down'));

    await voidOrphanedAppeals();

    expect(idsIn(removedUpdate()!.c)).toContain(ownerDeleted.id);
  });

  it('notifies only for rows its own statement claimed', async () => {
    // A moderator resolved appeal 2 first: the stamp statement does not hand it back.
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = strings.join('?');
      if (/FROM "Appeal" a/.test(sql) && !/UPDATE/.test(sql)) return Promise.resolve(orphans);
      if (/"CsamReport"/.test(sql)) return Promise.resolve([]);
      if (/UPDATE "Appeal"/.test(sql))
        return Promise.resolve(
          claimedRows(idsIn([strings, ...values])).filter((r) => r.id !== removed.id)
        );
      return Promise.resolve([]);
    }) as never);

    await voidOrphanedAppeals();

    expect(notified(removed.userId)).toEqual([]);
    expect(notified(removedModel.userId)).toHaveLength(1);
  });

  it('keeps going and records the appeal when a refund fails', async () => {
    mockRefundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    const result = await voidOrphanedAppeals();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ appealId: ownerDeleted.id })
    );
    expect(notified(ownerDeleted.userId)[0]?.details).toMatchObject({ refunded: false });
    expect(result).toMatchObject({ refundFailed: 1 });
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
    await getAppealCount({ userId: 1, status: [AppealStatus.Pending, AppealStatus.Rejected] });

    expect(dbMock.dbRead.appeal.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        NOT: { status: AppealStatus.Pending, entityRemovedAt: { not: null } },
      }),
    });
  });
});
