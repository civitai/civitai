import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getNavBanners } = vi.hoisted(() => ({ getNavBanners: vi.fn() }));
// Its only export. The real one loads the whole event engine.
vi.mock('~/server/services/nav-banner.service', () => ({ getNavBanners }));

import { eventRouter } from '~/server/routers/event.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const callerFor = (user: { id: number; isModerator?: boolean } | undefined) =>
  eventRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    req: {
      headers: { cookie: 'nav-banners-dismissed=%5B%22event%3Abirthday2026%22%5D', host: 'x' },
      cookies: { 'nav-banners-dismissed': '["event:birthday2026"]' },
    },
    res: { setHeader: () => undefined },
    cache: { browserTTL: 60, edgeTTL: 60, staleWhileRevalidate: 30, canCache: true, skip: false },
    features: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  getNavBanners.mockResolvedValue([{ id: 'event:e1' }]);
});

/**
 * A signed-out answer from this query is edge-cached publicly for every signed-out viewer, so it
 * may depend on the session alone. Dismissals are applied on the client for that reason. If you are
 * about to hand the resolver the request, its cookies or its headers (to filter dismissals on the
 * server, or by region), one viewer's answer would be served to others from the cache.
 */
describe('event.getNavBanners', () => {
  it('resolves from the session user alone, never the request', async () => {
    const user = { id: 42, isModerator: true };
    await expect(callerFor(user).getNavBanners()).resolves.toEqual([{ id: 'event:e1' }]);
    expect(getNavBanners.mock.calls).toStrictEqual([[{ viewer: user }]]);
  });

  it('resolves as signed out with no session', async () => {
    await callerFor(undefined).getNavBanners();
    expect(getNavBanners.mock.calls).toStrictEqual([[{ viewer: undefined }]]);
  });
});
