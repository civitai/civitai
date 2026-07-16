import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Coverage for the three workflow procedures on blocksRouter. Each procedure
 * has multiple error gates — token validity, scope, context binding,
 * authenticated-subject, budget, version belongs to model. We exercise each
 * gate independently so a regression that loosens one is caught.
 *
 * Strategy: mock every dependency at the module boundary (JWT verify, orchestrator
 * services, DB lookups, user service) so the router runs in-process and we can
 * assert exact arguments passed through.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockSubmitWorkflow,
  mockGetWorkflow,
  mockCancelWorkflow,
  mockCreateStepsFromGraph,
  mockBuildGenerationContext,
  mockAuditPromptServer,
  mockGetUserById,
  mockGetUserBuzzTransactions,
  mockGetUserBuzzAccount,
  mockGetDailyCompensation,
  mockCheckBlockCatalogRateLimit,
  mockGetSessionUser,
  mockDbRead,
  mockRedis,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockDailyBoostApply,
  mockDailyBoostGetDetails,
  mockGetUserBuzzAccounts,
  mockLogToAxiom,
  mockSysRedis,
  mockResolveCanGenerateForVersions,
  mockRecordSpendAttribution,
  mockDbWriteUserFindUnique,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  // getMyViewer reads the viewer's ban/mute/deleted state from dbWrite.user
  // (the PRIMARY, like /blocks/me). Hoisted so tests can drive it + reset it.
  mockDbWriteUserFindUnique: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockCreateStepsFromGraph: vi.fn(),
  mockBuildGenerationContext: vi.fn(),
  mockAuditPromptServer: vi.fn(),
  mockGetUserById: vi.fn(),
  // Buzz self-read bridges (getMyBuzzTransactions/Accounts + getMyDailyCompensation).
  mockGetUserBuzzTransactions: vi.fn(),
  mockGetUserBuzzAccount: vi.fn(),
  mockGetDailyCompensation: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  // assertAppBlocksEnabledForTokenUser now resolves the FULL SessionUser (so the
  // Flipt context carries the real tier/isMember). isAppBlocksEnabled is mocked
  // here, but getSessionUser must still be stubbed so the real resolver doesn't
  // hit the DB/redis.
  mockGetSessionUser: vi.fn(),
  mockDbRead: {
    modelVersion: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    // Required by resolveBlockCheckpoint (LoRA path) — published checkpoint
    // resolution reads both tables in parallel.
    modelBlockInstall: { findUnique: vi.fn() },
    blockUserSettings: { findUnique: vi.fn() },
    // Required by the platform-fallback rung (most-popular Checkpoint —
    // queried via ModelMetric so we can orderBy thumbsUpCount).
    modelMetric: { findFirst: vi.fn() },
  },
  // Complete `redis` client stub. `checkBlockCatalogRateLimit` (used by the buzz
  // self-read mutations) calls incrBy/expire/ttl on this client; the buzz mutations
  // also mock the limiter itself (below), but stubbing every method the client
  // exposes keeps ANY redis path — the limiter or a transitive cache read — from
  // crashing with `redis.<fn> is not a function` in the preview (get/set alone
  // was the gap the pr-preview surfaced).
  mockRedis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    incrBy: vi.fn(async () => 1),
    decrBy: vi.fn(async () => 0),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => -1),
    exists: vi.fn(async () => 0),
  },
  // sysRedis surface used by the cumulative Buzz-cap (audit A7). Default to an
  // empty window (get → null) so the cap is non-binding unless a test seeds it.
  mockSysRedis: {
    get: vi.fn(async () => null),
    incrBy: vi.fn(async () => 0),
    decrBy: vi.fn(async () => 0),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => -1),
  },
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  // Developer soft-launch (Phase B): the runtime AUTHZ gate now checks the
  // `appBlocksAuthor` capability against the token subject (was: isModerator).
  // Default mirrors the mod floor so existing mod-subject happy paths pass.
  mockIsAppBlocksAuthorEnabled: vi.fn(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  ),
  mockDailyBoostApply: vi.fn(async () => undefined),
  mockDailyBoostGetDetails: vi.fn(async () => ({
    awarded: 0,
    awardAmount: 25,
    accountType: 'blue',
    type: 'dailyBoost',
    description: 'For claiming daily boost rewards',
    cap: 25,
    onDemand: true,
  })),
  mockGetUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
  mockLogToAxiom: vi.fn(async () => undefined),
  // W10 page branch: the canonical generation-entitlement gate. The router
  // dynamic-imports it from generation.service; we mock the module so the
  // heavy generation import graph (image.service → event-engine-common) stays
  // out of the test and we can drive canGenerate per-test. Default = a Map
  // saying the version IS generatable; FORBIDDEN tests override to false / miss.
  mockResolveCanGenerateForVersions: vi.fn(),
  // W3 flow A — the spend-attribution write the submit path fires
  // best-effort after a resolved submit. Mocked at the module boundary so
  // the test asserts exact (server-derived) args + that a throw here never
  // breaks submit.
  mockRecordSpendAttribution: vi.fn(),
}));

// F4: submitWorkflow dynamically imports the dev-tunnel spend backstop. Mock the
// module so the default (no active tunnel → getActiveDevTunnel null) leaves every
// existing test unchanged, and the F4 tests can drive an active dev session.
const { mockGetActiveDevTunnel, mockReserveDevSessionBuzz, mockRefundDevSessionBuzz } = vi.hoisted(
  () => ({
    mockGetActiveDevTunnel: vi.fn(async () => null as unknown),
    mockReserveDevSessionBuzz: vi.fn(async () => ({ allowed: true, total: 0 })),
    mockRefundDevSessionBuzz: vi.fn(async () => undefined),
  })
);
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => mockGetActiveDevTunnel(...(a as [])),
  reserveDevSessionBuzz: (...a: unknown[]) => mockReserveDevSessionBuzz(...(a as [])),
  refundDevSessionBuzz: (...a: unknown[]) => mockRefundDevSessionBuzz(...(a as [])),
}));

// G8 (per-app spend/velocity cap) + G6 (persistent output queue) — submitWorkflow
// dynamic-imports these, and listMyWorkflows dynamic-imports the queue read. Mock
// at the module boundary so we drive allow/deny + assert the fire-and-forget queue
// write; the real services are unit-tested separately.
const {
  mockReserveAppSpend,
  mockRefundAppSpend,
  mockUpsertBlockWorkflow,
  mockListMyBlockWorkflows,
} = vi.hoisted(() => ({
  mockReserveAppSpend: vi.fn(),
  mockRefundAppSpend: vi.fn(async () => undefined),
  mockUpsertBlockWorkflow: vi.fn(async () => undefined),
  mockListMyBlockWorkflows: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  reserveAppSpend: (...a: unknown[]) => mockReserveAppSpend(...(a as [])),
  refundAppSpend: (...a: unknown[]) => mockRefundAppSpend(...(a as [])),
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  upsertBlockWorkflowOnSubmit: (...a: unknown[]) => mockUpsertBlockWorkflow(...(a as [])),
  listMyBlockWorkflows: (...a: unknown[]) => mockListMyBlockWorkflows(...(a as [])),
}));
// submitWorkflow fires recordScopeInvocation (detached) which dynamic-imports the
// REAL, heavy user-app-surface.service. That first-time real import serializes the
// module runner and starves the sibling detached fire-and-forget writes (G6 queue),
// making their timing non-deterministic. Mock it (this file exercises no other
// user-app-surface proc) so every detached write settles promptly.
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
  getWorkflow: mockGetWorkflow,
  cancelWorkflow: mockCancelWorkflow,
}));
// The router builds the txt2img step via the generation-graph pipeline
// (dynamically imported inside `createBlockTextToImageStep`): it calls
// `buildGenerationContext` for the external ctx, then
// `createWorkflowStepsFromGraphInput` for the step array (router takes steps[0]).
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: mockBuildGenerationContext,
  createWorkflowStepsFromGraphInput: mockCreateStepsFromGraph,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: mockAuditPromptServer,
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: mockGetUserById,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  // dbWrite is referenced for install-management procedures; stub the few
  // shapes the unrelated procedures could hit so the import doesn't crash.
  dbWrite: {
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    // getMyViewer's ban/mute/deleted lookup (mirrors /blocks/me — PRIMARY read).
    user: { findUnique: (...a: unknown[]) => mockDbWriteUserFindUnique(...a) },
  },
}));
// blocks.router transitively pulls in many redis-cache modules that read
// `REDIS_KEYS.<GROUP>.<KEY>` AT IMPORT TIME. The real keys live in redis/client
// (which connects on import, so we can't importActual it). A hand-trimmed
// REDIS_KEYS is whack-a-mole — it flakily threw on whichever key the load order
// reached first (RESOURCE_DATA, then CACHES.TAG_IDS_FOR_IMAGES, ...). `completeKeys`
// keeps the few values the tests assert on and auto-vivifies ANY other key to a
// deterministic placeholder string instead of `undefined.X`, ending the flake.
const { completeKeys } = vi.hoisted(() => {
  const group = (explicit: Record<string, string>, name: string): Record<string, string> =>
    new Proxy(explicit, {
      get: (t, k) => (k in t ? (t as any)[k] : typeof k === 'string' ? `mock:${name}:${k}` : (t as any)[k]),
    });
  const completeKeys = (explicit: Record<string, Record<string, string>>) =>
    new Proxy(explicit, {
      get: (t, g) => (g in t ? group((t as any)[g], g as string) : typeof g === 'string' ? group({}, g) : (t as any)[g]),
    });
  return { completeKeys };
});

vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: completeKeys({ BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } }),
  REDIS_SYS_KEYS: completeKeys({ BLOCKS: { BUZZ_CAP: 'system:blocks:buzz-cap' } }),
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
  getUserBuzzTransactions: (...args: unknown[]) => mockGetUserBuzzTransactions(...args),
  getUserBuzzAccount: (...args: unknown[]) => mockGetUserBuzzAccount(...args),
  getDailyCompensationRewardByUser: (...args: unknown[]) => mockGetDailyCompensation(...args),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...args: unknown[]) => mockCheckBlockCatalogRateLimit(...args),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: (...args: unknown[]) =>
    mockResolveCanGenerateForVersions(...args),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => mockLogToAxiom(...args),
}));
// W3 flow A — the submit path dynamic-imports recordSpendAttribution from
// here. Mock the whole module so we drive the spend-write behavior; the
// real service is unit-tested separately in spend-attribution.service.test.
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  recordSpendAttribution: (...args: unknown[]) => mockRecordSpendAttribution(...args),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    // W13 — updateUserSettings persists via this; default to a no-op resolve.
    upsertUserSettings: vi.fn(async () => ({ ok: true })),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    // Used by resolveBlockCheckpoint to read publisher settings — return
    // an empty-settings install shape by default so the LoRA path falls
    // through to the platform fallback (which most workflow tests assert
    // against). Individual tests override as needed.
    resolveBlockInstance: vi.fn(async () => ({
      source: 'install',
      modelId: 7,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings: {},
      installedByUserId: 42,
      appBlock: {
        id: 'ab_x',
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

// blocks.router imports `rateLimit` from middleware.trpc, which transitively
// pulls in user-preferences.service → caches.ts → tag.selector (a top-level
// `Prisma.validator(...)` call). In a fresh worktree the generated Prisma client
// can't be produced (NixOS engine fetch), so evaluating that chain throws at
// import time. Mock middleware.trpc with a pass-through `rateLimit` middleware
// (built from the real, lightweight `middleware` factory) to cut the chain —
// rate-limiting isn't under test here. (Same shim the sibling
// blocks.router.subscriptions.test.ts / getInstallConfig.test.ts / flag-gate.test.ts use.)
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: () => middleware(({ next }) => next()),
  };
});

import { blocksRouter } from '../blocks.router';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
// W13 — the submit path fires recordScopeInvocation (detached) with a structured
// `detail`. It's mocked above; grab the mock to assert the emitted detail.
import { recordScopeInvocation } from '~/server/services/blocks/user-app-surface.service';
// Warm the module cache for the (mocked) block-workflows.service so the router's
// DETACHED `await import(...)` of it in submitWorkflow resolves promptly — like
// buzz-attribution.service, which is statically imported by the router and so
// already loaded. Without this the dynamic import of a dynamic-only mocked module
// lags by ~a test, making the fire-and-forget queue write's timing flaky.
import '~/server/services/blocks/block-workflows.service';
import { TransactionType } from '~/shared/constants/buzz.constants';

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
    // Both modelId and slotId — the workflow path requires slotId in ctx
    // so resolveBlockCheckpoint can re-validate synthetic ids via the
    // BlockRegistry resolver.
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
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
  // publicProcedure chains: isAcceptableOrigin → enforceClientVersion →
  // applyDomainFeature → enforceTokenScope. We supply just enough of each
  // dependency to traverse them — these middlewares are exercised elsewhere;
  // the workflow procedures are what's under test.
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full, // bypass the token-scope gate
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

function happyVersionLookup() {
  mockDbRead.modelVersion.findUnique.mockResolvedValue({
    id: 99,
    baseModel: 'SDXL 1.0',
    modelId: 7,
    status: 'Published',
    model: { id: 7, type: 'Checkpoint' },
  });
}

function happyUser() {
  // Phase 2: App Blocks is moderator-only, and the runtime procedures now
  // assert the resolved viewer (from the block token) isModerator via
  // getUserById. The happy path therefore needs a moderator subject.
  // getUserById is called BOTH by assertViewerIsModerator (select id+isMod)
  // AND by getBlockSessionUser (submit path). A single mock resolution
  // covers both since they read overlapping fields.
  mockGetUserById.mockResolvedValue({
    id: 42,
    isModerator: true,
    tier: 'free',
    email: 'u@example.com',
    username: 'u',
  });
}

beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockParseSubjectUserId,
    mockGetOrchestratorToken,
    mockSubmitWorkflow,
    mockGetWorkflow,
    mockCancelWorkflow,
    mockCreateStepsFromGraph,
    mockBuildGenerationContext,
    mockAuditPromptServer,
    mockGetUserById,
    mockGetSessionUser,
    mockDbRead.modelVersion.findUnique,
    mockIsAppBlocksEnabled,
    mockDailyBoostApply,
    mockDailyBoostGetDetails,
    mockGetUserBuzzAccounts,
    mockGetUserBuzzTransactions,
    mockGetUserBuzzAccount,
    mockGetDailyCompensation,
    mockCheckBlockCatalogRateLimit,
    mockLogToAxiom,
    mockSysRedis.get,
    mockSysRedis.incrBy,
    mockSysRedis.decrBy,
    mockSysRedis.expire,
    mockSysRedis.ttl,
    mockResolveCanGenerateForVersions,
    mockRecordSpendAttribution,
    mockDbWriteUserFindUnique,
    mockIsAppBlocksAuthorEnabled,
    mockGetActiveDevTunnel,
    mockReserveDevSessionBuzz,
    mockRefundDevSessionBuzz,
    mockReserveAppSpend,
    mockRefundAppSpend,
    mockUpsertBlockWorkflow,
    mockListMyBlockWorkflows,
  ]) {
    fn.mockReset();
  }
  // G8 default: the per-app aggregate cap ALLOWS (non-binding) with a pinned
  // daily key so the refund paths have something to refund. G6 default: the
  // fire-and-forget queue write + the read resolve empty.
  mockReserveAppSpend.mockResolvedValue({
    allowed: true,
    dailyTotal: 0,
    velocityCount: 1,
    dailyKey: 'system:blocks:app-spend-cap:apb_test:day',
  });
  mockRefundAppSpend.mockResolvedValue(undefined);
  mockUpsertBlockWorkflow.mockResolvedValue(undefined);
  mockListMyBlockWorkflows.mockResolvedValue({ items: [], nextCursor: null });
  // F4 defaults: no active dev tunnel (getActiveDevTunnel → null) so the dev
  // spend backstop is inert for every non-dev test. The F4 tests override these.
  mockGetActiveDevTunnel.mockResolvedValue(null);
  mockReserveDevSessionBuzz.mockResolvedValue({ allowed: true, total: 0 });
  mockRefundDevSessionBuzz.mockResolvedValue(undefined);
  // W3 flow A default: the spend-attribution write resolves successfully.
  // Tests that exercise best-effort override it to reject.
  mockRecordSpendAttribution.mockResolvedValue({
    written: true,
    row: {
      id: 'bsa_x',
      status: 'pending',
      appOwnerShareCents: 0,
      spendSharePct: 0,
      grossValueCents: 0,
      rateCardVersion: 'v4',
      voidedReason: null,
    },
  });
  // Buzz-cap (audit A7): default to an empty window so the cap is non-binding
  // unless a test seeds prior spend. The cap is now an atomic reserve (INCRBY
  // returns the new running total) + refund (DECRBY); default incrBy → cost so
  // the reservation stays under the 50,000 cap unless a test overrides it.
  mockSysRedis.get.mockResolvedValue(null);
  mockSysRedis.incrBy.mockResolvedValue(0);
  mockSysRedis.decrBy.mockResolvedValue(0);
  mockSysRedis.expire.mockResolvedValue(true);
  mockSysRedis.ttl.mockResolvedValue(-1);
  // Buzz self-read bridges: default the per-instance rate limit to allowed.
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  // getMyViewer: default the viewer to an active (non-banned, non-muted,
  // non-deleted) user. Ban/mute/deleted tests override this.
  mockDbWriteUserFindUnique.mockResolvedValue({
    id: 42,
    username: 'u',
    bannedAt: null,
    muted: false,
    deletedAt: null,
  });
  // Defaults — every test starts with the flag on, a valid claim, an
  // authenticated subject, a fresh user/version row. Tests override only the
  // gate they're exercising. NB: mockReset wipes the implementation, so the
  // default has to be re-set every beforeEach (not just at hoisted-init time).
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  // Developer soft-launch (Phase B): default the AUTHOR gate to the mod floor —
  // the default subject is a mod, so every happy-path test passes
  // assertViewerIsAppDeveloper. FORBIDDEN tests drive a non-author subject.
  mockIsAppBlocksAuthorEnabled.mockImplementation(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  );
  // Phase 2 → soft-launch: default the resolved viewer to a moderator so every
  // happy-path test passes the runtime AUTHZ gate. FORBIDDEN tests override this
  // to a non-author (or vanished) subject.
  mockGetUserById.mockResolvedValue({
    id: 42,
    isModerator: true,
    tier: 'free',
    email: 'u@example.com',
    username: 'u',
  });
  // BOTH runtime gates (assertAppBlocksEnabledForTokenUser for the enabled
  // kill-switch AND assertViewerIsAppDeveloper for authz) resolve the subject via
  // sessionClient.getSessionUserById — default to a moderator so both pass. The
  // FORBIDDEN / vanished-viewer tests override THIS resolver (not getUserById).
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockBuildGenerationContext.mockResolvedValue({ externalCtx: {} });
  // createWorkflowStepsFromGraphInput returns `{ steps, workflowMetadata }`; the
  // block path is single-step txt2img, so default to one step (router takes
  // steps[0]). `workflowMetadata` is the queue/remix metadata the REAL submit
  // attaches and the whatIf submit omits — the graph yields it ONLY on real
  // (non-whatIf) calls, so default to undefined here and override per-test.
  mockCreateStepsFromGraph.mockResolvedValue({
    steps: [{ $type: 'textToImage', name: 's1', input: {} }],
    workflowMetadata: undefined,
  });
  // Daily-boost autoclaim defaults: balance high enough that no claim
  // fires unless a test explicitly drops it. Reward details say boost is
  // unclaimed today with the standard 25 awardAmount. Tests that exercise
  // autoclaim paths override either the balance or the details.
  mockDailyBoostApply.mockResolvedValue(undefined);
  mockDailyBoostGetDetails.mockResolvedValue({
    awarded: 0,
    awardAmount: 25,
    accountType: 'blue',
    type: 'dailyBoost',
    description: 'For claiming daily boost rewards',
    cap: 25,
    onDemand: true,
  });
  mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 10000, blue: 0, green: 0 });
  mockLogToAxiom.mockResolvedValue(undefined);
  // Default: the picked version IS generatable (page branch happy path). Tests
  // that exercise the entitlement gate override to canGenerate:false or an
  // empty Map (version missing → fail-closed).
  mockResolveCanGenerateForVersions.mockImplementation(
    async (versions: Array<{ id: number }>) =>
      new Map(versions.map((v) => [v.id, { canGenerate: true }]))
  );
});

