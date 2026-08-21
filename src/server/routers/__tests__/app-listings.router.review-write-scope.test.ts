import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 — the review WRITE gate is keyed on the resolved STORE SCOPE, not on a flag.
 *
 * ## The bug this pins
 *
 * `enforceAppListingsWriteFlag` used to be `if (await isAppListingsEnabled({user}))`
 * — i.e. `app-listings || app-blocks-enabled`. The store then widened by a THIRD
 * route: the `app-listings-public-external` flag plus `resolveStoreVisibilityScope`,
 * which lifts a non-privileged viewer to the `public-external` scope. The READ path
 * moved onto that scope; the write gate did not. So the external-only tester cohort
 * — which holds NEITHER flag `isAppListingsEnabled` looks at — reached an offsite
 * listing, saw the review affordance the read scope had legitimately shown them, and
 * got `UNAUTHORIZED: Apps are not enabled` on submit. Reported verbatim as
 * "could not post review, apps are not enabled".
 *
 * 🔴 A MODERATOR CANNOT REPRODUCE THIS. A mod holds `app-listings`, so the old flag
 * check passed and every surface looked healthy. The whole cohort dimension is
 * invisible from a privileged account, which is why the fixtures below are built
 * around the REAL reporting account (`camer047army744`, id 11072787, non-moderator,
 * confirmed against prod) rather than a generic "user".
 *
 * ## What is asserted
 *
 * The REAL `appListingsRouter` via `createCaller`, so the middleware wiring decides
 * — not a mock. `resolveStoreVisibilityScope` is faked with a FAITHFUL per-user impl
 * modelling the live posture (mod/tester → `full`, external-only cohort →
 * `public-external`, everyone else → `none`), and the assertions are on the RESOLVED
 * SCOPE reaching the service, never on a flag name: keying on a flag is the defect,
 * so a test that asserted a flag was consulted would re-encode it.
 *
 * The KIND half (offsite yes / onsite no) is enforced in the service and pinned by
 * `services/blocks/__tests__/app-listing-review.service.test.ts` +
 * `app-listing-review.store-scope.test.ts`; here we pin that the scope is THREADED,
 * which is the seam those service tests cannot see.
 */

