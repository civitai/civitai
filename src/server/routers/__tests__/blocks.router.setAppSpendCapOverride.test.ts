import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.setAppSpendCapOverride` / `blocks.getAppSpendCapOverride` — the
 * MOD-ONLY surface for the per-app generation spend/velocity cap override.
 *
 * 🔴 THE INVARIANT UNDER TEST: an app (or its developer) must never be able to
 * raise its OWN abuse ceiling. That is the entire reason the limits come from
 * the server-owned `trustTier` + this mod-gated override rather than from the
 * app manifest. Each case below FAILS if the gate is dropped:
 *   · anon (no session)   → UNAUTHORIZED, service NEVER called.
 *   · non-mod (logged in) → FORBIDDEN,    service NEVER called.
 *   · moderator           → served, service called with the validated input.
 *
 * Plus the schema bounds, which stop a mod (or a compromised mod session) from
 * writing a value that is "uncapped" in all but name, or a 0 that would silently
 * disable an app's generation entirely.
 *
 * Drives the REAL router so the middleware chain decides the outcome;
 * `BlockRegistry` is mocked at the module boundary (the service's own semantics
 * have a separate test).
 */

const { mockIsAppBlocksEnabled, mockSetAppSpendCapOverride, mockGetAppSpendCapOverride } =
  vi.hoisted(() => ({
    mockIsAppBlocksEnabled: vi.fn(),
    mockSetAppSpendCapOverride: vi.fn(),
    mockGetAppSpendCapOverride: vi.fn(),
  }));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    getAppDetail: vi.fn(),
    getFeaturedBlocks: vi.fn(),
    getMarketplaceMeta: vi.fn(),
    setMarketplaceMeta: vi.fn(),
    getAppSpendCapOverride: (...a: unknown[]) => mockGetAppSpendCapOverride(...a),
    setAppSpendCapOverride: (...a: unknown[]) => mockSetAppSpendCapOverride(...a),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
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
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: vi.fn() } },
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>(
    '@civitai/redis/client'
  );
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn() },
    sysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
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

const CONFIG_RESULT = {
  appBlockId: 'ab_1',
  trustTier: 'verified',
  spendCapBuzzPerDay: 9_000_000,
  spendVelocityMaxGens: 1_200,
  effective: { dailyBuzz: 9_000_000, velocityMaxGens: 1_200 },
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockSetAppSpendCapOverride.mockReset();
  mockSetAppSpendCapOverride.mockResolvedValue(CONFIG_RESULT);
  mockGetAppSpendCapOverride.mockReset();
  mockGetAppSpendCapOverride.mockResolvedValue(CONFIG_RESULT);
});

const SET_INPUT = {
  appBlockId: 'ab_1',
  spendCapBuzzPerDay: 9_000_000,
  spendVelocityMaxGens: 1_200,
} as const;

describe('blocks.setAppSpendCapOverride — MOD-ONLY cap write', () => {
  it('anon (no session): UNAUTHORIZED, the write is NEVER attempted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.setAppSpendCapOverride(SET_INPUT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockSetAppSpendCapOverride).not.toHaveBeenCalled();
  });

  it('non-mod (logged in — i.e. an app DEVELOPER): FORBIDDEN, the write is NEVER attempted', async () => {
    // The load-bearing case: a publisher cannot raise their own ceiling.
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.setAppSpendCapOverride(SET_INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockSetAppSpendCapOverride).not.toHaveBeenCalled();
  });

  it('moderator: served — the write runs with the validated input', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.setAppSpendCapOverride(SET_INPUT);
    expect(result).toEqual(CONFIG_RESULT);
    expect(mockSetAppSpendCapOverride).toHaveBeenCalledTimes(1);
    expect(mockSetAppSpendCapOverride.mock.calls[0][0]).toMatchObject({
      appBlockId: 'ab_1',
      spendCapBuzzPerDay: 9_000_000,
      spendVelocityMaxGens: 1_200,
    });
  });

  it('allows CLEARING an override (null) — the app falls back to its tier', async () => {
    mockSetAppSpendCapOverride.mockResolvedValue({
      ...CONFIG_RESULT,
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
      effective: { dailyBuzz: 5_000_000, velocityMaxGens: 600 },
    });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.setAppSpendCapOverride({
      appBlockId: 'ab_1',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    });
    expect(result.spendCapBuzzPerDay).toBeNull();
    expect(result.effective).toEqual({ dailyBuzz: 5_000_000, velocityMaxGens: 600 });
  });

  it.each([
    ['ZERO velocity (would silently disable the app, not cap it)', { spendVelocityMaxGens: 0 }],
    ['a NEGATIVE daily cap', { spendCapBuzzPerDay: -1 }],
    ['a FRACTIONAL velocity', { spendVelocityMaxGens: 12.5 }],
    ['an absurd daily cap above the hard bound', { spendCapBuzzPerDay: 5_000_000_000 }],
    ['an absurd velocity above the hard bound', { spendVelocityMaxGens: 1_000_000 }],
  ])('rejects %s at the schema layer (write NEVER attempted)', async (_label, patch) => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.setAppSpendCapOverride({ appBlockId: 'ab_1', ...patch } as never)
    ).rejects.toBeTruthy();
    expect(mockSetAppSpendCapOverride).not.toHaveBeenCalled();
  });
});

describe('blocks.getAppSpendCapOverride — MOD-ONLY read', () => {
  it('anon: UNAUTHORIZED, the read is NEVER attempted', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAppSpendCapOverride({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetAppSpendCapOverride).not.toHaveBeenCalled();
  });

  it('non-mod: FORBIDDEN — an app cannot PROBE its own ceiling either', async () => {
    // Withholding the number is deliberate: the submit rejection is number-free
    // so a hostile app can't tune a Sybil ring to sit just under the limit.
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getAppSpendCapOverride({ appBlockId: 'ab_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockGetAppSpendCapOverride).not.toHaveBeenCalled();
  });

  it('moderator: served — returns the tier, the override and the EFFECTIVE ceilings', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getAppSpendCapOverride({ appBlockId: 'ab_1' });
    expect(result).toEqual(CONFIG_RESULT);
    expect(mockGetAppSpendCapOverride).toHaveBeenCalledWith('ab_1');
  });

  it('NOT_FOUND for a missing app', async () => {
    mockGetAppSpendCapOverride.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAppSpendCapOverride({ appBlockId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