describe('blocks.pollWorkflow', () => {
  it('returns a snapshot for a valid token + workflowId', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue({
      id: 'wf_1',
      status: 'succeeded',
      cost: { total: 10 },
      steps: [
        {
          $type: 'textToImage',
          name: 's',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'b', url: 'https://cdn/i.png', available: true }] },
        },
      ],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(result.snapshot.workflowId).toBe('wf_1');
    expect(result.snapshot.status).toBe('succeeded');
    expect(result.snapshot.imageUrls).toEqual(['https://cdn/i.png']);
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'orch_token',
      path: { workflowId: 'wf_1' },
    });
  });

  it('rejects an invalid block token with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a token missing ai:write:budgeted scope with FORBIDDEN', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects anon subjects with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('blocks.cancelWorkflow', () => {
  it('cancels on the orchestrator then returns the canceled snapshot', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockCancelWorkflow.mockResolvedValue(undefined);
    mockGetWorkflow.mockResolvedValue({
      id: 'wf_1',
      status: 'canceled',
      cost: { total: 0 },
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(result.snapshot.workflowId).toBe('wf_1');
    expect(result.snapshot.status).toBe('canceled');
    // Cancel hits the orchestrator with the VIEWER's token — that's the
    // ownership gate (the orchestrator 403/404s for non-owned workflows).
    expect(mockCancelWorkflow).toHaveBeenCalledWith({ workflowId: 'wf_1', token: 'orch_token' });
    // Then re-reads the workflow to return the terminal snapshot.
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'orch_token',
      path: { workflowId: 'wf_1' },
    });
  });

  it('rejects an invalid block token with UNAUTHORIZED and never calls cancel', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a token missing ai:write:budgeted scope with FORBIDDEN', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('rejects anon subjects with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('blocks.estimateWorkflow', () => {
  it('returns a cost snapshot when the orchestrator whatif succeeds', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyVersionLookup();
    happyUser();
    mockSubmitWorkflow.mockResolvedValue({
      id: '',
      status: 'succeeded',
      cost: { total: 12 },
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.cost).toEqual({ total: 12 });
    // Estimate must use whatif=true so the orchestrator computes cost
    // without actually queueing the job.
    expect(mockSubmitWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ query: { whatif: true } })
    );
  });

  it('rejects when the block JWT pins a different modelId than the body', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ ctx: { modelId: 999 } }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects when the modelVersionId belongs to a different model', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyUser();
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      model: { id: 8, type: 'Checkpoint' },
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects an invalid token with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a source image (img2img) on a MODEL-bound token — img2img is PAGE-only in 2a', async () => {
    // The default validClaims() is a model-bound token (ctx.modelId=7). img2img
    // via sourceImage is a page-only feature this phase, so a model-bound token
    // carrying one must be rejected fail-closed BEFORE any spend.
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.estimateWorkflow({
        blockToken: 'tok',
        body: validBody({
          sourceImage: { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
        }),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('blocks.submitWorkflow', () => {
  it('submits the workflow when cost <= budget', async () => {
    // The recordScopeInvocation mock isn't in the shared beforeEach reset list;
    // clear it so this test's detached call is calls[0].
    vi.mocked(recordScopeInvocation).mockClear();
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    // First call (whatif) returns the cost preview; second call (real submit)
    // returns the actual workflow.
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 25 },
        steps: [],
      });

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(result.snapshot.status).toBe('pending');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    // Second call is the real submit (no whatif query).
    expect(mockSubmitWorkflow.mock.calls[1][0]).not.toHaveProperty('query');
    // Prompt was audited before the orchestrator was touched.
    expect(mockAuditPromptServer).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a cat', userId: 42 })
    );

    // W13 — the audit row carries a structured workflow.submit detail: the buzz
    // spend (NEGATIVE, absolute of the whatIf cost 25) + an ok outcome.
    await vi.waitFor(() => expect(vi.mocked(recordScopeInvocation)).toHaveBeenCalled());
    expect(vi.mocked(recordScopeInvocation).mock.calls[0][0]).toMatchObject({
      scope: 'ai:write:budgeted',
      detail: { action: 'workflow.submit', amount: -25, outcome: 'ok' },
    });
  });

  // ---- G8: per-app aggregate spend + velocity cap -------------------------
  describe('per-app aggregate spend/velocity cap (G8)', () => {
    function setupSubmit(workflowId = 'wf_real') {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: workflowId, status: 'unassigned', cost: { total: 25 }, steps: [] });
    }

    it('reserves against the app cap keyed on the TOKEN appBlockId (server-derived)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 100, appBlockId: 'apb_from_token' })
      );
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      // appBlockId from the verified token, cost from the whatIf estimate.
      expect(mockReserveAppSpend).toHaveBeenCalledWith('apb_from_token', 25);
    });

    it('REJECTS fail-safe when the per-app DAILY cap breaches — no real submit, per-user refunded', async () => {
      setupSubmit();
      mockReserveAppSpend.mockResolvedValue({
        allowed: false,
        reason: 'daily',
        dailyTotal: 999,
        velocityCount: 0,
      });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.error).toMatch(/app daily spend cap reached/);
      // Only the whatIf ran; the REAL submit was never reached (no spend).
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
      // The per-user daily reservation made just before was refunded (DECRBY).
      expect(mockSysRedis.decrBy).toHaveBeenCalled();
    });

    it('REJECTS with the velocity message when the short-window gen ceiling breaches', async () => {
      setupSubmit();
      mockReserveAppSpend.mockResolvedValue({
        allowed: false,
        reason: 'velocity',
        dailyTotal: 0,
        velocityCount: 121,
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.error).toMatch(/rate limit/i);
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    });

    it('passes through when UNDER the cap (real submit proceeds)', async () => {
      setupSubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      expect(mockRefundAppSpend).not.toHaveBeenCalled();
    });

    it('refunds the per-app reservation when the real submit THROWS (downstream failure)', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockRejectedValueOnce(new Error('orchestrator down'));

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toThrow(/orchestrator down/);
      expect(mockRefundAppSpend).toHaveBeenCalledWith('system:blocks:app-spend-cap:apb_test:day', 25);
    });

    it('is EXCLUDED for dev tokens (claims.dev === true → reserve never called)', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100, dev: true }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockReserveAppSpend).not.toHaveBeenCalled();
    });
  });

  // ---- G6: persistent block output queue (fire-and-forget write) ----------
  describe('persistent output queue write (G6)', () => {
    // The queue write is a DETACHED promise (fire-and-forget) that itself does a
    // dynamic import — poll with vi.waitFor rather than racing a fixed flush.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    function happySubmit(workflowId = 'wf_real') {
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: workflowId, status: 'unassigned', cost: { total: 25 }, steps: [] });
    }

    it('writes a queue row with SERVER-DERIVED args after a resolved submit', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({
          buzzBudget: 100,
          appBlockId: 'apb_from_token',
          blockInstanceId: 'bki_from_token',
          sub: 'user:42',
        })
      );
      happyVersionLookup();
      happyUser();
      happySubmit('wf_real');

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      // The write is DETACHED — let it settle, then match OUR distinctive call by
      // the token-derived appBlockId ('apb_from_token' can't collide with a leaked
      // fire-and-forget from a sibling test that uses default claims).
      await vi.waitFor(() =>
        expect(mockUpsertBlockWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({
            workflowId: 'wf_real',
            appBlockId: 'apb_from_token', // from the verified token, NOT the body
            blockInstanceId: 'bki_from_token',
            userId: 42, // from claims.sub
            status: 'pending', // snapshot status (unassigned → pending)
          })
        )
      );
    });

    it('a queue-write failure NEVER breaks (or changes) the submit response', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      happySubmit('wf_real');
      mockUpsertBlockWorkflow.mockRejectedValue(new Error('db down'));

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      await flushMicrotasks();
      // Submit still succeeds with the real workflow id.
      expect(result.snapshot.workflowId).toBe('wf_real');
    });

    it('does NOT write for dev tokens (synthetic non-FK appBlockId)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 100, dev: true, appBlockId: 'apb_dev_only' })
      );
      happyVersionLookup();
      happyUser();
      happySubmit('wf_real');

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      await flushMicrotasks();
      // Robust against a leaked sibling-test write: assert no write for THIS
      // (dev) app block specifically — the dev guard skips the write entirely.
      expect(mockUpsertBlockWorkflow).not.toHaveBeenCalledWith(
        expect.objectContaining({ appBlockId: 'apb_dev_only' })
      );
    });
  });

  // ---- F4: dev-tunnel per-session spend backstop --------------------------
  describe('dev-tunnel session spend cap (F4)', () => {
    function setupSubmit() {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });
    }

    it('rejects (fail-closed) when the dev session ceiling is exceeded — no real submit', async () => {
      setupSubmit();
      // Active dev tunnel for this (user, block); the reserve DENIES.
      mockGetActiveDevTunnel.mockResolvedValue({ sessionId: 'bki_dev', spendCapBuzz: 5000 });
      mockReserveDevSessionBuzz.mockResolvedValue({ allowed: false, total: 5000 });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.error).toMatch(/dev tunnel session Buzz cap reached/);
      // Only the whatIf cost-check submit ran; the REAL submit was never reached.
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
      // The reserve was checked against the session's own ceiling.
      expect(mockReserveDevSessionBuzz).toHaveBeenCalledWith('bki_dev', 25, 5000);
      // The daily-cap reservation was refunded (DECRBY) on the reject.
      expect(mockSysRedis.decrBy).toHaveBeenCalled();
    });

    it('passes through when the dev session is UNDER the ceiling (real submit proceeds)', async () => {
      setupSubmit();
      mockGetActiveDevTunnel.mockResolvedValue({ sessionId: 'bki_dev', spendCapBuzz: 5000 });
      mockReserveDevSessionBuzz.mockResolvedValue({ allowed: true, total: 25 });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      expect(mockRefundDevSessionBuzz).not.toHaveBeenCalled();
    });

    it('refunds the dev-session reservation when the real submit THROWS', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockGetActiveDevTunnel.mockResolvedValue({ sessionId: 'bki_dev', spendCapBuzz: 5000 });
      mockReserveDevSessionBuzz.mockResolvedValue({ allowed: true, total: 25 });
      // whatIf ok, then the REAL submit throws.
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockRejectedValueOnce(new Error('orchestrator down'));

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toThrow(/orchestrator down/);
      // both the daily cap AND the dev session reservation were refunded.
      expect(mockSysRedis.decrBy).toHaveBeenCalled();
      expect(mockRefundDevSessionBuzz).toHaveBeenCalledWith('bki_dev', 25);
    });

    it('is INERT for a normal submit (no active dev tunnel → reserve never called)', async () => {
      setupSubmit();
      // default mockGetActiveDevTunnel → null
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockReserveDevSessionBuzz).not.toHaveBeenCalled();
    });
  });

  // ---- workflow metadata parity (queue/remix view) ------------------------
  //
  // BUG this proves fixed: block-submitted generations carried NO `metadata` on
  // the submit body, so the orchestrator queue/remix view (which reads
  // `WorkflowData.params/resources/remixOfId` ← `workflow.metadata`) showed
  // blank prompt/seed/sampler/cfg/steps/resources. The normal generation form
  // (`generateFromGraph`) attaches `metadata: workflowMetadata` on the REAL
  // submit only — `undefined` on whatIf. These tests pin that parity for the
  // block path: real submit carries the metadata the graph produced; the whatIf
  // (cost-preflight) submit omits it.
  describe('attaches workflow metadata (queue/remix parity)', () => {
    it('REAL submit carries metadata.params + metadata.resources from the graph', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      happyVersionLookup();
      happyUser();
      mockSysRedis.incrBy.mockResolvedValue(125);
      // The graph yields metadata ONLY on the real (non-whatIf) call. The router
      // calls createBlockTextToImageStep twice (whatIf cost-check, then real); the
      // mock returns the same value both times, but only the REAL submit body
      // should carry `metadata` (the whatIf body must omit it — asserted below).
      const workflowMetadata = {
        params: { prompt: 'a cat', seed: 12345, sampler: 'Euler a', cfgScale: 7, steps: 25 },
        resources: [{ id: 99, strength: 1 }],
      };
      mockCreateStepsFromGraph.mockResolvedValue({
        steps: [{ $type: 'textToImage', name: 's1', input: {} }],
        workflowMetadata,
      });
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({
          id: 'wf_real',
          status: 'unassigned',
          cost: { total: 25 },
          steps: [],
        });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);

      // whatIf body (first call) must NOT carry metadata — mirrors the normal
      // path (`generateFromGraph` builds workflowMetadata only for real submits).
      const whatIfBody = mockSubmitWorkflow.mock.calls[0][0].body;
      expect(whatIfBody).not.toHaveProperty('metadata');

      // REAL submit body (second call) carries the graph's metadata so the queue
      // view's params/resources/remixOfId populate.
      const realBody = mockSubmitWorkflow.mock.calls[1][0].body;
      expect(realBody.metadata).toEqual(workflowMetadata);
      expect(realBody.metadata.params).toMatchObject({
        prompt: 'a cat',
        seed: 12345,
        sampler: 'Euler a',
        cfgScale: 7,
        steps: 25,
      });
      expect(realBody.metadata.resources).toEqual([{ id: 99, strength: 1 }]);
    });

    it('passes metadata through verbatim (no fabricated fields) — undefined when the graph omits it', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      happyVersionLookup();
      happyUser();
      mockSysRedis.incrBy.mockResolvedValue(125);
      // Graph returns no metadata (e.g. an entry path that doesn't build it):
      // the body must carry `metadata: undefined`, NOT a fabricated object.
      mockCreateStepsFromGraph.mockResolvedValue({
        steps: [{ $type: 'textToImage', name: 's1', input: {} }],
        workflowMetadata: undefined,
      });
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({
          id: 'wf_real',
          status: 'unassigned',
          cost: { total: 25 },
          steps: [],
        });

      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      const realBody = mockSubmitWorkflow.mock.calls[1][0].body;
      expect(realBody.metadata).toBeUndefined();
    });

    it('estimateWorkflow (whatIf) never attaches metadata to the body', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims());
      happyVersionLookup();
      happyUser();
      // Even if the graph somehow returned metadata, the whatIf estimate body
      // must not carry it (parity with the normal whatIf path).
      mockCreateStepsFromGraph.mockResolvedValue({
        steps: [{ $type: 'textToImage', name: 's1', input: {} }],
        workflowMetadata: { params: { prompt: 'a cat' }, resources: [] },
      });
      mockSubmitWorkflow.mockResolvedValue({
        id: '',
        status: 'succeeded',
        cost: { total: 12 },
        steps: [],
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockSubmitWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ query: { whatif: true } })
      );
      const estimateBody = mockSubmitWorkflow.mock.calls[0][0].body;
      expect(estimateBody).not.toHaveProperty('metadata');
    });
  });

  it('returns a failed-shape snapshot (no throw) when cost > budget', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 5 }));
    happyVersionLookup();
    happyUser();
    mockSubmitWorkflow.mockResolvedValueOnce({
      id: '',
      status: 'succeeded',
      cost: { total: 25 },
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.cost).toEqual({ total: 25 });
    expect(result.snapshot.error).toMatch(/insufficient buzz/i);
    // Critical: the real submit must NOT have been called when we rejected
    // for budget — only the whatif.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('rejects anon subjects with UNAUTHORIZED (no buzz account to charge)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  // ---- A7 cumulative Buzz-spend cap (atomic reserve-and-refund) -----------
  // The cap is now a per-USER (NOT per-app_block) daily aggregate enforced by
  // an atomic reserve: INCRBY returns the new running total; if it exceeds the
  // 50,000 cap we DECRBY-refund and reject. Prior spend is therefore seeded via
  // incrBy's RESOLVED TOTAL (the post-increment running counter), not a get().
  it('A7: rejects (no real submit) when the reservation would exceed the daily cap', async () => {
    // Per-call budget high enough to clear the per-call check; the reservation
    // (prior 49,990 + this 25) returns 50,015, tripping the 50,000 daily cap.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    mockSysRedis.incrBy.mockResolvedValue(50015);
    mockSubmitWorkflow.mockResolvedValueOnce({
      id: '',
      status: 'succeeded',
      cost: { total: 25 },
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.error).toMatch(/daily Buzz cap/i);
    // The whatif ran (1 call) but the REAL submit must NOT have fired.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    // The over-cap reservation must be REFUNDED (DECRBY) so a blocked submit
    // doesn't permanently consume the cap.
    expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1);
    const refundArgs = mockSysRedis.decrBy.mock.calls[0];
    expect(String(refundArgs[0])).toContain('system:blocks:buzz-cap');
    expect(refundArgs[1]).toBe(25);
    // Key-pinning: the refund must target the EXACT key the reservation used,
    // not a re-derived one (else a midnight-UTC rollover between reserve and
    // refund decrements the next day's key into a negative, TTL-less value).
    expect(String(refundArgs[0])).toBe(String(mockSysRedis.incrBy.mock.calls[0][0]));
  });

  it('A7: a submit within the cap succeeds and reserves the spend (no refund)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Reservation returns 125 (prior 100 + this 25), well under 50,000.
    mockSysRedis.incrBy.mockResolvedValue(125);
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 25 },
        steps: [],
      });

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    // The spend is reserved against the cumulative counter exactly once.
    expect(mockSysRedis.incrBy).toHaveBeenCalledTimes(1);
    const incrArgs = mockSysRedis.incrBy.mock.calls[0];
    // PER-USER key shape: system:blocks:buzz-cap:<userId>:<day> — and it must
    // NOT contain the appBlockId segment (ab_x from the resolveBlockInstance
    // mock). A per-app key would let a publisher multiply the ceiling.
    const incrKey = String(incrArgs[0]);
    expect(incrKey).toContain('system:blocks:buzz-cap');
    expect(incrKey).toMatch(/^system:blocks:buzz-cap:42:\d{4}-\d{2}-\d{2}$/);
    expect(incrKey).not.toContain('ab_x');
    expect(incrArgs[1]).toBe(25);
    // A within-cap submit keeps its reservation — no refund.
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('A7: cap counts cumulatively — once the running total tops the cap, submits are rejected', async () => {
    // Simulate the drain attack: per-call budget=1000 (each submit passes the
    // per-call check), but the reservation pushes the running total to 50,001 —
    // this submit is rejected and refunded.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    mockSysRedis.incrBy.mockResolvedValue(50001);
    mockSubmitWorkflow.mockResolvedValueOnce({
      id: '',
      status: 'succeeded',
      cost: { total: 1 },
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.error).toMatch(/daily Buzz cap/i);
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1);
  });

  it('A7: per-USER key is independent of appBlockId (two blocks share one ceiling)', async () => {
    // Two different appBlockIds for the same user must hit the SAME redis key,
    // so all of a user's blocks accumulate against ONE daily ceiling. Assert
    // the key the reservation uses excludes the appBlockId value entirely.
    happyVersionLookup();
    happyUser();
    mockSysRedis.incrBy.mockResolvedValue(25);
    function happySubmit() {
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({
          id: 'wf_real',
          status: 'unassigned',
          cost: { total: 25 },
          steps: [],
        });
    }

    // First block.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000, blockId: 'blk_A' }));
    (BlockRegistry.resolveBlockInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'install',
      modelId: 7,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings: {},
      installedByUserId: 42,
      appBlock: {
        id: 'ab_AAA',
        blockId: 'gen-from-model',
        appId: 'app',
        status: 'approved',
        manifest: { targets: [{ slotId: 'model.sidebar_top' }] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 33554431 },
      },
    });
    happySubmit();
    let caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    const keyA = String(mockSysRedis.incrBy.mock.calls[0][0]);

    // Second block — different appBlockId, same user.
    mockSubmitWorkflow.mockReset();
    mockSysRedis.incrBy.mockClear();
    mockSysRedis.incrBy.mockResolvedValue(50);
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000, blockId: 'blk_B' }));
    (BlockRegistry.resolveBlockInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'install',
      modelId: 7,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings: {},
      installedByUserId: 42,
      appBlock: {
        id: 'ab_BBB',
        blockId: 'gen-from-model',
        appId: 'app',
        status: 'approved',
        manifest: { targets: [{ slotId: 'model.sidebar_top' }] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 33554431 },
      },
    });
    happySubmit();
    caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    const keyB = String(mockSysRedis.incrBy.mock.calls[0][0]);

    // Same per-user key for both blocks, and neither carries an appBlock id.
    expect(keyA).toBe(keyB);
    expect(keyA).not.toContain('ab_AAA');
    expect(keyB).not.toContain('ab_BBB');
  });

  it('A7: refunds the reservation when the real submit throws (and propagates)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    mockSysRedis.incrBy.mockResolvedValue(125);
    // whatif resolves; the REAL submit rejects.
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
      .mockRejectedValueOnce(new Error('orchestrator 500'));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.submitWorkflow({ blockToken: 'tok', body: validBody() })).rejects.toThrow(
      'orchestrator 500'
    );
    // The reservation must be refunded since no submit resolved.
    expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1);
    const refundArgs = mockSysRedis.decrBy.mock.calls[0];
    expect(String(refundArgs[0])).toContain('system:blocks:buzz-cap');
    expect(refundArgs[1]).toBe(25);
    // Key-pinning: refund targets the exact reserved key (see over-cap test).
    expect(String(refundArgs[0])).toBe(String(mockSysRedis.incrBy.mock.calls[0][0]));
  });

  it('A7: keeps the reservation when submitWorkflow RESOLVES with a failed snapshot', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    mockSysRedis.incrBy.mockResolvedValue(125);
    // whatif resolves; the REAL submit RESOLVES (no throw) with a failed-status
    // snapshot. The old code recorded the spend after a resolved submit
    // regardless of status, so we must KEEP the reservation here — no refund.
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
      .mockResolvedValueOnce({ id: 'wf_real', status: 'failed', cost: { total: 25 }, steps: [] });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.status).toBe('failed');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    // Resolved submit → reservation stands → no refund.
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('rejects when the token has no buzzBudget claim', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: undefined }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects when the modelVersionId belongs to a different model', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyUser();
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      model: { id: 8, type: 'Checkpoint' },
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a source image (img2img) on a MODEL-bound token — img2img is PAGE-only in 2a', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({
        blockToken: 'tok',
        body: validBody({
          sourceImage: { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
        }),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects when prompt audit blocks the prompt', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyVersionLookup();
    happyUser();
    mockAuditPromptServer.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'prompt blocked' })
    );
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toBeInstanceOf(TRPCError);
    // Orchestrator must not have been touched — audit fails closed.
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('rejects when the App Blocks flag is disabled (kill-switch, even for a mod token)', async () => {
    // The flag is now evaluated IN-BODY against the TOKEN subject (not the
    // `enforceAppBlocksFlag` middleware's ctx.user), so it runs AFTER
    // verifyBlockToken — but it is still a real kill-switch. Even with a valid
    // MOD token, flag=off → UNAUTHORIZED "App Blocks not enabled", and the real
    // submit never fires.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
    // The token IS verified (the flag gate is in-body now), but no spend/submit.
    expect(mockVerifyBlockToken).toHaveBeenCalled();
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an invalid body shape (zod validation)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({
        blockToken: 'tok',
        // Intentionally malformed: `unknown` is not in the discriminator.
        body: { kind: 'unknown', modelId: 7 } as never,
      })
    ).rejects.toThrow();
  });

  // ---- App-Blocks flag evaluated against the TOKEN subject (dev:live fix) ----
  //
  // ROOT CAUSE this proves fixed: `enforceAppBlocksFlag` evaluated the flag
  // against `ctx.user` (the SESSION user). A dev:live / localhost call is
  // block-token-authed with NO session cookie → `ctx.user` is undefined → the
  // mod-segmented `app-blocks-enabled` flag global-evals false → 401, even when
  // the token's subject is a moderator. fakeCtx() has `user: undefined`,
  // reproducing exactly that path. With the fix the flag is evaluated against
  // the TOKEN subject (resolved via getUserById), so a mod subject passes and a
  // non-mod/anon subject is still blocked (no-widening).
  //
  // The mock here is FAITHFUL: it mirrors the live mod-segmented flag — ON iff
  // the supplied user is a moderator; no user (global eval) → false.
  describe('flag is evaluated against the block-token subject (no session)', () => {
    function faithfulModSegmentedFlag() {
      mockIsAppBlocksEnabled.mockImplementation(async (opts?: { user?: { isModerator?: boolean } }) =>
        !!opts?.user?.isModerator
      );
    }

    it('INVARIANT 1a — MOD token + flag-on: estimate passes the gate (reaches the cost step)', async () => {
      faithfulModSegmentedFlag();
      // ctx.user is undefined (dev:live), but the TOKEN subject (42) is a mod.
      mockVerifyBlockToken.mockResolvedValue(validClaims());
      mockGetUserById.mockResolvedValue({
        id: 42,
        isModerator: true,
        tier: 'free',
        email: 'u@example.com',
        username: 'u',
      });
      happyVersionLookup();
      mockSubmitWorkflow.mockResolvedValue({ id: '', status: 'succeeded', cost: { total: 12 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      // Got past the flag gate → the orchestrator whatif ran and produced a cost.
      expect(result.snapshot.cost).toEqual({ total: 12 });
      // The flag was evaluated against the TOKEN subject ({ user: <mod row> }),
      // NOT ctx.user (undefined) — the dev:live fix.
      expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({
        user: expect.objectContaining({ id: 42, isModerator: true }),
      });
    });

    it('INVARIANT 1a — MOD token + flag-on: submit passes the gate (real submit fires)', async () => {
      faithfulModSegmentedFlag();
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      mockGetUserById.mockResolvedValue({
        id: 42,
        isModerator: true,
        tier: 'free',
        email: 'u@example.com',
        username: 'u',
      });
      happyVersionLookup();
      mockSysRedis.incrBy.mockResolvedValue(125);
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    });

    it('INVARIANT 1b — NON-MOD token: flag false → 401, no submit (stays mod-only pre-GA)', async () => {
      faithfulModSegmentedFlag();
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      // TOKEN subject resolves to a NON-mod user → flag false. The flag gate
      // resolves the subject via getSessionUser (not ctx.user), so set it here.
      const nonMod = {
        id: 42,
        isModerator: false,
        tier: 'free',
        email: 'u@example.com',
        username: 'u',
      };
      mockGetUserById.mockResolvedValue(nonMod);
      mockGetSessionUser.mockResolvedValue(nonMod);
      happyVersionLookup();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('INVARIANT 1c — ANON token (sub:anon): rejected before the flag, no submit', async () => {
      faithfulModSegmentedFlag();
      // sub:'anon' → parseSubjectUserId returns null → UNAUTHORIZED before the
      // flag/mod resolve even runs (there is no resolvable user to evaluate).
      mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon', buzzBudget: 1000 }));
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      // Never resolved a user / evaluated the flag against one, never submitted.
      expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('INVARIANT 4 — invalid token rejected before any flag/mod check', async () => {
      faithfulModSegmentedFlag();
      mockVerifyBlockToken.mockResolvedValue(null);
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('INVARIANT 2 — page-host path (session=mod AND token=mod): unaffected, still passes', async () => {
      faithfulModSegmentedFlag();
      // A real page-host call carries BOTH a session AND the token, same mod.
      // After the change the gate uses the TOKEN subject (= the same mod) → pass.
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      mockGetUserById.mockResolvedValue({
        id: 42,
        isModerator: true,
        tier: 'free',
        email: 'u@example.com',
        username: 'u',
      });
      happyVersionLookup();
      mockSysRedis.incrBy.mockResolvedValue(125);
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });
      // Session user present (page-host), same mod as the token subject.
      const ctxWithSession = {
        ...fakeCtx(),
        user: { id: 42, isModerator: true, tier: 'free', username: 'u' },
      };
      const caller = blocksRouter.createCaller(ctxWithSession as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      // Gate used the TOKEN subject, not the session ctx.user.
      expect(mockIsAppBlocksEnabled).toHaveBeenCalledWith({
        user: expect.objectContaining({ id: 42, isModerator: true }),
      });
    });

    it('pollWorkflow: MOD token + flag-on passes; non-mod token → 401', async () => {
      faithfulModSegmentedFlag();
      mockVerifyBlockToken.mockResolvedValue(validClaims());
      mockGetUserById.mockResolvedValue({ id: 42, isModerator: true });
      mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
      mockGetWorkflow.mockResolvedValue({ id: 'wf_1', status: 'succeeded', cost: { total: 0 }, steps: [] });
      let caller = blocksRouter.createCaller(fakeCtx() as never);
      const ok = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
      expect(ok.snapshot.workflowId).toBe('wf_1');

      // Non-mod subject → flag false → 401, orchestrator never read. The flag
      // gate resolves the subject via getSessionUser.
      mockGetWorkflow.mockClear();
      mockGetUserById.mockResolvedValue({ id: 42, isModerator: false });
      mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false, tier: 'free' });
      caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
      expect(mockGetWorkflow).not.toHaveBeenCalled();
    });
  });

  // ---- W3 flow A — buzz SPEND attribution wire-in ------------------------
  // The submit path fires a best-effort, fire-and-forget spend-attribution
  // write after a RESOLVED submit with a real workflow id. Everything it
  // passes is SERVER-DERIVED from the verified token claims (forge-safe);
  // a throw inside it must NEVER break the generation. The fire is a
  // detached promise, so we let microtasks flush before asserting.
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));

  function happySubmitWithWorkflow(cost = 25, workflowId = 'wf_real') {
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: cost }, steps: [] })
      .mockResolvedValueOnce({
        id: workflowId,
        status: 'unassigned',
        cost: { total: cost },
        steps: [],
      });
  }

  it('A-flow: fires a spend attribution with SERVER-DERIVED args on a resolved submit', async () => {
    // Token carries the attribution-bearing claims; the BODY carries
    // attacker-controllable fields. The write must read from CLAIMS only.
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({
        buzzBudget: 1000,
        appId: 'app_from_token',
        appBlockId: 'apb_from_token',
        blockInstanceId: 'bki_from_token',
        sub: 'user:42',
      })
    );
    happyVersionLookup();
    happyUser();
    happySubmitWithWorkflow(25, 'wf_real');

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    // Server-derived from the VERIFIED token, not the client body.
    expect(arg.appId).toBe('app_from_token');
    expect(arg.appBlockId).toBe('apb_from_token');
    expect(arg.blockInstanceId).toBe('bki_from_token');
    expect(arg.userId).toBe(42); // from claims.sub, via parseSubjectUserId
    expect(arg.workflowId).toBe('wf_real'); // the orchestrator's id
    // Amount is the orchestrator-computed cost (ceil), not a client value.
    expect(arg.buzzAmount).toBe(25);
  });

  it('G5: threads the body sharedContentKey (opaque) through to the spend attribution', async () => {
    // The published-content-author key is app-supplied on the BODY and passed
    // OPAQUE to the service (which resolves the author server-side). Assert it
    // is threaded through; when absent it is null (unchanged behaviour).
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    happySubmitWithWorkflow(25, 'wf_real');

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({
      blockToken: 'tok',
      body: validBody({ sharedContentKey: 'k_content_01ABC' }),
    });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    expect(mockRecordSpendAttribution.mock.calls[0][0].sharedContentKey).toBe('k_content_01ABC');
  });

  it('G5: sharedContentKey is null on the attribution when the body omits it', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    happySubmitWithWorkflow(25, 'wf_real');

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    expect(mockRecordSpendAttribution.mock.calls[0][0].sharedContentKey).toBeNull();
  });

  // 🟡-1: the bounty must accrue off the REALIZED debit on the submit
  // snapshot, not the whatif preflight ESTIMATE. Drive the whatif and the
  // real submit to DIFFERENT costs so a regression to `Math.ceil(cost)`
  // (the estimate) is caught.
  function submitWithEstimateAndRealized(
    estimate: number,
    realized: number | undefined,
    workflowId = 'wf_real'
  ) {
    // First call (whatif) → ESTIMATE; second call (real submit) → REALIZED.
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: estimate }, steps: [] })
      .mockResolvedValueOnce({
        id: workflowId,
        status: 'unassigned',
        // When `realized` is undefined, emit a snapshot with NO cost so the
        // router exercises its estimate-fallback branch.
        ...(realized === undefined ? {} : { cost: { total: realized } }),
        steps: [],
      });
  }

  it('🟡-1: accrues the bounty off the REALIZED debit (estimate 100, realized 40 → 40)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    submitWithEstimateAndRealized(100, 40);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    // Realized (40), NOT the whatif estimate (100). A revert to
    // `Math.ceil(cost)` makes this 100 and fails the assertion.
    expect(arg.buzzAmount).toBe(40);
  });

  it('🟡-1: a cache-hit / 0-realized accrues NOTHING even with a non-zero estimate', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Estimate said 100 but the gen cost 0 (cache hit). The author must not
    // be credited for a generation the platform never charged for.
    submitWithEstimateAndRealized(100, 0);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzAmount).toBe(0);
  });

  it('🟡-1: falls back to the ESTIMATE when the realized value is absent', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Submit snapshot carries no cost → realized absent → fall back to the
    // estimate (100) so attribution isn't silently zeroed when the
    // orchestrator omits the cost on the snapshot.
    submitWithEstimateAndRealized(100, undefined);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzAmount).toBe(100);
  });

  // #2833 — block payout EARN parity. The submit snapshot surfaces the REAL
  // per-account debit on `transactions.list` (the same signal on-site earns
  // off). The PAID portion (green/yellow) must accrue the author bounty; the
  // FREE portion (blue) must never. These drive the real-debit branch.
  function submitWithTransactions(
    realizedCost: number | undefined,
    transactions:
      | Array<{ type: 'debit' | 'credit'; amount: number; accountType: string }>
      | undefined,
    workflowId = 'wf_real'
  ) {
    mockSubmitWorkflow
      // whatif estimate — deliberately large so a regression that reads the
      // estimate instead of the realized paid debit is caught.
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 999 }, steps: [] })
      .mockResolvedValueOnce({
        id: workflowId,
        status: 'unassigned',
        ...(realizedCost === undefined ? {} : { cost: { total: realizedCost } }),
        ...(transactions === undefined ? {} : { transactions: { list: transactions } }),
        steps: [],
      });
  }

  it('#2833: a PAID green debit earns — stamps green + the summed PAID amount (not the blue free floor)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Drained 90 FREE blue + 10 PAID green. Only the 10 green earns.
    submitWithTransactions(100, [
      { type: 'debit', amount: 90, accountType: 'blue' },
      { type: 'debit', amount: 10, accountType: 'green' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('green'); // payout-eligible → bounty accrues
    expect(arg.buzzAmount).toBe(10); // ONLY the paid portion, not 100
  });

  it('#2833: a PAID yellow debit (mature) earns — stamps yellow + the paid amount', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    submitWithTransactions(5, [{ type: 'debit', amount: 5, accountType: 'yellow' }]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('yellow');
    expect(arg.buzzAmount).toBe(5);
  });

  it('#2833: multiple PAID debits are SUMMED', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    submitWithTransactions(60, [
      { type: 'debit', amount: 40, accountType: 'green' },
      { type: 'debit', amount: 20, accountType: 'green' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('green');
    expect(arg.buzzAmount).toBe(60);
  });

  it('#2833: TWO distinct PAID currencies (green + yellow) → defensive fall to blue floor, never sum across types', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // The current contract offers ['blue', green|yellow] so at most ONE paid
    // account drains. This guards a FUTURE change that offers BOTH: if two
    // distinct paid accountTypes appear we must NOT sum them under one type —
    // fall back to the conservative blue floor (blue + realized cost).
    // Realized cost (55) is deliberately != the 40+30=70 cross-type sum so a
    // regression that summed across types would assert 70, not the 55 floor.
    submitWithTransactions(55, [
      { type: 'debit', amount: 40, accountType: 'green' },
      { type: 'debit', amount: 30, accountType: 'yellow' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('blue'); // conservative floor, not green/yellow
    expect(arg.buzzAmount).toBe(55); // realized-cost floor, NOT the 70 cross-type sum
  });

  it('#2833: CREDIT entries (refunds) NET against debits on the paid account (10 debit − 3 credit → 7)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // A same-submit partial refund: the author bounty must accrue off what the
    // user NET paid (7), not the gross debit (10).
    submitWithTransactions(10, [
      { type: 'debit', amount: 10, accountType: 'green' },
      { type: 'credit', amount: 3, accountType: 'green' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('green');
    expect(arg.buzzAmount).toBe(7);
  });

  it('#2833: a fully-refunded paid spend (debit == credit → net 0) falls to the blue free floor', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Net 0 paid → nothing was net-paid → conservative blue floor + realized cost.
    submitWithTransactions(12, [
      { type: 'debit', amount: 8, accountType: 'green' },
      { type: 'credit', amount: 8, accountType: 'green' },
    ]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('blue');
    expect(arg.buzzAmount).toBe(12);
  });

  it('#2833: a BLUE-ONLY debit stays on the free floor — blue + realized cost, ZERO-bounty', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Whole cost drained from FREE blue → must NOT earn. Falls to the floor:
    // blue (payout-excluded) + the realized cost.
    submitWithTransactions(25, [{ type: 'debit', amount: 25, accountType: 'blue' }]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('blue');
    expect(arg.buzzAmount).toBe(25);
  });

  it('#2833: NO transactions on the snapshot → conservative blue free floor (anti-farming, unchanged)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Orchestrator omitted transactions (e.g. cache path). We CANNOT see a
    // paid debit → fall back to blue + cost, so nothing farms a bounty.
    submitWithTransactions(40, undefined);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.buzzType).toBe('blue');
    expect(arg.buzzAmount).toBe(40);
  });

  it('A-flow: forge-safe — a forged appId/appBlockId in the BODY is ignored', async () => {
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ buzzBudget: 1000, appId: 'app_real', appBlockId: 'apb_real' })
    );
    happyVersionLookup();
    happyUser();
    happySubmitWithWorkflow(25, 'wf_real');

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    // Inject forged attribution fields onto the body — the schema strips
    // unknowns, but even if it didn't, the write reads only from claims.
    await caller.submitWorkflow({
      blockToken: 'tok',
      body: {
        ...validBody(),
        appId: 'app_ATTACKER',
        appBlockId: 'apb_ATTACKER',
        appOwnerUserId: 9999,
      } as never,
    });
    await flushMicrotasks();

    const arg = mockRecordSpendAttribution.mock.calls[0][0];
    expect(arg.appId).toBe('app_real');
    expect(arg.appBlockId).toBe('apb_real');
    // No client-supplied owner/share is forwarded — the service derives it.
    expect(arg).not.toHaveProperty('appOwnerUserId');
  });

  it('A-flow: best-effort — a thrown attribution write does NOT break submit', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    happySubmitWithWorkflow(25, 'wf_real');
    mockRecordSpendAttribution.mockRejectedValue(new Error('attribution DB down'));

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    // The generation must still succeed despite the attribution failure.
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();
    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(result.snapshot.status).toBe('pending');
    expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
  });

  it('A-flow: does NOT attribute a RESOLVED failed snapshot (no generation to credit)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // whatif resolves; real submit RESOLVES with a failed status + a
    // (non-sentinel) id. The reservation is kept, but no generation ran, so
    // no author bounty accrues.
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
      .mockResolvedValueOnce({ id: 'wf_real', status: 'failed', cost: { total: 25 }, steps: [] });

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();
    expect(result.snapshot.status).toBe('failed');
    expect(mockRecordSpendAttribution).not.toHaveBeenCalled();
  });

  it('A-flow: does NOT attribute the over-budget rejection (no submit happened)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 5 }));
    happyVersionLookup();
    happyUser();
    // Only the whatif fires; cost (25) > budget (5) → early failed return.
    mockSubmitWorkflow.mockResolvedValueOnce({
      id: '',
      status: 'succeeded',
      cost: { total: 25 },
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    await flushMicrotasks();
    expect(result.snapshot.status).toBe('failed');
    expect(mockRecordSpendAttribution).not.toHaveBeenCalled();
  });
});

