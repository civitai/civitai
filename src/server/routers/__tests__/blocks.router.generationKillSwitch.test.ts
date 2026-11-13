import { beforeEach, describe, expect, it, vi } from 'vitest';

// The global generation kill switch (moderators' "generation disabled" / "members only") must stop
// an App Blocks submit exactly as it stops an onsite one: before any spend reservation or
// orchestrator submit, with the operator's message.

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockSubmitWorkflow,
  mockGetUserById,
  mockGetSessionUser,
  mockReserveAppSpend,
  mockGetHighestTierSubscription,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockReserveAppSpend: vi.fn(async () => ({ allowed: true, dailyKey: null })),
  mockGetHighestTierSubscription: vi.fn(async () => null as { tier: string } | null),
}));

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  queryWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  submitWorkflow: mockSubmitWorkflow,
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: vi.fn(async () => true),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  updateBlockWorkflowStatus: vi.fn(async () => undefined),
  listMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  reserveAppSpend: (...a: unknown[]) => mockReserveAppSpend(...(a as [])),
  refundAppSpend: vi.fn(async () => undefined),
  chargeAppSpendOverage: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settleCustomComfySpend: vi.fn(async () => undefined) };
});
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: mockGetUserById }));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: (...a: unknown[]) => mockGetHighestTierSubscription(...(a as [])),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
  // Off, so the training arm stops at its own flag: a refusal only that arm can produce.
  isAppBlocksTrainingKindEnabled: vi.fn(async () => false),
  isAppBlocksConfirmedStepEnabled: vi.fn(async () => false),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ blue: 11, green: 22, yellow: 33 })),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPublishRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPostRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPostAppRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPollRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockEstimateCellsRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockSubmitRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockSubmitUserRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.incr.mockImplementation(async () => 1);
redisMock.redis.incrBy.mockImplementation(async () => 1);
redisMock.redis.decrBy.mockImplementation(async () => 0);
redisMock.redis.expire.mockImplementation(async () => true);
redisMock.redis.ttl.mockImplementation(async () => -1);
redisMock.sysRedis.incrBy.mockImplementation(async () => 0);
redisMock.sysRedis.decrBy.mockImplementation(async () => 0);
redisMock.sysRedis.expire.mockImplementation(async () => true);
redisMock.sysRedis.ttl.mockImplementation(async () => -1);

const VIEWER = 42;
const OPERATOR_MESSAGE = 'Generation is paused while we fix an incident.';

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'pixel-poet',
    appId: 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B',
    appBlockId: 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A',
    blockInstanceId: 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C',
    ctx: { slotId: 'none', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
    maxBrowsingLevel: sfwBrowsingLevelsFlag,
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

const caller = () => blocksRouter.createCaller(fakeCtx() as never);

const TRAINING_PARAMS = {
  engine: 'ai-toolkit',
  ecosystem: 'sdxl',
  epochs: 5,
  resolution: 1024,
  lr: 0.0001,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'cosine',
  optimizerType: 'adamw8bit',
  networkDim: 32,
  networkAlpha: 16,
  noiseOffset: null,
  minSnrGamma: null,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};
const TRAINING_ARM_REFUSAL = 'training from apps is not enabled';

/** What the moderators' kill switch has stored, or null for "never set". */
let storedStatus: Record<string, unknown> | null = null;

const BODIES = {
  textToImage: {
    kind: 'textToImage',
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
  },
  customComfy: { kind: 'customComfy', recipe: 'starter-comfy-txt2img', params: {} },
  workflow: { kind: 'workflow', steps: [{ $type: 'textToImage', input: {} }] },
  step: {
    kind: 'step',
    $type: 'polyGen',
    input: { engine: 'meshy', prompt: 'a teapot' },
    maxBuzz: 200,
  },
} as const;

const submit = (body: unknown) =>
  caller()
    .submitWorkflow({ blockToken: 'tok', body: body as never })
    .catch((e: unknown) => e as { code?: string; message?: string });

const killSwitchReads = () =>
  redisMock.sysRedis.hGet.mock.calls.filter(
    ([, field]) => field === REDIS_SYS_KEYS.GENERATION.STATUS
  ).length;

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
  storedStatus = null;
  redisMock.sysRedis.hGet.mockImplementation((async (_key: string, field: string) =>
    field === REDIS_SYS_KEYS.GENERATION.STATUS && storedStatus
      ? JSON.stringify(storedStatus)
      : null) as never);
  mockGetUserById.mockResolvedValue({ id: VIEWER, isModerator: false });
  mockGetSessionUser.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockGetHighestTierSubscription.mockResolvedValue(null);
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : VIEWER));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockReserveAppSpend.mockResolvedValue({ allowed: true, dailyKey: null });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);
});

