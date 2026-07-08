import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pre-GA hardening — `assertAppBlocksEnabledForTokenUser` (the BLOCK-TOKEN
 * runtime gate) must hydrate the FULL server-side SessionUser before feeding it
 * to the App Blocks flag, so the Flipt context carries the user's REAL tier /
 * isMember — not the `'free'` / `'false'` type-defaults a trimmed
 * `{ id, isModerator }` cast (the #2740 shape) would leave.
 *
 * This matters because `isAppBlocksEnabled({ user })` → `buildFliptContext(user)`
 * reads `id`, `isModerator`, AND `tier` (deriving `isMember`). It's correct
 * TODAY only because the live `app-blocks-enabled` flag segments solely on
 * `isModerator`; the moment it's widened to segment on `tier`/region, a stale
 * `tier:'free'` context would silently mis-gate a paying user.
 *
 * Strategy: drive the REAL `assertAppBlocksEnabledForTokenUser` through the
 * `pollWorkflow` proc with the REAL `app-blocks-flag` service AND the REAL
 * `buildFliptContext`. Only `~/server/flipt/client` is stubbed — its `isFlipt`
 * CAPTURES the exact context the gate built and returns `true` (gate passes).
 * `getSessionUser` is mocked to a moderator on a paid tier, and we assert the
 * captured context carries the real `tier`/`isMember` — i.e. the cast is now
 * faithful. We also drive a flag implementation that SEGMENTS ON TIER to prove
 * the gate would evaluate against the user's actual tier post-widening.
 *
 * Mock set mirrors `blocks.router.workflow.test.ts` (heavy services stubbed so
 * importing the router doesn't drag in the generated Prisma client / selectors).
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockGetWorkflow,
  mockGetUserById,
  mockGetSessionUser,
  mockIsFlipt,
  mockGetUserBuzzAccounts,
  mockLogToAxiom,
  mockRedis,
  mockSysRedis,
  mockDbRead,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockRedis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
  mockSysRedis: {
    get: vi.fn(async () => null),
    incrBy: vi.fn(async () => 0),
    decrBy: vi.fn(async () => 0),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => -1),
  },
  mockDbRead: {
    modelVersion: { findUnique: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
  },
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: mockGetWorkflow,
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
}));
// The NEW dependency under test: the gate now resolves the full SessionUser via the hub-backed sessionClient.
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
// REAL app-blocks-flag + REAL buildFliptContext run; only the Flipt edge is
// stubbed so we can CAPTURE the context the gate built.
vi.mock('~/server/flipt/client', () => ({
  isFlipt: (...a: unknown[]) => mockIsFlipt(...a),
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

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'blk_test',
    appId: 'app_test',
    blockInstanceId: 'bki_test',
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
    ...over,
  };
}

function fakeCtx() {
  return {
    acceptableOrigin: true,
    user: undefined, // block-token proc: no session — the gate must use the TOKEN subject
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockParseSubjectUserId,
    mockGetOrchestratorToken,
    mockGetWorkflow,
    mockGetUserById,
    mockGetSessionUser,
    mockIsFlipt,
    mockGetUserBuzzAccounts,
    mockLogToAxiom,
  ]) {
    fn.mockReset();
  }
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockGetWorkflow.mockResolvedValue({ id: 'wf_1', status: 'succeeded', cost: { total: 0 }, steps: [] });
  // assertViewerIsModerator reads the (trimmed) row directly — keep it a mod.
  mockGetUserById.mockResolvedValue({ id: 42, isModerator: true });
  mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 10000, blue: 0, green: 0 });
  // Default Flipt stub: ON only when the captured context says isModerator==true
  // (mirrors the LIVE app-blocks-enabled `moderators` segment). Tests that probe
  // tier-segmentation override this.
  mockIsFlipt.mockImplementation(
    async (_flag: string, _entityId: string, ctx?: Record<string, string>) =>
      ctx?.isModerator === 'true'
  );
});

describe('assertAppBlocksEnabledForTokenUser — Flipt context is hydrated from the real SessionUser', () => {
  it('builds the Flipt context with the REAL tier/isMember (not free/false defaults)', async () => {
    // A moderator on a PAID tier. The trimmed #2740 cast would have lost `tier`
    // → context tier:'free' / isMember:'false'. The fix resolves the full user.
    mockGetSessionUser.mockResolvedValue({
      id: 42,
      isModerator: true,
      tier: 'gold',
    } as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    // The gate resolved the full SessionUser for the TOKEN subject (42), not ctx.user.
    expect(mockGetSessionUser).toHaveBeenCalledWith(42);

    // Find the app-blocks-enabled Flipt eval and assert its context is faithful.
    const appBlocksCall = mockIsFlipt.mock.calls.find((c) => c[0] === 'app-blocks-enabled');
    expect(appBlocksCall).toBeDefined();
    const [, entityId, ctx] = appBlocksCall as [string, string, Record<string, string>];
    expect(entityId).toBe('42');
    expect(ctx.isModerator).toBe('true');
    // The load-bearing assertions: REAL subscription tier, not the stale default.
    expect(ctx.tier).toBe('gold');
    expect(ctx.isMember).toBe('true');
    expect(ctx.userId).toBe('42');
  });

  it('a flag SEGMENTED ON TIER now evaluates against the user real tier (post-widening proof)', async () => {
    // Simulate widening app-blocks-enabled to gate on a paid tier: ON iff
    // tier !== 'free'. With the OLD trimmed cast the context would always say
    // tier:'free' → this paying moderator would be wrongly BLOCKED. With the
    // hydrated context the gate sees tier:'gold' and PASSES.
    mockIsFlipt.mockImplementation(
      async (_flag: string, _entityId: string, ctx?: Record<string, string>) =>
        !!ctx && ctx.tier !== 'free'
    );
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'gold' } as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    // Does NOT throw "App Blocks not enabled" — the tier-segmented flag passes
    // because the context carries the real tier.
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).resolves.toBeDefined();

    const appBlocksCall = mockIsFlipt.mock.calls.find((c) => c[0] === 'app-blocks-enabled');
    expect((appBlocksCall as [string, string, Record<string, string>])[2].tier).toBe('gold');
  });

  it('a vanished subject → undefined user → global eval → flag false → blocked (fail-closed preserved)', async () => {
    mockGetSessionUser.mockResolvedValue(undefined as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });

    // Global eval: with no user, isAppBlocksEnabled takes the no-user branch and
    // calls isFlipt(flag) with NO entityId/context (buildFliptContext is never
    // run) → the moderators-segmented default stub resolves false.
    const appBlocksCall = mockIsFlipt.mock.calls.find((c) => c[0] === 'app-blocks-enabled');
    expect(appBlocksCall).toBeDefined();
    // No context argument was passed (global eval), so the segment can't match.
    expect((appBlocksCall as unknown[])[2]).toBeUndefined();
  });
});