/**
 * Daily-boost autoclaim path. After cost ≤ budget but before submit, the
 * router checks the user's actual Buzz balance and opportunistically claims
 * the 25-blue daily boost when it would close the gap. Tests cover the
 * trigger matrix from the spec: sufficient balance, claimed-today, hopeless
 * gap, gap-closer, and apply() failure.
 */
describe('blocks.submitWorkflow — daily boost autoclaim', () => {
  function happySubmitSequence(cost = 25) {
    // First call: whatif preflight returns cost. Second call: real submit.
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: cost }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: cost },
        steps: [],
      });
  }

  it('does NOT claim when the user has enough buzz already (boost unclaimed)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 1000, blue: 0, green: 0 });
    mockDailyBoostGetDetails.mockResolvedValue({
      awarded: 0,
      awardAmount: 25,
      accountType: 'blue',
      type: 'dailyBoost',
      description: 'd',
      cap: 25,
      onDemand: true,
    });
    happySubmitSequence(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).not.toHaveBeenCalled();
    expect(result.snapshot.autoClaim).toBeUndefined();
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('does NOT claim when boost was already claimed today', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    // Balance short of cost but boost is already claimed (awarded > 0).
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 10, blue: 0, green: 0 });
    mockDailyBoostGetDetails.mockResolvedValue({
      awarded: 25,
      awardAmount: 25,
      accountType: 'blue',
      type: 'dailyBoost',
      description: 'd',
      cap: 25,
      onDemand: true,
    });
    happySubmitSequence(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).not.toHaveBeenCalled();
    expect(result.snapshot.autoClaim).toBeUndefined();
    // Submit still proceeds — the orchestrator's own balance check is
    // authoritative; the host doesn't pre-fail on possibly-stale buzz API
    // data.
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('claims when user is short AND the boost would close the gap', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    // Cost 25, balance 5, boost 25 → 5 + 25 = 30 >= 25 ✓
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 5, blue: 0, green: 0 });
    mockDailyBoostGetDetails.mockResolvedValue({
      awarded: 0,
      awardAmount: 25,
      accountType: 'blue',
      type: 'dailyBoost',
      description: 'd',
      cap: 25,
      onDemand: true,
    });
    happySubmitSequence(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).toHaveBeenCalledTimes(1);
    expect(mockDailyBoostApply).toHaveBeenCalledWith({ userId: 42 }, expect.anything());
    expect(result.snapshot.autoClaim).toEqual({
      type: 'dailyBoost',
      amount: 25,
      accountType: 'blue',
    });
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('does NOT claim when the boost would NOT close the gap (hopeless)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
    happyVersionLookup();
    happyUser();
    // Cost 200, balance 10, boost 25 → 10 + 25 = 35 < 200. Don't burn the
    // boost on a still-hopeless submit; let the orchestrator surface the
    // insufficient-buzz error and let the block render Top-Up.
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 10, blue: 0, green: 0 });
    mockDailyBoostGetDetails.mockResolvedValue({
      awarded: 0,
      awardAmount: 25,
      accountType: 'blue',
      type: 'dailyBoost',
      description: 'd',
      cap: 25,
      onDemand: true,
    });
    happySubmitSequence(200);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).not.toHaveBeenCalled();
    expect(result.snapshot.autoClaim).toBeUndefined();
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('submit still proceeds when dailyBoostReward.apply throws (warning logged)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 5, blue: 0, green: 0 });
    mockDailyBoostGetDetails.mockResolvedValue({
      awarded: 0,
      awardAmount: 25,
      accountType: 'blue',
      type: 'dailyBoost',
      description: 'd',
      cap: 25,
      onDemand: true,
    });
    mockDailyBoostApply.mockRejectedValueOnce(new Error('redis down'));
    happySubmitSequence(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).toHaveBeenCalledTimes(1);
    // No autoClaim field on the snapshot — the claim failed.
    expect(result.snapshot.autoClaim).toBeUndefined();
    // But the workflow still went through to the real submit.
    expect(result.snapshot.workflowId).toBe('wf_real');
    // And the failure was logged for ops.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'block-autoclaim-boost', stage: 'apply' }),
      'webhooks'
    );
  });

  it('does NOT claim and submit still proceeds when precheck (balance lookup) throws', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    mockGetUserBuzzAccounts.mockRejectedValueOnce(new Error('buzz api 503'));
    happySubmitSequence(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).not.toHaveBeenCalled();
    expect(result.snapshot.autoClaim).toBeUndefined();
    expect(result.snapshot.workflowId).toBe('wf_real');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'block-autoclaim-boost', stage: 'precheck' }),
      'webhooks'
    );
  });

  it('does NOT claim when the reward multiplier zeros the award (rewardsIneligible)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyVersionLookup();
    happyUser();
    mockGetUserBuzzAccounts.mockResolvedValue({ yellow: 5, blue: 0, green: 0 });
    // awardAmount = 0 means there's nothing to claim for this user.
    mockDailyBoostGetDetails.mockResolvedValue({
      awarded: 0,
      awardAmount: 0,
      accountType: 'blue',
      type: 'dailyBoost',
      description: 'd',
      cap: 25,
      onDemand: true,
    });
    happySubmitSequence(25);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });

    expect(mockDailyBoostApply).not.toHaveBeenCalled();
    expect(result.snapshot.autoClaim).toBeUndefined();
  });
});

