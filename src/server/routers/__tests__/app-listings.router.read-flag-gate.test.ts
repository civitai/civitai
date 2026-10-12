import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * The DARK-POSTURE + external-before-onsite GA (Phase 1) gate on the unified store
 * read path.
 *
 * `appListings.listAvailable` / `getAppDetail` / `listReviews` are
 * `publicProcedure`s behind `enforceAppListingsReadFlag`, which now resolves a
 * STORE VISIBILITY SCOPE (`resolveStoreVisibilityScope(ctx.user)`) onto
 * `ctx._storeScope` that the 3 procs branch on:
 *   - `none`            → EMPTY page / NOT_FOUND, service NOT consulted (dark).
 *   - `full`            → served with `scope: 'full'` (mods + testers, all kinds).
 *   - `public-external` → served with `scope: 'public-external'` (offsite-only; the
 *     onsite exclusion is enforced in the service — here we assert the SCOPE is
 *     threaded down AND that a service-returned null/empty (onsite) becomes a
 *     router-level 404/empty).
 *
 * `resolveStoreVisibilityScope` is mocked with a faithful per-caller impl (mod →
 * `full`; a `publicExternal` toggle → `public-external`; else `none`). The read
 * services are mocked so importing the router doesn't drag in the generated Prisma
 * client, and so we can assert "NOT consulted" + the exact scope passed.
 */

const {
  mockResolveStoreVisibilityScope,
  mockListAvailableListings,
  mockGetListingDetail,
  mockListAppListingReviews,
} = vi.hoisted(() => ({
  mockResolveStoreVisibilityScope: vi.fn(),
  mockListAvailableListings: vi.fn(),
  mockGetListingDetail: vi.fn(),
  mockListAppListingReviews: vi.fn(),
}));

// The read middleware now resolves a store-visibility SCOPE.
vi.mock('~/server/services/app-blocks-flag', () => ({
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
  // 🔴 THE READ MIDDLEWARE NOW RESOLVES TWO AXES. A one-key factory here makes the WHOLE
  // file fail to import (`No "resolveViewerAudienceFloor" export is defined on the … mock`)
  // rather than failing one case, which is why it is stubbed rather than left out.
  // `public` is the least-privileged floor, so these scope cases keep asserting the SURFACE
  // gate in isolation — exactly what they were written to cover.
  resolveViewerAudienceFloor: vi.fn(async () => 'public'),
}));
// The read services are dynamically imported by the procs; mock them so the DB /
// generated client is never loaded, and so we can assert "NOT consulted" + scope.
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAvailableListings: (...a: unknown[]) => mockListAvailableListings(...a),
  getListingDetail: (...a: unknown[]) => mockGetListingDetail(...a),
}));
vi.mock('~/server/services/blocks/app-listing-review.service', () => ({
  listAppListingReviews: (...a: unknown[]) => mockListAppListingReviews(...a),
}));
// rateLimit pulls in redis; the gate under test is the flag middleware, so stub
// it to a pass-through (mirrors blocks.router.flag-gate.test.ts).
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
// server-domain pulls in env/host helpers; the maturity host-check is not the
// unit under test (default SFW / non-red).
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
}));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

type ScopeUser = { isModerator?: boolean } | undefined;

/**
 * Faithful stand-in for `resolveStoreVisibilityScope`: a moderator (or app-listings
 * grantee, modeled here as `isModerator`) → `full`; else, when the public-external
 * flag is toggled ON, any viewer (incl. anon) → `public-external`; else → `none`.
 */
let publicExternal = false;
function fakeResolveScope(opts?: {
  user?: ScopeUser;
}): Promise<'full' | 'public-external' | 'none'> {
  if (opts?.user?.isModerator) return Promise.resolve('full');
  if (publicExternal) return Promise.resolve('public-external');
  return Promise.resolve('none');
}

function fakeCtx(user: unknown, features: Record<string, boolean> = {}) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: features as never,
    track: undefined,
  };
}

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

beforeEach(() => {
  publicExternal = false;
  mockResolveStoreVisibilityScope.mockReset();
  mockResolveStoreVisibilityScope.mockImplementation(fakeResolveScope);
  mockListAvailableListings.mockReset();
  mockListAvailableListings.mockResolvedValue({ items: [{ id: 'apl_1' }], nextCursor: undefined });
  mockGetListingDetail.mockReset();
  mockGetListingDetail.mockResolvedValue({ id: 'apl_1', slug: 'x', kind: 'offsite' });
  mockListAppListingReviews.mockReset();
  mockListAppListingReviews.mockResolvedValue({ items: [{ id: 5 }], nextCursor: undefined });
});

describe('appListings.listAvailable — scope gate', () => {
  it('anonymous (none): empty page, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailableListings).not.toHaveBeenCalled();
    expect(mockResolveStoreVisibilityScope).toHaveBeenCalledWith({ user: undefined });
  });

  it('non-moderator (none): empty page, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailableListings).not.toHaveBeenCalled();
  });

  it('moderator (full): served with scope=full', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [{ id: 'apl_1' }], nextCursor: undefined });
    expect(mockListAvailableListings).toHaveBeenCalledTimes(1);
    expect(mockListAvailableListings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'full' })
    );
  });

  it('public-external flag on, anon: served with scope=public-external (offsite-only, proves anon-capable)', async () => {
    publicExternal = true;
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [{ id: 'apl_1' }], nextCursor: undefined });
    expect(mockListAvailableListings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'public-external' })
    );
  });

  it('public-external flag on, MOD still resolves full (public flag never narrows a mod)', async () => {
    publicExternal = true;
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await caller.listAvailable({ limit: 20 });
    expect(mockListAvailableListings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'full' })
    );
  });
});

