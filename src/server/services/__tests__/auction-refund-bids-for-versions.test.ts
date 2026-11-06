import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  refundTransaction,
  refundMultiAccountTransaction,
  getTransactionByExternalId,
  getMultiAccountTransactionsByPrefix,
} = vi.hoisted(() => ({
  refundTransaction: vi.fn(async (_id: string, _d?: string) => ({ transactionId: 'x' })),
  refundMultiAccountTransaction: vi.fn(async (_input: unknown) => ({
    refundedTransactions: [{ amount: 10 }] as { amount: number }[],
  })),
  getTransactionByExternalId: vi.fn(async (_id: string) => null as unknown),
  getMultiAccountTransactionsByPrefix: vi.fn(
    async (_prefix: string) => [] as { transactionId: string; amount?: number }[]
  ),
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
  getTransactionByExternalId,
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix,
}));

import { deleteBidsForModel, refundBidsForVersions } from '~/server/services/auction.service';
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
    expect(refundTransaction.mock.calls[0].slice(0, 2)).toEqual([PLAIN, expect.any(String)]);
    expect(bidsDeleted).toEqual([1, 2]);
    expect(bids.find((b) => b.id === 3)?.deleted).toBe(false);
  });

  it('refunds nothing a second time when run again', async () => {
    await run();
    await run();
    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(refundTransaction).toHaveBeenCalledTimes(1);
  });

  // A content wipe refunds a model it keeps by version; deleting that model later goes through
  // deleteBidsForModel, which must find nothing left to refund.
  it('refunds nothing when a model whose bids a wipe refunded is deleted later', async () => {
    await run();
    dbMock.dbWrite.model.findFirst.mockResolvedValue({
      name: 'zzfixture',
      modelVersions: [{ id: VERSION }],
    } as never);

    const later = await deleteBidsForModel({ modelId: 7 });

    expect(later.bidsDeleted).toEqual([]);
    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(refundTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns a refund that still failed, its bid already cancelled', async () => {
    refundTransaction.mockRejectedValue(new Error('buzz down'));
    const { refundFailed, bidsDeleted } = await run();
    refundTransaction.mockReset().mockResolvedValue({ transactionId: 'x' });
    expect(refundFailed).toEqual([PLAIN]);
    expect(bidsDeleted).toEqual([1, 2]);
  });

  it('counts a plain refund already on the ledger as done', async () => {
    // Every attempt answers 409, so only reading the ledger can make it count as done.
    refundTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id === `refund-${PLAIN}` ? { externalTransactionId: id } : null
    );
    const { refundFailed } = await run();
    const ledgerReads = getTransactionByExternalId.mock.calls.map(([id]) => id);
    refundTransaction.mockReset().mockResolvedValue({ transactionId: 'x' });
    getTransactionByExternalId.mockReset().mockResolvedValue(null);
    expect(refundFailed).toEqual([]);
    expect(ledgerReads).toContain(`refund-${PLAIN}`);
  });

  it('returns a 409 with no refund on the ledger behind it as failed', async () => {
    refundTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );
    const { refundFailed } = await run();
    refundTransaction.mockReset().mockResolvedValue({ transactionId: 'x' });
    expect(refundFailed).toEqual([PLAIN]);
  });

  it('counts a multi-account refund whose legs are all on the ledger as done', async () => {
    refundMultiAccountTransaction.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'conflict', cause: new BuzzApiError(409, 'x') })
    );
    getMultiAccountTransactionsByPrefix.mockResolvedValue([{ transactionId: 'leg-1', amount: 10 }]);
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id === 'refund-leg-1' ? { externalTransactionId: id } : null
    );
    const { refundFailed } = await run();
    refundMultiAccountTransaction
      .mockReset()
      .mockResolvedValue({ refundedTransactions: [{ amount: 10 }] });
    getMultiAccountTransactionsByPrefix.mockReset().mockResolvedValue([]);
    getTransactionByExternalId.mockReset().mockResolvedValue(null);
    expect(refundFailed).toEqual([]);
  });

  it('returns a multi-account refund that found no transactions as failed', async () => {
    refundMultiAccountTransaction.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'missing', cause: new BuzzApiError(404, 'x') })
    );
    const { refundFailed } = await run();
    refundMultiAccountTransaction.mockReset().mockResolvedValue({
      refundedTransactions: [{ amount: 10 }],
    });
    expect(refundFailed).toEqual([PREFIX]);
  });

  it('returns a multi-account refund that still failed', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));
    const { refundFailed } = await run();
    refundMultiAccountTransaction
      .mockReset()
      .mockResolvedValue({ refundedTransactions: [{ amount: 10 }] });
    expect(refundFailed).toEqual([PREFIX]);
  });

  it('works with no model row to read', async () => {
    await run();
    expect(dbMock.dbWrite.model.findFirst).not.toHaveBeenCalled();
  });
});
