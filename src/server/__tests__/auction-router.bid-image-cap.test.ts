import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const service = vi.hoisted(() => ({
  getAuctionBySlug: vi.fn(),
  getMyBids: vi.fn(),
  getMyRecurringBids: vi.fn(),
}));
// image.service's real import graph is heavy; nothing here reads it.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn(), topicSend: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...service,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { auctionRouter } = await import('~/server/routers/auction.router');

/** Drives the real procedures, so what is asserted is what each viewer is answered with. */
const createCaller = createCallerFactory(auctionRouter);
const ONBOARDED = 1 | 2 | 4 | 8;
const OWNER = 5;

type Viewer = { user?: { id: number; isModerator?: boolean }; canViewNsfw: boolean; bot?: string };
const callerFor = ({ user, canViewNsfw, bot }: Viewer, cache: Record<string, number> = {}) =>
  createCaller({
    user: user && {
      ...user,
      onboarding: ONBOARDED,
      emailVerified: new Date('2026-01-01T00:00:00Z'),
      meta: {},
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, auctions: true, canViewNsfw },
    track: {},
    ip: '127.0.0.1',
    cache,
    req: { headers: bot ? { [VERIFIED_BOT_HEADER]: bot } : {} },
    res: undefined,
  } as never);

// Image ids 1-3: public, above every cap, unrated.
const bids = () =>
  [NsfwLevel.PG, NsfwLevel.X, 0].map((nsfwLevel, i) => ({
    entityId: i + 1,
    entityData: { model: { id: i + 1 }, image: { id: i + 1, nsfwLevel, userId: OWNER } },
  }));
const shown = (list: { entityData?: { image?: { id: number } } }[]) =>
  list.map((b) => b.entityData?.image?.id ?? null);

const CAPPED: Viewer = { user: { id: 6 }, canViewNsfw: false };

beforeEach(() => {
  service.getAuctionBySlug.mockReset().mockImplementation(async () => ({ id: 1, bids: bids() }));
  service.getMyBids.mockReset().mockImplementation(async () => bids());
  service.getMyRecurringBids.mockReset().mockImplementation(async () => bids());
});

describe('auction bid images', () => {
  it('a capped viewer gets no bid image above the cap, on the auction page or My Bids', async () => {
    const caller = callerFor(CAPPED);
    expect(shown((await caller.getBySlug({ slug: 'sd1' })).bids)).toEqual([1, null, null]);
    expect(shown(await caller.getMyBids())).toEqual([1, null, null]);
    expect(shown(await caller.getMyRecurringBids())).toEqual([1, null, null]);
  });

  it.each<[string, Viewer]>([
    ['an uncapped viewer', { user: { id: 6 }, canViewNsfw: true }],
    ['the image owner', { user: { id: OWNER }, canViewNsfw: false }],
    ['a moderator', { user: { id: 7, isModerator: true }, canViewNsfw: false }],
  ])('%s keeps every bid image', async (_label, viewer) => {
    const caller = callerFor(viewer);
    expect(shown((await caller.getBySlug({ slug: 'sd1' })).bids)).toEqual([1, 2, 3]);
    expect(shown(await caller.getMyBids())).toEqual([1, 2, 3]);
  });

  it("a verified crawler's auction answer is kept out of the edge cache", async () => {
    const cache = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 60 };
    await callerFor({ canViewNsfw: true, bot: 'googlebot' }, cache).getBySlug({ slug: 'sd1' });
    expect(cache).toEqual({ edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 });

    const anon = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 60 };
    await callerFor({ canViewNsfw: false }, anon).getBySlug({ slug: 'sd1' });
    expect(anon.edgeTTL).toBe(60);
  });
});
