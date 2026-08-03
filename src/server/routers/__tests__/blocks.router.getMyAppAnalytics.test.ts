import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Phase 0 author-analytics proc — gate + delegation + input validation.
 *
 * Same mock skeleton as blocks.router.flag-gate.test.ts (heavy services
 * stubbed so importing the router doesn't drag in the stale generated
 * Prisma client). The analytics SERVICE is mocked at the boundary — this
 * test asserts the ROUTER wiring:
 *   - moderatorProcedure + enforceAppBlocksFlag gate (non-mod / anon rejected,
 *     dark behind the appBlocks flag);
 *   - the caller's session user id is threaded into the service (ownership is
 *     enforced inside the service, covered by app-analytics.service.test.ts);
 *   - the zod input is validated (appBlockId length cap, from/to datetime).
 */

const {
  mockIsAppBlocksEnabled,
  mockGetMyAppAnalytics,
  mockGetRevenueForOwner,
  mockGetRecentAttributionsForOwner,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
  mockLogToAxiom,
  mockRedis,
  mockSysRedis,
  mockDbRead,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetMyAppAnalytics: vi.fn(),
  mockGetRevenueForOwner: vi.fn(),
  mockGetRecentAttributionsForOwner: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockRedis: { get: vi.fn(), set: vi.fn() },
  mockSysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  mockDbRead: {
    modelVersion: { findUnique: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    appBlock: { findMany: vi.fn() },
    blockBuzzAttribution: { groupBy: vi.fn() },
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/app-analytics.service', () => ({
  getMyAppAnalytics: (...a: unknown[]) => mockGetMyAppAnalytics(...a),
  // emptyAnalytics + resolveRange are pure (no DB) — use the real ones so the
  // flag-off short-circuit returns the genuine zeroed shape.
  emptyAnalytics: (
    range: unknown,
    notOwned: boolean,
    unavailable: string | undefined = notOwned ? 'notOwned' : undefined
  ) => ({
    range,
    notOwned,
    ...(unavailable ? { unavailable } : {}),
    installs: { total: 0, active: 0, series: [] },
    runs: { count: 0, buzzSpent: 0, series: [] },
    buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
    engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
  }),
  resolveRange: () => ({ from: new Date(0), to: new Date(0), granularity: 'day' as const }),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  getRevenueForOwner: (...a: unknown[]) => mockGetRevenueForOwner(...a),
  getRecentAttributionsForOwner: (...a: unknown[]) => mockGetRecentAttributionsForOwner(...a),
  emptyRevenue: () => ({
    summary: {
      pending: { count: 0, grossCents: 0, shareCents: 0 },
      confirmed: { count: 0, grossCents: 0, shareCents: 0 },
      paidOut: { count: 0, grossCents: 0, shareCents: 0 },
      voided: { count: 0, grossCents: 0 },
    },
    topApps: [],
    recentAttributions: [],
  }),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  return { ...actual, redis: mockRedis, sysRedis: mockSysRedis };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
    features: { appBlocks: !!(user as { isModerator?: boolean })?.isModerator } as never,
    track: undefined,
  };
}

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

const SENTINEL = {
  range: { from: new Date(), to: new Date(), granularity: 'day' as const },
  notOwned: false,
  installs: { total: 0, active: 0, series: [] },
  runs: { count: 0, buzzSpent: 0, series: [] },
  buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
  engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockGetMyAppAnalytics.mockReset();
  mockGetMyAppAnalytics.mockResolvedValue(SENTINEL);
  mockGetRevenueForOwner.mockReset();
  mockGetRevenueForOwner.mockResolvedValue({ summary: {}, topApps: [] });
  mockGetRecentAttributionsForOwner.mockReset();
  mockGetRecentAttributionsForOwner.mockResolvedValue([]);
});

