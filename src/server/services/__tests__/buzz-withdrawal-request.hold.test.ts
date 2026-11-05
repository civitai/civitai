import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';

const mocks = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  getUserBuzzAccount: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransaction: mocks.createBuzzTransaction,
  getUserBuzzAccount: mocks.getUserBuzzAccount,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createBuzzWithdrawalRequest,
  updateBuzzWithdrawalRequest,
} from '~/server/services/buzz-withdrawal-request.service';
import {
  decidePayoutReview,
  openPayoutHold,
} from '~/server/services/creator-program-prepayout-review/hold';
import { installPayoutReviewTable } from '~/server/services/creator-program-prepayout-review/__tests__/payout-review-fake';
import {
  BuzzWithdrawalRequestStatus,
  UserPaymentConfigurationProvider,
} from '~/shared/utils/prisma/enums';

const userId = 77;
const request = () =>
  createBuzzWithdrawalRequest({
    userId,
    amount: 5000,
    provider: UserPaymentConfigurationProvider.Tipalti,
  });

describe('createBuzzWithdrawalRequest with a payout-review hold', () => {
  let table: ReturnType<typeof installPayoutReviewTable>;
  beforeEach(() => {
    vi.clearAllMocks();
    table = installPayoutReviewTable();
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ id: userId });
    dbMock.dbRead.userPaymentConfiguration.findFirst.mockResolvedValue({
      userId,
      tipaltiPaymentsEnabled: true,
      tipaltiAccountId: 'tipalti-77',
    });
    dbMock.dbWrite.buzzWithdrawalRequest.create.mockResolvedValue({ id: 'req-1' });
    mocks.getUserBuzzAccount.mockResolvedValue([{ balance: 100000 }]);
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
  });
  afterEach(() => table.uninstall());

  it('refuses while the hold is open and files the request once it is cleared', async () => {
    const hold = await openPayoutHold(
      { userId, ground: 'fraud', reason: 'test hold', askRef: 'card-1' },
      'user:1'
    );

    await expect(request()).rejects.toThrow('on hold');
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.buzzWithdrawalRequest.create).not.toHaveBeenCalled();

    await decidePayoutReview(
      { id: hold.id, userId, period: hold.period, action: 'clear', version: hold.version },
      'user:1'
    );

    await expect(request()).resolves.toEqual({ id: 'req-1' });
    expect(mocks.createBuzzTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('updateBuzzWithdrawalRequest with a payout-review hold', () => {
  let table: ReturnType<typeof installPayoutReviewTable>;
  beforeEach(() => {
    vi.clearAllMocks();
    table = installPayoutReviewTable();
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ id: userId });
    dbMock.dbRead.buzzWithdrawalRequest.findMany.mockResolvedValue([
      {
        id: 'req-0',
        userId,
        status: BuzzWithdrawalRequestStatus.Requested,
        requestedToProvider: UserPaymentConfigurationProvider.Tipalti,
        requestedBuzzAmount: 5000,
        platformFeeRate: 3000,
        buzzWithdrawalTransactionId: 'tx-0',
        metadata: {},
      },
    ]);
  });
  afterEach(() => table.uninstall());

  const approve = (by: number) =>
    updateBuzzWithdrawalRequest({
      requestIds: ['req-0'],
      status: BuzzWithdrawalRequestStatus.Approved,
      userId: by,
    });

  it('refuses a moderator approval of a request filed before the hold', async () => {
    await openPayoutHold({ userId, ground: 'investigation', reason: 'test hold' }, 'user:1');

    await expect(approve(1)).rejects.toThrow('active payout hold');
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  });
});
