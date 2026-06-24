import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * `getNavSummary` — the lightweight booleans that drive the conditional tabs in
 * the apps sub-nav (`AppsSubNav`). This test asserts the ROUTER wiring:
 *   - protectedProcedure + enforceAppBlocksFlag gate (anon rejected; flag-off
 *     returns the all-false shape and runs NO query);
 *   - each existence check is a `findFirst` scoped to `ctx.user.id` (no
 *     cross-user leakage);
 *   - the returned booleans reflect presence/absence per table;
 *   - `isReviewer` is derived from the session user (real `isAppReviewer`,
 *     which is `isModerator`-only).
 *
 * Same mock skeleton as blocks.router.getMyAppAnalytics.test.ts (heavy services
 * stubbed so importing the router doesn't drag in the stale generated Prisma
 * client). The three nav-summary tables are mocked on `dbRead` at the boundary.
 */

const {
  mockIsAppBlocksEnabled,
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
    appBlock: { findMany: vi.fn(), findFirst: vi.fn() },
    appBlockPublishRequest: { findFirst: vi.fn() },
    blockUserSubscription: { findFirst: vi.fn() },
    blockBuzzAttribution: { groupBy: vi.fn() },
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/app-analytics.service', () => ({
  getMyAppAnalytics: vi.fn(),
  emptyAnalytics: vi.fn(),
  resolveRange: vi.fn(),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  getRevenueForOwner: vi.fn(),
  getRecentAttributionsForOwner: vi.fn(),
  emptyRevenue: vi.fn(),
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
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: { BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } },
  REDIS_SYS_KEYS: { BLOCKS: { BUZZ_CAP: 'system:blocks:buzz-cap' } },
}));
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
    listUserSubscriptions: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// enforceAppBlocksFlag gates on isAppBlocksEnabled({ user }); the live flag is
// base-false with a moderators segment. Model that: flag ON iff user is a mod.
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

// App Blocks is mod-only pre-GA, so a flag-on user is a moderator → isReviewer
// is true for these. (`isAppReviewer` is the real impl = isModerator-only.)
const modUser = { id: 7, isModerator: true, tier: 'free', username: 'mod' };
const otherModUser = { id: 99, isModerator: true, tier: 'free', username: 'mod2' };

const ALL_FALSE = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockDbRead.blockUserSubscription.findFirst.mockReset();
  mockDbRead.appBlockPublishRequest.findFirst.mockReset();
  mockDbRead.appBlock.findFirst.mockReset();
  // Default: nothing exists for anyone.
  mockDbRead.blockUserSubscription.findFirst.mockResolvedValue(null);
  mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  mockDbRead.appBlock.findFirst.mockResolvedValue(null);
});

describe('getNavSummary — gate', () => {
  it('anonymous: rejected (protectedProcedure) before any query runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getNavSummary()).rejects.toBeInstanceOf(TRPCError);
    expect(mockDbRead.blockUserSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('flag OFF: returns the all-false shape and runs NO existence query', async () => {
    // A logged-in non-mod has the appBlocks flag dark → enforceAppBlocksFlag
    // marks _appBlocksDisabled on the query ctx → the proc short-circuits.
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result).toEqual(ALL_FALSE);
    expect(mockDbRead.blockUserSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });
});

describe('getNavSummary — booleans reflect existence', () => {
  it('user with NONE of {installs, submissions, approved apps}: all-false except isReviewer (mod)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result).toEqual({
      hasInstalls: false,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: true, // flag-on user is a mod pre-GA
    });
  });

  it('hasInstalls true ONLY when a subscription row exists', async () => {
    mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasInstalls).toBe(true);
    expect(result.hasSubmissions).toBe(false);
    expect(result.hasApprovedApps).toBe(false);
  });

  it('hasSubmissions true ONLY when a publish-request row exists', async () => {
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pr_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasSubmissions).toBe(true);
    expect(result.hasInstalls).toBe(false);
    expect(result.hasApprovedApps).toBe(false);
  });

  it('hasApprovedApps true ONLY when an approved owned app exists', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue({ id: 'apb_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result.hasApprovedApps).toBe(true);
    expect(result.hasInstalls).toBe(false);
    expect(result.hasSubmissions).toBe(false);
  });

  it('all three present: every flag true', async () => {
    mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pr_1' });
    mockDbRead.appBlock.findFirst.mockResolvedValue({ id: 'apb_1' });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getNavSummary();
    expect(result).toEqual({
      hasInstalls: true,
      hasSubmissions: true,
      hasApprovedApps: true,
      isReviewer: true,
    });
  });
});

describe('getNavSummary — own-data scoping (no cross-user)', () => {
  it('each existence check is scoped to ctx.user.id + selects only id (LIMIT 1)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(otherModUser) as never);
    await caller.getNavSummary();

    const subArgs = mockDbRead.blockUserSubscription.findFirst.mock.calls[0][0];
    expect(subArgs.where).toEqual({ userId: otherModUser.id });
    expect(subArgs.select).toEqual({ id: true });

    const prArgs = mockDbRead.appBlockPublishRequest.findFirst.mock.calls[0][0];
    expect(prArgs.where).toEqual({ submittedByUserId: otherModUser.id });
    expect(prArgs.select).toEqual({ id: true });

    const appArgs = mockDbRead.appBlock.findFirst.mock.calls[0][0];
    expect(appArgs.where).toEqual({ app: { userId: otherModUser.id }, status: 'approved' });
    expect(appArgs.select).toEqual({ id: true });
  });

  it('approved-app check filters on status=approved (not pending/rejected apps)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getNavSummary();
    const appArgs = mockDbRead.appBlock.findFirst.mock.calls[0][0];
    expect(appArgs.where.status).toBe('approved');
  });

  it('uses findFirst (existence), never count — count({take:1}) is a full COUNT(*)', async () => {
    // Regression guard for the audit fix: the proc must use findFirst, not
    // count. If a `count` mock is referenced the call would be undefined here.
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getNavSummary();
    expect(mockDbRead.blockUserSubscription.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appBlockPublishRequest.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appBlock.findFirst).toHaveBeenCalledTimes(1);
  });
});
