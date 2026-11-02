import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockGetWorkflow,
  mockCancelWorkflow,
  mockSubmitWorkflow,
  mockQueryWorkflows,
  mockGetUserById,
  mockGetSessionUser,
  mockCheckBlockCatalogRateLimit,
  mockCheckBlockPublishRateLimit,
  mockCheckBlockPollRateLimit,
  mockCheckBlockEstimateCellsRateLimit,
  mockCheckBlockSubmitRateLimit,
  mockCheckBlockSubmitUserRateLimit,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockListMyBlockWorkflows,
  mockGetUserBuzzAccounts,
  mockResolveBlockInstance,
  mockReserveAppSpend,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockPublishRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockPollRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockEstimateCellsRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockSubmitRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockSubmitUserRateLimit: vi.fn(async () => ({ allowed: true })),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockListMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
  mockGetUserBuzzAccounts: vi.fn(async () => ({ blue: 11, green: 22, yellow: 33 })),
  mockResolveBlockInstance: vi.fn(async () => null),
  mockReserveAppSpend: vi.fn(async () => ({ allowed: true, dailyKey: null })),
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  queryWorkflows: mockQueryWorkflows,
  getWorkflow: mockGetWorkflow,
  cancelWorkflow: mockCancelWorkflow,
  submitWorkflow: mockSubmitWorkflow,
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: vi.fn(async () => true),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  updateBlockWorkflowStatus: vi.fn(async () => undefined),
  listMyBlockWorkflows: (...a: unknown[]) => mockListMyBlockWorkflows(...(a as [])),
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
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
// Named-export mock rather than `importOriginal` spread: the real `buzz.service` transitively
// imports `image.service`, whose own import graph does not resolve under the unit project. The
// router binds exactly this one export from it.
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...(a as [])),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckBlockCatalogRateLimit(...(a as [])),
  checkBlockPublishRateLimit: (...a: unknown[]) => mockCheckBlockPublishRateLimit(...(a as [])),
  checkBlockPostRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPostAppRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPollRateLimit: (...a: unknown[]) => mockCheckBlockPollRateLimit(...(a as [])),
  checkBlockEstimateCellsRateLimit: (...a: unknown[]) =>
    mockCheckBlockEstimateCellsRateLimit(...(a as [])),
  checkBlockSubmitRateLimit: (...a: unknown[]) => mockCheckBlockSubmitRateLimit(...(a as [])),
  checkBlockSubmitUserRateLimit: (...a: unknown[]) =>
    mockCheckBlockSubmitUserRateLimit(...(a as [])),
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
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';

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
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const APP_TAG = `app-block:${APP_ID}`;
const INSTANCE = 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C';
/** The orchestrator's own id shape: `<owning userId>-<yyyyMMddHHmmssfff>`. */
const OWN_ID = `${VIEWER}-20260915120000000`;

/** Pairwise-distinct fixture fields: an `allowed: true` control cannot pass on a shared value. */
function workflowFixture(over: Record<string, unknown> = {}) {
  return {
    id: OWN_ID,
    status: 'processing',
    createdAt: '2026-09-15T12:00:00.000Z',
    cost: { total: 13 },
    steps: [],
    tags: ['civitai', 'app-block', APP_TAG],
    ...over,
  };
}

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'pixel-poet',
    appId: APP_ID,
    appBlockId: 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A',
    blockInstanceId: INSTANCE,
    // Both runtime scopes: these cases exercise generation procs AND the buzz self-read, and a
    // scope check ahead of the limiter would refuse before it could be reached.
    ctx: { slotId: 'none', entityType: 'none' },
    scopes: ['ai:write:budgeted', 'buzz:read:self'],
    buzzBudget: 50,
    maxBrowsingLevel: sfwBrowsingLevelsFlag,
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

const caller = () => blocksRouter.createCaller(fakeCtx() as never);
beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockParseSubjectUserId,
    mockGetOrchestratorToken,
    mockGetWorkflow,
    mockCancelWorkflow,
    mockSubmitWorkflow,
    mockQueryWorkflows,
    mockGetUserById,
    mockGetSessionUser,
    mockCheckBlockCatalogRateLimit,
    mockCheckBlockPublishRateLimit,
    mockCheckBlockPollRateLimit,
    mockCheckBlockSubmitRateLimit,
    mockCheckBlockSubmitUserRateLimit,
    mockIsAppBlocksEnabled,
    mockIsAppBlocksAuthorEnabled,
    mockListMyBlockWorkflows,
    mockGetUserBuzzAccounts,
    mockResolveBlockInstance,
    mockReserveAppSpend,
  ]) {
    fn.mockReset();
  }
  resetEnv();
  // The real orchestrator, i.e. per-user tokens and per-user workflow ids — the `dev` default
  // short-circuits the viewer binding, which would change which guard refuses first.
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
  mockGetUserById.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : VIEWER));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockCheckBlockPublishRateLimit.mockResolvedValue({ allowed: true });
  mockCheckBlockPollRateLimit.mockResolvedValue({ allowed: true });
  mockCheckBlockSubmitRateLimit.mockResolvedValue({ allowed: true });
  mockCheckBlockSubmitUserRateLimit.mockResolvedValue({ allowed: true });
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockCancelWorkflow.mockResolvedValue(undefined);
  mockGetWorkflow.mockResolvedValue(workflowFixture());
  mockListMyBlockWorkflows.mockResolvedValue({ items: [], nextCursor: null });
  mockGetUserBuzzAccounts.mockResolvedValue({ blue: 11, green: 22, yellow: 33 });
  mockResolveBlockInstance.mockResolvedValue(null);
  mockReserveAppSpend.mockResolvedValue({ allowed: true, dailyKey: null });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
});

const BODIES = {
  textToImage: validBody(),
  customComfy: { kind: 'customComfy', recipe: 'starter-comfy-txt2img', params: {} },
  workflow: { kind: 'workflow', steps: [{ $type: 'textToImage', input: {} }] },
} as const;

const MUTED = { muted: true, bannedAt: null };
const BANNED = { muted: false, bannedAt: new Date('2026-01-01') };

describe('blocks.submitWorkflow — account restriction on the token subject', () => {
  beforeEach(() => {
    dbMock.dbWrite.user.findUnique.mockReset();
  });

  it.each(Object.entries(BODIES))(
    'refuses a muted subject on the %s branch before any spend',
    async (_kind, body) => {
      dbMock.dbWrite.user.findUnique.mockResolvedValue(MUTED as never);

      await expect(
        caller().submitWorkflow({ blockToken: 'tok', body: body as never })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: RESTRICTED_ACCOUNT_MESSAGE });
      expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VIEWER } })
      );
      expect(mockReserveAppSpend).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['banned', BANNED],
    ['missing', null],
  ])('refuses a subject whose row is %s', async (_label, row) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row as never);

    await expect(
      caller().submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: RESTRICTED_ACCOUNT_MESSAGE });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('leaves an anonymous subject to its own refusal, without reading a user row', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));

    const error = await caller()
      .submitWorkflow({ blockToken: 'tok', body: validBody() })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('turns a flood away at the limiter, before the restriction read', async () => {
    mockCheckBlockSubmitRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });

    await expect(
      caller().submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('CONTROL: an unrestricted subject passes the check to the branch behind it', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);

    // The txt2img branch's own lookup is the next refusal this fixture reaches.
    await expect(
      caller().submitWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ message: 'model version not found' });
  });
});
