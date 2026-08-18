import { beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, so they are erased and safe to reference from the hoisted `vi.mock`
// factories below (and `@typescript-eslint/consistent-type-imports` bans the inline
// `typeof import(...)` form the older sibling suites use).
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as EnvOther from '~/env/other';

/**
 * civitai/civitai#4003 — `appListings.getMyListingForApp` is RATE-LIMITED, enforced.
 *
 * The proc's slug arm resolves any top-level listing and distinguishes "not yours"
 * (NOT_OWNED→FORBIDDEN) from "no such row" (NOT_FOUND), so an unlimited `.query` is a
 * slug-existence oracle over the whole namespace. `.use(rateLimit({ limit: 60,
 * period: 60 }))` meters it.
 *
 * 🔴 This file deliberately does NOT mock `~/server/middleware.trpc` — every sibling
 * router test stubs `rateLimit` to a pass-through, which is exactly what makes those
 * suites blind to whether the middleware is wired at all. Here the REAL middleware
 * runs, against the globally-mocked redis client, so the assertions are about the
 * procedure's own chain.
 *
 * Two things had to be defeated for the limiter to be reachable at all, and both are
 * why a naive "call it 61 times" test would pass with the middleware DELETED:
 *   - `rateLimit` early-returns when `isDev || isTest || isPreview` → `~/env/other` is
 *     mocked with `isTest: false` (everything else actual).
 *   - it also early-returns for moderators → the caller is a NON-mod author from the
 *     tester cohort, with `getFeatureFlags().appBlocksAuthor` mocked true for them.
 *
 * The matrix pins BOTH numbers rather than just "it can throw":
 *   - 61 attempts spread across the last 59s → TOO_MANY_REQUESTS  (kills limit > 60,
 *     and kills a SHORTER period, which would age most of that spread out)
 *   - 60 attempts across the same window     → resolves           (kills limit < 60)
 *   - 200 attempts, all 90–120s old          → resolves           (kills a LONGER
 *     period, e.g. the 3600 the write procs use, which would count every one)
 *
 * The window arithmetic is `attempts > limit` in the middleware (strictly greater), so
 * 60 recorded attempts is the last passing state and 61 is the first refusal.
 */

const AUTHOR_IDS = new Set([2]); // non-mod app-dev-tester cohort

const { mockGetMyListingForApp, mockHSetWithTTL, mockIsAppBlocksAuthorEnabled } = vi.hoisted(
  () => ({
    mockGetMyListingForApp: vi.fn(async () => ({ appListingId: 'apl_1', status: 'draft' })),
    mockHSetWithTTL: vi.fn(async () => undefined),
    mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  })
);

vi.mock('~/server/services/blocks/offsite-listing.service', () => ({
  getMyListingForApp: mockGetMyListingForApp,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
  isAppListingsEnabled: vi.fn(async () => true),
  resolveStoreVisibilityScope: vi.fn(async () => 'full'),
}));
// `appDeveloperProcedure` gates on `getFeatureFlags(ctx).appBlocksAuthor`; the cohort
// rule mirrors the sibling authz suite (mod floor OR the tester cohort).
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
// The one lever that makes the limiter run at all under vitest.
vi.mock('~/env/other', async () => ({
  ...(await vi.importActual<typeof EnvOther>('~/env/other')),
  isDev: false,
  isTest: false,
  isPreview: false,
}));
// The quota WRITE. Stubbed so the sliding-window read is the only thing under test
// (and so a fail-open log line can't be mistaken for the limiter working).
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { TRPCError } from '@trpc/server';
import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockHGet = redisMock.redis.packed.hGet;

const author = { id: 2, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };

function authorCtx() {
  return {
    acceptableOrigin: true,
    user: author as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

/** `n` recorded attempts spread evenly across the `spanMs` immediately before now. */
function attemptsSpanning(n: number, spanMs: number, offsetMs = 0) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => now - offsetMs - Math.round((spanMs * i) / n));
}

function call() {
  return appListingsRouter.createCaller(authorCtx() as never).getMyListingForApp({
    appBlockId: 'apb_1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMyListingForApp.mockResolvedValue({ appListingId: 'apl_1', status: 'draft' });
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
  mockHGet.mockResolvedValue([]);
});

describe('getMyListingForApp — the rate limit is ENFORCED (civitai#4003)', () => {
  it('refuses with TOO_MANY_REQUESTS once the window holds more than 60 attempts', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(61, 59_000));

    const err = await call().then(
      () => null,
      (e: unknown) => e as TRPCError
    );

    expect(err).toBeInstanceOf(TRPCError);
    expect(err?.code).toBe('TOO_MANY_REQUESTS');
    expect(err?.message).toBe('Too many listing lookups — slow down.');
    // The refusal happens BEFORE the resolve — no row is read for a metered probe.
    expect(mockGetMyListingForApp).not.toHaveBeenCalled();
  });

  it('still serves the 60th attempt in the window (the limit is 60, not lower)', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(60, 59_000));

    await expect(call()).resolves.toEqual({ appListingId: 'apl_1', status: 'draft' });
    expect(mockGetMyListingForApp).toHaveBeenCalledTimes(1);
  });

  it('ages attempts out after 60s — 200 older ones do not refuse (the period is 60, not hourly)', async () => {
    // 200 attempts, every one between 90s and 120s ago: outside a 60s window, inside
    // any longer one. A period of 3600 (this router's write shape) would refuse here.
    mockHGet.mockResolvedValue(attemptsSpanning(200, 30_000, 90_000));

    await expect(call()).resolves.toEqual({ appListingId: 'apl_1', status: 'draft' });
    expect(mockGetMyListingForApp).toHaveBeenCalledTimes(1);
  });

  it('records the served attempt against the caller quota', async () => {
    mockHGet.mockResolvedValue([]);

    await call();

    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1);
    // Bucketed by user id, not by IP — the author is authenticated.
    expect(mockHSetWithTTL.mock.calls[0]?.[2]).toBe(`user:${author.id}`);
  });

  it('does not record an attempt for a refused call beyond recording nothing new', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(61, 59_000));

    await expect(call()).rejects.toThrow();

    expect(mockHSetWithTTL).not.toHaveBeenCalled();
  });
});
