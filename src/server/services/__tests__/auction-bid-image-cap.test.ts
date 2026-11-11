import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';

// image.service's real import graph is heavy; nothing here reads it.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn(), topicSend: vi.fn(async () => undefined) },
}));

const { bidImagesFor, capAuctionBidImages, capBidImages, publicSignalData } = await import(
  '~/server/services/auction.service'
);

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

  it('My Bids and My Recurring Bids lists are capped the same way', () => {
    const capped = capBidImages(
      auction(...LEVELS).bids as never,
      bidImagesFor({
        user: { id: 6 },
        features: { canViewNsfw: false },
      } as never)
    );
    expect(shown({ bids: capped })).toEqual([1, null, null, null, 5]);
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

  it('every bid read and every bid-change signal go through the cap', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
    const router = read('src/server/routers/auction.router.ts');
    const procedure = (name: string, next: string) =>
      router.slice(router.indexOf(`${name}:`), router.indexOf(`${next}:`));
    const bySlug = procedure('getBySlug', 'getMyBids');
    expect(bySlug).toContain('keepCrawlerAnswerOutOfEdgeCache(ctx)');
    expect(bySlug).toMatch(
      /capAuctionBidImages\(await getAuctionBySlug\(input\), bidImagesFor\(ctx\)\)/
    );
    expect(procedure('getMyBids', 'getMyRecurringBids')).toMatch(
      /capBidImages\(await getMyBids\([^)]*\), bidImagesFor\(ctx\)\)/
    );
    expect(procedure('getMyRecurringBids', 'createBid')).toMatch(
      /capBidImages\(await getMyRecurringBids\([^)]*\), bidImagesFor\(ctx\)\)/
    );
    const service = read('src/server/services/auction.service.ts');
    expect(service.match(/SignalMessages\.AuctionBidChange/g)).toHaveLength(3);
    const sends = service.match(/target: SignalMessages\.AuctionBidChange,\s*data: [^,]+,/g) ?? [];
    expect(sends).toHaveLength(3);
    for (const send of sends) expect(send).toContain('publicSignalData(');
  });
});
