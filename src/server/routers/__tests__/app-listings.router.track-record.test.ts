import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `appListings.getDeveloperTrackRecord` — the ROUTER half: the store gates in front of the
 * track-record read.
 *
 * Drives the REAL `appListingsRouter` via `createCaller`, so the procedure wiring decides:
 *   - a viewer whose store scope is `none` gets `null`, and the read is never made;
 *   - otherwise the read runs for THIS viewer's scope and floor (never a default), with the
 *     developer from the input.
 *
 * The SQL (which rows count) lives in `app-listing-track-record.service.behavior.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  resolveStoreVisibilityScope: vi.fn(),
  getDeveloperTrackRecord: vi.fn(async (..._a: unknown[]) => ({ appCount: 4, reviewCount: 12 })),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  resolveStoreVisibilityScope: mocks.resolveStoreVisibilityScope,
  resolveViewerAudienceFloor: vi.fn(async () => 'public'),
}));
vi.mock('~/server/services/blocks/app-listing-track-record.service', () => ({
  getDeveloperTrackRecord: mocks.getDeveloperTrackRecord,
}));
vi.mock('~/server/prom/store-scope.metrics', () => ({ recordStoreScopeApplied: vi.fn() }));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
  isRedCapableHost: () => false,
}));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const viewer = { id: 7, isModerator: false, tier: 'free', username: 'viewer' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveStoreVisibilityScope.mockResolvedValue('none');
});

describe('appListings.getDeveloperTrackRecord', () => {
  it('🔴 a dark store (scope none) returns null without reading anything', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getDeveloperTrackRecord({ userId: 4101 })).resolves.toBeNull();
    expect(mocks.getDeveloperTrackRecord).not.toHaveBeenCalled();
  });

  it("reads the record for this viewer's own scope and floor", async () => {
    mocks.resolveStoreVisibilityScope.mockResolvedValue('public-external');
    const caller = appListingsRouter.createCaller(fakeCtx(viewer) as never);
    await expect(caller.getDeveloperTrackRecord({ userId: 4101 })).resolves.toEqual({
      appCount: 4,
      reviewCount: 12,
    });
    expect(mocks.getDeveloperTrackRecord).toHaveBeenCalledTimes(1);
    expect(mocks.getDeveloperTrackRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 4101,
        scope: 'public-external',
        floor: 'public',
        redCapable: false,
      })
    );
  });

  it('rejects a non-positive developer id at the input', async () => {
    mocks.resolveStoreVisibilityScope.mockResolvedValue('full');
    const caller = appListingsRouter.createCaller(fakeCtx(viewer) as never);
    await expect(caller.getDeveloperTrackRecord({ userId: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.getDeveloperTrackRecord).not.toHaveBeenCalled();
  });
});
