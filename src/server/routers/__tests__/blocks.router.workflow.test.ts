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
  mockCreateTextToImageStep,
  mockAuditPromptServer,
  mockGetUserById,
  mockDbRead,
  mockRedis,
  mockIsAppBlocksEnabled,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetWorkflow: vi.fn(),
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
  mockIsAppBlocksEnabled: vi.fn(async () => true),
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
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  REDIS_KEYS: { BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
  },
}));

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
    ctx: { modelId: 7 },
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
  mockGetUserById.mockResolvedValue({
    id: 42,
    isModerator: false,
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
    mockCreateTextToImageStep,
    mockAuditPromptServer,
    mockGetUserById,
    mockDbRead.modelVersion.findUnique,
    mockIsAppBlocksEnabled,
  ]) {
    fn.mockReset();
  }
  // Defaults — every test starts with the flag on, a valid claim, an
  // authenticated subject, a fresh user/version row. Tests override only the
  // gate they're exercising. NB: mockReset wipes the implementation, so the
  // default has to be re-set every beforeEach (not just at hoisted-init time).
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockCreateTextToImageStep.mockResolvedValue({ $type: 'textToImage', name: 's1', input: {} });
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

  it('uses publisher default when no viewer override is set', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyUser();
    loraVersionLookup();
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 691639 },
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
  });

  it('viewer override beats publisher default', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 100 }));
    happyUser();
    loraVersionLookup();
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 111 }, // publisher
    });
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
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      settings: { default_checkpoint_version_id: 691639 },
    });
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
});