const {
  mockIsAppListingsEnabled,
  mockResolveStoreVisibilityScope,
  mockUpsertReview,
  mockGetMyReview,
  mockListReviews,
} = vi.hoisted(() => ({
  mockIsAppListingsEnabled: vi.fn(),
  mockResolveStoreVisibilityScope: vi.fn(),
  mockUpsertReview: vi.fn(async () => ({
    review: { id: 8801, recommended: true },
    isNewReview: true,
  })),
  mockGetMyReview: vi.fn(async () => ({
    id: 8801,
    recommended: true,
    details: 'external tester note',
    createdAt: new Date('2026-08-19T09:15:00Z'),
  })),
  mockListReviews: vi.fn(async () => ({ items: [{ id: 8801 }], nextCursor: undefined })),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  // 🔴 A FAITHFUL fake, deliberately NOT a thrower. Making this throw would turn a
  // base-revision run red on the MOCK'S error instead of on the assertion, and a
  // test that dies for the wrong reason is not evidence. With the honest impl below,
  // running this suite at the base revision reproduces the REPORTED SYMPTOM exactly
  // — `UNAUTHORIZED: Apps are not enabled` for the external-only cohort — and the
  // admission tests fail on their own `resolves` expectation.
  isAppListingsEnabled: mockIsAppListingsEnabled,
  isAppBlocksEnabled: vi.fn(async () => false),
  isAppBlocksAuthorEnabled: vi.fn(async () => false),
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
}));
vi.mock('~/server/services/blocks/app-listing-review.service', () => ({
  upsertAppListingReview: (...a: unknown[]) => mockUpsertReview(...a),
  getMyAppListingReview: (...a: unknown[]) => mockGetMyReview(...a),
  listAppListingReviews: (...a: unknown[]) => mockListReviews(...a),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// ---------------------------------------------------------------------------
// Fixtures — pairwise distinct, non-default, and none equal to any constant the
// assertions name (no id is 0/1, no listing id is a prefix of another).
// ---------------------------------------------------------------------------

/** THE reporting account: non-moderator, `app-listings-public-external` only. */
const EXTERNAL_TESTER = {
  id: 11072787,
  isModerator: false,
  tier: 'free',
  username: 'camer047army744',
};
/** A moderator — resolves `full`. The account that CANNOT see the bug. */
const MOD_USER = { id: 4271, isModerator: true, tier: 'founder', username: 'mod-nine' };
/** A non-mod app-dev-tester holding `app-listings` — also `full`. */
const TESTER_USER = { id: 6390, isModerator: false, tier: 'free', username: 'dev-tester' };
/** Holds no store flag at all — the store is dark for them. */
const DARK_USER = { id: 8514, isModerator: false, tier: 'free', username: 'ordinary' };

const OFFSITE_LISTING = 'apl_offsite_kt4';
const ONSITE_LISTING = 'apl_onsite_zw9';

/** Every id the fake resolver lifts to `public-external` (external-only cohort). */
const EXTERNAL_COHORT = new Set([EXTERNAL_TESTER.id]);
/** Every id the fake resolver lifts to `full` (mods + app-dev-testers). */
const FULL_COHORT = new Set([MOD_USER.id, TESTER_USER.id]);

/**
 * Faithful stand-in for `resolveStoreVisibilityScope`, including its PRIORITY ORDER
 * (axis 1 short-circuits, so a mod in the external cohort is never narrowed).
 */
function fakeResolveScope(opts?: { user?: { id?: number; isModerator?: boolean } }) {
  const u = opts?.user;
  if (!u) return Promise.resolve('none');
  if (u.isModerator || FULL_COHORT.has(u.id ?? -1)) return Promise.resolve('full');
  if (EXTERNAL_COHORT.has(u.id ?? -1)) return Promise.resolve('public-external');
  return Promise.resolve('none');
}

/**
 * Faithful stand-in for `isAppListingsEnabled` = `app-listings || app-blocks-enabled`.
 *
 * 🔴 THE EXTERNAL COHORT IS ABSENT FROM IT ON PURPOSE — that is the entire defect.
 * This function is what the write gate used to call, and it answers `false` for the
 * very viewers `resolveStoreVisibilityScope` lifts to `public-external`.
 */
function fakeIsAppListingsEnabled(opts?: { user?: { id?: number; isModerator?: boolean } }) {
  const u = opts?.user;
  return Promise.resolve(!!u && (!!u.isModerator || FULL_COHORT.has(u.id ?? -1)));
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

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveStoreVisibilityScope.mockImplementation(fakeResolveScope);
  mockIsAppListingsEnabled.mockImplementation(fakeIsAppListingsEnabled);
});

// ---------------------------------------------------------------------------
// THE REGRESSION — the external-only cohort can write. RED at base.
// ---------------------------------------------------------------------------

describe('external-only tester cohort (public-external) — the reported bug', () => {
  it('upsertReview is ADMITTED (was UNAUTHORIZED "Apps are not enabled")', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(EXTERNAL_TESTER) as never);
    await expect(
      caller.upsertReview({ appListingId: OFFSITE_LISTING, recommended: true })
    ).resolves.toMatchObject({ review: { id: 8801 } });
    expect(mockUpsertReview).toHaveBeenCalledTimes(1);
  });

  it('upsertReview threads the RESOLVED SCOPE into the service, not a flag verdict', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(EXTERNAL_TESTER) as never);
    await caller.upsertReview({ appListingId: OFFSITE_LISTING, recommended: false });
    // The scope is the load-bearing argument: without it the service defaults to
    // `full` and the kind gate is inert for this cohort.
    expect(mockUpsertReview.mock.calls[0][0]).toMatchObject({
      userId: EXTERNAL_TESTER.id,
      scope: 'public-external',
      input: { appListingId: OFFSITE_LISTING, recommended: false },
    });
  });

  it('getMyReview is ADMITTED and threads the same scope (form prefill loads)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(EXTERNAL_TESTER) as never);
    await expect(caller.getMyReview({ appListingId: OFFSITE_LISTING })).resolves.toMatchObject({
      id: 8801,
    });
    expect(mockGetMyReview).toHaveBeenCalledWith(OFFSITE_LISTING, EXTERNAL_TESTER.id, {
      scope: 'public-external',
    });
  });

  it('the gate resolves the scope WITH the caller context — a global eval matches no segment', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(EXTERNAL_TESTER) as never);
    await caller.upsertReview({ appListingId: OFFSITE_LISTING, recommended: true });
    expect(mockResolveStoreVisibilityScope).toHaveBeenCalledWith({ user: EXTERNAL_TESTER });
  });

  it('🔴 the gate does NOT consult `isAppListingsEnabled` — keying on that flag IS the bug', async () => {
    // Stated separately from the admission tests above so a regression is
    // attributable: those would go red on the SYMPTOM (a 401), this names the CAUSE.
    // The fake would answer `false` for this caller, which is why the flag must not
    // be the thing the gate asks.
    await expect(fakeIsAppListingsEnabled({ user: EXTERNAL_TESTER })).resolves.toBe(false);
    const caller = appListingsRouter.createCaller(fakeCtx(EXTERNAL_TESTER) as never);
    await caller.upsertReview({ appListingId: OFFSITE_LISTING, recommended: true });
    expect(mockIsAppListingsEnabled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// UNCHANGED — a `full`-scope viewer behaves exactly as before.
// ---------------------------------------------------------------------------

describe('full-scope viewers are unchanged', () => {
  it('moderator writes, and gets scope `full` (never narrowed by the external axis)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(MOD_USER) as never);
    await expect(
      caller.upsertReview({ appListingId: ONSITE_LISTING, recommended: true })
    ).resolves.toMatchObject({ review: { id: 8801 } });
    expect(mockUpsertReview.mock.calls[0][0]).toMatchObject({
      userId: MOD_USER.id,
      scope: 'full',
    });
  });

  it('non-mod app-dev-tester (holds `app-listings`) also resolves `full`', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(TESTER_USER) as never);
    await caller.upsertReview({ appListingId: ONSITE_LISTING, recommended: true });
    expect(mockUpsertReview.mock.calls[0][0]).toMatchObject({ scope: 'full' });
  });

  it('a full-scope viewer reaches getMyReview with scope `full`', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(MOD_USER) as never);
    await caller.getMyReview({ appListingId: ONSITE_LISTING });
    expect(mockGetMyReview).toHaveBeenCalledWith(ONSITE_LISTING, MOD_USER.id, { scope: 'full' });
  });
});

