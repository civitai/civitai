import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * FORKABLE APPS, PR 3 — the ROUTER half of `appListings.startFork` / `getForkSession`.
 *
 * Drives the REAL `appListingsRouter` via `createCaller`: sign-in is required, the viewer's store
 * scope (from the same middleware every store read uses) and the request's host reach the service,
 * the client sends ONLY a listing id, and the session read is behind the rollout flag and keyed on
 * the CALLER's id. The gates themselves are `app-fork-start.service.test.ts`'s.
 */

const mocks = vi.hoisted(() => ({
  startAppFork: vi.fn(async (..._a: unknown[]) => ({
    forkSlug: 'garden-fork-1f2e',
    parentName: 'Garden',
    parentListingId: 'apl_router_6001',
    seed: { url: 'https://seeds.router.test/x.zip', sha256: 'b'.repeat(64), bytes: 1234 },
  })),
  getForkSessionForUser: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  isAppBlocksForkEnabled: vi.fn(async (..._a: unknown[]) => true),
  scope: 'full' as string,
}));

vi.mock('~/server/services/blocks/app-fork-start.service', () => ({
  startAppFork: mocks.startAppFork,
  getForkSessionForUser: mocks.getForkSessionForUser,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
  isAppBlocksForkEnabled: mocks.isAppBlocksForkEnabled,
  resolveStoreVisibilityScope: vi.fn(async () => mocks.scope),
  resolveViewerAudienceFloor: vi.fn(async () => 'public'),
}));
vi.mock('~/server/prom/store-scope.metrics', () => ({ recordStoreScopeApplied: vi.fn() }));
vi.mock('~/server/services/feature-flags.service', async () => {
  const actual = await vi.importActual<typeof FeatureFlagsService>(
    '~/server/services/feature-flags.service'
  );
  return { ...actual, getFeatureFlags: () => ({ appBlocksAuthor: false }) };
});
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
  isRedCapableHost: (host?: string) => host === 'red.router.test',
}));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown, host = 'site.router.test') {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: { host } } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const viewer = { id: 6101, isModerator: false, tier: 'free', username: 'viewer', onboarding: 0x1f };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope = 'full';
  mocks.isAppBlocksForkEnabled.mockResolvedValue(true);
});

describe('appListings.startFork', () => {
  it('requires sign-in; the service is never reached', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(null) as never);
    await expect(caller.startFork({ listingId: 'apl_router_6001' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mocks.startAppFork).not.toHaveBeenCalled();
  });

  it('hands the service the caller, the listing id, the viewer’s store scope and the host', async () => {
    mocks.scope = 'public-external';
    const caller = appListingsRouter.createCaller(fakeCtx(viewer, 'red.router.test') as never);
    await expect(caller.startFork({ listingId: 'apl_router_6001' })).resolves.toEqual({
      forkSlug: 'garden-fork-1f2e',
      parentName: 'Garden',
      parentListingId: 'apl_router_6001',
      seed: { url: 'https://seeds.router.test/x.zip', sha256: 'b'.repeat(64), bytes: 1234 },
    });
    expect(mocks.startAppFork).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: viewer.id }),
        listingId: 'apl_router_6001',
        scope: 'public-external',
        redCapable: true,
      })
    );
  });

  it('accepts nothing but a listing id — a client cannot name a parent block or commit', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(viewer) as never);
    await caller.startFork({
      listingId: 'apl_router_6001',
      // Extra keys are stripped by the input schema; none reaches the service.
      ...({ forkOfAppBlockId: 'ab_forged_6002', forkOfCommitSha: 'c'.repeat(40) } as object),
    } as never);
    const arg = mocks.startAppFork.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(['listingId', 'redCapable', 'req', 'scope', 'user']);
  });
});

describe('appListings.getForkSession', () => {
  it('flag OFF → null, without reading the session', async () => {
    mocks.isAppBlocksForkEnabled.mockResolvedValue(false);
    const caller = appListingsRouter.createCaller(fakeCtx(viewer) as never);
    await expect(caller.getForkSession({ forkSlug: 'garden-fork-1f2e' })).resolves.toBeNull();
    expect(mocks.getForkSessionForUser).not.toHaveBeenCalled();
  });

  it('reads the CALLER’s session by slug', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(viewer) as never);
    await caller.getForkSession({ forkSlug: 'garden-fork-1f2e' });
    expect(mocks.getForkSessionForUser).toHaveBeenCalledWith({
      userId: viewer.id,
      forkSlug: 'garden-fork-1f2e',
    });
  });
});
