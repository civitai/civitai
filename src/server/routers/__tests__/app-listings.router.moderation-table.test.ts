import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 post-approval mgmt (P2) — `appListings.listAllListingsForModeration` authz.
 *
 * The mod management-table read is a `moderatorProcedure`: anon + non-mod callers
 * are rejected (the service is never consulted), a moderator is served, and the
 * validated filter input is forwarded to the service. The service is mocked so
 * importing the router doesn't drag in the generated Prisma client.
 */

const { mockListAll } = vi.hoisted(() => ({ mockListAll: vi.fn() }));

vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAllListingsForModeration: (...a: unknown[]) => mockListAll(...a),
}));
// rateLimit pulls in redis; stub to pass-through (the unit under test is authz).
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

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

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

beforeEach(() => {
  mockListAll.mockReset();
  mockListAll.mockResolvedValue({ items: [{ id: 'apl_1' }], nextCursor: null });
});

describe('appListings.listAllListingsForModeration — mod-only', () => {
  it('anonymous → rejected, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listAllListingsForModeration({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('non-moderator → rejected, service NOT consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.listAllListingsForModeration({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('moderator → served', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.listAllListingsForModeration({});
    expect(result).toEqual({ items: [{ id: 'apl_1' }], nextCursor: null });
    expect(mockListAll).toHaveBeenCalledTimes(1);
  });

  it('forwards the validated status/kind/search filters to the service', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await caller.listAllListingsForModeration({
      status: 'removed',
      kind: 'offsite',
      search: 'cool',
      limit: 10,
    });
    expect(mockListAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'removed', kind: 'offsite', search: 'cool', limit: 10 })
    );
  });

  it('rejects an out-of-range limit at the schema boundary (>50)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.listAllListingsForModeration({ limit: 999 } as never)
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockListAll).not.toHaveBeenCalled();
  });
});
