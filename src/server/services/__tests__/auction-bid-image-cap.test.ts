import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { imagesFetch, topicSend, refundTransaction } = vi.hoisted(() => ({
  imagesFetch: vi.fn(async (_ids: number[]) => ({} as Record<number, unknown>)),
  topicSend: vi.fn(async (_args: unknown) => undefined),
  refundTransaction: vi.fn(async (_id: string, _d?: string) => ({ transactionId: 'x' })),
}));
const buzz = vi.hoisted(() => ({
  getUserBuzzAccount: vi.fn(async () => [{ balance: 1000 }]),
  createMultiAccountBuzzTransaction: vi.fn(async () => ({
    transactionCount: 1,
    transactionIds: [{ transactionId: 'tx-new' }],
  })),
}));

// image.service's real import graph is heavy; only the cache the entity hydration reads is needed.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: imagesFetch },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: vi.fn(), topicSend } }));
vi.mock('~/server/services/buzz.service', () => ({
  refundTransaction,
  getTransactionByExternalId: vi.fn(async () => null),
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(async () => []),
  createBuzzTransaction: vi.fn(),
  ...buzz,
}));

const {
  bidImagesFor,
  capAuctionBidImages,
  createBid,
  deleteBid,
  publicSignalData,
  refundBidsForVersions,
} = await import('~/server/services/auction.service');

const OWNER = 5;
const auction = (...levels: number[]) => ({
  bids: levels.map((nsfwLevel, i) => ({
    id: i + 1,
    entityData: { model: { id: i + 1 }, image: { id: i + 1, nsfwLevel, userId: OWNER } },
  })),
});
const LEVELS = [
  NsfwLevel.PG,
  NsfwLevel.X,
  0,
  NsfwLevel.PG | NsfwLevel.XXX,
  NsfwLevel.PG | NsfwLevel.PG13,
];
const shown = (a: { bids: { entityData?: { image?: { id: number } } }[] }) =>
  a.bids.map((b) => b.entityData?.image?.id ?? null);

describe('auction bid images', () => {
  const forViewer = (ctx: object) =>
    shown(capAuctionBidImages(auction(...LEVELS) as never, bidImagesFor(ctx as never)));

  it('a capped viewer gets only bid images whose every rating bit is inside the cap', () => {
    expect(forViewer({ user: { id: 6 }, features: { canViewNsfw: false } })).toEqual([
      1,
      null,
      null,
      null,
      5,
    ]);
    expect(forViewer({ features: { canViewNsfw: true } })).toEqual([1, null, null, null, null]);
  });

  it.each([
    ['the owner', { user: { id: OWNER }, features: { canViewNsfw: false } }],
    ['a moderator', { user: { id: 7, isModerator: true }, features: { canViewNsfw: false } }],
    ['an uncapped viewer', { user: { id: 6 }, features: { canViewNsfw: true } }],
  ])('%s keeps every bid image', (_label, ctx) => {
    expect(forViewer(ctx)).toEqual([1, 2, 3, 4, 5]);
  });

  it('the bid stays when its image is dropped', () => {
    const [bid] = publicSignalData(auction(NsfwLevel.X) as never).bids;
    expect(bid).toMatchObject({ id: 1, entityData: { model: { id: 1 } } });
    expect(bid.entityData?.image).toBeUndefined();
  });

  // One payload goes to every subscriber of the auction's topic, capped or not.
  it('a bid-change signal carries only public images', () => {
    expect(shown(publicSignalData(auction(...LEVELS) as never))).toEqual([
      1,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('bid-change signals', () => {
  const AUCTION = 5;
  const day = 24 * 60 * 60 * 1000;
  // Version 10 shows a public image, 11 one above the public cap.
  const images: Record<number, { id: number; nsfwLevel: number }> = {
    10: { id: 100, nsfwLevel: NsfwLevel.PG },
    11: { id: 110, nsfwLevel: NsfwLevel.X },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.auction.findFirst.mockResolvedValue({
      id: AUCTION,
      quantity: 2,
      startAt: new Date(Date.now() - day),
      endAt: new Date(Date.now() + day),
      minPrice: 1,
      // Not a Model auction, so createBid skips the version checks it has its own tests for.
      auctionBase: { id: 3, slug: 'sd1', type: 'Image' },
      bids: [10, 11].map((entityId) => ({ entityId, amount: 5, deleted: false })),
    } as never);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue(
      [10, 11].map((id) => ({
        id,
        name: `v${id}`,
        model: { id, meta: null, user: { id: 1 } },
      })) as never
    );
    imagesFetch.mockResolvedValue(
      Object.fromEntries(
        Object.entries(images).map(([id, image]) => [
          id,
          { images: [{ ...image, userId: OWNER, metadata: {} }] },
        ])
      )
    );
  });

  const sentImages = () => {
    expect(topicSend).toHaveBeenCalledTimes(1);
    const [{ topic, data }] = topicSend.mock.calls[0] as [
      {
        topic: string;
        data: { bids: { entityId: number; entityData?: { image?: { id: number } } }[] };
      }
    ];
    expect(topic).toBe(`auction:${AUCTION}`);
    return Object.fromEntries(data.bids.map((b) => [b.entityId, b.entityData?.image?.id ?? null]));
  };

  it('placing a bid sends only public images to the topic', async () => {
    dbMock.dbWrite.bid.findMany.mockResolvedValue([]);
    dbMock.dbWrite.bid.create.mockResolvedValue({} as never);
    // createBid's own read sees only this bidder's bids on the entity: none yet.
    const auction = await dbMock.dbWrite.auction.findFirst({} as never);
    dbMock.dbWrite.auction.findFirst.mockResolvedValueOnce({ ...auction, bids: [] } as never);

    await createBid({
      userId: 1,
      auctionId: AUCTION,
      entityId: 10,
      amount: 5,
      accountTypes: ['yellow'],
    } as Parameters<typeof createBid>[0]);

    expect(sentImages()).toEqual({ 10: 100, 11: null });
  });

  it('deleting a bid sends only public images to the topic', async () => {
    dbMock.dbWrite.bid.findFirst.mockResolvedValue({
      userId: 1,
      transactionIds: ['tx-bid'],
      auction: {
        id: AUCTION,
        startAt: new Date(Date.now() - day),
        endAt: new Date(Date.now() + day),
        auctionBase: { slug: 'sd1' },
      },
    } as never);
    dbMock.dbWrite.bid.update.mockResolvedValue({} as never);

    await deleteBid({ userId: 1, bidId: 77 });

    expect(sentImages()).toEqual({ 10: 100, 11: null });
  });

  it('refunding bids for removed versions sends only public images to the topic', async () => {
    dbMock.dbWrite.auction.findMany.mockResolvedValue([
      { id: AUCTION, auctionBase: { slug: 'sd1' } },
    ] as never);
    dbMock.dbWrite.bidRecurring.findMany.mockResolvedValue([]);
    dbMock.dbWrite.bid.updateManyAndReturn.mockResolvedValue([
      { id: 1, userId: 2, transactionIds: ['tx-plain'] },
    ] as never);

    await refundBidsForVersions({ versionIds: [12], name: 'zzfixture', notificationKey: 7 });

    expect(sentImages()).toEqual({ 10: 100, 11: null });
  });
});