/**
 * LoRA-install precedence tests. The earlier submitWorkflow tests use a
 * Checkpoint-type fixture for the bound model, which short-circuits
 * resolveBlockCheckpoint to the Checkpoint-self branch. These exercise the
 * full publisher-default ∪ viewer-override resolution.
 */
describe('blocks.submitWorkflow — LoRA install precedence', () => {
  function loraVersionLookup() {
    // First lookup: resolveBlockVersionContext fetches the LoRA's version.
    // Then resolveBlockCheckpoint fetches the chosen Checkpoint.
    mockDbRead.modelVersion.findUnique.mockImplementation((args: { where: { id: number } }) => {
      if (args.where.id === 99) {
        // The LoRA the block is bound to.
        return Promise.resolve({
          id: 99,
          baseModel: 'Flux.1 D',
          modelId: 7,
          status: 'Published',
          model: { id: 7, type: 'LORA' },
        });
      }
      if (args.where.id === 691639) {
        // The platform Flux Checkpoint.
        return Promise.resolve({
          id: 691639,
          name: 'v1.0',
          baseModel: 'Flux.1 D',
          modelId: 618692,
          status: 'Published',
          model: { id: 618692, name: 'FLUX', type: 'Checkpoint' },
        });
      }
      return Promise.resolve(null);
    });
  }

  it('falls back to platform default when no publisher default AND no viewer override', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyUser();
    loraVersionLookup();
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({ settings: {} });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    // Platform fallback returns the top-thumbed Flux Checkpoint metric.
    mockDbRead.modelMetric.findFirst.mockResolvedValue({
      modelId: 618692,
      model: {
        id: 618692,
        name: 'FLUX',
        modelVersions: [{ id: 691639, name: 'v1.0', baseModel: 'Flux.1 D' }],
      },
    });
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 10 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 10 },
        steps: [],
      });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('rejects with BAD_REQUEST only when the ecosystem has no Checkpoints at all', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyUser();
    loraVersionLookup();
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({ settings: {} });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    // Platform fallback empty — no Published Checkpoint exists for this family.
    mockDbRead.modelMetric.findFirst.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // Helper to override the resolveBlockInstance mock with a specific
  // publisher settings payload. The default mock returns empty settings;
  // tests that exercise the publisher-default path must inject their value.
  function publisherSettings(settings: Record<string, unknown>) {
    (BlockRegistry.resolveBlockInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'install',
      modelId: 7,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings,
      installedByUserId: 42,
      appBlock: {
        id: 'ab_x',
        blockId: 'gen-from-model',
        appId: 'app',
        status: 'approved',
        manifest: { targets: [{ slotId: 'model.sidebar_top' }] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 33554431 },
      },
    });
  }

  it('uses publisher default when no viewer override is set', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyUser();
    loraVersionLookup();
    publisherSettings({ default_checkpoint_version_id: 691639 });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 10 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 10 },
        steps: [],
      });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('viewer override beats publisher default', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyUser();
    loraVersionLookup();
    publisherSettings({ default_checkpoint_version_id: 111 });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue({
      settings: { checkpoint_version_id: 691639 }, // viewer override
    });
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 10 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 10 },
        steps: [],
      });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    // resolveBlockCheckpoint should have queried the override id (691639),
    // not the publisher default (111). loraVersionLookup returns null for
    // 111, so if the precedence is wrong the test fails on resolve.
    expect(mockDbRead.modelVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 691639 } })
    );
  });

  it('drops a stale viewer override and falls through to publisher default', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyUser();
    loraVersionLookup();
    publisherSettings({ default_checkpoint_version_id: 691639 });
    // Override points at a deleted version (222 → null from loraVersionLookup).
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue({
      settings: { checkpoint_version_id: 222 },
    });
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 10 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 10 },
        steps: [],
      });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    // Submission lands — the stale override was dropped and publisher default
    // 691639 took over.
    expect(result.snapshot.workflowId).toBe('wf_real');
  });

  it('subscription-sourced install (bus_pub_*): submits using subscription settings', async () => {
    // The bug fix: pre-fix submitWorkflow → resolveBlockCheckpoint →
    // findUnique({blockInstanceId:'bus_pub_X'}) returned null and the call
    // threw BAD_REQUEST. Post-fix the resolver routes through to the
    // subscription row's settings and the workflow goes through.
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ buzzBudget: 100, blockInstanceId: 'bus_pub_abcd' })
    );
    happyUser();
    loraVersionLookup();
    (BlockRegistry.resolveBlockInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'publisher_subscription',
      modelId: 7,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings: { default_checkpoint_version_id: 691639 },
      installedByUserId: 99, // the subscription owner
      appBlock: {
        id: 'ab_x',
        blockId: 'gen-from-model',
        appId: 'app',
        status: 'approved',
        manifest: { targets: [{ slotId: 'model.sidebar_top' }] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 33554431 },
      },
    });
    mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 10 }, steps: [] })
      .mockResolvedValueOnce({
        id: 'wf_real',
        status: 'unassigned',
        cost: { total: 10 },
        steps: [],
      });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
    expect(result.snapshot.workflowId).toBe('wf_real');
    // Resolver was called with the synthetic id + slot from JWT ctx.
    expect(BlockRegistry.resolveBlockInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        blockInstanceId: 'bus_pub_abcd',
        modelId: 7,
        slotId: 'model.sidebar_top',
      })
    );
  });
});

