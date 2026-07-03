import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 P2a — the DARK-POSTURE gate on the unified store read path.
 *
 * `appListings.listAvailable` / `getAppDetail` are `publicProcedure`s behind
 * `enforceAppListingsReadFlag` (the mod-segmented App Blocks flag). This is the
 * SINGLE control that keeps the whole store dark until the segment is widened at
 * cutover. `isAppBlocksEnabled` is mocked with a FAITHFUL per-user impl (ON only
 * when the caller is a moderator, matching the live `app-blocks-enabled` rule),
 * and the read service is mocked so importing the router doesn't drag in the
 * generated Prisma client (stale in a PR worktree). We then drive the REAL
 * router so the middleware's `{ user: ctx.user }` wiring is what decides:
 *   - list:   anon/non-mod → EMPTY page, service NOT consulted; mod → served.
 *   - detail: anon/non-mod → NOT_FOUND, service NOT consulted; mod → served.
 *   - flag lit for anon → served (proves the path is anon-CAPABLE, no leftover
 *     isModerator gate) — the deliberate cutover widen.
 */

const { mockIsAppBlocksEnabled, mockListAvailableListings, mockGetListingDetail } = vi.hoisted(
  () => ({
    mockIsAppBlocksEnabled: vi.fn(),
    mockListAvailableListings: vi.fn(),
    mockGetListingDetail: vi.fn(),
  })
);

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
// The read service is dynamically imported by the procs; mock it so the DB /
// generated client is never loaded, and so we can assert "NOT consulted".
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAvailableListings: (...a: unknown[]) => mockListAvailableListings(...a),
  getListingDetail: (...a: unknown[]) => mockGetListingDetail(...a),
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

/** Faithful mod-segmented flag: ON iff the caller is a moderator (anon → false). */
function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(!!opts?.user?.isModerator);
}

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

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockListAvailableListings.mockReset();
  mockListAvailableListings.mockResolvedValue({ items: [{ id: 'apl_1' }], nextCursor: undefined });
  mockGetListingDetail.mockReset();
  mockGetListingDetail.mockResolvedValue({ id: 'apl_1', slug: 'x', kind: 'onsite' });
});

describe('appListings.listAvailable — dark posture', () => {
  it('anonymous (flag off): empty page, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailableListings).not.toHaveBeenCalled();
    expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({ user: undefined });
  });

  it('non-moderator (flag off): empty page, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailableListings).not.toHaveBeenCalled();
  });

  it('moderator: gate passes, service IS consulted (mods-only is the live state)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [{ id: 'apl_1' }], nextCursor: undefined });
    expect(mockListAvailableListings).toHaveBeenCalledTimes(1);
  });

  it('anonymous WITH the flag widened (cutover): served — proves anon-capable', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [{ id: 'apl_1' }], nextCursor: undefined });
    expect(mockListAvailableListings).toHaveBeenCalledTimes(1);
  });
});

describe('appListings.getAppDetail — dark posture', () => {
  it('anonymous (flag off): NOT_FOUND, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAppDetail({ slug: 'foo' })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetListingDetail).not.toHaveBeenCalled();
  });

  it('non-moderator (flag off): NOT_FOUND, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getAppDetail({ slug: 'foo' })).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetListingDetail).not.toHaveBeenCalled();
  });

  it('moderator: gate passes, detail served', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getAppDetail({ slug: 'foo' });
    expect(result).toMatchObject({ id: 'apl_1' });
    expect(mockGetListingDetail).toHaveBeenCalledTimes(1);
  });

  it('moderator, listing not approved/found (service → null): NOT_FOUND', async () => {
    mockGetListingDetail.mockResolvedValue(null);
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAppDetail({ id: 'apl_missing' })).rejects.toBeInstanceOf(TRPCError);
  });
});
