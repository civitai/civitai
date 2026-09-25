import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * An appeal whose entity has been deleted can never be reviewed: the moderator queue is driven
 * from the entity row, so nothing ever resolves it. It stayed Pending forever, kept the user's fee,
 * and counted toward their free-appeal allowance. The sweep closes each one as Void and refunds.
 */

const { mockRefundMultiAccountTransaction, mockRefundTransaction, mockCreateNotification } =
  vi.hoisted(() => ({
    mockRefundMultiAccountTransaction: vi.fn(),
    mockRefundTransaction: vi.fn(),
    mockCreateNotification: vi.fn(),
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

import { voidOrphanedAppeals } from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const claimed = [
  {
    id: 1,
    userId: 10,
    entityType: EntityType.Image,
    entityId: 100,
    buzzTransactionId: 'appeal-10-1700000000000',
  },
  { id: 2, userId: 20, entityType: EntityType.Image, entityId: 200, buzzTransactionId: null },
  {
    id: 3,
    userId: 30,
    entityType: EntityType.Model,
    entityId: 300,
    buzzTransactionId: 'legacy-txn-id',
  },
];

function claimSql() {
  const strings = dbMock.dbWrite.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
  return strings?.join('?') ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue(claimed);
  mockRefundMultiAccountTransaction.mockResolvedValue(undefined);
  mockRefundTransaction.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
});

describe('voidOrphanedAppeals', () => {
  it('claims only still-Pending appeals, as Void, in a single statement', async () => {
    await voidOrphanedAppeals();

    // One UPDATE … RETURNING is what makes a re-run unable to refund the same appeal twice: a row
    // is only handed back to the refund loop by the statement that moved it out of Pending.
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = claimSql();
    expect(sql).toMatch(/UPDATE "Appeal"/);
    expect(sql).toMatch(/'Void'::"AppealStatus"/);
    // Once to pick candidates, and again on the UPDATE itself: a moderator resolving the appeal
    // between the two must win, or the user gets a verdict and then a Void on top of it.
    expect(sql.match(/status = 'Pending'::"AppealStatus"/g)).toHaveLength(2);
    expect(sql).toMatch(/RETURNING/);
  });

  it('only treats an appeal as orphaned when its entity row is gone', async () => {
    await voidOrphanedAppeals();

    const sql = claimSql();
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "Image"/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "Model"/);
  });

  it('refunds each fee through the path that matches how it was charged', async () => {
    await voidOrphanedAppeals();

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'appeal-10-1700000000000' })
    );
    expect(mockRefundTransaction).toHaveBeenCalledTimes(1);
    expect(mockRefundTransaction.mock.calls[0]?.[0]).toBe('legacy-txn-id');
  });

  it('keeps going and records the appeal when a refund fails', async () => {
    mockRefundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    const result = await voidOrphanedAppeals();

    // The appeal is already Void, so the sweep will never pick it up again: the log line is the
    // only record that this user is still owed their fee.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ appealId: 1, buzzTransactionId: 'appeal-10-1700000000000' })
    );
    expect(mockRefundTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ voided: 3, refunded: 1, refundFailed: 1 });
  });

  it('tells each user their appeal was closed, and whether they got their fee back', async () => {
    await voidOrphanedAppeals();

    const details = mockCreateNotification.mock.calls.map((c) => c[0].details);
    expect(details).toEqual([
      expect.objectContaining({ entityId: 100, status: AppealStatus.Void, refunded: true }),
      expect.objectContaining({ entityId: 200, status: AppealStatus.Void, refunded: false }),
      expect.objectContaining({ entityId: 300, status: AppealStatus.Void, refunded: true }),
    ]);
    expect(mockCreateNotification.mock.calls.map((c) => c[0].userId)).toEqual([10, 20, 30]);
  });

  it('does nothing when there are no orphans', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    const result = await voidOrphanedAppeals();

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ voided: 0 });
  });
});
