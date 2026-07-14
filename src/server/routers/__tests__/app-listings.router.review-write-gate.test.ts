import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 — the review WRITE gate rides the store-visibility flag, not the held
 * block-runtime flag.
 *
 * `appListings.upsertReview` / `getMyReview` are `protectedProcedure`s (auth
 * REQUIRED) behind `enforceAppListingsWriteFlag`. That middleware is keyed on the
 * DEDICATED store-visibility flag `isAppListingsEnabled` — the SAME flag as the
 * store visibility + `listReviews` read path — rather than the block-runtime
 * `isAppBlocksEnabled` (`enforceAppBlocksFlag`). Before the fix, the reads gated
 * on `app-listings` while the writes gated on `app-blocks-enabled`, so once the
 * store widens INDEPENDENTLY a viewer would SEE the review affordance but 403 on
 * submit.
 *
 * This drives the REAL `appListingsRouter` via `createCaller` so the middleware
 * wiring (not a mock) decides. Both flag helpers are mocked with FAITHFUL
 * per-user impls modelling the intended launch posture:
 *   - `isAppBlocksEnabled` (block-runtime, HELD to mods)  → ON iff moderator.
 *   - `isAppListingsEnabled` (store visibility, WIDENED)  → ON iff moderator OR
 *     in the store cohort.
 * So a store-cohort NON-mod is the regression case: store-visible but
 * block-runtime-held. The review service is mocked so importing the router never
 * drags in the generated Prisma client (stale in a PR worktree).
 */

const STORE_IDS = new Set([5]); // widened store cohort (non-mod, store-visible)

const {
  mockIsAppListingsEnabled,
  mockIsAppBlocksEnabled,
  mockUpsertReview,
  mockGetMyReview,
  mockListReviews,
} = vi.hoisted(() => ({
  mockIsAppListingsEnabled: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockUpsertReview: vi.fn(async () => ({ id: 1, recommended: true })),
  mockGetMyReview: vi.fn(async () => ({ id: 1, recommended: true, details: null, createdAt: new Date() })),
  mockListReviews: vi.fn(async () => ({ items: [{ id: 1 }], nextCursor: undefined })),
}));

// The write gate now reads `isAppListingsEnabled`; the router module ALSO
// references `isAppBlocksEnabled`/`isAppBlocksAuthorEnabled` for OTHER procs'
// middleware, so provide all three (only the two under test are exercised here).
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppListingsEnabled: mockIsAppListingsEnabled,
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: vi.fn(async () => false),
}));
// The review service is dynamically imported by the procs; mock it so the DB /
// generated client is never loaded, and so we can assert "NOT consulted".
vi.mock('~/server/services/blocks/app-listing-review.service', () => ({
  upsertAppListingReview: (...a: unknown[]) => mockUpsertReview(...a),
  getMyAppListingReview: (...a: unknown[]) => mockGetMyReview(...a),
  listAppListingReviews: (...a: unknown[]) => mockListReviews(...a),
}));
// rateLimit pulls in redis; the gate under test is the flag middleware, so stub
// it to a pass-through (mirrors the sibling router tests).
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
// server-domain pulls in env/host helpers; the maturity host-check is not the
// unit under test (default SFW / non-red).
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Store-visibility flag: ON iff the caller is a mod OR in the widened store cohort. */
function fakeListingsFlag(opts?: { user?: { id?: number; isModerator?: boolean } }) {
  const u = opts?.user;
  return Promise.resolve(!!u && (!!u.isModerator || STORE_IDS.has(u.id ?? -1)));
}
/** Held block-runtime flag: ON iff the caller is a moderator (the today posture). */
function fakeBlocksFlag(opts?: { user?: { isModerator?: boolean } }) {
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
// Store-visible but block-runtime-HELD: the case that 403'd before the fix.
const storeUser = { id: 5, isModerator: false, tier: 'free', username: 'store-viewer' };
// Neither store-visible nor a mod: the store is still dark for this caller.
const darkUser = { id: 7, isModerator: false, tier: 'free', username: 'user' };

const upsertInput = { appListingId: 'apl_1', recommended: true };
const getMyInput = { appListingId: 'apl_1' };
const listInput = { appListingId: 'apl_1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppListingsEnabled.mockImplementation(fakeListingsFlag);
  mockIsAppBlocksEnabled.mockImplementation(fakeBlocksFlag);
});

// ---------------------------------------------------------------------------
// REGRESSION: store-visible but block-runtime-held → writes ALLOWED.
// ---------------------------------------------------------------------------

describe('review writes ride the store flag (regression)', () => {
  it('upsertReview: store-cohort NON-mod (listings ON, blocks OFF) is ALLOWED — the button no longer 403s', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(storeUser) as never);
    await expect(caller.upsertReview(upsertInput)).resolves.toMatchObject({ id: 1 });
    expect(mockUpsertReview).toHaveBeenCalledTimes(1);
    expect(mockUpsertReview.mock.calls[0][0]).toMatchObject({ userId: storeUser.id });
    // The write gate must consult the STORE flag, not the held block-runtime flag.
    expect(mockIsAppListingsEnabled).toHaveBeenCalledWith({ user: storeUser });
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
  });

  it('getMyReview: store-cohort NON-mod (listings ON, blocks OFF) is ALLOWED — form prefill loads', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(storeUser) as never);
    await expect(caller.getMyReview(getMyInput)).resolves.toMatchObject({ id: 1 });
    expect(mockGetMyReview).toHaveBeenCalledWith(getMyInput.appListingId, storeUser.id);
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
  });

  it('moderator still passes (OR-fallback preserves today’s access)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.upsertReview(upsertInput)).resolves.toMatchObject({ id: 1 });
    await expect(caller.getMyReview(getMyInput)).resolves.toMatchObject({ id: 1 });
    expect(mockUpsertReview).toHaveBeenCalledTimes(1);
    expect(mockGetMyReview).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// REJECT: store dark for the caller → UNAUTHORIZED, service NOT consulted.
// ---------------------------------------------------------------------------

describe('review writes reject when the store is dark for the caller', () => {
  it('upsertReview: non-store non-mod (listings OFF) → UNAUTHORIZED, service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(darkUser) as never);
    await expect(caller.upsertReview(upsertInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });

  it('getMyReview: non-store non-mod (listings OFF) → UNAUTHORIZED, service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(darkUser) as never);
    await expect(caller.getMyReview(getMyInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockGetMyReview).not.toHaveBeenCalled();
  });

  it('upsertReview: anonymous → UNAUTHORIZED (protectedProcedure), service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.upsertReview(upsertInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// READ path unchanged: listReviews stays on the same store flag (soft, not hard).
// ---------------------------------------------------------------------------

describe('listReviews (read) — behavior unchanged', () => {
  it('store-cohort NON-mod (listings ON): reviews served', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(storeUser) as never);
    await expect(caller.listReviews(listInput)).resolves.toEqual({ items: [{ id: 1 }], nextCursor: undefined });
    expect(mockListReviews).toHaveBeenCalledTimes(1);
  });

  it('non-store non-mod (listings OFF): EMPTY page (soft), service NOT consulted — no throw', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(darkUser) as never);
    await expect(caller.listReviews(listInput)).resolves.toEqual({ items: [], nextCursor: undefined });
    expect(mockListReviews).not.toHaveBeenCalled();
  });

  it('anonymous (listings OFF): EMPTY page (soft), never throws', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listReviews(listInput)).resolves.toEqual({ items: [], nextCursor: undefined });
    expect(mockListReviews).not.toHaveBeenCalled();
  });
});