/**
 * Developer soft-launch (Phase B) — the block-token-authed runtime procedures
 * re-assert the AUTHOR capability against the RESOLVED viewer (from the token
 * subject, NOT ctx.user). A token whose subject resolves to a NON-author
 * (non-mod, not in the `app-blocks-author` cohort) must be rejected with
 * FORBIDDEN even though the token is otherwise valid (valid signature, correct
 * scopes, matching ctx).
 *
 * This is the defense-in-depth layer beneath the gated token-minting endpoint:
 * even if a token were somehow minted for a non-author, the runtime refuses it.
 *
 * NB: the AUTHZ gate resolves the subject via sessionClient.getSessionUserById
 * (mockGetSessionUser) and evaluates isAppBlocksAuthorEnabled against it — a
 * non-mod with no cohort grant → the default mock returns false → FORBIDDEN.
 */
describe('soft-launch — block-token runtime procedures reject non-author viewers', () => {
  function nonModViewer() {
    const nonMod = {
      id: 42,
      isModerator: false,
      tier: 'free',
      email: 'u@example.com',
      username: 'u',
    };
    // Both runtime gates resolve the subject via getSessionUserById; a non-author
    // subject (default author mock = mod-floor only) fails assertViewerIsAppDeveloper.
    mockGetUserById.mockResolvedValue(nonMod);
    mockGetSessionUser.mockResolvedValue(nonMod);
  }

  it('pollWorkflow → FORBIDDEN for a non-mod resolved viewer', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    nonModViewer();
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The orchestrator must never be reached for a non-mod.
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('cancelWorkflow → FORBIDDEN for a non-mod resolved viewer', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    nonModViewer();
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('estimateWorkflow → FORBIDDEN for a non-mod resolved viewer', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    nonModViewer();
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // No orchestrator interaction for a non-mod.
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('submitWorkflow → FORBIDDEN for a non-mod resolved viewer', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    nonModViewer();
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The prompt audit + orchestrator must never run for a non-mod.
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('FORBIDDEN when the resolved viewer has vanished (getSessionUserById → null)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    // The enabled kill-switch is mocked ON (default), so the FORBIDDEN comes from
    // the authz gate: a vanished subject → undefined user → no mod floor + the
    // author mock's `!!undefined?.isModerator` → false → FORBIDDEN.
    mockGetUserById.mockResolvedValue(null);
    mockGetSessionUser.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('author-capable NON-MOD subject passes the authz gate (cohort widening)', async () => {
    // A curated non-mod author: the enabled kill-switch is ON and the
    // `appBlocksAuthor` capability resolves true for this subject → the runtime
    // proc gets PAST the authz gate (reaches the orchestrator read).
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    const cohortAuthor = { id: 42, isModerator: false, tier: 'free', username: 'u' };
    mockGetSessionUser.mockResolvedValue(cohortAuthor);
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
    mockGetWorkflow.mockResolvedValue({ id: 'wf_1', status: 'succeeded', cost: { total: 0 }, steps: [] });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const ok = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(ok.snapshot.workflowId).toBe('wf_1');
    expect(mockIsAppBlocksAuthorEnabled).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 42, isModerator: false }),
    });
  });
});

/**
 * W10 — full-page apps spend Buzz on generation. A PAGE token's ctx is
 * `{ slotId, entityType: 'none' }` with NO modelId: a page lets the viewer pick
 * ANY model they're entitled to generate against. The runtime branch therefore
 * (a) SKIPS the model-binding `ctxModelId === body.modelId` check, and
 * (b) REPLACES it with the canonical generation-entitlement gate
 *     (resolveCanGenerateForVersions) against the REAL viewer.
 * Everything else (budget ceiling, daily cap reservation) is shared with the
 * model path and unchanged.
 */
describe('blocks workflow — W10 page token (entityType:none)', () => {
  // Page claim: ctx carries entityType:'none' + slotId, NO modelId. The
  // blockInstanceId is the synthetic page id (page_<appBlockId>).
  function pageClaims(over: Record<string, unknown> = {}) {
    return validClaims({
      blockInstanceId: 'page_apb_page',
      ctx: { slotId: 'app.page', entityType: 'none' },
      ...over,
    });
  }

  describe('estimateWorkflow', () => {
    it('a page token skips model-binding and passes the canGenerate gate → reaches whatif', async () => {
      // ctx has NO modelId, body.modelId=7 — a MODEL token would 403 here; a
      // page token must NOT.
      mockVerifyBlockToken.mockResolvedValue(pageClaims());
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({
        id: '',
        status: 'succeeded',
        cost: { total: 12 },
        steps: [],
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.cost).toEqual({ total: 12 });
      // The entitlement gate ran against the picked version (99) with the REAL
      // viewer (id 42, mod true) — NOT an elevated/hardcoded context.
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      const [versions, gateCtx] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(versions[0]).toMatchObject({ id: 99 });
      expect(gateCtx.user).toEqual({ id: 42, isModerator: true });
      expect(mockSubmitWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ query: { whatif: true } })
      );
    });

    it('derives sfwOnly:true from a SFW token maturity claim (not the request domain)', async () => {
      // FIX 2: the resource-selection gate's `sfwOnly` is now derived from the
      // AUTHORITATIVE token maturity (`resolveBlockMaturity` → allowMatureContent
      // === false on a SFW ceiling), NOT request-time `ctx.domain`. A SFW
      // maturity claim (green/blue ceiling = 3) must flow into
      // resolveCanGenerateForVersions' context arg as sfwOnly:true even when the
      // request `ctx.domain` is the default (blue, which used to map to false).
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ maxBrowsingLevel: 3 }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({
        id: '',
        status: 'succeeded',
        cost: { total: 12 },
        steps: [],
      });
      // fakeCtx() omits domain → defaults are irrelevant now; the claim drives it.
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      const [, gateCtx] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(gateCtx.sfwOnly).toBe(true);
      // wildcards is independent and untouched here → still false.
      expect(gateCtx.wildcardsEnabled).toBe(false);
    });

    it('a BLUE token (SFW per App-Blocks product decision) also derives sfwOnly:true', async () => {
      // FIX 2 regression guard: under the OLD `ctx.domain === 'green'` rule a
      // blue block had sfwOnly:false → could pick a mature resource. Now a blue
      // token mints a SFW ceiling (maxBrowsingLevel = 3) so the resource gate is
      // SFW too, unified with the generation-output clamp.
      mockVerifyBlockToken.mockResolvedValue(
        pageClaims({ domain: 'blue', maxBrowsingLevel: 3 })
      );
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({
        id: '',
        status: 'succeeded',
        cost: { total: 12 },
        steps: [],
      });
      const caller = blocksRouter.createCaller({ ...fakeCtx(), domain: 'blue' } as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      const [, gateCtx] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(gateCtx.sfwOnly).toBe(true);
    });

    it('a RED token (mature ceiling) derives sfwOnly:false (mature resource selection allowed)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        pageClaims({ domain: 'red', maxBrowsingLevel: 31 })
      );
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({
        id: '',
        status: 'succeeded',
        cost: { total: 12 },
        steps: [],
      });
      const caller = blocksRouter.createCaller({ ...fakeCtx(), domain: 'red' } as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      const [, gateCtx] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(gateCtx.sfwOnly).toBe(false);
    });

    it('derives wildcardsEnabled:true from ctx.features.wildcards and forwards it into the canGenerate gate', async () => {
      // The page branch mirrors model-version.controller: the gate context's
      // wildcardsEnabled is `!!ctx.features.wildcards`. fakeCtx() omits the flag
      // (→ false), so an enabled-wildcards ctx is the only way to exercise this
      // branch — it must flow into the gate context arg as true.
      // Red ceiling (maxBrowsingLevel = 31) so sfwOnly stays false — this test
      // is about wildcards independence, not the maturity clamp. A token with no
      // claim would now FAIL CLOSED to sfwOnly:true (FIX 2), masking the point.
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ maxBrowsingLevel: 31 }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({
        id: '',
        status: 'succeeded',
        cost: { total: 12 },
        steps: [],
      });
      const ctx = fakeCtx();
      const caller = blocksRouter.createCaller({
        ...ctx,
        features: { ...(ctx.features as object), wildcards: true },
      } as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      const [, gateCtx] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(gateCtx.wildcardsEnabled).toBe(true);
      // maturity is independent here → with a red ceiling sfwOnly is false.
      expect(gateCtx.sfwOnly).toBe(false);
    });

    it('a page token whose picked model is NOT generatable → FORBIDDEN, no orchestrator call', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims());
      happyVersionLookup();
      happyUser();
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map([[99, { canGenerate: false }]])
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('fail-closed: page token where the picked version is MISSING from the result Map → FORBIDDEN', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims());
      happyVersionLookup();
      happyUser();
      mockResolveCanGenerateForVersions.mockResolvedValue(new Map()); // empty → miss
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('submitWorkflow', () => {
    it('a page token submits when generatable + within budget (no spend bound bypassed)', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockSysRedis.incrBy.mockResolvedValue(25); // reservation under the cap
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({
          id: 'wf_real',
          status: 'unassigned',
          cost: { total: 25 },
          steps: [],
        });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      // Entitlement gate ran (security replacement for model-binding).
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      // The daily-cap reservation path runs for pages exactly as for models.
      expect(mockSysRedis.incrBy).toHaveBeenCalledTimes(1);
      expect(mockSysRedis.incrBy.mock.calls[0][1]).toBe(25);
      // Prompt was audited before any orchestrator interaction.
      expect(mockAuditPromptServer).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'a cat', userId: 42 })
      );
    });

    it('a page token whose picked model is NOT generatable → FORBIDDEN, no spend, no reservation', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map([[99, { canGenerate: false }]])
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // No orchestrator interaction, no prompt audit, and CRUCIALLY no Buzz
      // reservation (the gate is BEFORE reserveBlockBuzzSpend).
      expect(mockAuditPromptServer).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('a page submit over budget → failed-shape snapshot (no throw), reservation refunded', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ buzzBudget: 5 }));
      happyVersionLookup();
      happyUser();
      // whatif cost 25 > budget 5. The over-budget check is BEFORE the
      // reservation, so no reserve/refund here — matches the model path.
      mockSubmitWorkflow.mockResolvedValueOnce({
        id: '',
        status: 'succeeded',
        cost: { total: 25 },
        steps: [],
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.cost).toEqual({ total: 25 });
      expect(result.snapshot.error).toMatch(/insufficient buzz/i);
      // Only the whatif ran; the real submit did not.
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
      // No reservation was taken (over-budget rejected before reserve).
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('a page submit respects the per-USER daily cap (reservation over cap → failed + refund)', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ buzzBudget: 1000 }));
      happyVersionLookup();
      happyUser();
      // whatif clears the per-call budget, but the reservation tops the daily
      // cap → reject + refund, exactly as for a model token.
      mockSysRedis.incrBy.mockResolvedValue(50015);
      mockSubmitWorkflow.mockResolvedValueOnce({
        id: '',
        status: 'succeeded',
        cost: { total: 25 },
        steps: [],
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.error).toMatch(/daily Buzz cap/i);
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1); // whatif only
      expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1); // reservation refunded
      // Per-USER key (no appBlockId) — page spend shares the same daily ceiling.
      const incrKey = String(mockSysRedis.incrBy.mock.calls[0][0]);
      expect(incrKey).toMatch(/^system:blocks:buzz-cap:42:\d{4}-\d{2}-\d{2}$/);
    });

    // ──────────────────── GA-gap: orchestrator resource belt ─────────────────
    //
    // The pre-spend gate (`resolveCanGenerateForVersions`) deliberately does NOT
    // check early-access `hasAccess` or the `availability:Private` subscription
    // requirement (see the SCOPE comment on assertViewerCanGeneratePageResources).
    // Those are enforced DOWNSTREAM by the orchestrator resource belt
    // (`getGenerationResourceData` → `getResourceData`, which folds
    // `canGenerate = hasAccess && canGenerate` and throws on a Private resource
    // without an active subscription). That belt runs INSIDE
    // `createTextToImageStep`, and the whatIf step is built BEFORE any Buzz
    // reservation.
    //
    // WHAT THIS PROVES: a page viewer who is NOT entitled to an early-access /
    // Private model — but whose model PASSES the pre-spend gate (canGenerate is
    // the DEFAULT true here, modelling the gate's deliberate blind spot) — is
    // rejected by the belt at the whatIf step, BEFORE any reservation. The
    // reservation path (`reserveBlockBuzzSpend`/incrBy) is never reached, so the
    // viewer spends nothing.
    //
    // WHAT THIS DOES NOT PROVE: that getResourceData's REAL hasAccess/Private
    // logic actually rejects those models — that logic is mocked away here (it
    // lives in orchestrator/common.ts and is exercised by its own suite). This
    // test pins the ORDERING + fail-shape contract (belt before spend, throw →
    // no reservation), not the belt's internal entitlement maths. A DEPLOYED
    // browser run against a real early-access / Private model is still required
    // to prove end-to-end entitlement enforcement on the live page surface.
    it('GA-gap: a page model that passes the pre-spend gate but is rejected by the orchestrator belt (early-access/Private) → no spend, no reservation', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims({ buzzBudget: 1000 }));
      happyVersionLookup();
      happyUser();
      // Pre-spend gate PASSES (default canGenerate:true) — modelling that the
      // gate does NOT see early-access / Private entitlement.
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map([[99, { canGenerate: true }]])
      );
      // The orchestrator resource belt (inside createTextToImageStep) rejects an
      // un-entitled early-access / Private resource. The whatIf step is the FIRST
      // belt call in submit, and it is BEFORE the reservation.
      mockCreateStepsFromGraph.mockRejectedValueOnce(
        new TRPCError({ code: 'FORBIDDEN', message: 'early access pass required' })
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // The belt threw at the whatIf step — BEFORE any orchestrator submit and
      // BEFORE any Buzz reservation. Nothing was spent.
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled(); // no reservation
      expect(mockSysRedis.decrBy).not.toHaveBeenCalled(); // nothing to refund
    });

    // Companion: the same belt rejection on the ESTIMATE (whatIf) path — the
    // pre-flight cost estimate also runs through createTextToImageStep, so an
    // un-entitled model is rejected before a cost is ever returned to the page.
    it('GA-gap: estimate of a belt-rejected (early-access/Private) page model → throws, no orchestrator submit', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaims());
      happyVersionLookup();
      happyUser();
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map([[99, { canGenerate: true }]])
      );
      mockCreateStepsFromGraph.mockRejectedValueOnce(
        new TRPCError({ code: 'FORBIDDEN', message: 'this model requires a subscription' })
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });
  });

  // ───────────────────── Page-LoRA (Increment 1) ───────────────────────────
  //
  // A page token can carry `body.additionalResources: [{ modelVersionId,
  // strength }]` (LoRA stack). The server resolves each statelessly, enforces
  // LoRA-only + platform generation-compatibility (getResourceGenerationSupport,
  // GA — allows same-ecosystem AND platform-defined cross-ecosystem LoRAs, still
  // fail-closed on null/unknown), then gates the checkpoint AND every LoRA
  // through resolveCanGenerateForVersions in ONE call — fail-closed if any
  // resource is non-LoRA / not platform-compatible / not entitled. This runs
  // BEFORE resolveBlockCheckpoint / any cost / any reservation.
  describe('Page-LoRA — additionalResources', () => {
    // Multi-version lookup keyed by where.id. Checkpoint 99 = SDXL Checkpoint;
    // additional rows are LoRAs (override per-test for family/type cases).
    function versionRows(rows: Record<number, Record<string, unknown>>) {
      const defaults: Record<number, Record<string, unknown>> = {
        99: {
          id: 99,
          baseModel: 'SDXL 1.0',
          modelId: 7,
          status: 'Published',
          availability: 'Public',
          usageControl: 'Download',
          meta: null,
          generationCoverage: { covered: true },
          model: { id: 7, type: 'Checkpoint', userId: 1 },
        },
        ...rows,
      };
      mockDbRead.modelVersion.findUnique.mockImplementation(async (args: any) => {
        return defaults[args?.where?.id] ?? null;
      });
    }

    const sdxlLora = (id: number, over: Record<string, unknown> = {}) => ({
      id,
      baseModel: 'SDXL 1.0',
      modelId: 100 + id,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: { covered: true },
      model: { id: 100 + id, type: 'LORA', userId: 2 },
      ...over,
    });

    const bodyWithLoras = (resources: Array<{ modelVersionId: number; strength?: number }>) =>
      validBody({ additionalResources: resources });

    function pageClaimsLocal(over: Record<string, unknown> = {}) {
      return validClaims({
        blockInstanceId: 'page_apb_page',
        ctx: { slotId: 'app.page', entityType: 'none' },
        ...over,
      });
    }

    // FIX1 tests use a NON-Checkpoint page body, so resolveBlockCheckpoint falls
    // through rungs 2-4 (viewer override / publisher default / popular). The
    // LoRA-install-precedence suite above leaves a `default_checkpoint_version_id`
    // on the (un-reset) resolveBlockInstance mock — clear both override sources
    // so these tests deterministically reach the platform-popular fallback.
    function clearCheckpointOverrides() {
      (BlockRegistry.resolveBlockInstance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        source: 'install',
        modelId: 7,
        slotId: 'app.page',
        enabled: true,
        settings: {},
        installedByUserId: 42,
        appBlock: {
          id: 'ab_x',
          blockId: 'gen-from-model',
          appId: 'app',
          status: 'approved',
          manifest: { targets: [{ slotId: 'app.page' }] },
          approvedScopes: ['ai:write:budgeted'],
          app: { allowedScopes: 33554431 },
        },
      });
      mockDbRead.blockUserSettings.findUnique.mockResolvedValue(null);
    }

    it('a page submit gates the checkpoint AND every LoRA in ONE call', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201), 202: sdxlLora(202) });
      happyUser();
      mockSysRedis.incrBy.mockResolvedValue(25);
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({
        blockToken: 'tok',
        body: bodyWithLoras([{ modelVersionId: 201, strength: 0.8 }, { modelVersionId: 202 }]),
      });
      expect(result.snapshot.workflowId).toBe('wf_real');
      // The gate ran ONCE with checkpoint + both LoRAs in a single array.
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      const [versions] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(versions.map((v: { id: number }) => v.id).sort((a: number, b: number) => a - b)).toEqual([
        99, 201, 202,
      ]);
    });

    it('SECURITY: an un-entitled LoRA (canGenerate:false) → FORBIDDEN, no spend, no reservation', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201) });
      happyUser();
      // Checkpoint is generatable, the LoRA is NOT.
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map<number, { canGenerate: boolean }>([
          [99, { canGenerate: true }],
          [201, { canGenerate: false }],
        ])
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled(); // no reservation
      expect(mockAuditPromptServer).not.toHaveBeenCalled();
    });

    it('SECURITY fail-closed: a LoRA MISSING from the result Map → FORBIDDEN', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201) });
      happyUser();
      // The LoRA (201) is simply absent from the Map → must be treated as deny.
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map<number, { canGenerate: boolean }>([[99, { canGenerate: true }]])
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('rejects a NON-LoRA additional resource (BAD_REQUEST), before the entitlement gate', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // 201 is a Checkpoint, not a LoRA.
      versionRows({ 201: sdxlLora(201, { model: { id: 301, type: 'Checkpoint', userId: 2 } }) });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // Type rejection happens before the entitlement gate / any spend.
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('rejects a platform-INCOMPATIBLE cross-ecosystem LoRA (BAD_REQUEST), before the entitlement gate', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // GA: the boundary is now getResourceGenerationSupport (platform
      // compatibility), not exact-family equality. Checkpoint is SDXL; the LoRA
      // is SD 1.5 — and there is NO cross-ecosystem generation rule for a SD1
      // LORA into SDXL (the only SD1→SDXL rule covers TextualInversion, not
      // LORA), so getResourceGenerationSupport returns null → still rejected.
      versionRows({ 201: sdxlLora(201, { baseModel: 'SD 1.5' }) });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('rejects an unpublished LoRA (NOT_FOUND), no info leak', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201, { status: 'Draft' }) });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('estimate: an un-entitled LoRA → FORBIDDEN, no orchestrator whatif', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal());
      versionRows({ 201: sdxlLora(201) });
      happyUser();
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map<number, { canGenerate: boolean }>([
          [99, { canGenerate: true }],
          [201, { canGenerate: false }],
        ])
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.estimateWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('BELT: a LoRA that passes the pre-spend gate but is rejected by the orchestrator belt (early-access/Private) → no spend', async () => {
      // The pre-spend gate deliberately does NOT see early-access / Private
      // entitlement (default canGenerate:true here). The orchestrator belt (run
      // inside createTextToImageStep for the FULL resource array at whatIf,
      // BEFORE any reservation) is the second fail-closed layer.
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201) });
      happyUser();
      mockResolveCanGenerateForVersions.mockResolvedValue(
        new Map<number, { canGenerate: boolean }>([
          [99, { canGenerate: true }],
          [201, { canGenerate: true }],
        ])
      );
      mockCreateStepsFromGraph.mockRejectedValueOnce(
        new TRPCError({ code: 'BAD_REQUEST', message: 'Using Private resources require an active subscription.' })
      );
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled(); // belt threw before reserve
      expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
    });

    // ── Money (Piece 4): the multi-resource cost is bounded by BOTH ceilings ──
    it('MONEY: a 2-LoRA gen whose cost exceeds the per-gen budget returns the failed snapshot', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 30 }));
      versionRows({ 201: sdxlLora(201), 202: sdxlLora(202) });
      happyUser();
      // whatif cost (with the LoRAs) is 75 > the 30 per-gen budget.
      mockSubmitWorkflow.mockResolvedValueOnce({
        id: '',
        status: 'succeeded',
        cost: { total: 75 },
        steps: [],
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({
        blockToken: 'tok',
        body: bodyWithLoras([{ modelVersionId: 201 }, { modelVersionId: 202 }]),
      });
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.cost).toEqual({ total: 75 });
      expect(result.snapshot.error).toMatch(/insufficient buzz/i);
      // Only the whatif ran; no real submit, no reservation taken.
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('MONEY: a multi-LoRA gen accumulates against the per-user daily cap (reservation over cap → failed + refund)', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201), 202: sdxlLora(202) });
      happyUser();
      // whatif clears the per-call budget, but the reservation (with the LoRA
      // cost folded in) tops the 50,000 daily cap → reject + refund.
      mockSysRedis.incrBy.mockResolvedValue(50040);
      mockSubmitWorkflow.mockResolvedValueOnce({
        id: '',
        status: 'succeeded',
        cost: { total: 60 },
        steps: [],
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({
        blockToken: 'tok',
        body: bodyWithLoras([{ modelVersionId: 201 }, { modelVersionId: 202 }]),
      });
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.error).toMatch(/daily Buzz cap/i);
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1); // whatif only
      expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1); // reservation refunded
      // The reservation amount is the multi-resource cost (ceil 60).
      expect(mockSysRedis.incrBy.mock.calls[0][1]).toBe(60);
    });

    // ── FIX 1: family-match anchors on the RESOLVED checkpoint, not the body ──
    //
    // For a normal page the body model IS the Checkpoint, so resolved.baseModel
    // and the resolved-checkpoint baseModel coincide. But nothing forces the
    // page body to be a Checkpoint: if a page sends a NON-Checkpoint body,
    // resolveBlockCheckpoint resolves a DIFFERENT default checkpoint as the
    // anchor (viewer/publisher/popular-in-ecosystem). The LoRA family-match must
    // validate against THAT checkpoint's baseModel — not the body model's.
    it('FIX1: non-Checkpoint page body — LoRA family-matches the RESOLVED default checkpoint, not the body model', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Body model 99 is a LoRA (NOT a Checkpoint), baseModel SD 1.5. The
      // additional LoRA 201 is SDXL — it MISMATCHES the body model's family but
      // MATCHES the resolved default checkpoint's family (SDXL, below).
      versionRows({
        99: {
          id: 99,
          baseModel: 'SD 1.5',
          modelId: 7,
          status: 'Published',
          availability: 'Public',
          usageControl: 'Download',
          meta: null,
          generationCoverage: { covered: true },
          model: { id: 7, type: 'LORA', userId: 1 },
        },
        201: sdxlLora(201),
      });
      happyUser();
      clearCheckpointOverrides();
      // resolveBlockCheckpoint (non-Checkpoint body) falls through to the
      // platform-popular fallback → modelMetric.findFirst returns an SDXL
      // checkpoint (version 500). redis.get default = null (cache miss).
      mockDbRead.modelMetric.findFirst.mockResolvedValue({
        modelId: 300,
        model: {
          id: 300,
          name: 'Popular SDXL',
          modelVersions: [{ id: 500, name: 'v1', baseModel: 'SDXL 1.0' }],
        },
      });
      mockSysRedis.incrBy.mockResolvedValue(25);
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      // The SDXL LoRA is compatible with the SDXL *resolved checkpoint* (it would
      // have been rejected if the match used the SD 1.5 body model).
      const result = await caller.submitWorkflow({
        blockToken: 'tok',
        body: bodyWithLoras([{ modelVersionId: 201 }]),
      });
      expect(result.snapshot.workflowId).toBe('wf_real');
      // The gate ran with the body version + the LoRA (both passed the
      // checkpoint-anchored family match).
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      const [versions] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(versions.map((v: { id: number }) => v.id).sort((a: number, b: number) => a - b)).toEqual([
        99, 201,
      ]);
      // The graph input's `model` anchor is the RESOLVED checkpoint (500), not
      // the body version (99). (In the graph shape the checkpoint is `model`,
      // not `resources[0]` — the additional LoRA lives in `resources`.)
      const stepArg = mockCreateStepsFromGraph.mock.calls[0][0];
      expect(stepArg.input.model.id).toBe(500);
    });

    it('FIX1: non-Checkpoint page body — a LoRA matching the BODY family but NOT the resolved checkpoint is REJECTED', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Body model 99 is an SD 1.5 LoRA; additional LoRA 201 is ALSO SD 1.5
      // (matches the body) — but the resolved default checkpoint is SDXL, so the
      // checkpoint-anchored match must REJECT it. (Old body-anchored logic would
      // have wrongly accepted it.)
      versionRows({
        99: {
          id: 99,
          baseModel: 'SD 1.5',
          modelId: 7,
          status: 'Published',
          availability: 'Public',
          usageControl: 'Download',
          meta: null,
          generationCoverage: { covered: true },
          model: { id: 7, type: 'LORA', userId: 1 },
        },
        201: sdxlLora(201, { baseModel: 'SD 1.5', model: { id: 301, type: 'LORA', userId: 2 } }),
      });
      happyUser();
      clearCheckpointOverrides();
      mockDbRead.modelMetric.findFirst.mockResolvedValue({
        modelId: 300,
        model: {
          id: 300,
          name: 'Popular SDXL',
          modelVersions: [{ id: 500, name: 'v1', baseModel: 'SDXL 1.0' }],
        },
      });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // Rejected at the family boundary — before the entitlement gate / any spend.
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    // ── FIX 2: an unrecognized base-model FAILS CLOSED under the GA check ──────
    //
    // GA: the boundary is getResourceGenerationSupport, which does
    // baseModelByName.get(...) for BOTH sides and returns null when either is
    // unrecognized. So an unknown checkpoint baseModel OR an unknown LoRA
    // baseModel → null → reject. This preserves the fail-closed-on-unknown
    // posture the old 'Other'-sentinel guards provided, without those guards.
    it('FIX2: a checkpoint + LoRA with unknown baseModels → BAD_REQUEST (fail-closed on unknown)', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Checkpoint body baseModel is an unrecognized string; the LoRA has a
      // DIFFERENT unrecognized string. The unknown CHECKPOINT alone makes
      // getResourceGenerationSupport return null → reject (it never even looks
      // up the LoRA's ecosystem once the primary is unresolved).
      versionRows({
        99: {
          id: 99,
          baseModel: 'TotallyUnknownBase-Z',
          modelId: 7,
          status: 'Published',
          availability: 'Public',
          usageControl: 'Download',
          meta: null,
          generationCoverage: { covered: true },
          model: { id: 7, type: 'Checkpoint', userId: 1 },
        },
        201: sdxlLora(201, { baseModel: 'AnotherUnknownBase-Q' }),
      });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // Denied before the entitlement gate / any spend.
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    it('FIX2: a known checkpoint + an unknown-baseModel LoRA → BAD_REQUEST', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Checkpoint is a recognized SDXL baseModel; the LoRA baseModel is unknown.
      // getResourceGenerationSupport resolves the primary ecosystem but then
      // baseModelByName.get(loraBaseModel) is undefined → null → reject. An
      // unrecognized LoRA must be denied even against a known checkpoint.
      versionRows({ 201: sdxlLora(201, { baseModel: 'UnknownBaseModel-XYZ' }) });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    // ── LOW-1: the literal 'Other' base-model group FAILS CLOSED ──────────────
    //
    // Regression guard for the GA swap. The null check alone does NOT catch the
    // platform's RECOGNIZED baseModel record literally named 'Other' (BM.Other →
    // ECO.Other): baseModelByName.get('Other') SUCCEEDS, so an ('Other','Other')
    // pair resolves both sides to the SAME ECO.Other ecosystem and
    // getGenerationSupport short-circuits to 'full' BEFORE any disabled/coverage
    // check → non-null → ACCEPT — a fail-OPEN on a billing boundary. The re-added
    // getBaseModelSetType(...) === 'Other' guard must reject it (the entitlement
    // gate must NOT be reached and NO spend reserved).
    it("LOW-1: a checkpoint + LoRA both with the literal 'Other' baseModel → BAD_REQUEST (fail-closed on 'Other' group)", async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Checkpoint body 99 is the recognized 'Other' baseModel record; the LoRA
      // is also 'Other'. Without the explicit guard getResourceGenerationSupport
      // would return 'full' (same ECO.Other ecosystem) and the pair would be
      // accepted — the fail-open this test pins shut.
      versionRows({
        99: {
          id: 99,
          baseModel: 'Other',
          modelId: 7,
          status: 'Published',
          availability: 'Public',
          usageControl: 'Download',
          meta: null,
          generationCoverage: { covered: true },
          model: { id: 7, type: 'Checkpoint', userId: 1 },
        },
        201: sdxlLora(201, { baseModel: 'Other' }),
      });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // The entitlement gate must NOT be reached and NO Buzz reserved.
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    // LOW-1 (LoRA side): a recognized non-'Other' checkpoint + a literal-'Other'
    // LoRA must also fail closed — the LoRA-side guard rejects before the
    // support call even though the checkpoint is fine.
    it("LOW-1: a recognized checkpoint + a literal-'Other' LoRA → BAD_REQUEST", async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Checkpoint 99 is SDXL (versionRows default); the LoRA is the literal
      // 'Other' baseModel record. getResourceGenerationSupport('SDXL 1.0',
      // 'Other', LORA) is null here (different ecosystems, no rule) so this also
      // passes via the null check — but the explicit guard rejects it FIRST,
      // independent of the support call.
      versionRows({ 201: sdxlLora(201, { baseModel: 'Other' }) });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    // ── GA: platform-VALID cross-ecosystem LoRA is now ACCEPTED ────────────────
    //
    // This is the core proof of the GA swap. Before GA, the exact-family
    // equality (getBaseModelSetType) collapsed Pony into its own family ('Pony')
    // distinct from SDXL and REJECTED a Pony LoRA on an SDXL checkpoint. The
    // platform, however, defines an explicit cross-ecosystem generation rule
    // (crossEcosystemRules: Pony → SDXL for LORA/DoRA/LoCon/etc. = 'partial'), so
    // getResourceGenerationSupport('SDXL 1.0', 'Pony', LORA) is non-null → the
    // gate must now PROCEED to the entitlement gate (no family BAD_REQUEST).
    it('GA: a platform-compatible cross-ecosystem LoRA (Pony on an SDXL checkpoint) is ACCEPTED', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      // Checkpoint 99 is SDXL (versionRows default); the additional LoRA is Pony.
      versionRows({ 201: sdxlLora(201, { baseModel: 'Pony' }) });
      happyUser();
      mockSysRedis.incrBy.mockResolvedValue(25);
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: 25 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({
        blockToken: 'tok',
        body: bodyWithLoras([{ modelVersionId: 201 }]),
      });
      expect(result.snapshot.workflowId).toBe('wf_real');
      // It cleared the compatibility boundary and reached the entitlement gate
      // (checkpoint + the cross-ecosystem LoRA in ONE call) — NOT a family
      // BAD_REQUEST.
      expect(mockResolveCanGenerateForVersions).toHaveBeenCalledTimes(1);
      const [versions] = mockResolveCanGenerateForVersions.mock.calls[0];
      expect(versions.map((v: { id: number }) => v.id).sort((a: number, b: number) => a - b)).toEqual([
        99, 201,
      ]);
    });

    // ── GA: a genuinely-incompatible cross-ecosystem LoRA is STILL rejected ────
    //
    // A Flux LoRA on an SDXL checkpoint: different ecosystems with NO
    // cross-ecosystem generation rule between them, so
    // getResourceGenerationSupport('SDXL 1.0', 'Flux.1 D', LORA) is null → reject.
    // This proves the GA widening did NOT collapse into "accept any cross-
    // ecosystem LoRA" — only the platform-permitted pairs pass.
    it('GA: a genuinely-incompatible cross-ecosystem LoRA (Flux on an SDXL checkpoint) is STILL BAD_REQUEST', async () => {
      mockVerifyBlockToken.mockResolvedValue(pageClaimsLocal({ buzzBudget: 1000 }));
      versionRows({ 201: sdxlLora(201, { baseModel: 'Flux.1 D' }) });
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    });

    // ── Model-path guard: additionalResources is page-only ─────────────────
    it('MODEL token with additionalResources → FORBIDDEN (page-only feature, no un-gated fan-out)', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      happyVersionLookup();
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Rejected before the entitlement gate / any orchestrator interaction.
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('MODEL token estimate with additionalResources → FORBIDDEN', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims());
      happyVersionLookup();
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.estimateWorkflow({ blockToken: 'tok', body: bodyWithLoras([{ modelVersionId: 201 }]) })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('REGRESSION — model token still enforces model binding', () => {
    it('estimate: a MODEL token (no entityType) with a mismatched body.modelId → FORBIDDEN', async () => {
      // ctx.modelId 999 ≠ body.modelId 7, and NO entityType → model path → the
      // model-binding check must still fire. The entitlement gate must NOT run
      // (model tokens never reach the page branch).
      mockVerifyBlockToken.mockResolvedValue(validClaims({ ctx: { modelId: 999 } }));
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.estimateWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
    });

    it('submit: a MODEL token with a mismatched body.modelId → FORBIDDEN (binding unchanged)', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100, ctx: { modelId: 999 } }));
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('submit: a matching MODEL token does NOT run the page entitlement gate', async () => {
      // The standard happy model path (ctx.modelId 7 === body 7) must keep its
      // exact behaviour — no canGenerate call (model binding IS the gate).
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
      happyVersionLookup();
      happyUser();
      mockSysRedis.incrBy.mockResolvedValue(25);
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: 25 }, steps: [] })
        .mockResolvedValueOnce({
          id: 'wf_real',
          status: 'unassigned',
          cost: { total: 25 },
          steps: [],
        });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockResolveCanGenerateForVersions).not.toHaveBeenCalled();
    });
  });
});

