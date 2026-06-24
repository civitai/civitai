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
  emptyAnalytics: (range: unknown, notOwned: boolean) => ({
    range,
    notOwned,
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
    expect(result.notOwned).toBe(false);
    expect(result.installs).toEqual({ total: 0, active: 0, series: [] });
    expect(result.runs).toEqual({ count: 0, buzzSpent: 0, series: [] });
    expect(result.buzzPurchased).toEqual({ count: 0, buzzAmount: 0, grossCents: 0 });
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
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
