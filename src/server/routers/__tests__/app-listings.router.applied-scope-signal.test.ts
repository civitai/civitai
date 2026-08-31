import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 `none` vs `absent` — the distinction civitai#3983 could not make.
 *
 * Every store read entry point folds a missing scope into a safe default: the tRPC
 * procs `?? 'none'` (fail closed → `{ items: [] }`), the listing service `?? 'full'`
 * (fail open → the whole catalog). Both defaults are individually defensible and
 * TOGETHER they are why the same underlying fault presented as an empty store on one
 * entry point and a full catalog on the other — while being invisible on both,
 * because a response cannot say which branch produced it.
 *
 * `recordStoreScopeApplied` is called BEFORE the fallback, so `absent` is a value an
 * operator can see. This suite pins that:
 *   - a resolved scope is recorded as itself, per entry point;
 *   - a scope that never arrives is recorded as `absent` and NOT as `none`.
 *
 * The second case is the POSITIVE CONTROL for the whole diagnostic: it proves the
 * instrument can actually observe the state it was built to detect, rather than
 * being a counter that only ever emits the values everything else already reports.
 */

const { mockResolveStoreVisibilityScope, recordStoreScopeApplied } = vi.hoisted(() => ({
  mockResolveStoreVisibilityScope: vi.fn(),
  recordStoreScopeApplied: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
}));
vi.mock('~/server/prom/store-scope.metrics', () => ({ recordStoreScopeApplied }));
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAvailableListings: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getListingDetail: vi.fn(async () => ({ id: 'apl_1', slug: 'x', kind: 'offsite' })),
}));
vi.mock('~/server/services/blocks/app-listing-review.service', () => ({
  listAppListingReviews: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));
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

const listInput = { kind: 'all', sort: 'newest', limit: 24, direction: 'forward' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the scope an entry point BRANCHED on is recorded per entry point', () => {
  it('records `public-external` on the list proc', async () => {
    mockResolveStoreVisibilityScope.mockResolvedValue('public-external');
    const caller = appListingsRouter.createCaller(fakeCtx({ id: 7 }) as never);
    await caller.listAvailable(listInput);
    expect(recordStoreScopeApplied).toHaveBeenCalledWith('public-external', 'trpc-list');
  });

  it('records `full` on the detail proc', async () => {
    mockResolveStoreVisibilityScope.mockResolvedValue('full');
    const caller = appListingsRouter.createCaller(fakeCtx({ id: 7 }) as never);
    await caller.getAppDetail({ slug: 'x' } as never);
    expect(recordStoreScopeApplied).toHaveBeenCalledWith('full', 'trpc-detail');
  });

  it('records `none` on the reviews proc', async () => {
    mockResolveStoreVisibilityScope.mockResolvedValue('none');
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await caller.listReviews({ appListingId: 'apl_1', limit: 10 } as never);
    expect(recordStoreScopeApplied).toHaveBeenCalledWith('none', 'trpc-reviews');
  });
});

describe('🔴 POSITIVE CONTROL: a scope that never arrives reads as `absent`, not `none`', () => {
  it('list: an absent scope is distinguishable from a resolved `none`', async () => {
    // The shape under suspicion: the middleware runs but no usable scope reaches the
    // procedure. The response is byte-identical to a genuine `none` — the counter is
    // the only thing that can tell them apart.
    mockResolveStoreVisibilityScope.mockResolvedValue(undefined);
    const caller = appListingsRouter.createCaller(fakeCtx({ id: 7 }) as never);

    await expect(caller.listAvailable(listInput)).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });

    expect(recordStoreScopeApplied).toHaveBeenCalledWith(undefined, 'trpc-list');
    expect(recordStoreScopeApplied).not.toHaveBeenCalledWith('none', 'trpc-list');
  });

  it('detail: an absent scope still fails CLOSED (NOT_FOUND) while being recorded', async () => {
    mockResolveStoreVisibilityScope.mockResolvedValue(undefined);
    const caller = appListingsRouter.createCaller(fakeCtx({ id: 7 }) as never);

    await expect(caller.getAppDetail({ slug: 'x' } as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(recordStoreScopeApplied).toHaveBeenCalledWith(undefined, 'trpc-detail');
  });
});