describe('getMyAppAnalytics — gate', () => {
  it('moderator: gate passes, service called with the session user id', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppAnalytics({ appBlockId: 'apb_1' });
    expect(result).toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
    const args = mockGetMyAppAnalytics.mock.calls[0][0];
    expect(args.userId).toBe(modUser.id);
    expect(args.appBlockId).toBe('apb_1');
  });

  it('non-moderator: rejected before the service runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getMyAppAnalytics({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('anonymous: rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getMyAppAnalytics({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('flag OFF (even for a moderator): returns zeroed analytics + runs NO aggregate', async () => {
    // moderatorProcedure passes (mod), but the appBlocks flag is OFF →
    // enforceAppBlocksFlag marks _appBlocksDisabled on the query ctx → the proc
    // short-circuits to the empty shape and never touches the aggregate service.
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppAnalytics({ appBlockId: 'apb_1' });
    expect(result.installs).toEqual({ total: 0, active: 0, series: [] });
    expect(result.runs).toEqual({ count: 0, buzzSpent: 0, series: [] });
    expect(result.buzzPurchased).toEqual({ count: 0, buzzAmount: 0, grossCents: 0 });
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('flag OFF: the zeroed payload is FLAGGED unavailable, not passed off as data', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppAnalytics({ appBlockId: 'apb_1' });
    expect(result.unavailable).toBe('notEntitled');
    // Fail-closed on the legacy field too: a client that only guards on
    // `notOwned` (civitai/cli#190) must refuse to render this payload.
    expect(result.notOwned).toBe(true);
  });

  it('DISCRIMINATOR: a dark-flag zero is distinguishable from a genuine owned-but-empty zero', async () => {
    // Both payloads have byte-identical all-zero counters and the same range —
    // that is exactly the confusion this proc used to ship. The ONLY thing a
    // client can branch on is the discriminator, so pin it from both sides.
    const range = { from: new Date(0), to: new Date(0), granularity: 'day' as const };
    const genuineZero = {
      range,
      notOwned: false,
      installs: { total: 0, active: 0, series: [] },
      runs: { count: 0, buzzSpent: 0, series: [] },
      buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
      engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
    };
    mockGetMyAppAnalytics.mockResolvedValue(genuineZero);

    const owned = await blocksRouter
      .createCaller(fakeCtx(modUser) as never)
      .getMyAppAnalytics({ appBlockId: 'apb_1' });

    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const dark = await blocksRouter
      .createCaller(fakeCtx(modUser) as never)
      .getMyAppAnalytics({ appBlockId: 'apb_1' });

    // Precondition: the counters really are identical, so nothing else could
    // tell these apart.
    expect(dark.installs).toEqual(owned.installs);
    expect(dark.runs).toEqual(owned.runs);
    expect(dark.buzzPurchased).toEqual(owned.buzzPurchased);
    expect(dark.engagement).toEqual(owned.engagement);

    // A genuinely-measured empty app is NOT flagged; the dark-flag one is.
    expect(owned.unavailable).toBeUndefined();
    expect(dark.unavailable).toBe('notEntitled');
    expect(owned.notOwned).toBe(false);
    expect(dark.notOwned).toBe(true);
    expect(dark).not.toEqual(owned);
  });
});

describe('getMyAppAnalytics — input validation & delegation', () => {
  it('threads optional from/to (parsed to Date) into the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getMyAppAnalytics({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-21T00:00:00.000Z',
    });
    const args = mockGetMyAppAnalytics.mock.calls[0][0];
    expect(args.from).toBeInstanceOf(Date);
    expect(args.to).toBeInstanceOf(Date);
    expect(args.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('rejects an over-long appBlockId (zod max 64)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.getMyAppAnalytics({ appBlockId: 'x'.repeat(65) })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('rejects a non-datetime `from`', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.getMyAppAnalytics({ from: 'not-a-date' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });
});

describe('getMyRevenue — dark-flag short-circuit', () => {
  it('flag ON (moderator): runs the revenue aggregate', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });
    expect(mockGetRevenueForOwner).toHaveBeenCalledTimes(1);
    expect(result.recentAttributions).toEqual([]);
  });

  it('flag OFF (even for a moderator): returns zeroed revenue + runs NO query', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });
    expect(result.topApps).toEqual([]);
    expect(result.recentAttributions).toEqual([]);
    expect(result.summary.confirmed).toEqual({ count: 0, grossCents: 0, shareCents: 0 });
    expect(mockGetRevenueForOwner).not.toHaveBeenCalled();
    expect(mockGetRecentAttributionsForOwner).not.toHaveBeenCalled();
  });
});

