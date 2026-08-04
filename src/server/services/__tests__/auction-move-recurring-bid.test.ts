import { vi, describe, it, expect, beforeEach } from 'vitest';

// `moveRecurringBidToLatest` re-targets an unfunded standing instruction (BidRecurring)
// at the newest eligible published version. These pin the eligibility walk — a copy of
// createBid's inline gates, deliberately not shared — and that the swap never touches
// today's charged Bid (delete+create only, no refunds).
const {
  bidRecurringFindFirst,
  bidRecurringFindMany,
  bidRecurringDelete,
  bidRecurringCreate,
  modelVersionFindFirst,
  modelVersionFindMany,
  transaction,
  imagesFetch,
} = vi.hoisted(() => ({
  bidRecurringFindFirst: vi.fn(),
  bidRecurringFindMany: vi.fn(),
  bidRecurringDelete: vi.fn(async () => ({})),
  bidRecurringCreate: vi.fn(async () => ({ id: 999 })),
  modelVersionFindFirst: vi.fn(),
  modelVersionFindMany: vi.fn(async () => [] as unknown[]),
  transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  imagesFetch: vi.fn(async () => ({} as Record<number, unknown>)),
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    $transaction: transaction,
    bidRecurring: {
      findFirst: bidRecurringFindFirst,
      findMany: bidRecurringFindMany,
      delete: bidRecurringDelete,
      create: bidRecurringCreate,
    },
    modelVersion: { findFirst: modelVersionFindFirst, findMany: modelVersionFindMany },
  },
  dbRead: {},
}));

// image.service's real import graph (-> event-engine-common) is heavy; only the cache the
// entity hydration reads is needed here.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: imagesFetch },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: vi.fn(), topicSend: vi.fn() } }));
// Pins the type/ecosystem gate to a known shape instead of the real basemodel constants.
vi.mock('~/components/Auction/auction.utils', () => ({
  getModelTypesForAuction: vi.fn(() => [{ type: 'Checkpoint', baseModels: ['SDXL 1.0'] }]),
  miscAuctionName: 'Misc',
}));

import { getMyRecurringBids, moveRecurringBidToLatest } from '~/server/services/auction.service';

const auctionBase = {
  id: 10,
  type: 'Model',
  ecosystem: 'sd1',
  name: 'SD1',
  slug: 'sd1',
  description: null,
};

const recurringBid = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 100,
  userId: 1,
  entityId: 5,
  amount: 200,
  startAt: new Date('2026-07-01T00:00:00Z'),
  endAt: new Date('2026-09-01T00:00:00Z'),
  isPaused: true,
  accountType: 'yellow',
  auctionBase,
  ...overrides,
});

// Ordered newest-first, as the service's `orderBy: { index: 'asc' }` would return them.
const version = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 5,
  name: 'v1',
  baseModel: 'SDXL 1.0',
  availability: 'Public',
  status: 'Published',
  model: {
    type: 'Checkpoint',
    meta: null,
    poi: false,
    minor: false,
    status: 'Published',
    nsfw: false,
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  modelVersionFindFirst.mockResolvedValue({ modelId: 50 });
});

