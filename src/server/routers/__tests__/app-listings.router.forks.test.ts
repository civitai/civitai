import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * Forkable apps — the ROUTER half: the gates in front of the services.
 *
 * Drives the REAL `appListingsRouter` via `createCaller`, so the procedure wiring (not a mock)
 * decides:
 *   - `updateListing` with a `forkable` key: a banned account is refused by the middleware, the
 *     `app-blocks-fork` rollout flag must admit the caller, and a service NOT_OWNED (a stranger)
 *     reaches the client as FORBIDDEN (403). A patch WITHOUT the key never evaluates the flag.
 *   - `listForks`: flag off → `null` with no read at all; a parent this viewer cannot open →
 *     `null`; otherwise the page, computed for the viewer's own scope/floor.
 *
 * Services are mocked; the opt-in's ownership and non-material handling live in
 * `offsite-listing.forkable.service.test.ts`, the fork list's SQL in
 * `app-listing-forks.service.behavior.test.ts`.
 */

const AUTHOR_IDS = new Set([31]);

const mocks = vi.hoisted(() => ({
  updateListing: vi.fn(async (..._a: unknown[]) => ({
    listingId: 'apl_router_7001',
    status: 'approved',
    requiresReview: false,
    shadowId: null,
  })),
  isAppBlocksForkEnabled: vi.fn(async (..._a: unknown[]) => false),
  getStoreVisibleListingSummary: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  listListingForks: vi.fn(async (..._a: unknown[]) => ({
    totalCount: 2,
    items: [
      { id: 'apl_fork_7012', slug: 'fork-b', name: 'Fork B' },
      { id: 'apl_fork_7011', slug: 'fork-a', name: 'Fork A' },
    ],
    nextCursor: null,
  })),
}));

vi.mock('~/server/services/blocks/offsite-listing.service', () => ({
  updateListing: mocks.updateListing,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
  isAppBlocksForkEnabled: mocks.isAppBlocksForkEnabled,
  resolveStoreVisibilityScope: vi.fn(async () => 'full'),
  resolveViewerAudienceFloor: vi.fn(async () => 'public'),
}));
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  getStoreVisibleListingSummary: mocks.getStoreVisibleListingSummary,
}));
vi.mock('~/server/services/blocks/app-listing-forks.service', () => ({
  listListingForks: mocks.listListingForks,
}));
vi.mock('~/server/prom/store-scope.metrics', () => ({ recordStoreScopeApplied: vi.fn() }));
// appDeveloperProcedure gates on getFeatureFlags(ctx).appBlocksAuthor.
vi.mock('~/server/services/feature-flags.service', async () => {
  const actual = await vi.importActual<typeof FeatureFlagsService>(
    '~/server/services/feature-flags.service'
  );
  return {
    ...actual,
    getFeatureFlags: (ctx: { user?: { id?: number; isModerator?: boolean } }) => ({
      appBlocksAuthor: !!ctx.user && (!!ctx.user.isModerator || AUTHOR_IDS.has(ctx.user.id ?? -1)),
    }),
  };
});
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
  isRedCapableHost: () => false,
}));

import { appListingsRouter } from '../app-listings.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { FORK_SETTING_DISABLED_MESSAGE } from '~/shared/constants/app-fork.constants';

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

const author = { id: 31, isModerator: false, tier: 'free', username: 'author', onboarding: 0x1f };
const banned = { ...author, id: 32, bannedAt: new Date('2026-01-02T00:00:00Z') };
const mod = { id: 33, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };

const forkPatch = { listingId: 'apl_router_7001', patch: { forkable: true } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAppBlocksForkEnabled.mockResolvedValue(false);
  mocks.getStoreVisibleListingSummary.mockResolvedValue(null);
});

