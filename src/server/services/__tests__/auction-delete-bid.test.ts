import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refundTransaction, getTransactionByExternalId } = vi.hoisted(() => ({
  refundTransaction: vi.fn(),
  getTransactionByExternalId: vi.fn(),
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
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
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
