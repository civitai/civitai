import { beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only namespace import: `typeof import('...')` inline is rejected by
// @typescript-eslint/consistent-type-imports, so the type is named up here.
import type * as BlockGenIdempotency from '~/server/utils/block-gen-idempotency';

/**
 * SCOPE ENFORCEMENT + CONSENT BUDGET on the App Blocks runtime.
 *
 * Two changes are under test, and they are two halves of one decision:
 *
 *   1. `assertViewerIsAppDeveloper` — an AUTHORING capability — no longer gates the
 *      RUNTIME procedures. It gated 15 call sites; it now gates exactly one
 *      (`updateUserSettings`). The consequence is that a viewer who is not an app
 *      author can finally USE an app. The consequence we must NOT let through is a
 *      widening on the one runtime proc that had no scope check of its own,
 *      `getMyBuzzBalance` — so that proc grew a `buzz:read:self` requirement.
 *
 *   2. A per-(user, app, UTC-day) CONSENT BUDGET the viewer sets at consent time,
 *      reserved alongside the platform's per-user daily cap. Both apply; the
 *      tighter binds. NULL budget ⇒ byte-identical to before.
 *
 * 🔴 THE REDIS COUNTERS ARE MODELLED STATEFULLY, NOT STUBBED TO A CONSTANT. The
 * defect this suite exists to catch is a REFUND that does not happen — a denied
 * attempt burning the viewer's platform allowance. A stub returning a fixed number
 * cannot see that: the assertion has to be "the counter came back to where it
 * started", which needs a counter. `sysRedis.incrBy`/`decrBy` therefore run against
 * an in-memory map keyed by the REAL key strings the router builds, and the
 * NULL-budget test doubles as the positive control that the map moves at all.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockSubmitWorkflow,
  mockCreateStepsFromGraph,
  mockBuildGenerationContext,
  mockAuditPromptServer,
  mockGetUserById,
  mockCheckBlockCatalogRateLimit,
  mockGetSessionUser,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockDailyBoostApply,
  mockDailyBoostGetDetails,
  mockGetUserBuzzAccounts,
  mockResolveCanGenerateForVersions,
  mockGetResourceData,
  mockGetHighestTierSubscription,
  mockRecordSpendAttribution,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockCreateStepsFromGraph: vi.fn(),
  mockBuildGenerationContext: vi.fn(),
  mockAuditPromptServer: vi.fn(),
  mockGetUserById: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksAuthorEnabled: vi.fn(),
  mockDailyBoostApply: vi.fn(),
  mockDailyBoostGetDetails: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockResolveCanGenerateForVersions: vi.fn(),
  mockGetResourceData: vi.fn(),
  mockGetHighestTierSubscription: vi.fn(),
  mockRecordSpendAttribution: vi.fn(),
}));

const {
  mockGetActiveDevTunnel,
  mockReserveDevSessionBuzz,
  mockRefundDevSessionBuzz,
  mockChargeDevSessionOverage,
} = vi.hoisted(() => ({
  mockGetActiveDevTunnel: vi.fn(async () => null as unknown),
  mockReserveDevSessionBuzz: vi.fn(async () => ({ allowed: true, total: 0 })),
  mockRefundDevSessionBuzz: vi.fn(async () => undefined),
  mockChargeDevSessionOverage: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => mockGetActiveDevTunnel(...(a as [])),
  reserveDevSessionBuzz: (...a: unknown[]) => mockReserveDevSessionBuzz(...(a as [])),
  refundDevSessionBuzz: (...a: unknown[]) => mockRefundDevSessionBuzz(...(a as [])),
  chargeDevSessionOverage: (...a: unknown[]) => mockChargeDevSessionOverage(...(a as [])),
}));

const { mockReserveAppSpend, mockRefundAppSpend, mockChargeAppSpendOverage } = vi.hoisted(() => ({
  mockReserveAppSpend: vi.fn(),
  mockRefundAppSpend: vi.fn(async () => undefined),
  mockChargeAppSpendOverage: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  reserveAppSpend: (...a: unknown[]) => mockReserveAppSpend(...(a as [])),
  refundAppSpend: (...a: unknown[]) => mockRefundAppSpend(...(a as [])),
  chargeAppSpendOverage: (...a: unknown[]) => mockChargeAppSpendOverage(...(a as [])),
}));

const { mockUpsertBlockWorkflow, mockListMyBlockWorkflows, mockUpdateBlockWorkflowStatus } =
  vi.hoisted(() => ({
    mockUpsertBlockWorkflow: vi.fn(async () => undefined),
    mockListMyBlockWorkflows: vi.fn(),
    mockUpdateBlockWorkflowStatus: vi.fn(async () => 1),
  }));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  upsertBlockWorkflowOnSubmit: (...a: unknown[]) => mockUpsertBlockWorkflow(...(a as [])),
  listMyBlockWorkflows: (...a: unknown[]) => mockListMyBlockWorkflows(...(a as [])),
  updateBlockWorkflowStatus: (...a: unknown[]) => mockUpdateBlockWorkflowStatus(...(a as [])),
}));

const { mockPersistCustomComfySettle, mockSettleCustomComfySpend } = vi.hoisted(() => ({
  mockPersistCustomComfySettle: vi.fn(async () => undefined),
  mockSettleCustomComfySpend: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', () => ({
  persistCustomComfySettle: (...a: unknown[]) => mockPersistCustomComfySettle(...(a as [])),
  settleCustomComfySpend: (...a: unknown[]) => mockSettleCustomComfySpend(...(a as [])),
}));

const { mockClaimGen, mockFinalizeGen, mockReleaseGen, genIdemStore } = vi.hoisted(() => ({
  genIdemStore: new Map<string, unknown>(),
  mockClaimGen: vi.fn(),
  mockFinalizeGen: vi.fn(),
  mockReleaseGen: vi.fn(),
}));
vi.mock('~/server/utils/block-gen-idempotency', async (importActual) => {
  const actual = await importActual<typeof BlockGenIdempotency>();
  return {
    ...actual,
    claimGenIdempotency: (...a: unknown[]) => mockClaimGen(...(a as [])),
    finalizeGenIdempotency: (...a: unknown[]) => mockFinalizeGen(...(a as [])),
    releaseGenIdempotency: (...a: unknown[]) => mockReleaseGen(...(a as [])),
  };
});

vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: mockSubmitWorkflow,
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: mockBuildGenerationContext,
  createWorkflowStepsFromGraphInput: mockCreateStepsFromGraph,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: mockAuditPromptServer,
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: mockGetUserById }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: {
    apply: (...args: unknown[]) => mockDailyBoostApply(...args),
    getUserRewardDetails: (...args: unknown[]) => mockDailyBoostGetDetails(...args),
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...args: unknown[]) => mockGetUserBuzzAccounts(...args),
  getUserBuzzTransactions: vi.fn(),
  getUserBuzzAccount: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...args: unknown[]) => mockCheckBlockCatalogRateLimit(...args),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: (...args: unknown[]) => mockResolveCanGenerateForVersions(...args),
  getResourceData: (...args: unknown[]) => mockGetResourceData(...args),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: (...args: unknown[]) => mockGetHighestTierSubscription(...args),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  recordSpendAttribution: (...args: unknown[]) => mockRecordSpendAttribution(...args),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    upsertUserSettings: vi.fn(async () => ({ ok: true })),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(async () => ({
      source: 'install',
      modelId: 7,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings: {},
      installedByUserId: 42,
      appBlock: {
        id: 'apb_test',
        blockId: 'gen-from-model',
        appId: 'app',
        status: 'approved',
        manifest: { targets: [{ slotId: 'model.sidebar_top' }] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 33554431 },
      },
    })),
  },
}));
// Same import-chain shim the sibling blocks.router suites use: `rateLimit` transitively
// evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockSysRedis = redisMock.sysRedis;
const mockDbRead = dbMock.dbRead;
const mockGrantFindUnique = dbMock.dbWrite.appUserScopeGrant.findUnique;

// ── The stateful counter model. See the file header for why this is not a stub.
const counters = new Map<string, number>();
/** [key PREFIX, starting value] — lets a test seed "N already spent today" without
 *  reconstructing the UTC-day suffix the router appends. */
const seeds: Array<[string, number]> = [];
function startingValue(key: string): number {
  const hit = seeds.find(([prefix]) => key.startsWith(prefix));
  return hit ? hit[1] : 0;
}
function currentValue(key: string): number {
  return counters.has(key) ? (counters.get(key) as number) : startingValue(key);
}
/** The one key seen under a prefix. Throws rather than returning undefined: a test that
 *  asserts on "the daily key" must fail loudly if the router never touched one, instead
 *  of quietly comparing `undefined` and passing. */
function keyUnder(prefix: string): string {
  const found = [...counters.keys()].filter((k) => k.startsWith(prefix));
  if (found.length !== 1) {
    throw new Error(`expected exactly 1 redis key under '${prefix}', saw ${found.length}`);
  }
  return found[0];
}
function anyKeyUnder(prefix: string): boolean {
  return [...counters.keys()].some((k) => k.startsWith(prefix));
}

const DAILY_PREFIX = `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:42:`;
const CONSENT_PREFIX = `${REDIS_SYS_KEYS.BLOCKS.CONSENT_BUDGET}:42:apb_test:`;

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
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 100,
    ...over,
  };
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
    ...over,
  };
}

function fakeCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

/** whatIf quote then real submit, both at `cost`. */
function orchestratorQuoting(cost: number) {
  mockSubmitWorkflow
    .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: cost }, steps: [] })
    .mockResolvedValueOnce({
      id: 'wf_real',
      status: 'unassigned',
      cost: { total: cost },
      steps: [],
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` clears CALLS, not the `mockResolvedValueOnce` QUEUE. A test that
  // rejects before the real submit leaves its second queued value behind, and the NEXT
  // test's whatIf then consumes it — so the real submit returns the whatIf's empty id and
  // the failure reads as "the router did not submit". Reset this one explicitly.
  mockSubmitWorkflow.mockReset();
  counters.clear();
  seeds.length = 0;
  genIdemStore.clear();

  mockSysRedis.incrBy.mockImplementation(async (key: string, by: number) => {
    const next = currentValue(key) + by;
    counters.set(key, next);
    return next;
  });
  mockSysRedis.decrBy.mockImplementation(async (key: string, by: number) => {
    const next = currentValue(key) - by;
    counters.set(key, next);
    return next;
  });
  mockSysRedis.get.mockResolvedValue(null);
  mockSysRedis.expire.mockResolvedValue(true);
  mockSysRedis.ttl.mockResolvedValue(-1);

  // DEFAULT: no grant row ⇒ no consent budget. This is the pre-change world, and it is
  // what every test that is not about the budget runs in.
  mockGrantFindUnique.mockResolvedValue(null);

  mockReserveAppSpend.mockResolvedValue({
    allowed: true,
    dailyTotal: 0,
    velocityCount: 1,
    dailyKey: 'system:blocks:app-spend-cap:apb_test:day',
  });
  mockRefundAppSpend.mockResolvedValue(undefined);
  mockUpsertBlockWorkflow.mockResolvedValue(undefined);
  mockListMyBlockWorkflows.mockResolvedValue({ items: [], nextCursor: null });
  mockPersistCustomComfySettle.mockResolvedValue(undefined);
  mockSettleCustomComfySpend.mockResolvedValue(undefined);

  mockClaimGen.mockImplementation(async () => ({ state: 'acquired', key: 'k' }));
  mockFinalizeGen.mockResolvedValue(undefined);
  mockReleaseGen.mockResolvedValue(undefined);

  mockGetActiveDevTunnel.mockResolvedValue(null);
  mockReserveDevSessionBuzz.mockResolvedValue({ allowed: true, total: 0 });
  mockRefundDevSessionBuzz.mockResolvedValue(undefined);

  mockRecordSpendAttribution.mockResolvedValue({ written: false, row: null });
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  // DEFAULT: the subject is NOT an app author. That is the cohort this change exists to
  // unblock, so it is the default here rather than the exception.
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => false);
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false, tier: 'free' });
  mockGetUserById.mockResolvedValue({
    id: 42,
    isModerator: false,
    tier: 'free',
    email: 'u@example.com',
    username: 'u',
  });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockBuildGenerationContext.mockResolvedValue({ externalCtx: {} });
  mockCreateStepsFromGraph.mockResolvedValue({
    steps: [{ $type: 'textToImage', name: 's1', input: {} }],
    workflowMetadata: undefined,
  });
  mockDailyBoostApply.mockResolvedValue(undefined);
  mockDailyBoostGetDetails.mockResolvedValue({
    awarded: 0,
    awardedCount: 0,
    awardAmount: 25,
    accountType: 'blue',
    type: 'dailyBoost',
    description: 'For claiming daily boost rewards',
    cap: 25,
    onDemand: true,
  });
  mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 10000, blue: 0, green: 0 });
  mockResolveCanGenerateForVersions.mockImplementation(
    async (versions: Array<{ id: number }>) =>
      new Map(versions.map((v) => [v.id, { canGenerate: true }]))
  );
  mockDbRead.modelVersion.findUnique.mockResolvedValue({
    id: 99,
    baseModel: 'SDXL 1.0',
    modelId: 7,
    status: 'Published',
    model: { id: 7, type: 'Checkpoint' },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The cohort is unblocked, and the widening it could have caused is closed.
// ─────────────────────────────────────────────────────────────────────────────

describe('runtime access is governed by SCOPE, not by the authoring capability', () => {
  // REGRESSION (red at origin/main): the author gate rejected this submit with
  // FORBIDDEN, which is the whole reason the non-author cohort could not use apps.
  it('a NON-AUTHOR holding a validly-scoped token can submitWorkflow', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.workflowId).toBe('wf_real');
    // The author capability was consulted for nothing on this path — asserting the
    // OUTCOME alone would still pass if the gate had merely been mocked open, which is
    // not the claim. The claim is that the runtime no longer asks.
    expect(mockIsAppBlocksAuthorEnabled).not.toHaveBeenCalled();
  });

  // REGRESSION (red at origin/main): there was no scope check here at all, so removing
  // the author gate would have exposed the viewer's balance to ANY valid block token.
  it('getMyBuzzBalance REJECTS a token lacking buzz:read:self', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['ai:write:budgeted'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzBalance({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block lacks buzz:read:self scope',
    });
    // Nothing was read. Without this the test would pass on a FORBIDDEN thrown by any
    // later gate — including one that had already fetched the balance.
    expect(mockGetUserBuzzAccounts).not.toHaveBeenCalled();
  });

  // The positive half of the pair: with the scope, a NON-AUTHOR gets their balance. This
  // is what proves the FORBIDDEN above is attributable to the scope and not to the
  // subject being a non-author.
  it('getMyBuzzBalance SERVES a non-author whose token carries buzz:read:self', async () => {
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ scopes: ['ai:write:budgeted', 'buzz:read:self'] })
    );
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 7, blue: 3, green: 1 });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzBalance({ blockToken: 'tok' })).resolves.toEqual({
      yellow: 7,
      blue: 3,
      green: 1,
    });
  });

  // INVARIANT GUARD — green at origin/main AND at HEAD. The scope check on these two
  // procedures already existed; this pins that removing the author gate did not disturb
  // it. It is NOT regression coverage for this change and must not be counted as such.
  it('INVARIANT: submitWorkflow rejects a token without ai:write:budgeted', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
  });

  // INVARIANT GUARD — green at origin/main AND at HEAD. Same status as the one above.
  it('INVARIANT: estimateWorkflow rejects a token without ai:write:budgeted', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The consent budget.
// ─────────────────────────────────────────────────────────────────────────────

describe('per-(user, app) consent budget', () => {
  // 🔴 HOLD THE AUTHOR DIMENSION CONSTANT IN THIS BLOCK. The suite's default subject is a
  // NON-author, which at `origin/main` is rejected by the author gate before any cap runs
  // — so every test here would go red at base for a reason that has nothing to do with a
  // budget, and the red/green matrix would attribute the wrong cause. Granting the author
  // capability leaves the BUDGET as the only dimension that varies between base and HEAD.
  beforeEach(() => {
    mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
    mockGetUserById.mockResolvedValue({
      id: 42,
      isModerator: true,
      tier: 'free',
      email: 'u@example.com',
      username: 'u',
    });
  });

  // INVARIANT GUARD — green at origin/main AND at HEAD, and that is the CLAIM: a grant
  // with no budget must behave byte-identically to the world before the column existed.
  // It doubles as the POSITIVE CONTROL for the whole counter model: a reassuring "no
  // consent key was written" is indistinguishable from a harness wired to nothing unless
  // something in the same test makes a number move, so this asserts BOTH — the platform
  // counter reached 25, and the consent counter was never touched.
  it('INVARIANT: NULL budget writes no consent key, and the platform counter still moves', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: null, revokedAt: null });
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(counters.get(keyUnder(DAILY_PREFIX))).toBe(25); // the number moved
    expect(anyKeyUnder(CONSENT_PREFIX)).toBe(false); // and only the one key was used
  });

  // INVARIANT GUARD — green at both. The platform ceiling is unchanged; this pins that
  // the second reservation did not accidentally relax it.
  it('INVARIANT: NULL budget still binds at the 50k platform cap', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: null, revokedAt: null });
    seeds.push([DAILY_PREFIX, BLOCK_BUZZ_CAP_PER_DAY - 10]);
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.error).toContain('daily Buzz cap reached');
    // Only ONE orchestrator call — the whatIf. The real submit never ran.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  // REGRESSION (red at origin/main — the concept does not exist there).
  it('a spend over the consented per-app budget is REJECTED', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: 100, revokedAt: null });
    seeds.push([CONSENT_PREFIX, 90]); // 90 already spent by this app today
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25); // 90 + 25 = 115 > 100

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.error).toContain('app Buzz limit reached');
    // The user's own number is in the message — it is their setting, not a platform secret.
    expect(result.snapshot.error).toContain('your limit for this app is 100');
    // No real submit. `toHaveBeenCalledTimes(1)` is the whatIf quote only.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  // 🔴 REGRESSION (red at origin/main), and the correctness requirement this whole
  // change turns on. A denial that keeps the platform reservation silently burns the
  // viewer's 50,000/day allowance for a generation that never ran.
  it('a consent-budget denial REFUNDS the platform daily reservation', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: 100, revokedAt: null });
    seeds.push([CONSENT_PREFIX, 90]);
    seeds.push([DAILY_PREFIX, 300]); // 300 already spent today across all apps
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.status).toBe('failed');

    const dailyKey = keyUnder(DAILY_PREFIX);
    const consentKey = keyUnder(CONSENT_PREFIX);
    // BACK TO THE PRE-ATTEMPT VALUE — not merely "below the cap".
    expect(counters.get(dailyKey)).toBe(300);
    expect(counters.get(consentKey)).toBe(90);
    // And it genuinely round-tripped rather than never being reserved: both legs were
    // INCRBY'd and both were DECRBY'd. Without this pair the assertion above would also
    // pass if the reservation had been skipped entirely.
    expect(mockSysRedis.incrBy).toHaveBeenCalledWith(dailyKey, 25);
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(dailyKey, 25);
    expect(mockSysRedis.incrBy).toHaveBeenCalledWith(consentKey, 25);
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(consentKey, 25);
  });

  // REGRESSION (red at origin/main), and specifically the BOUNDARY case. Without it a
  // `>` → `>=` mutation of the guard SURVIVES: every other test here sits well clear of
  // the cap, so only a spend landing EXACTLY on it can tell the two operators apart. The
  // budget is a ceiling the user consented to, so spending up to it must be allowed.
  it('a spend landing EXACTLY on the consented budget SUCCEEDS', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: 100, revokedAt: null });
    seeds.push([CONSENT_PREFIX, 75]);
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25); // 75 + 25 = 100, exactly the cap

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(counters.get(keyUnder(CONSENT_PREFIX))).toBe(100);
  });

  // REGRESSION (red at origin/main). A spend INSIDE the budget goes through and both
  // counters carry it — the negative image of the two tests above, so "rejected" cannot
  // be the answer the code gives for everything.
  it('a spend within the consented budget SUCCEEDS and charges both counters', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: 100, revokedAt: null });
    seeds.push([CONSENT_PREFIX, 50]);
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25); // 50 + 25 = 75 <= 100

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(counters.get(keyUnder(CONSENT_PREFIX))).toBe(75);
    expect(counters.get(keyUnder(DAILY_PREFIX))).toBe(25);
  });

  // INVARIANT GUARD — green at origin/main AND at HEAD, and the reason is worth stating
  // rather than glossing: at base it passes VACUOUSLY, because no consent key exists to
  // find. It carries information only at HEAD, where the feature is present and the skip
  // is a real branch. Do NOT count it as regression coverage. A dev/live-harness token is
  // self-bound and its appBlockId is frequently synthetic, so it takes no consent
  // reservation — the same exclusion `reserveAppSpend` already takes.
  it('a dev token takes NO consent reservation even when a budget exists', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: 1, revokedAt: null });
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true }));
    orchestratorQuoting(25); // would blow a budget of 1 instantly if it applied

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(anyKeyUnder(CONSENT_PREFIX)).toBe(false);
    // The grant row was never even read — the skip is upstream of the DB call.
    expect(mockGrantFindUnique).not.toHaveBeenCalled();
  });

  // INVARIANT GUARD — green at both, vacuously at base for the same reason as the dev
  // test above. A revoked grant reports no budget, mirroring getGrantedScopes: a revoked
  // grant carries no spend scope, so there is nothing for a budget to bound and enforcing
  // a stale one would be enforcing against nothing.
  it('a REVOKED grant contributes no consent budget', async () => {
    mockGrantFindUnique.mockResolvedValue({ buzzBudgetPerDay: 1, revokedAt: new Date() });
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(anyKeyUnder(CONSENT_PREFIX)).toBe(false);
  });

  // REGRESSION (red at origin/main). Fail CLOSED: a budget that cannot be READ must not
  // be treated as absent, because absent means "unbounded within the platform cap" — the
  // one direction a money cap must never drift. And the platform leg must not stay burned.
  it('a DB error reading the budget fails the submit CLOSED and refunds the platform leg', async () => {
    mockGrantFindUnique.mockRejectedValue(new Error('replica unavailable'));
    seeds.push([DAILY_PREFIX, 300]);
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    orchestratorQuoting(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.submitWorkflow({ blockToken: 'tok', body: validBody() })).rejects.toThrow();

    expect(counters.get(keyUnder(DAILY_PREFIX))).toBe(300);
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1); // whatIf only — no real submit
  });
});