/**
 * MATURITY ENFORCEMENT (GA gate) — the authoritative server-side belt.
 *
 * The maturity ceiling is derived from the TOKEN's `maxBrowsingLevel` claim
 * (server-minted from the request host), NEVER from a client body field. A
 * SFW-domain token (green/blue → claim = sfwBrowsingLevelsFlag) must force
 * `allowMatureContent: false` into the orchestrator workflow body; a red token
 * (claim = allBrowsingLevelsFlag) must leave it unset (no clamp). A token with
 * NO claim (legacy / pre-feature) fails CLOSED to SFW.
 *
 * Browsing-level flag values (NsfwLevel bits): PG=1, PG13=2 → SFW=3;
 * R|X|XXX add 4|8|16 → all = 31.
 */
const SFW_CEILING = 3; // sfwBrowsingLevelsFlag (PG | PG13)
const ALL_CEILING = 31; // allBrowsingLevelsFlag (PG | PG13 | R | X | XXX)

describe('blocks workflow — color-domain maturity enforcement', () => {
  function lastSubmitBody() {
    const calls = mockSubmitWorkflow.mock.calls;
    return (calls[calls.length - 1][0] as { body: Record<string, unknown> }).body;
  }
  function firstSubmitBody() {
    return (mockSubmitWorkflow.mock.calls[0][0] as { body: Record<string, unknown> }).body;
  }

  describe('estimateWorkflow', () => {
    it('green-domain token (SFW ceiling) forces allowMatureContent=false into the whatif body', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ domain: 'green', maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({ id: '', status: 'succeeded', cost: { total: 5 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(firstSubmitBody().allowMatureContent).toBe(false);
    });

    it('blue-domain token (SFW ceiling, product decision) ALSO forces allowMatureContent=false', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ domain: 'blue', maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({ id: '', status: 'succeeded', cost: { total: 5 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(firstSubmitBody().allowMatureContent).toBe(false);
    });

    it('red-domain token (mature ceiling) does NOT clamp — allowMatureContent omitted', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ domain: 'red', maxBrowsingLevel: ALL_CEILING })
      );
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({ id: '', status: 'succeeded', cost: { total: 5 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(firstSubmitBody()).not.toHaveProperty('allowMatureContent');
    });

    it('legacy token (no maxBrowsingLevel claim) FAILS CLOSED to SFW', async () => {
      // validClaims() carries NO maxBrowsingLevel — the pre-feature shape.
      mockVerifyBlockToken.mockResolvedValue(validClaims());
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({ id: '', status: 'succeeded', cost: { total: 5 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      expect(firstSubmitBody().allowMatureContent).toBe(false);
    });
  });

  describe('submitWorkflow', () => {
    function happySubmit(cost = 10) {
      mockSubmitWorkflow
        .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: cost }, steps: [] })
        .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: cost }, steps: [] });
    }

    it('green-domain token forces allowMatureContent=false on BOTH whatif and real submit', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, domain: 'green', maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      expect(firstSubmitBody().allowMatureContent).toBe(false); // whatif
      expect(lastSubmitBody().allowMatureContent).toBe(false); // real submit
    });

    it('blue-domain token (SFW per product decision) forces allowMatureContent=false on the real submit', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, domain: 'blue', maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(lastSubmitBody().allowMatureContent).toBe(false);
    });

    it('red-domain token leaves allowMatureContent UNSET (mature allowed)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, domain: 'red', maxBrowsingLevel: ALL_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(firstSubmitBody()).not.toHaveProperty('allowMatureContent');
      expect(lastSubmitBody()).not.toHaveProperty('allowMatureContent');
    });

    it('legacy token (no claim) FAILS CLOSED to SFW on the real submit', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 1000 }));
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(lastSubmitBody().allowMatureContent).toBe(false);
    });

    it('clamp is TOKEN-derived: a malicious body cannot widen a SFW token to mature', async () => {
      // The token is SFW (green). The attacker stuffs allowMatureContent:true
      // (and an nsfwLevel) onto the BODY. The schema strips unknowns, and even
      // if it didn't, the clamp reads the TOKEN claim — the submitted body MUST
      // still carry allowMatureContent:false.
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, domain: 'green', maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({
        blockToken: 'tok',
        body: { ...validBody(), allowMatureContent: true, nsfwLevel: 'xxx' } as never,
      });
      expect(lastSubmitBody().allowMatureContent).toBe(false);
    });

    it('prompt audit isGreen is DOMAIN-derived: SFW token → isGreen=true', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, domain: 'blue', maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockAuditPromptServer).toHaveBeenCalledWith(
        expect.objectContaining({ isGreen: true })
      );
    });

    it('prompt audit isGreen is DOMAIN-derived: red token → isGreen=false', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, domain: 'red', maxBrowsingLevel: ALL_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockAuditPromptServer).toHaveBeenCalledWith(
        expect.objectContaining({ isGreen: false })
      );
    });
  });
});

