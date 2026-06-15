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
  mockCreateTextToImageStep,
  mockAuditPromptServer,
  mockGetUserById,
  mockDbRead,
  mockRedis,
  mockIsAppBlocksEnabled,
  mockDailyBoostApply,
  mockDailyBoostGetDetails,
  mockGetUserBuzzAccounts,
  mockLogToAxiom,
  mockSysRedis,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockCreateTextToImageStep: vi.fn(),
  mockAuditPromptServer: vi.fn(),
  mockGetUserById: vi.fn(),
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
  mockRedis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
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
vi.mock('~/server/services/orchestrator/textToImage/textToImage', () => ({
  createTextToImageStep: mockCreateTextToImageStep,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: mockAuditPromptServer,
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: mockGetUserById,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  // dbWrite is referenced for install-management procedures; stub the few
  // shapes the unrelated procedures could hit so the import doesn't crash.
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
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
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: {
    apply: (...args: unknown[]) => mockDailyBoostApply(...args),
    getUserRewardDetails: (...args: unknown[]) => mockDailyBoostGetDetails(...args),
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...args: unknown[]) => mockGetUserBuzzAccounts(...args),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => mockLogToAxiom(...args),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
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

import { blocksRouter } from '../blocks.router';
import { BlockRegistry } from '~/server/services/block-registry.service';
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
    mockCreateTextToImageStep,
    mockAuditPromptServer,
    mockGetUserById,
    mockDbRead.modelVersion.findUnique,
    mockIsAppBlocksEnabled,
    mockDailyBoostApply,
    mockDailyBoostGetDetails,
    mockGetUserBuzzAccounts,
    mockLogToAxiom,
    mockSysRedis.get,
    mockSysRedis.incrBy,
    mockSysRedis.decrBy,
    mockSysRedis.expire,
    mockSysRedis.ttl,
  ]) {
    fn.mockReset();
  }
  // Buzz-cap (audit A7): default to an empty window so the cap is non-binding
  // unless a test seeds prior spend. The cap is now an atomic reserve (INCRBY
  // returns the new running total) + refund (DECRBY); default incrBy → cost so
  // the reservation stays under the 50,000 cap unless a test overrides it.
  mockSysRedis.get.mockResolvedValue(null);
  mockSysRedis.incrBy.mockResolvedValue(0);
  mockSysRedis.decrBy.mockResolvedValue(0);
  mockSysRedis.expire.mockResolvedValue(true);
  mockSysRedis.ttl.mockResolvedValue(-1);
  // Defaults — every test starts with the flag on, a valid claim, an
  // authenticated subject, a fresh user/version row. Tests override only the
  // gate they're exercising. NB: mockReset wipes the implementation, so the
  // default has to be re-set every beforeEach (not just at hoisted-init time).
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  // Phase 2: default the resolved viewer to a moderator so every happy-path
  // test passes the new assertViewerIsModerator gate. FORBIDDEN tests override
  // this to a non-mod (or vanished) user.
  mockGetUserById.mockResolvedValue({
    id: 42,
    isModerator: true,
    tier: 'free',
    email: 'u@example.com',
    username: 'u',
  });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockCreateTextToImageStep.mockResolvedValue({ $type: 'textToImage', name: 's1', input: {} });
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
});

describe('blocks.submitWorkflow', () => {
  it('submits the workflow when cost <= budget', async () => {
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

  it('rejects when the App Blocks flag is disabled', async () => {
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockVerifyBlockToken).not.toHaveBeenCalled();
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
 * Phase 2 — App Blocks is moderator-only until GA. Every block-token-authed
 * runtime procedure re-asserts that the RESOLVED viewer (from the token
 * subject, NOT ctx.user) is a moderator. A token whose subject resolves to a
 * non-mod verified user must be rejected with FORBIDDEN even though the token
 * itself is otherwise valid (valid signature, correct scopes, matching ctx).
 *
 * This is the defense-in-depth layer beneath the mod-gated token minting
 * endpoint: even if a token were somehow minted for a non-mod, the runtime
 * refuses it.
 */
describe('Phase 2 — block-token runtime procedures reject non-mod viewers', () => {
  function nonModViewer() {
    mockGetUserById.mockResolvedValue({
      id: 42,
      isModerator: false,
      tier: 'free',
      email: 'u@example.com',
      username: 'u',
    });
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

  it('FORBIDDEN when the resolved viewer has vanished (getUserById → null)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetUserById.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
