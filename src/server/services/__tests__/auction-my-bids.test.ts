import { vi, describe, it, expect, beforeEach } from 'vitest';

// `getMyBids` computes per-entity totals, ranking and the winning threshold in SQL and
// returns one row per bid the user placed. These tests pin the JS half of that split —
// the threshold/`additionalPriceNeeded` arithmetic that used to run over every bid of
// every auction the user had ever touched.
const { queryRaw, auctionFindMany, modelVersionFindMany, imagesFetch } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  auctionFindMany: vi.fn(),
  modelVersionFindMany: vi.fn(async () => [] as unknown[]),
  imagesFetch: vi.fn(async () => ({} as Record<number, unknown>)),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: queryRaw,
    auction: { findMany: auctionFindMany },
    modelVersion: { findMany: modelVersionFindMany },
  },
  dbWrite: {},
}));

// image.service's real import graph (-> event-engine-common) is heavy; only the cache the
// entity hydration reads is needed here.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: imagesFetch },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: vi.fn(), topicSend: vi.fn() } }));

import { getMyBids } from '~/server/services/auction.service';

const NOW = new Date('2026-07-20T12:00:00Z');

// An auction that is currently running, and one that closed yesterday.
const activeAuction = {
  id: 1,
  startAt: new Date('2026-07-20T00:00:00Z'),
  endAt: new Date('2026-07-21T00:00:00Z'),
  validFrom: new Date('2026-07-21T00:00:00Z'),
  validTo: new Date('2026-07-22T00:00:00Z'),
  quantity: 2,
  minPrice: 100,
  auctionBase: { id: 10, type: 'Model', ecosystem: 'sd1', name: 'SD1', slug: 'sd1' },
};
const closedAuction = {
  ...activeAuction,
  id: 2,
  startAt: new Date('2026-07-19T00:00:00Z'),
  endAt: new Date('2026-07-20T00:00:00Z'),
  auctionBase: { ...activeAuction.auctionBase, id: 20, slug: 'sdxl' },
};

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 100,
  entityId: 5,
  amount: 150,
  createdAt: new Date('2026-07-20T09:00:00Z'),
  fromRecurring: false,
  isRefunded: false,
  accountType: 'yellow',
  auctionId: 1,
  position: 1,
  totalAmount: 150,
  winners: 1,
  lowestWinning: 150,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  auctionFindMany.mockImplementation(async () => [activeAuction, closedAuction]);
});

describe('getMyBids', () => {
  it('returns [] and skips the auction lookup when the user has no bids in range', async () => {
    queryRaw.mockResolvedValue([]);

    expect(await getMyBids({ userId: 1 })).toEqual([]);
    expect(auctionFindMany).not.toHaveBeenCalled();
  });

  it('needs nothing more when the bid is already at or above the minimum', async () => {
    queryRaw.mockResolvedValue([row({ totalAmount: 150 })]);

    const [bid] = await getMyBids({ userId: 1 });
    expect(bid.aboveThreshold).toBe(true);
    expect(bid.additionalPriceNeeded).toBe(0);
    expect(bid.position).toBe(1);
    expect(bid.totalAmount).toBe(150);
  });

  it('asks for the auction minimum when the winning slots are not yet full', async () => {
    // quantity 2, only 1 winner so far -> the bar is still minPrice, not the lowest winner.
    queryRaw.mockResolvedValue([
      row({ totalAmount: 40, position: 2, winners: 1, lowestWinning: 150 }),
    ]);

    const [bid] = await getMyBids({ userId: 1 });
    expect(bid.aboveThreshold).toBe(false);
    expect(bid.additionalPriceNeeded).toBe(60); // 100 (minPrice) - 40
  });

  it('asks for one over the lowest winner once every slot is taken', async () => {
    queryRaw.mockResolvedValue([
      row({ totalAmount: 40, position: 3, winners: 2, lowestWinning: 120 }),
    ]);

    const [bid] = await getMyBids({ userId: 1 });
    expect(bid.additionalPriceNeeded).toBe(81); // (120 + 1) - 40
  });

  it('marks bids on a closed auction inactive', async () => {
    queryRaw.mockResolvedValue([row({ auctionId: 2 })]);

    const [bid] = await getMyBids({ userId: 1 });
    expect(bid.isActive).toBe(false);
    expect(bid.auction.id).toBe(2);
  });

  it('zeroes out a bid whose entity has no surviving aggregate', async () => {
    queryRaw.mockResolvedValue([row({ position: null, totalAmount: null, lowestWinning: null })]);

    const [bid] = await getMyBids({ userId: 1 });
    expect(bid).toMatchObject({
      position: 0,
      totalAmount: 0,
      aboveThreshold: false,
      additionalPriceNeeded: 0,
      isActive: false,
    });
  });

  it('sorts newest first, breaking ties on the larger total', async () => {
    queryRaw.mockResolvedValue([
      row({ id: 1, entityId: 5, createdAt: new Date('2026-07-20T08:00:00Z'), totalAmount: 150 }),
      row({ id: 2, entityId: 6, createdAt: new Date('2026-07-20T10:00:00Z'), totalAmount: 110 }),
      row({ id: 3, entityId: 7, createdAt: new Date('2026-07-20T10:00:00Z'), totalAmount: 900 }),
    ]);

    const bids = await getMyBids({ userId: 1 });
    expect(bids.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  // `metadata` on the entity image and on the creator's profile picture, plus the image
  // tag list, were the three largest fields in the auction payload and nothing on the
  // cards reads any of them.
  describe('entity hydration payload', () => {
    beforeEach(() => {
      modelVersionFindMany.mockResolvedValue([
        {
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
            meta: { cannotPromote: true },
            user: {
              id: 7,
              username: 'creator',
              profilePicture: { id: 1, url: 'abc', metadata: { size: 1048496 } },
            },
          },
        },
      ]);
      imagesFetch.mockResolvedValue({
        5: { images: [{ id: 9, url: 'img', hash: 'h', metadata: { size: 44449628 } }] },
      });
    });

    it('drops the image and profile-picture metadata blobs', async () => {
      queryRaw.mockResolvedValue([row({ entityId: 5 })]);

      const [bid] = await getMyBids({ userId: 1 });
      expect(bid.entityData?.image?.metadata).toBeNull();
      expect(bid.entityData?.model.user.profilePicture?.metadata).toBeNull();
      expect(bid.entityData?.image?.url).toBe('img'); // the fields the card renders survive
      expect(bid.entityData?.model.cannotPromote).toBe(true);
    });

    it('reads the image cache directly, skipping the tag round-trip', async () => {
      queryRaw.mockResolvedValue([row({ entityId: 5 })]);

      const [bid] = await getMyBids({ userId: 1 });
      expect(bid.entityData?.image).not.toHaveProperty('tags');
      expect(imagesFetch).toHaveBeenCalledWith([5]);
    });
  });

  it('never selects an auction’s bid list', async () => {
    queryRaw.mockResolvedValue([row()]);

    const [bid] = await getMyBids({ userId: 1 });
    expect(bid.auction).not.toHaveProperty('bids');
    expect(auctionFindMany.mock.calls[0][0].select).not.toHaveProperty('bids');
  });
});
