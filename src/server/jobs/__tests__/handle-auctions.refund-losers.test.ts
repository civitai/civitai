import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { refundTransaction, getTransactionByExternalId } = vi.hoisted(() => ({
  refundTransaction: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: unknown) => ({ name, cron, run: fn }),
  getJobDate: vi.fn(),
}));
// Heavy import surfaces this path never touches.
vi.mock('~/server/services/model.service', () => ({
  bustFeaturedModelsCache: vi.fn(),
  getTopWeeklyEarners: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { updateSync: vi.fn() } }));
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/auction.service', () => ({
  isAuctionTransactionPrefix: () => false,
}));
vi.mock('~/server/services/buzz.service', () => ({
  refundTransaction,
  getTransactionByExternalId,
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
}));

import { _refundLosersForAuction } from '~/server/jobs/handle-auctions';

type AuctionRow = Parameters<typeof _refundLosersForAuction>[0];
type Losers = Parameters<typeof _refundLosersForAuction>[1];

const TX = 'tx-lost-bid';
const auctionRow = {
  id: 5,
  bids: [
    {
      id: 77,
      auctionId: 5,
      entityId: 11,
      deleted: false,
      isRefunded: false,
      transactionIds: [TX],
    },
  ],
} as unknown as AuctionRow;
const losers = [{ entityId: 11, position: 2, userIds: [1], auctionId: 5 }] as unknown as Losers;

// What the app's mapError throws: the status survives only as `cause`.
const conflict = () =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') });

const markedRefunded = () =>
  dbMock.dbWrite.bid.updateMany.mock.calls.flatMap(
    ([args]) => (args as { where: { id: { in: number[] } } }).where.id.in
  );

beforeEach(() => {
  vi.clearAllMocks();
  refundTransaction.mockReset();
  getTransactionByExternalId.mockReset().mockResolvedValue(null);
});

describe('_refundLosersForAuction — a lost bid refunded on an earlier run', () => {
  it('marks the bid refunded when the repeat refund answers 200 (Buzz today)', async () => {
    refundTransaction.mockResolvedValue({ transactionId: TX });

    await _refundLosersForAuction(auctionRow, losers);

    expect(markedRefunded()).toEqual([77]);
  });

  it('marks the bid refunded when the repeat refund answers 409 and the refund is on the ledger', async () => {
    refundTransaction.mockRejectedValue(conflict());
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id === `refund-${TX}` ? { externalTransactionId: id } : null
    );

    await _refundLosersForAuction(auctionRow, losers);

    expect(getTransactionByExternalId).toHaveBeenCalledWith(`refund-${TX}`);
    expect(markedRefunded()).toEqual([77]);
  });

  it('leaves the bid unrefunded when a 409 has no refund on the ledger behind it', async () => {
    refundTransaction.mockRejectedValue(conflict());

    await _refundLosersForAuction(auctionRow, losers);

    expect(markedRefunded()).toEqual([]);
  });
});
