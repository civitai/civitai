import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  refundTransaction,
  getTransactionByExternalId,
  refundMultiAccountTransaction,
  getMultiAccountTransactionsByPrefix,
} = vi.hoisted(() => ({
  refundTransaction: vi.fn(),
  getTransactionByExternalId: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
}));

// image.service's real import graph is heavy; only the cache the entity hydration reads is needed.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn(), topicSend: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/buzz.service', () => ({
  refundTransaction,
  getTransactionByExternalId,
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction,
  getMultiAccountTransactionsByPrefix,
}));

import { deleteBid } from '~/server/services/auction.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const TX = 'tx-bid';
const day = 24 * 60 * 60 * 1000;

// What the app's mapError throws: the status survives only as `cause`.
const conflict = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') });

const markedDeleted = () =>
  dbMock.dbWrite.bid.update.mock.calls.some(
    ([args]) => (args as { data: { deleted?: boolean } }).data.deleted === true
  );

beforeEach(() => {
  vi.clearAllMocks();
  refundTransaction.mockReset();
  refundMultiAccountTransaction.mockReset();
  getMultiAccountTransactionsByPrefix.mockReset().mockResolvedValue([]);
  getTransactionByExternalId.mockReset().mockResolvedValue(null);
  dbMock.dbWrite.bid.findFirst.mockResolvedValue({
    userId: 1,
    transactionIds: [TX],
    auction: {
      id: 5,
      startAt: new Date(Date.now() - day),
      endAt: new Date(Date.now() + day),
      auctionBase: { slug: 'sd1' },
    },
  } as never);
  dbMock.dbWrite.bid.update.mockResolvedValue({} as never);
  dbMock.dbWrite.auction.findFirst.mockResolvedValue({
    id: 5,
    quantity: 1,
    bids: [],
    auctionBase: { slug: 'sd1' },
  } as never);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
});

describe('deleteBid — a bid whose refund already went through', () => {
  it('deletes the bid when the repeat refund answers 200 (Buzz today)', async () => {
    refundTransaction.mockResolvedValue({ transactionId: TX });

    await deleteBid({ userId: 1, bidId: 77 });

    expect(markedDeleted()).toBe(true);
  });

  it('deletes the bid when the repeat refund answers 409 and the refund is on the ledger', async () => {
    refundTransaction.mockRejectedValue(conflict());
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id === `refund-${TX}` ? { externalTransactionId: id } : null
    );

    await deleteBid({ userId: 1, bidId: 77 });

    expect(getTransactionByExternalId).toHaveBeenCalledWith(`refund-${TX}`);
    expect(markedDeleted()).toBe(true);
  });

  it('keeps the bid and throws when a 409 has no refund on the ledger behind it', async () => {
    refundTransaction.mockRejectedValue(conflict());

    await expect(deleteBid({ userId: 1, bidId: 77 })).rejects.toThrow('conflict');

    expect(markedDeleted()).toBe(false);
  });
});

describe('deleteBid — a bid paid across accounts (auction prefix)', () => {
  const PREFIX = 'auction-5-1-77';
  const legs = ['leg-a', 'leg-b'].map((transactionId) => ({
    transactionId,
    externalTransactionId: `${PREFIX}-${transactionId}`,
    accountType: 'yellow',
    accountId: 1,
    amount: 50,
  }));

  beforeEach(() => {
    dbMock.dbWrite.bid.findFirst.mockResolvedValue({
      userId: 1,
      transactionIds: [PREFIX],
      auction: {
        id: 5,
        startAt: new Date(Date.now() - day),
        endAt: new Date(Date.now() + day),
        auctionBase: { slug: 'sd1' },
      },
    } as never);
  });

  it('deletes the bid when a retry finds every leg already refunded', async () => {
    refundMultiAccountTransaction.mockRejectedValue(conflict());
    getMultiAccountTransactionsByPrefix.mockResolvedValue(legs);
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id.startsWith('refund-') ? { externalTransactionId: id } : null
    );

    await deleteBid({ userId: 1, bidId: 77 });

    expect(refundTransaction).not.toHaveBeenCalled();
    expect(markedDeleted()).toBe(true);
  });

  it('refunds the bid’s own prefix and deletes the bid', async () => {
    refundMultiAccountTransaction.mockResolvedValue({
      refundedTransactions: [{ amount: 50 }, { amount: 50 }],
    });

    await deleteBid({ userId: 1, bidId: 77 });

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: PREFIX })
    );
    expect(markedDeleted()).toBe(true);
  });

  it('keeps the bid and throws when the refund answers with no transactions', async () => {
    refundMultiAccountTransaction.mockResolvedValue({ refundedTransactions: [] });

    await expect(deleteBid({ userId: 1, bidId: 77 })).rejects.toThrow(/No transactions/);

    expect(markedDeleted()).toBe(false);
  });

  it('refunds no leg again when a second delete finds the first one refunded it', async () => {
    refundMultiAccountTransaction
      .mockResolvedValueOnce({ refundedTransactions: [{ amount: 50 }, { amount: 50 }] })
      .mockRejectedValueOnce(conflict());
    getMultiAccountTransactionsByPrefix.mockResolvedValue(legs);
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id.startsWith('refund-') ? { externalTransactionId: id } : null
    );

    await Promise.all([deleteBid({ userId: 1, bidId: 77 }), deleteBid({ userId: 1, bidId: 77 })]);

    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  it('keeps a bid whose second charge fails to refund, and a retry refunds only that one', async () => {
    dbMock.dbWrite.bid.findFirst.mockResolvedValue({
      userId: 1,
      transactionIds: [PREFIX, TX],
      auction: {
        id: 5,
        startAt: new Date(Date.now() - day),
        endAt: new Date(Date.now() + day),
        auctionBase: { slug: 'sd1' },
      },
    } as never);
    refundMultiAccountTransaction
      .mockResolvedValueOnce({ refundedTransactions: [{ amount: 50 }, { amount: 50 }] })
      .mockRejectedValue(conflict());
    getMultiAccountTransactionsByPrefix.mockResolvedValue(legs);
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id.startsWith('refund-leg-') ? { externalTransactionId: id } : null
    );
    refundTransaction.mockRejectedValue(new BuzzApiError(500, 'Internal Server Error'));

    await expect(deleteBid({ userId: 1, bidId: 77 })).rejects.toThrow(/500/);
    expect(markedDeleted()).toBe(false);

    refundTransaction.mockReset().mockResolvedValue({ transactionId: TX });
    await deleteBid({ userId: 1, bidId: 77 });

    expect(markedDeleted()).toBe(true);
    // The prefix refund went through once; the retry found its legs refunded and paid none again.
    expect(refundTransaction.mock.calls.map(([id]) => id)).toEqual([TX]);
  });

  it('keeps the bid and throws when the prefix lists no transactions', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(404, 'Not Found'));

    await expect(deleteBid({ userId: 1, bidId: 77 })).rejects.toThrow(/No transactions/);

    expect(markedDeleted()).toBe(false);
  });
});
