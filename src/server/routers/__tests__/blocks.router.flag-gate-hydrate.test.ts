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
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
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
// 🔴 STRUCTURALLY BLIND TO THE VIEWER HALF OF THE WORKFLOW SCOPE. This file never sets
// `ORCHESTRATOR_MODE`, so it runs under the schema default `'dev'` — the one mode in which
// `assertBlockWorkflowMintedForViewer` short-circuits. That is why ids like `wf_1` are fine here
// and would be refused in prod. A `pollWorkflow`/`cancelWorkflow` case cloned out of this file
// inherits that blindness while looking like coverage: set the mode explicitly, as
// blocks.router.workflowScope.test.ts does.

import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockRedis = redisMock.redis;
const mockSysRedis = redisMock.sysRedis;
const mockLogToAxiom = loggingMock.logToAxiom;
redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.sysRedis.incrBy.mockImplementation(async () => 0);
redisMock.sysRedis.decrBy.mockImplementation(async () => 0);
redisMock.sysRedis.expire.mockImplementation(async () => true);
redisMock.sysRedis.ttl.mockImplementation(async () => -1);

// Every workflow a block can legitimately name carries its producing app's provenance tag, and
// `blocks.pollWorkflow`/`cancelWorkflow` assert it. These fixtures are about other properties, so
// they carry the default claims' tag; the scoping guard itself is exercised in
// blocks.router.workflowScope.test.ts.
const BLOCK_APP_TAG = 'app-block:app_test';

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
  mockGetWorkflow.mockResolvedValue({
    tags: [BLOCK_APP_TAG],
    id: 'wf_1',
    status: 'succeeded',
    cost: { total: 0 },
    steps: [],
  });
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
// `authorizeBlockBridgeToken` resolves the backing app_blocks row on every bridge proc and
// refuses a missing or non-approved one. The shared db mock answers `null` by default, so
// without this every call here would 404 on a condition none of these tests is about.
beforeEach(() => {
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
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

  it('a vanished subject is refused BEFORE the flag is consulted (no Flipt call at all)', async () => {
    mockGetSessionUser.mockResolvedValue(undefined as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'runtime block token subject could not be resolved',
    });

    // 🔴 THIS ASSERTION IS THE POINT, and it replaces one that asserted the
    // opposite. The old test pinned "isFlipt was called with NO entityId/context
    // (a global eval), so the segment can't match" — which is true and proves
    // nothing: a global eval returns the flag's BASE value, so that test passed
    // only because the stub's base was false. See the base-true case below.
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-enabled');
    expect(mockIsFlipt.mock.calls.filter((c) => c[0] === 'app-blocks-enabled')).toHaveLength(0);
  });

  it('🔴 a vanished subject is STILL refused when the flag is base-`enabled: true` (the GA flip)', async () => {
    // The forcing condition for this whole gate: `app-blocks-enabled` widened by
    // BASE rather than by segment. Every stub in this file's default setup has a
    // false base, which is what made the retracted "global eval → fail-closed"
    // derivation look tested. Here the flag says yes to everything, exactly as a
    // base-enabled flag does for a no-entityId eval (measured against the real
    // wasm engine in `app-blocks-flag.base-enabled-flip.test.ts`).
    mockIsFlipt.mockImplementation(async () => true);
    mockGetSessionUser.mockResolvedValue(undefined as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'runtime block token subject could not be resolved',
    });
  });

  it('POSITIVE CONTROL: the same base-true flag still ADMITS a subject that hydrates', async () => {
    // Without this, the two refusals above are indistinguishable from a harness
    // that rejects `pollWorkflow` for some unrelated reason.
    mockIsFlipt.mockImplementation(async () => true);
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'gold' } as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).resolves.toBeDefined();
  });
});

describe('assertViewerIsAppDeveloper — the AUTHOR gate refuses an unresolvable subject', () => {
  it('🔴 refuses with its OWN message when the subject vanishes between the two gates, base-true flag', async () => {
    // `updateUserSettings` is the single remaining call site of the author gate. It
    // runs `assertAppBlocksEnabledForTokenUser` first and `assertViewerIsAppDeveloper`
    // second, and each resolves the subject independently against the hub-backed
    // session client — so a subject deleted between the two awaits is a real, if
    // narrow, state. `mockResolvedValueOnce` reproduces it and is the only way to
    // reach the author gate's own branch without stubbing the gate under test.
    mockIsFlipt.mockImplementation(async () => true); // base-`enabled: true`
    mockGetSessionUser
      .mockResolvedValueOnce({ id: 42, isModerator: false, tier: 'free' } as never)
      .mockResolvedValue(undefined as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.updateUserSettings({ blockToken: 'tok', settings: {} })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app-authoring subject could not be resolved',
    });
  });

  it('POSITIVE CONTROL: a subject that hydrates on both calls passes BOTH gates', async () => {
    // Proves the refusal above is attributable to the missing subject, not to the
    // author capability or to anything downstream: same flag, same input, same
    // mocks — only the second hydration differs. Asserting the SPECIFIC downstream
    // outcome is load-bearing: `rejects.not.toMatchObject(...)` passes on ANY other
    // rejection, so it cannot tell "got past both gates" from "blew up differently".
    // NOT_FOUND / 'Block install not found' comes from the mocked BlockRegistry
    // returning no instance, which is several steps PAST both gates.
    mockIsFlipt.mockImplementation(async () => true);
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false, tier: 'free' } as never);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.updateUserSettings({ blockToken: 'tok', settings: {} })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Block install not found' });
  });
});
