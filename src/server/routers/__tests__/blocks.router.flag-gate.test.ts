import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * H2 — `enforceAppBlocksFlag` middleware threads the request user's context
 * into the App Blocks flag gate.
 *
 * `isAppBlocksEnabled` is mocked with a FAITHFUL per-user implementation
 * (mirrors the live `moderators`-segmented flag: ON only when the supplied
 * user is a moderator). The test then drives the real blocks router so the
 * middleware's `{ user: ctx.user }` wiring is what decides the outcome:
 *   - moderator → query proceeds (registry consulted), mutation allowed;
 *   - non-mod   → query returns [] (disabled), mutation UNAUTHORIZED;
 *   - anon      → query returns [] (disabled), mutation UNAUTHORIZED.
 *
 * This is the no-widening invariant proven through the actual router path.
 *
 * The mock set mirrors `blocks.router.workflow.test.ts` — the heavy services
 * (orchestrator, buzz, redis, registry, user.service) are stubbed so importing
 * the router doesn't drag in the generated Prisma client / selectors (stale in
 * a PR worktree).
 */

const {
  mockIsAppBlocksEnabled,
  mockListForModel,
  mockListAvailable,
  mockInstallOnModel,
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
  mockListForModel: vi.fn(),
  mockListAvailable: vi.fn(),
  mockInstallOnModel: vi.fn(),
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
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
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
    listForModel: (...a: unknown[]) => mockListForModel(...a),
    listAvailable: (...a: unknown[]) => mockListAvailable(...a),
    installOnModel: (...a: unknown[]) => mockInstallOnModel(...a),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
// rateLimit pulls in redis + heavy deps; the gate under test is the flag
// middleware, so stub rateLimit to a pass-through middleware. (The real
// rate-limit middleware is exercised end-to-end by the live stack, not here.)
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Faithful mod-segmented flag: ON iff the supplied user is a moderator. No user
// (anon machine path) → false. Mirrors the live `app-blocks-enabled` rule.
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
    // ctx.features.appBlocks mirrors the client gate. For the listForModel
    // happy path we set it true for the mod so the registry is reached; the
    // middleware gate is the unit under test.
    features: { appBlocks: !!(user as { isModerator?: boolean })?.isModerator } as never,
    track: undefined,
  };
}

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockListForModel.mockReset();
  mockListForModel.mockResolvedValue([{ id: 'blk_1' }]);
  mockListAvailable.mockReset();
  mockListAvailable.mockResolvedValue({ items: [{ id: 'ab_1' }], nextCursor: undefined });
  mockInstallOnModel.mockReset();
  mockInstallOnModel.mockResolvedValue({ id: 'install_1' });
});

const listInput = { modelId: 7, slotId: 'model.sidebar_top' as const };

describe('enforceAppBlocksFlag — query (listForModel)', () => {
  it('moderator: gate passes, registry is consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.listForModel(listInput);
    expect(result).toEqual([{ id: 'blk_1' }]);
    expect(mockListForModel).toHaveBeenCalledTimes(1);
    // Threaded the session user into the gate.
    expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({ user: modUser });
  });

  it('non-moderator: gate disables → [] (no-widening), registry NOT consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    const result = await caller.listForModel(listInput);
    expect(result).toEqual([]);
    expect(mockListForModel).not.toHaveBeenCalled();
    expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({ user: normalUser });
  });

  it('anonymous: gate disables → [] (no-widening), registry NOT consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listForModel(listInput);
    expect(result).toEqual([]);
    expect(mockListForModel).not.toHaveBeenCalled();
    expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({ user: undefined });
  });
});

describe('listAvailable — anon-capable read path, dark behind the flag gate (F-E E1)', () => {
  it('anonymous WITHOUT the flag: gate disables → empty (dark today), registry NOT consulted', async () => {
    // Real anon today: the mod-segmented flag can never match without a mod
    // context, so the middleware sets _appBlocksDisabled → empty. This is the
    // "dark" invariant — removing the old hardcoded isModerator gate did NOT
    // widen access; the flag gate is the real control.
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailable).not.toHaveBeenCalled();
    expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({ user: undefined });
  });

  it('non-mod WITHOUT the flag: gate disables → empty, registry NOT consulted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [], nextCursor: undefined });
    expect(mockListAvailable).not.toHaveBeenCalled();
  });

  it('anonymous WITH the flag granted (the dark path, lit): registry IS consulted', async () => {
    // Simulate the post-launch segment widen: the flag resolves ON even with no
    // user. The procedure must then serve the anon caller (no session) — proving
    // it is anon-CAPABLE, not just mod-only. listAvailable is publicProcedure;
    // there is NO secondary isModerator gate left to block this.
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [{ id: 'ab_1' }], nextCursor: undefined });
    expect(mockListAvailable).toHaveBeenCalledTimes(1);
  });

  it('moderator: gate passes, registry IS consulted (mods-only is the live state)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.listAvailable({ limit: 20 });
    expect(result).toEqual({ items: [{ id: 'ab_1' }], nextCursor: undefined });
    expect(mockListAvailable).toHaveBeenCalledTimes(1);
  });
});

describe('enforceAppBlocksFlag — mutation (installOnModel)', () => {
  const installInput = { modelId: 7, appBlockId: 'app_1', slotId: 'model.sidebar_top' as const };

  it('non-moderator: rejected before the mutation runs (no-widening)', async () => {
    // moderatorProcedure also gates on isModerator; either gate refusing is
    // acceptable — the invariant is that a non-mod cannot reach the mutation.
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.installOnModel(installInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockInstallOnModel).not.toHaveBeenCalled();
  });

  it('anonymous: rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.installOnModel(installInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockInstallOnModel).not.toHaveBeenCalled();
  });
});

describe('enforceAppBlocksFlag — mod query (getPublishRequestScreenshots, E5 Low-2)', () => {
  // The new mod-review screenshot query is moderatorProcedure + enforceAppBlocksFlag;
  // a non-mod / anon caller must be rejected before the query body reaches (mod-only).
  const input = { publishRequestId: 'pr_1' };

  it('non-moderator: rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getPublishRequestScreenshots(input)).rejects.toBeInstanceOf(TRPCError);
  });

  it('anonymous: rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getPublishRequestScreenshots(input)).rejects.toBeInstanceOf(TRPCError);
  });
});