/**
 * OAuth token-scope gate on getMyAppAnalytics — the proc `civitai app metrics`
 * calls. It was UN-annotated, so `enforceTokenScope` implicitly required
 * `TokenScope.Full`: a personal API key worked but the `civitai login` OAuth token
 * (the CLI's default auth path) 403'd. Now
 * `.meta({ requiredScope: TokenScope.AppBlocksSubmit })` — the same bit
 * `GET /api/v1/blocks/submissions` requires, which the same command already calls
 * to resolve slug → appBlockId. Mirrors app-listings.router.cli-scope.test.ts.
 *
 * Bitmasks are hard-coded so an enum drift trips the sanity test rather than
 * silently re-pointing the gate.
 *
 * 🔴 WHICH OF THESE IS ACTUAL REGRESSION COVERAGE — measured, not assumed. With the
 * `.meta` line deleted, ONLY 'CLI OAuth login token … reaches the service' goes red,
 * and it fails with this gate's own error ("Your API key does not have the required
 * scope for this action", enforce-token-scope.ts:84) — the exact 403 this change
 * fixes. The other three stay GREEN on pre-change code and are INVARIANT guards, not
 * regression guards:
 *   - NO_SUBMIT was already FORBIDDEN before, because an un-annotated proc implicitly
 *     requires `Full` and that token lacks Full too. It pins that narrowing the gate
 *     did not accidentally WIDEN it — a different property, worth keeping, but it
 *     would not have caught the original bug.
 *   - the Full-key and session cases pin no-regression, and passed before by
 *     construction.
 * Do not read four green tests here as four tests of the fix.
 */
const FULL = 33554431; // TokenScope.Full — a Full personal API key
const CLI = 1 | (1 << 25) | (1 << 26); // UserRead|AppBlocksSubmit|AppBlocksDevTunnel = 100663297
const NO_SUBMIT = 1 | (1 << 26); // UserRead|AppBlocksDevTunnel = 67108865 — lacks AppBlocksSubmit

// A token-authenticated caller (apiKeyId set) carrying `scope`. The user stays a
// moderator so the author/flag gates are satisfied and the ONLY variable is scope.
function tokenCtx(scope: number) {
  return { ...fakeCtx(modUser), apiKeyId: 999, tokenScope: scope };
}

describe('getMyAppAnalytics — OAuth scope gate', () => {
  it('the hard-coded bitmasks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(1 << 25);
    expect(TokenScope.UserRead | TokenScope.AppBlocksSubmit | TokenScope.AppBlocksDevTunnel).toBe(
      CLI
    );
    expect(TokenScope.UserRead | TokenScope.AppBlocksDevTunnel).toBe(NO_SUBMIT);
    // Full deliberately EXCLUDES AppBlocksSubmit — so it is enforceTokenScope's
    // early-return on Full, NOT hasFlag(Full, AppBlocksSubmit), that preserves the
    // existing personal-API-key path. If someone ever folds bit 25 into Full, this
    // fails and the reasoning above has to be revisited.
    expect((TokenScope.Full & TokenScope.AppBlocksSubmit) === TokenScope.AppBlocksSubmit).toBe(
      false
    );
  });

  it('CLI OAuth login token (carries AppBlocksSubmit) reaches the service', async () => {
    const caller = blocksRouter.createCaller(tokenCtx(CLI) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).resolves.toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
  });

  it('Full personal API key still reaches the service (no regression)', async () => {
    const caller = blocksRouter.createCaller(tokenCtx(FULL) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).resolves.toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
  });

  it('a scoped token WITHOUT AppBlocksSubmit is FORBIDDEN and never reaches the service', async () => {
    const caller = blocksRouter.createCaller(tokenCtx(NO_SUBMIT) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('scope'),
    });
    // The denial must come from the SCOPE gate, before any aggregate runs — not from
    // the author/flag gate, which this ctx satisfies.
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('a session (no bearer token) is unaffected — the web panel path', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).resolves.toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
  });
});