describe('updateListing — the fork opt-in', () => {
  it('a BANNED account is refused by the middleware; the service is never reached', async () => {
    mocks.isAppBlocksForkEnabled.mockResolvedValue(true);
    const caller = appListingsRouter.createCaller(fakeCtx(banned) as never);
    await expect(caller.updateListing(forkPatch)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.updateListing).not.toHaveBeenCalled();
  });

  it('flag OFF for the caller → FORBIDDEN with the disabled message; the service is never reached', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(author) as never);
    await expect(caller.updateListing(forkPatch)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORK_SETTING_DISABLED_MESSAGE,
    });
    expect(mocks.updateListing).not.toHaveBeenCalled();
  });

  it('flag ON → the patch reaches the service with the caller id', async () => {
    mocks.isAppBlocksForkEnabled.mockResolvedValue(true);
    const caller = appListingsRouter.createCaller(fakeCtx(author) as never);
    await caller.updateListing(forkPatch);
    expect(mocks.updateListing).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: 'apl_router_7001',
        patch: { forkable: true },
        userId: author.id,
      })
    );
  });

  it('a STRANGER (service NOT_OWNED) gets FORBIDDEN — a 403, not a 400', async () => {
    mocks.isAppBlocksForkEnabled.mockResolvedValue(true);
    mocks.updateListing.mockRejectedValueOnce(
      Object.assign(new Error('you can only edit your own listings'), {
        name: 'OffsiteRequestError',
        code: 'NOT_OWNED',
      })
    );
    const caller = appListingsRouter.createCaller(fakeCtx(author) as never);
    const err = await caller.updateListing(forkPatch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('flag OFF still lets the author turn it OFF — consent is never stranded by a rollback', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(author) as never);
    await caller.updateListing({ listingId: 'apl_router_7001', patch: { forkable: false } });
    expect(mocks.isAppBlocksForkEnabled).not.toHaveBeenCalled();
    expect(mocks.updateListing).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { forkable: false }, userId: author.id })
    );
  });

  it('a patch WITHOUT the key never evaluates the fork flag', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(author) as never);
    await caller.updateListing({ listingId: 'apl_router_7001', patch: { tagline: 'hello' } });
    expect(mocks.isAppBlocksForkEnabled).not.toHaveBeenCalled();
    expect(mocks.updateListing).toHaveBeenCalledTimes(1);
  });
});

describe('listForks', () => {
  const input = { listingId: 'apl_parent_7010' };

  it('flag OFF → null, and nothing is read', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.listForks(input)).resolves.toBeNull();
    expect(mocks.getStoreVisibleListingSummary).not.toHaveBeenCalled();
    expect(mocks.listListingForks).not.toHaveBeenCalled();
  });

  it('a parent this viewer cannot open → null; its forks are never counted', async () => {
    mocks.isAppBlocksForkEnabled.mockResolvedValue(true);
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.listForks(input)).resolves.toBeNull();
    expect(mocks.getStoreVisibleListingSummary).toHaveBeenCalledWith(
      { id: 'apl_parent_7010' },
      { redCapable: false, scope: 'full', floor: 'public' }
    );
    expect(mocks.listListingForks).not.toHaveBeenCalled();
  });

  it('flag ON + a visible parent → the page, for the viewer’s scope and floor', async () => {
    mocks.isAppBlocksForkEnabled.mockResolvedValue(true);
    mocks.getStoreVisibleListingSummary.mockResolvedValue({
      id: 'apl_parent_7010',
      slug: 'parent-app',
      name: 'Parent App',
    });
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.listForks({ ...input, limit: 5 })).resolves.toEqual({
      totalCount: 2,
      items: [
        { id: 'apl_fork_7012', slug: 'fork-b', name: 'Fork B' },
        { id: 'apl_fork_7011', slug: 'fork-a', name: 'Fork A' },
      ],
      nextCursor: null,
    });
    expect(mocks.listListingForks).toHaveBeenCalledTimes(1);
    // The replica, not the primary: a public read.
    expect(mocks.listListingForks.mock.calls[0][0]).toBe(dbMock.dbRead);
    expect(mocks.listListingForks.mock.calls[0][1]).toEqual({
      parentListingId: 'apl_parent_7010',
      cursor: null,
      limit: 5,
      scope: 'full',
      floor: 'public',
      redCapable: false,
    });
  });
});
