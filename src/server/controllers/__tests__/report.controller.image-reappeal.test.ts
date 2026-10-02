import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A second appeal on an image, end to end through the fee: the real handler, the real
 * service, and an Appeal table that enforces the same unique indexes as the database.
 *
 * Before this was fixed, an image that was approved on appeal and later blocked again could
 * never be appealed: the fee was charged, the insert hit the (entityType, entityId, userId)
 * unique index, and the fee was refunded in the same second.
 */

const { mockCharge, mockRefund } = vi.hoisted(() => ({
  mockCharge: vi.fn(),
  mockRefund: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction: mockCharge,
  refundMultiAccountTransaction: mockRefund,
}));

import { createEntityAppealHandler } from '../report.controller';
import { APPEAL_ALREADY_PENDING } from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const OWNER = 602767;
const IMAGE_ID = 99;
const KEY = ['entityType', 'entityId', 'userId'] as const;

type AppealRow = {
  id: number;
  entityType: EntityType;
  entityId: number;
  userId: number;
  status: AppealStatus;
  buzzTransactionId: string | null;
};

let appeals: AppealRow[];

// Read from the generated client rather than restated, so the fake enforces whatever unique
// index schema.full.prisma declares. The Pending-only index exists only in the migration SQL,
// because Prisma cannot express a partial index, so that one is restated here.
const declaredUniques = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Appeal')!
  .uniqueFields as (keyof AppealRow)[][];

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`entityType`,`entityId`,`userId`)',
    { code: 'P2002', clientVersion: Prisma.prismaVersion.client }
  );
}

function seed(...statuses: AppealStatus[]) {
  appeals = statuses.map((status, i) => ({
    id: i + 1,
    entityType: EntityType.Image,
    entityId: IMAGE_ID,
    userId: OWNER,
    status,
    buzzTransactionId: null,
  }));
}

const appeal = () =>
  createEntityAppealHandler({
    input: { entityId: IMAGE_ID, entityType: EntityType.Image, message: 'Blocked again.' },
    ctx: { user: { id: OWNER }, features: { isGreen: false } } as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  seed();

  dbMock.dbRead.image.findUnique.mockResolvedValue({ id: IMAGE_ID, userId: OWNER });
  // Past the free allowance, so every appeal here carries the fee.
  dbMock.dbRead.appeal.count.mockResolvedValue(3);
  dbMock.dbRead.appeal.findFirst.mockImplementation(
    async ({ where }: { where: Partial<AppealRow> }) =>
      appeals.filter((a) => KEY.every((k) => a[k] === where[k])).sort((a, b) => b.id - a.id)[0] ??
      null
  );
  dbMock.dbWrite.appeal.create.mockImplementation(
    async ({ data }: { data: Omit<AppealRow, 'id' | 'status'> }) => {
      const row: AppealRow = { id: appeals.length + 1, status: AppealStatus.Pending, ...data };
      const clashes = (fields: (keyof AppealRow)[], others: AppealRow[]) =>
        others.some((a) => fields.every((f) => a[f] === row[f]));
      if (declaredUniques.some((fields) => clashes(fields, appeals))) throw uniqueViolation();
      const pending = appeals.filter((a) => a.status === AppealStatus.Pending);
      if (clashes([...KEY], pending)) throw uniqueViolation();
      appeals.push(row);
      return row;
    }
  );

  mockCharge.mockResolvedValue({ transactionCount: 1 });
  mockRefund.mockResolvedValue(undefined);
});

describe('a second appeal on the same image', () => {
  it('charges once and records a new appeal when an approved image has been blocked again', async () => {
    seed(AppealStatus.Approved);

    await expect(appeal()).resolves.toMatchObject({ status: AppealStatus.Pending });

    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(appeals.map((a) => a.status)).toEqual([AppealStatus.Approved, AppealStatus.Pending]);
    expect(appeals[1].buzzTransactionId).toMatch(/^appeal-602767-/);
  });

  // Justin's decision (2026-10-02): one appeal per block. A rejection upheld the block that is
  // still in place, so asking again is refused, and refused before the fee is charged.
  it('refuses an appeal of a block that was already upheld on appeal, without charging', async () => {
    seed(AppealStatus.Rejected);

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This removal has already been reviewed on appeal and the decision stands',
    });

    expect(mockCharge).not.toHaveBeenCalled();
    expect(appeals).toHaveLength(1);
  });

  it('refuses while an appeal is still pending, without charging', async () => {
    seed(AppealStatus.Approved, AppealStatus.Pending);

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_PENDING,
    });

    expect(mockCharge).not.toHaveBeenCalled();
    expect(appeals).toHaveLength(2);
  });

  it('refunds the fee it charged when a concurrent submit took the pending slot first', async () => {
    seed(AppealStatus.Approved, AppealStatus.Pending);
    // The guard's read misses the other request's row; the index is what catches it.
    dbMock.dbRead.appeal.findFirst.mockResolvedValueOnce(null);

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_PENDING,
    });

    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund.mock.calls[0][0].externalTransactionIdPrefix).toBe(
      mockCharge.mock.calls[0][0].externalTransactionIdPrefix
    );
    expect(appeals).toHaveLength(2);
  });
});
