import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type * as AppCustomEventsModule from '~/server/services/blocks/app-custom-events.service';

/**
 * `blocks.getMyAppCustomEvents` — the Custom events card's own procedure. Asserts the ROUTER
 * wiring: the same gate chain and scope as `getMyAppAnalytics`, the session user threaded into
 * the service, input validation, and that `getMyAppAnalytics` itself no longer carries any
 * custom-events input or key. The service is mocked at the boundary; its ownership-before-query
 * behaviour is covered in `app-custom-events.service.test.ts`. The mock skeleton is copied from
 * `blocks.router.getMyAppAnalytics.test.ts`.
 */

const {
  mockIsAppBlocksEnabled,
  mockGetMyAppAnalytics,
  mockGetRevenueForOwner,
  mockGetRecentAttributionsForOwner,
  mockGetGoodsSalesForOwner,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
  mockGetMyAppCustomEvents,
} = vi.hoisted(() => ({
  mockGetMyAppCustomEvents: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetMyAppAnalytics: vi.fn(),
  mockGetRevenueForOwner: vi.fn(),
  mockGetRecentAttributionsForOwner: vi.fn(),
  mockGetGoodsSalesForOwner: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/app-custom-events.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppCustomEventsModule>()),
  getMyAppCustomEvents: (...a: unknown[]) => mockGetMyAppCustomEvents(...a),
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
// 🔴 SPREAD + OVERRIDES, not a hand-listed factory. This suite DOES assert revenue, so it
// needs the three reads stubbed — but a factory that lists only those fails to LOAD the
// moment `blocks.router` imports one more export from this module: in CI, in a file nobody
// was looking at, with a green typecheck. It already had to be edited twice for exactly
// that (`getGoodsSalesForOwner`, then `unreadableGoodsSales` + `isMissingGoodsTableError`).
//
// The spread also keeps the PURE helpers real, which is strictly better than copying them:
// the unreadable-path test below then exercises the actual `unreadableGoodsSales()` shape
// and the actual `isMissingGoodsTableError` predicate, so neither can drift from the copy
// a hand-listed factory would have had to carry. `emptyRevenue()` is real for the same
// reason — it is the function whose `unavailable` discriminator the flag-off test asserts.
vi.mock('~/server/services/blocks/buzz-attribution.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getRevenueForOwner: (...a: unknown[]) => mockGetRevenueForOwner(...a),
  getRecentAttributionsForOwner: (...a: unknown[]) => mockGetRecentAttributionsForOwner(...a),
  getGoodsSalesForOwner: (...a: unknown[]) => mockGetGoodsSalesForOwner(...a),
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
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
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
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';

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
  mockGetGoodsSalesForOwner.mockReset();
  mockGetGoodsSalesForOwner.mockResolvedValue({
    sales: {
      count: 0,
      grossBuzz: 0,
      shareBuzz: 0,
      shareUsdCents: 0,
      grossUsdCents: 0,
      blueGrossBuzz: 0,
    },
    refunded: { count: 0, grossBuzz: 0 },
  });
});

const SECTION = {
  declared: [],
  includeOwner: false,
  topEvents: [],
  undeclaredDrops: 6,
  range: { from: new Date(0), to: new Date(0), granularity: 'day' as const },
};

beforeEach(() => {
  mockGetMyAppCustomEvents.mockReset();
  mockGetMyAppCustomEvents.mockResolvedValue(SECTION);
});

describe('getMyAppCustomEvents — gate and delegation', () => {
  it('moderator: threads the session user and the inputs into the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppCustomEvents({
      appBlockId: 'apb_1',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-21T00:00:00.000Z',
      includeOwner: true,
      event: 'generate_clicked',
    });
    expect(result).toBe(SECTION);
    expect(mockGetMyAppCustomEvents).toHaveBeenCalledTimes(1);
    expect(mockGetMyAppCustomEvents).toHaveBeenCalledWith({
      userId: modUser.id,
      appBlockId: 'apb_1',
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-21T00:00:00.000Z'),
      includeOwner: true,
      event: 'generate_clicked',
    });
  });

  it('non-moderator: rejected before the service runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getMyAppCustomEvents({ appBlockId: 'apb_1' })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });

  it('anonymous: rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getMyAppCustomEvents({ appBlockId: 'apb_1' })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });

  it('flag OFF: a denied, unavailable section and no read', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const result = await blocksRouter
      .createCaller(fakeCtx(modUser) as never)
      .getMyAppCustomEvents({ appBlockId: 'apb_1', event: 'generate_clicked' });
    expect(result.denied).toBe('notEntitled');
    expect(result.unavailable).toBe(true);
    expect(result.topEvents).toEqual([]);
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });

  it('a token without AppBlocksSubmit is refused, like getMyAppAnalytics', async () => {
    const ctx = { ...fakeCtx(modUser), tokenScope: TokenScope.UserRead };
    await expect(
      blocksRouter.createCaller(ctx as never).getMyAppCustomEvents({ appBlockId: 'apb_1' })
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      blocksRouter.createCaller(ctx as never).getMyAppAnalytics({ appBlockId: 'apb_1' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });
});

describe('getMyAppCustomEvents — input validation', () => {
  it.each([
    ['the drop marker', '__undeclared__'],
    ['an upper-case name', 'Generate'],
    ['a dashed name', 'generate-clicked'],
    ['a name over 64 characters', `a${'b'.repeat(64)}`],
    ['an empty name', ''],
  ])('rejects %s as `event`', async (_label, event) => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.getMyAppCustomEvents({ appBlockId: 'apb_1', event })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });

  it('accepts a 64-character name', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const event = `a${'b'.repeat(63)}`;
    await caller.getMyAppCustomEvents({ appBlockId: 'apb_1', event });
    expect(mockGetMyAppCustomEvents.mock.calls[0][0].event).toBe(event);
  });

  it('requires an app id', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getMyAppCustomEvents({} as never)).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean includeOwner', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.getMyAppCustomEvents({ appBlockId: 'apb_1', includeOwner: 'yes' as never })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });
});

describe('getMyAppAnalytics carries no custom-events input', () => {
  it("custom-events keys are stripped: the service gets exactly main's arguments", async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getMyAppAnalytics({
      appBlockId: 'apb_1',
      includeOwner: true,
      event: 'generate_clicked',
      withCustomEvents: true,
    } as never);
    const args = mockGetMyAppAnalytics.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(['appBlockId', 'from', 'to', 'userId']);
    expect(args).toEqual({
      userId: modUser.id,
      appBlockId: 'apb_1',
      from: undefined,
      to: undefined,
    });
    expect(mockGetMyAppCustomEvents).not.toHaveBeenCalled();
  });
});