/**
 * Buzz-type PARITY with the on-site generator. Block-initiated workflows used
 * to hardcode currencies=['yellow']; they now derive blue-first + the domain
 * currency from the AUTHORITATIVE token maturity ceiling (resolveBlockMaturity
 * → isGreen), at parity with on-site resolveGenerationCurrencies:
 *   - SFW (green/blue, SFW ceiling) → ['blue','green']
 *   - mature (.red, mature ceiling) → ['blue','yellow']
 * And the SPENT currency is recorded on the spend-attribution row so the
 * (dark) payout rail can exclude free/granted Buzz.
 */
describe('blocks workflow — buzz-type parity + spend-attribution currency', () => {
  function happySubmit(cost = 10) {
    mockSubmitWorkflow
      .mockResolvedValueOnce({ id: '', status: 'succeeded', cost: { total: cost }, steps: [] })
      .mockResolvedValueOnce({ id: 'wf_real', status: 'unassigned', cost: { total: cost }, steps: [] });
  }
  function bodyOf(callIdx: number) {
    return (mockSubmitWorkflow.mock.calls[callIdx][0] as { body: Record<string, unknown> }).body;
  }

  // NOTE: the orchestrator currency VALUES (the BuzzClientAccount-mapped
  // strings) can't be asserted here — the global test setup mocks
  // `@civitai/client` with a stub `BuzzClientAccount` lacking BLUE/GREEN/YELLOW
  // (see src/__tests__/setup.ts), so `BuzzTypes.toOrchestratorType` yields
  // nulls under vitest. The exact SFW→blue/green, mature→blue/yellow,
  // blue-first ordering is asserted on the pure `BuzzSpendType` strings in
  // src/server/utils/__tests__/buzz-helpers.test.ts. Here we assert the
  // ROUTER-level behavior that depends on the derivation: the currency array
  // is now the 2-element PARITY set (was a 1-element ['yellow'] hardcode), it's
  // applied at EVERY submit site, and the recorded spend buzzType matches the
  // domain currency (pure string, unaffected by the client mock).
  describe('estimateWorkflow currencies (whatIf)', () => {
    it('derives a 2-element parity currency set (was 1-element yellow-only)', async () => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ maxBrowsingLevel: SFW_CEILING }));
      happyVersionLookup();
      happyUser();
      mockSubmitWorkflow.mockResolvedValue({ id: '', status: 'succeeded', cost: { total: 5 }, steps: [] });
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.estimateWorkflow({ blockToken: 'tok', body: validBody() });
      const currencies = bodyOf(0).currencies as unknown[];
      expect(Array.isArray(currencies)).toBe(true);
      expect(currencies).toHaveLength(2);
    });
  });

  describe('submitWorkflow currencies (whatIf cost-check AND real submit MATCH)', () => {
    it('applies the SAME 2-element parity currency set to both submit bodies', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      const whatIf = bodyOf(0).currencies as unknown[];
      const real = bodyOf(1).currencies as unknown[];
      // Both sites get a 2-element set, and the real submit's set is identical
      // to the whatIf cost-check's (so the estimate matches what's drained).
      expect(whatIf).toHaveLength(2);
      expect(real).toEqual(whatIf);
    });
  });

  describe('spend-attribution records a payout-safe currency basis (conservative free floor)', () => {
    // green is PAID/payout-eligible, but the orchestrator doesn't surface the
    // real per-account split and blocks drain blue (free) FIRST, so we stamp the
    // conservative free floor (blue) → 0 payout until a follow-up records the
    // real debit. Both domains stamp blue.
    it('SFW block records buzzType="blue" (free first-drained floor → 0 payout)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      // The spend write is fire-and-forget; flush the microtask queue.
      await Promise.resolve();
      await Promise.resolve();
      expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
      expect(mockRecordSpendAttribution.mock.calls[0][0]).toMatchObject({
        buzzType: 'blue',
        workflowId: 'wf_real',
      });
    });

    it('mature (.red) block ALSO records buzzType="blue" (free first-drained floor → 0 payout)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: ALL_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockRecordSpendAttribution).toHaveBeenCalledTimes(1);
      expect(mockRecordSpendAttribution.mock.calls[0][0]).toMatchObject({
        buzzType: 'blue',
        workflowId: 'wf_real',
      });
    });
  });

  // ---- viewer-picked accountType (money page blocks) ----------------------
  // The exact reordered orchestrator currency VALUES can't be asserted here
  // (the global @civitai/client mock nulls out BuzzClientAccount, so
  // toOrchestratorType yields non-comparable values — the ORDERING is asserted
  // on the pure BuzzSpendType strings in buzz-helpers.test.ts). Here we pin the
  // ROUTER-level behavior: an ALLOWED / ABSENT pick submits normally, and a
  // DISALLOWED pick is REJECTED before any orchestrator spend.
  describe('honors body.accountType (preferred-first, domain-clamped)', () => {
    it('absent accountType → submits normally (Auto, both submit sites fire)', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({ blockToken: 'tok', body: validBody() });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      // Auto still derives the 2-element parity currency set at both sites.
      expect((bodyOf(0).currencies as unknown[]).length).toBe(2);
      expect((bodyOf(1).currencies as unknown[]).length).toBe(2);
    });

    it('ALLOWED accountType (green on a SFW block) → submits normally', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      happySubmit();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      const result = await caller.submitWorkflow({
        blockToken: 'tok',
        body: validBody({ accountType: 'green' }),
      });
      expect(result.snapshot.workflowId).toBe('wf_real');
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      // whatIf + real still carry the same currency set (estimate matches drain).
      expect((bodyOf(1).currencies as unknown[]).length).toBe(2);
    });

    it('DISALLOWED accountType (yellow on a SFW block) → BAD_REQUEST, no spend', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: SFW_CEILING })
      );
      happyVersionLookup();
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody({ accountType: 'yellow' }) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // The domain clamp must fire BEFORE any orchestrator interaction.
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('DISALLOWED accountType (green on a mature .red block) → BAD_REQUEST, no spend', async () => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ buzzBudget: 1000, maxBrowsingLevel: ALL_CEILING })
      );
      happyVersionLookup();
      happyUser();
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({ blockToken: 'tok', body: validBody({ accountType: 'green' }) })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('rejects an out-of-enum accountType at the schema boundary (zod)', async () => {
      const caller = blocksRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.submitWorkflow({
          blockToken: 'tok',
          // `red` is disabled and not in the spendable enum → zod rejects.
          body: validBody({ accountType: 'red' }) as never,
        })
      ).rejects.toThrow();
    });
  });
});