// ---------------------------------------------------------------------------
// STILL REJECTED — `none` is the only scope the gate itself refuses.
// ---------------------------------------------------------------------------

describe('none-scope viewers are still rejected', () => {
  it('upsertReview → UNAUTHORIZED, service NEVER consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(DARK_USER) as never);
    await expect(
      caller.upsertReview({ appListingId: OFFSITE_LISTING, recommended: true })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });

  it('getMyReview → UNAUTHORIZED, service NEVER consulted', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(DARK_USER) as never);
    await expect(caller.getMyReview({ appListingId: OFFSITE_LISTING })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetMyReview).not.toHaveBeenCalled();
  });

  it('anonymous → rejected by protectedProcedure before the scope gate runs', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(
      caller.upsertReview({ appListingId: OFFSITE_LISTING, recommended: true })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The read path is untouched by this change.
// ---------------------------------------------------------------------------

describe('listReviews (read) is unaffected', () => {
  it('external-only cohort still gets its reviews page served with its own scope', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(EXTERNAL_TESTER) as never);
    await expect(caller.listReviews({ appListingId: OFFSITE_LISTING })).resolves.toEqual({
      items: [{ id: 8801 }],
      nextCursor: undefined,
    });
    expect(mockListReviews.mock.calls[0][1]).toEqual({ scope: 'public-external' });
  });

  it('a full-scope viewer is served with scope `full`', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(TESTER_USER) as never);
    await expect(caller.listReviews({ appListingId: ONSITE_LISTING })).resolves.toEqual({
      items: [{ id: 8801 }],
      nextCursor: undefined,
    });
    expect(mockListReviews.mock.calls[0][1]).toEqual({ scope: 'full' });
  });

  it('a none-scope viewer still gets an EMPTY page (soft), never a throw', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(DARK_USER) as never);
    await expect(caller.listReviews({ appListingId: OFFSITE_LISTING })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(mockListReviews).not.toHaveBeenCalled();
  });

  it('anonymous still gets an EMPTY page (soft), never throws', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listReviews({ appListingId: OFFSITE_LISTING })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(mockListReviews).not.toHaveBeenCalled();
  });
});