describe('blocks.submitWorkflow — global generation kill switch', () => {
  it.each(Object.entries(BODIES))(
    'refuses the %s kind while generation is disabled, before any spend',
    async (_kind, body) => {
      storedStatus = { mode: 'disabled', message: OPERATOR_MESSAGE };
      await expect(submit(body)).resolves.toMatchObject({
        code: 'BAD_REQUEST',
        message: OPERATOR_MESSAGE,
      });
      expect(mockReserveAppSpend).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    }
  );

  it('refuses a free subject while generation is members-only', async () => {
    storedStatus = { mode: 'memberOnly', message: OPERATOR_MESSAGE };
    await expect(submit(BODIES.textToImage)).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      message: OPERATOR_MESSAGE,
    });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an anonymous subject while generation is disabled', async () => {
    storedStatus = { mode: 'disabled', message: OPERATOR_MESSAGE };
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    await expect(submit(BODIES.textToImage)).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      message: OPERATOR_MESSAGE,
    });
  });

  // Each control lands on the textToImage branch's own next refusal — proof the kill switch let
  // it through rather than refusing it with a different message.
  const NEXT_REFUSAL = 'model version not found';

  it('CONTROL: a member passes the members-only switch to the branch behind it', async () => {
    storedStatus = { mode: 'memberOnly', message: OPERATOR_MESSAGE };
    mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
    await expect(submit(BODIES.textToImage)).resolves.toMatchObject({ message: NEXT_REFUSAL });
  });

  it('CONTROL: a moderator passes the disabled switch, as onsite', async () => {
    storedStatus = { mode: 'disabled', message: OPERATOR_MESSAGE };
    mockGetUserById.mockResolvedValue({ id: VIEWER, isModerator: true });
    await expect(submit(BODIES.textToImage)).resolves.toMatchObject({ message: NEXT_REFUSAL });
  });

  it('CONTROL: generation enabled lets the submit through, without a user lookup', async () => {
    storedStatus = { mode: 'enabled', message: OPERATOR_MESSAGE };
    await expect(submit(BODIES.textToImage)).resolves.toMatchObject({ message: NEXT_REFUSAL });
    expect(killSwitchReads()).toBeGreaterThan(0);
    expect(mockGetHighestTierSubscription).not.toHaveBeenCalled();
  });

  it('leaves the training kind to the training status, not the generation switch', async () => {
    storedStatus = { mode: 'disabled', message: OPERATOR_MESSAGE };
    // A body that passes input validation, so the refusal below is the training arm's own.
    const error = await submit({
      kind: 'training',
      items: [
        { air: 'K1.jpeg', caption: 'a' },
        { air: 'K2.jpeg', caption: 'b' },
      ],
      engine: 'ai-toolkit',
      model: 'sdxl',
      params: TRAINING_PARAMS,
      triggerWord: 'mychar',
      samplePrompts: ['mychar on a beach'],
      quoteId: `tq_${'1'.repeat(32)}`,
    });
    expect(error).toMatchObject({ message: TRAINING_ARM_REFUSAL });
    expect(killSwitchReads()).toBe(0);
  });
});