// ---- getMyBuzzBalance (host-mediated, token-bound balance read) ------------
// Money page blocks read the VIEWER's OWN spendable balances via the block
// token WITHOUT holding buzz:read:self. userId is derived from the self-bound
// token sub, never client input — a page can only read its own session's user.
describe('blocks.getMyBuzzBalance', () => {
  it('returns the three spendable balances for a valid token (from getUserBuzzAccounts)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyUser();
    // getUserBuzzAccounts returns every spend type; the proc projects to three.
    mockGetUserBuzzAccounts.mockResolvedValue({ blue: 100, green: 20, yellow: 5, red: 999 });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyBuzzBalance({ blockToken: 'tok' });
    expect(result).toEqual({ blue: 100, green: 20, yellow: 5 });
    // Never returns internal types (red / creatorProgram / cash).
    expect(result).not.toHaveProperty('red');
    // The balance is read for the TOKEN subject (42), not any client input.
    expect(mockGetUserBuzzAccounts).toHaveBeenCalledWith({ userId: 42 });
  });

  it('defaults missing account values to 0', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyUser();
    mockGetUserBuzzAccounts.mockResolvedValue({ blue: 50 } as never);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyBuzzBalance({ blockToken: 'tok' });
    expect(result).toEqual({ blue: 50, green: 0, yellow: 0 });
  });

  it('rejects an invalid block token with UNAUTHORIZED (never reads a balance)', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzBalance({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetUserBuzzAccounts).not.toHaveBeenCalled();
  });

  it('rejects an anon subject with UNAUTHORIZED (no balance to read)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzBalance({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetUserBuzzAccounts).not.toHaveBeenCalled();
  });

  it('rejects when the App Blocks flag is disabled (kill-switch)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    happyUser();
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzBalance({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps are not enabled',
    });
    expect(mockGetUserBuzzAccounts).not.toHaveBeenCalled();
  });

  it('rejects a non-author subject with FORBIDDEN (author gate, no balance read)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    // Enabled kill-switch passes, but the subject is not an app author.
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false, tier: 'free' });
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzBalance({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockGetUserBuzzAccounts).not.toHaveBeenCalled();
  });
});

// ---- getMyViewer (host-mediated, token-bound viewer identity read) ----------
// A page block reads the VIEWER's OWN identity ("who am I") via the block token,
// backing the SDK useViewer() hook. userId is derived from the self-bound token
// sub (never client input), gated on the `user:read:self` consent scope (unlike
// the scope-free getMyBuzzBalance). Mirrors /api/v1/blocks/me: dbWrite ban/mute/
// deleted lookup, 404 on deleted, 403 on banned, `status:'muted'` for muted.
const VIEWER_READ = ['user:read:self'];

describe('blocks.getMyViewer', () => {
  it('returns the SELF-BOUND viewer identity for a valid token (id/username/status/buzzBudget)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyViewer({ blockToken: 'tok' });
    // buzzBudget comes from the token claim (validClaims default 50).
    expect(result).toEqual({ id: 42, username: 'u', status: 'active', buzzBudget: 50 });
    // The identity is read for the TOKEN subject (42) — NEVER a client input.
    expect(mockDbWriteUserFindUnique.mock.calls[0][0].where).toEqual({ id: 42 });
  });

  it('passes a muted viewer through with status:muted', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockDbWriteUserFindUnique.mockResolvedValue({
      id: 42,
      username: 'u',
      bannedAt: null,
      muted: true,
      deletedAt: null,
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyViewer({ blockToken: 'tok' });
    expect(result.status).toBe('muted');
  });

  it('surfaces buzzBudget as null when the token carries no budget claim', async () => {
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ scopes: VIEWER_READ, buzzBudget: undefined })
    );
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyViewer({ blockToken: 'tok' });
    expect(result.buzzBudget).toBeNull();
  });

  it('rejects a token missing user:read:self with FORBIDDEN (never reads the db)', async () => {
    // Default validClaims scopes are ['ai:write:budgeted'] — no viewer consent.
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDbWriteUserFindUnique).not.toHaveBeenCalled();
  });

  it('rejects an invalid block token with UNAUTHORIZED (never reads the db)', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDbWriteUserFindUnique).not.toHaveBeenCalled();
  });

  it('rejects an anon subject with UNAUTHORIZED (no viewer identity to read)', async () => {
    // Carries the scope so it reaches the self-bind step, which rejects anon.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ, sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDbWriteUserFindUnique).not.toHaveBeenCalled();
  });

  it('rejects when the App Blocks flag is disabled (kill-switch, no db read)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps are not enabled',
    });
    expect(mockDbWriteUserFindUnique).not.toHaveBeenCalled();
  });

  it('rejects a non-author subject with FORBIDDEN (author gate, no db read)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false, tier: 'free' });
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDbWriteUserFindUnique).not.toHaveBeenCalled();
  });

  it('rate-limits per blockInstanceId BEFORE the db read (TOO_MANY_REQUESTS)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    // The rate limit is checked on the SELF-BOUND blockInstanceId, before the db.
    expect(mockCheckBlockCatalogRateLimit).toHaveBeenCalledWith('bki_test');
    expect(mockDbWriteUserFindUnique).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the resolved viewer is deleted', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockDbWriteUserFindUnique.mockResolvedValue({
      id: 42,
      username: 'u',
      bannedAt: null,
      muted: false,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns NOT_FOUND when the viewer row has vanished', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockDbWriteUserFindUnique.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns FORBIDDEN (banned) when the resolved viewer is banned', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: VIEWER_READ }));
    mockDbWriteUserFindUnique.mockResolvedValue({
      id: 42,
      username: 'u',
      bannedAt: new Date('2026-01-01T00:00:00Z'),
      muted: false,
      deletedAt: null,
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyViewer({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'banned',
    });
  });
});

describe('blocks.listMyWorkflows (G6 — persistent output queue read)', () => {
  it("returns the caller's own workflows, scoped to the TOKEN appBlockId + viewer", async () => {
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ appBlockId: 'apb_from_token', sub: 'user:42' })
    );
    mockListMyBlockWorkflows.mockResolvedValue({
      items: [{ workflowId: 'wf_2', status: 'succeeded', submittedAt: 'iso2', updatedAt: 'iso2' }],
      nextCursor: null,
    });

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.listMyWorkflows({ blockToken: 'tok', limit: 10 });

    expect(result.items.map((i) => i.workflowId)).toEqual(['wf_2']);
    // userId (from claims.sub) + appBlockId (from the token) are server-scoped —
    // a block can't read another user's or another app's queue.
    expect(mockListMyBlockWorkflows).toHaveBeenCalledWith({
      userId: 42,
      appBlockId: 'apb_from_token',
      limit: 10,
      cursor: undefined,
    });
  });

  it('threads a cursor through for keyset pagination', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ appBlockId: 'apb_1', sub: 'user:42' }));
    mockListMyBlockWorkflows.mockResolvedValue({ items: [], nextCursor: null });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.listMyWorkflows({ blockToken: 'tok', cursor: 'iso|wf_9' });
    expect(mockListMyBlockWorkflows.mock.calls[0][0].cursor).toBe('iso|wf_9');
  });

  it('rejects an invalid block token with UNAUTHORIZED and never reads the queue', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.listMyWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockListMyBlockWorkflows).not.toHaveBeenCalled();
  });

  it('rejects a token missing ai:write:budgeted scope with FORBIDDEN', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: [] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.listMyWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockListMyBlockWorkflows).not.toHaveBeenCalled();
  });

  it('rejects anon subjects with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.listMyWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockListMyBlockWorkflows).not.toHaveBeenCalled();
  });
});

// ---- Buzz self-read bridges (getMyBuzz{Transactions,Accounts} + -----------
// getMyDailyCompensation) — host-mediated, token-bound, buzz:read:self consent.
// A `buzz:read:self` claim is REQUIRED (unlike the scope-free getMyBuzzBalance).
// ---------------------------------------------------------------------------
const BUZZ_READ = ['buzz:read:self'];

describe('blocks.getMyBuzzTransactions', () => {
  it('returns the SELF-BOUND ledger with the hardened projection (details allowlist + externalTransactionId nulled)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    mockGetUserBuzzTransactions.mockResolvedValue({
      cursor: new Date('2026-06-30T00:00:00Z'),
      transactions: [
        {
          date: new Date('2026-07-01T00:00:00Z'),
          type: TransactionType.Purchase,
          fromAccountId: 0,
          toAccountId: 42,
          fromAccountType: 'yellow',
          toAccountType: 'yellow',
          amount: 100,
          description: 'buy',
          details: { entityId: 5, entityType: 'Model', stripePaymentIntentId: 'pi_secret' },
          externalTransactionId: 'pi_secret',
          toUser: { id: 42, username: 'me', status: 'active' },
          fromUser: undefined,
        },
      ],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyBuzzTransactions({ blockToken: 'tok', accountType: 'yellow' });
    // Self-bound: accountId is always the token subject (42), never client input.
    expect(mockGetUserBuzzTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 42, accountType: 'yellow' })
    );
    const row = result.transactions[0];
    expect(row.type).toBe('Purchase');
    // Details allowlist drops the Stripe payment-intent ref.
    expect(row.details).not.toHaveProperty('stripePaymentIntentId');
    // Purchase row → externalTransactionId nulled (processor-reference leak class).
    expect(row.externalTransactionId).toBeNull();
    // Counterparty stripped to {id, username}.
    expect(row.toUser).toEqual({ id: 42, username: 'me' });
  });

  it('maps the TransactionType NAME to the enum for the service call', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    mockGetUserBuzzTransactions.mockResolvedValue({ cursor: null, transactions: [] });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.getMyBuzzTransactions({ blockToken: 'tok', type: 'Tip', limit: 200 });
    expect(mockGetUserBuzzTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 42, type: TransactionType.Tip, limit: 200 })
    );
  });

  it('FORBIDDEN without the buzz:read:self scope (consent gate), before any read', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzTransactions({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockGetUserBuzzTransactions).not.toHaveBeenCalled();
  });

  it('UNAUTHORIZED for an invalid token / anon subject (never reads)', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    let caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzTransactions({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ, sub: 'anon' }));
    caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzTransactions({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetUserBuzzTransactions).not.toHaveBeenCalled();
  });

  it('rate-limit trips → TOO_MANY_REQUESTS BEFORE the service call', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzTransactions({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockCheckBlockCatalogRateLimit).toHaveBeenCalledWith('bki_test');
    expect(mockGetUserBuzzTransactions).not.toHaveBeenCalled();
  });

  it('rejects a bad accountType at the input boundary (never reads)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.getMyBuzzTransactions({ blockToken: 'tok', accountType: 'red' } as never)
    ).rejects.toBeDefined();
    expect(mockGetUserBuzzTransactions).not.toHaveBeenCalled();
  });
});

describe('blocks.getMyBuzzAccounts', () => {
  it('reads every exposed pool for the SELF-BOUND subject, projecting {accountType, balance}', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    mockGetUserBuzzAccount.mockResolvedValue([
      { id: 42, balance: 100, lifetimeBalance: null, accountType: 'yellow' },
      { id: 42, balance: 5, lifetimeBalance: null, accountType: 'cashSettled' },
    ]);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyBuzzAccounts({ blockToken: 'tok' });
    expect(mockGetUserBuzzAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 42 })
    );
    expect(result.accounts).toEqual([
      { accountType: 'yellow', balance: 100 },
      { accountType: 'cashSettled', balance: 5 },
    ]);
  });

  it('FORBIDDEN without buzz:read:self; UNAUTHORIZED for invalid token', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    let caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzAccounts({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mockVerifyBlockToken.mockResolvedValue(null);
    caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.getMyBuzzAccounts({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetUserBuzzAccount).not.toHaveBeenCalled();
  });
});

describe('blocks.getMyDailyCompensation', () => {
  it('reads the SELF-BOUND per-model compensation for the month of date', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    mockGetDailyCompensation.mockResolvedValue({ resources: [], hasPublishedResources: false });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.getMyDailyCompensation({
      blockToken: 'tok',
      date: new Date('2026-07-01'),
    });
    expect(result).toEqual({ resources: [], hasPublishedResources: false });
    expect(mockGetDailyCompensation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, source: 'compensation' })
    );
  });

  it('rate-limit trips → TOO_MANY_REQUESTS before the ClickHouse-backed read', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: BUZZ_READ }));
    happyUser();
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.getMyDailyCompensation({ blockToken: 'tok', date: new Date('2026-07-01') })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockGetDailyCompensation).not.toHaveBeenCalled();
  });

  it('FORBIDDEN without buzz:read:self (consent gate)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.getMyDailyCompensation({ blockToken: 'tok', date: new Date('2026-07-01') })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetDailyCompensation).not.toHaveBeenCalled();
  });
});

// W13 — updateUserSettings records an audit row with a static settings.update
// detail. Drives the real proc (via createCaller) with the default happy-path
// mocks and asserts the emitted detail.
describe('blocks.updateUserSettings — W13 action detail', () => {
  it('emits a settings.update detail after persisting the viewer settings', async () => {
    vi.mocked(recordScopeInvocation).mockClear();
    mockVerifyBlockToken.mockResolvedValue(validClaims());

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.updateUserSettings({ blockToken: 'tok', settings: {} });
    expect(result).toEqual({ ok: true });
    expect(BlockRegistry.upsertUserSettings).toHaveBeenCalled();

    await vi.waitFor(() => expect(vi.mocked(recordScopeInvocation)).toHaveBeenCalled());
    expect(vi.mocked(recordScopeInvocation).mock.calls[0][0]).toMatchObject({
      scope: 'block:settings:write',
      endpoint: 'user-settings:write',
      detail: { action: 'settings.update', outcome: 'ok' },
    });
  });
});