describe('moveRecurringBidToLatest', () => {
  it('moves the bid to the newest eligible version, preserving its terms', async () => {
    const bid = recurringBid();
    bidRecurringFindFirst.mockResolvedValueOnce(bid).mockResolvedValueOnce(null);
    modelVersionFindMany.mockResolvedValue([version({ id: 9, name: 'v2' }), version()]);

    const res = await moveRecurringBidToLatest({ userId: 1, bidId: 100 });

    expect(res).toEqual({ id: 999, entityId: 9, name: 'v2' });
    expect(bidRecurringDelete).toHaveBeenCalledWith({ where: { id: 100 } });
    expect(bidRecurringCreate).toHaveBeenCalledWith({
      data: {
        userId: 1,
        entityId: 9,
        amount: 200,
        startAt: bid.startAt,
        endAt: bid.endAt,
        isPaused: true,
        auctionBaseId: 10,
        accountType: 'yellow',
      },
      select: { id: true },
    });
  });

  it('skips newer versions that fail the eligibility gates', async () => {
    bidRecurringFindFirst.mockResolvedValueOnce(recurringBid()).mockResolvedValueOnce(null);
    modelVersionFindMany.mockResolvedValue([
      version({ id: 9, status: 'Draft' }),
      version({ id: 8, availability: 'Private' }),
      version({ id: 7, baseModel: 'Other Base' }),
      version({ id: 6, name: 'eligible' }),
      version(),
    ]);

    const res = await moveRecurringBidToLatest({ userId: 1, bidId: 100 });
    expect(res.entityId).toBe(6);
  });

  it('errors without writing when the bid is already on the latest eligible version', async () => {
    bidRecurringFindFirst.mockResolvedValueOnce(recurringBid());
    modelVersionFindMany.mockResolvedValue([version(), version({ id: 4 })]);

    await expect(moveRecurringBidToLatest({ userId: 1, bidId: 100 })).rejects.toThrow(
      'already on the latest'
    );
    expect(bidRecurringDelete).not.toHaveBeenCalled();
    expect(bidRecurringCreate).not.toHaveBeenCalled();
  });

  it('blocks when the user already holds a recurring bid on the target version', async () => {
    bidRecurringFindFirst.mockResolvedValueOnce(recurringBid()).mockResolvedValueOnce({ id: 55 });
    modelVersionFindMany.mockResolvedValue([version({ id: 9, name: 'v2' }), version()]);

    await expect(moveRecurringBidToLatest({ userId: 1, bidId: 100 })).rejects.toThrow(
      'already have a recurring bid'
    );
    expect(bidRecurringDelete).not.toHaveBeenCalled();
    expect(bidRecurringCreate).not.toHaveBeenCalled();
  });

  it("rejects another user's bid", async () => {
    bidRecurringFindFirst.mockResolvedValueOnce(recurringBid({ userId: 2 }));

    await expect(moveRecurringBidToLatest({ userId: 1, bidId: 100 })).rejects.toThrow(
      'Bid not found'
    );
  });
});

describe('getMyRecurringBids moveToLatest hint', () => {
  const activeRow = {
    id: 100,
    entityId: 5,
    amount: 200,
    createdAt: new Date('2026-07-20T09:00:00Z'),
    endAt: null,
    isPaused: false,
    accountType: 'yellow',
    auctionBase,
  };
  const hydratedVersion = {
    id: 5,
    name: 'v1',
    baseModel: 'SDXL 1.0',
    nsfwLevel: 1,
    model: {
      id: 50,
      name: 'A model',
      type: 'Checkpoint',
      nsfw: false,
      poi: false,
      minor: false,
      meta: null,
      user: { id: 7, username: 'creator', profilePicture: null },
    },
  };
  const candidates = [
    { id: 9, name: 'v2', modelId: 50, baseModel: 'SDXL 1.0' },
    { id: 5, name: 'v1', modelId: 50, baseModel: 'SDXL 1.0' },
  ];

  // Call order: active bids -> entity hydration -> [candidate versions, all recurring rows].
  const arrange = ({
    candidateVersions = candidates,
    allRecurring = [{ auctionBaseId: 10, entityId: 5, accountType: 'yellow' }],
  }: {
    candidateVersions?: unknown[];
    allRecurring?: unknown[];
  }) => {
    bidRecurringFindMany.mockResolvedValueOnce([activeRow]).mockResolvedValueOnce(allRecurring);
    modelVersionFindMany
      .mockResolvedValueOnce([hydratedVersion])
      .mockResolvedValueOnce(candidateVersions);
  };

  it('offers the newest published version of the model', async () => {
    arrange({});

    const [bid] = await getMyRecurringBids({ userId: 1 });
    expect(bid.moveToLatest).toEqual({ status: 'available', targetId: 9, targetName: 'v2' });
  });

  it('reports the target as taken when another recurring bid already covers it', async () => {
    arrange({
      allRecurring: [
        { auctionBaseId: 10, entityId: 5, accountType: 'yellow' },
        { auctionBaseId: 10, entityId: 9, accountType: 'yellow' },
      ],
    });

    const [bid] = await getMyRecurringBids({ userId: 1 });
    expect(bid.moveToLatest).toEqual({ status: 'targetTaken', targetName: 'v2' });
  });

  it('offers nothing when the bid is already on the latest version', async () => {
    arrange({ candidateVersions: [candidates[1]] });

    const [bid] = await getMyRecurringBids({ userId: 1 });
    expect(bid.moveToLatest).toBeNull();
  });

  it('ignores newer versions outside the auction ecosystem', async () => {
    arrange({
      candidateVersions: [
        { id: 9, name: 'v2', modelId: 50, baseModel: 'Other Base' },
        candidates[1],
      ],
    });

    const [bid] = await getMyRecurringBids({ userId: 1 });
    expect(bid.moveToLatest).toBeNull();
  });
});