describe('appListings.getAppDetail — scope gate', () => {
  it('anonymous (none): NOT_FOUND, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAppDetail({ slug: 'foo' })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetListingDetail).not.toHaveBeenCalled();
  });

  it('non-moderator (none): NOT_FOUND, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getAppDetail({ slug: 'foo' })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetListingDetail).not.toHaveBeenCalled();
  });

  it('moderator (full): detail served with scope=full', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getAppDetail({ slug: 'foo' });
    expect(result).toMatchObject({ id: 'apl_1' });
    expect(mockGetListingDetail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'full' })
    );
  });

  it('public-external, offsite listing: served with scope=public-external', async () => {
    publicExternal = true;
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.getAppDetail({ slug: 'ext' });
    expect(result).toMatchObject({ id: 'apl_1' });
    expect(mockGetListingDetail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'public-external' })
    );
  });

  it('public-external, ONSITE listing (service → null): NOT_FOUND', async () => {
    // The service applies the kind gate: an onsite listing under public-external
    // returns null → the router maps that to NOT_FOUND (no id/slug bypass).
    publicExternal = true;
    mockGetListingDetail.mockResolvedValue(null);
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAppDetail({ id: 'apl_onsite' })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetListingDetail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'public-external' })
    );
  });
});

describe('appListings.listReviews — scope gate', () => {
  it('anonymous (none): empty, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listReviews({ appListingId: 'apl_1', limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAppListingReviews).not.toHaveBeenCalled();
  });

  it('moderator (full): served with scope=full', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.listReviews({ appListingId: 'apl_1', limit: 20 });
    expect(result).toEqual({ items: [{ id: 5 }], nextCursor: undefined });
    expect(mockListAppListingReviews).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'full' })
    );
  });

  it('public-external: served with scope=public-external (offsite-only enforced in service)', async () => {
    publicExternal = true;
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await caller.listReviews({ appListingId: 'apl_1', limit: 20 });
    expect(mockListAppListingReviews).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'public-external' })
    );
  });

  it('public-external, onsite listing (service → empty): empty page returned', async () => {
    publicExternal = true;
    mockListAppListingReviews.mockResolvedValue({ items: [], nextCursor: undefined });
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listReviews({ appListingId: 'apl_onsite', limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
  });
});

describe('appListings.listAvailable — the sub-listing response-shape flag', () => {
  // Sub-listing cards are a different shape, so a caller must ASK for them (only the store grid
  // does) AND the viewer must have the flag. Each row changes one of the two.
  it.each([
    ['flag on, opted in', true, true, true],
    ['flag on, not opted in', true, undefined, false],
    ['flag on, opted out', true, false, false],
    ['flag off, opted in', false, true, false],
  ] as const)('%s', async (_label, flag, optIn, expected) => {
    const caller = appListingsRouter.createCaller(
      fakeCtx(modUser, flag ? { appStoreSubListings: true } : {}) as never
    );
    await caller.listAvailable({ limit: 20, includeSubListings: optIn });
    expect(mockListAvailableListings).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ includeSubListings: expected })
    );
  });

  // The request browsing level, not the stored preference: a viewer who switched mature content
  // off keeps an old saved level that must not reach the image check.
  it.each([
    ['mature on, nsfw domain', { showNsfw: true, browsingLevel: 7 }, { canViewNsfw: true }, 7],
    ['mature off, nsfw domain', { showNsfw: false, browsingLevel: 7 }, { canViewNsfw: true }, 1],
    ['sfw domain', { showNsfw: true, browsingLevel: 28 }, { canViewNsfw: false }, 3],
  ])('passes the request browsing level (%s)', async (_label, prefs, flags, expected) => {
    const caller = appListingsRouter.createCaller(
      fakeCtx({ ...modUser, ...prefs }, flags) as never
    );
    await caller.listAvailable({ limit: 20 });
    expect(mockListAvailableListings).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ viewerBrowsingLevel: expected })
    );
  });
});

describe('the viewer handed to the store reads (for the viewer-scoped `restrictedAudience`)', () => {
  // The service derives the badge from this viewer; a proc that dropped it, or hardcoded
  // `isModerator`, would silently fall back to anonymous with every service test still green.
  it('listAvailable passes the session user id + moderator flag', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await caller.listAvailable({ limit: 20 });
    expect(mockListAvailableListings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ viewer: { userId: 1, isModerator: true } })
    );
  });

  it('listAvailable: a signed-in NON-moderator is passed as such', async () => {
    publicExternal = true;
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    await caller.listAvailable({ limit: 20 });
    expect(mockListAvailableListings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ viewer: { userId: 2, isModerator: false } })
    );
  });

  it('getAppDetail passes the session viewer; anonymous is { userId: null, isModerator: false }', async () => {
    const mod = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await mod.getAppDetail({ slug: 'foo' });
    expect(mockGetListingDetail).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ viewer: { userId: 1, isModerator: true } })
    );
    publicExternal = true;
    const anon = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await anon.getAppDetail({ slug: 'ext' });
    expect(mockGetListingDetail).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ viewer: { userId: null, isModerator: false } })
    );
  });
});
