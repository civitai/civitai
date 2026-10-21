import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refundTransaction, refundMultiAccountTransaction } = vi.hoisted(() => ({
  refundTransaction: vi.fn(async () => ({ transactionId: 'x' })),
  refundMultiAccountTransaction: vi.fn(async () => ({})),
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
  refundMultiAccountTransaction,
  getTransactionByExternalId: vi.fn(),
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
}));

import { refundBidsForVersions } from '~/server/services/auction.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const AUCTION = 5;
const VERSION = 70;
const OTHER_VERSION = 71;
const PREFIX = 'auction-5-70-1700000000';
const PLAIN = 'tx-plain';

type BidRow = {
  id: number;
  userId: number;
  auctionId: number;
  entityId: number;
  transactionIds: string[];
  deleted: boolean;
};
let bids: BidRow[] = [];

const run = () =>
  refundBidsForVersions({ versionIds: [VERSION], name: 'zzfixture', notificationKey: 7 });

beforeEach(() => {
  vi.clearAllMocks();
  bids = [
    {
      id: 1,
      userId: 1,
      auctionId: AUCTION,
      entityId: VERSION,
      transactionIds: [PREFIX],
      deleted: false,
    },
    {
      id: 2,
      userId: 2,
      auctionId: AUCTION,
      entityId: VERSION,
      transactionIds: [PLAIN],
      deleted: false,
    },
    {
      id: 3,
      userId: 3,
      auctionId: AUCTION,
      entityId: OTHER_VERSION,
      transactionIds: ['tx-other'],
      deleted: false,
    },
  ];
  const day = 24 * 60 * 60 * 1000;
  dbMock.dbWrite.auction.findMany.mockResolvedValue([
    { id: AUCTION, auctionBase: { slug: 'sd1' } },
  ] as never);
  dbMock.dbWrite.auction.findFirst.mockResolvedValue({
    id: AUCTION,
    quantity: 1,
    startAt: new Date(Date.now() - day),
    endAt: new Date(Date.now() + day),
    bids: [],
    auctionBase: { slug: 'sd1' },
  } as never);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.bidRecurring.findMany.mockResolvedValue([]);
  // Applies the where the way Postgres would, so a repeat run sees what the first one marked.
  dbMock.dbWrite.bid.updateManyAndReturn.mockImplementation((async (args: {
    where: {
      auctionId: { in: number[] };
      entityId: { in: number[] };
      deleted?: boolean;
    };
  }) => {
    const { where } = args;
    const hit = bids.filter(
      (b) =>
        where.auctionId.in.includes(b.auctionId) &&
        where.entityId.in.includes(b.entityId) &&
        (where.deleted === undefined || b.deleted === where.deleted)
    );
    for (const b of hit) b.deleted = true;
    return hit.map(({ id, userId, transactionIds }) => ({ id, userId, transactionIds }));
  }) as never);
});

describe('refundBidsForVersions', () => {
  it('refunds an auction-prefix bid once, through the multi-account refund only', async () => {
    await run();
    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: PREFIX })
    );
    expect(refundTransaction).not.toHaveBeenCalledWith(PREFIX, expect.anything());
  });

  it('refunds a plain bid once, and nothing on another version', async () => {
    const { bidsDeleted } = await run();
    expect(refundTransaction).toHaveBeenCalledTimes(1);
    expect(refundTransaction).toHaveBeenCalledWith(PLAIN, expect.any(String));
    expect(bidsDeleted).toEqual([1, 2]);
    expect(bids.find((b) => b.id === 3)?.deleted).toBe(false);
  });

  it('refunds nothing a second time when run again', async () => {
    await run();
    await run();
    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(refundTransaction).toHaveBeenCalledTimes(1);
  });

  it('works with no model row to read', async () => {
    await run();
    expect(dbMock.dbWrite.model.findFirst).not.toHaveBeenCalled();
  });
});
