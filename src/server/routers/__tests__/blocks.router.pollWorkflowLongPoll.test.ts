import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUTER-LEVEL proof that `blocks.pollWorkflow`'s long poll is WIRED, not merely
 * implemented.
 *
 * `workflow.service.test.ts` proves `resolveBlockPollWaitSeconds` clamps
 * correctly — that is a statement about a function. It says nothing about
 * whether the procedure a block calls actually hands the resolved value to the
 * orchestrator, and "the clamp is correct but nothing calls it" is the exact
 * shape of an inert feature. So these drive the real tRPC procedure and assert
 * on the ARGUMENT `getWorkflow` received.
 *
 * The four cases the design review named are covered here end-to-end: a
 * workflow that completes inside the hold, one that does NOT (the orchestrator's
 * 202 → a non-terminal snapshot the caller re-arms on), a terminal failure, and
 * a cancellation.
 *
 * Mock strategy mirrors `blocks.router.textOutputModeration.test.ts`: every
 * dependency at the module boundary, so the router runs in-process.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockQueryWorkflows,
  mockGetWorkflow,
  mockCancelWorkflow,
  mockSubmitWorkflow,
  mockGetUserById,
  mockGetSessionUser,
  mockCheckBlockCatalogRateLimit,
  mockDbRead,
  mockRedis,
  mockSysRedis,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockUpdateBlockWorkflowStatus,
  mockSettleCustomComfySpend,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  mockDbRead: {
    modelVersion: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    blockUserSettings: { findUnique: vi.fn() },
    modelMetric: { findFirst: vi.fn() },
  },
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
  mockSysRedis: {
    get: vi.fn(async () => null),
    incrBy: vi.fn(async () => 0),
    decrBy: vi.fn(async () => 0),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => -1),
  },
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockUpdateBlockWorkflowStatus: vi.fn(async () => undefined),
  mockSettleCustomComfySpend: vi.fn(async () => undefined),
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
  updateBlockWorkflowStatus: mockUpdateBlockWorkflowStatus,
  listMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settleCustomComfySpend: mockSettleCustomComfySpend };
});
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: mockGetUserById }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const { completeKeys } = vi.hoisted(() => {
  const group = (explicit: Record<string, string>, name: string): Record<string, string> =>
    new Proxy(explicit, {
      get: (t, k) =>
        k in t
          ? (t as Record<string, string>)[k as string]
          : typeof k === 'string'
          ? `mock:${name}:${k}`
          : (t as Record<string, string>)[k as string],
    });
  const completeKeys = (explicit: Record<string, Record<string, string>>) =>
    new Proxy(explicit, {
      get: (t, g) =>
        g in t
          ? group((t as Record<string, Record<string, string>>)[g as string], g as string)
          : typeof g === 'string'
          ? group({}, g)
          : (t as Record<string, Record<string, string>>)[g as string],
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
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...args: unknown[]) => mockCheckBlockCatalogRateLimit(...args),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MAX_BLOCK_POLL_WAIT_SECONDS } from '~/server/services/blocks/workflow.service';

// 🔴 PAIRWISE-DISTINCT FIXTURE FIELDS. Every workflow below differs in id,
// status AND cost, so a wiring bug that returns the wrong workflow — or a stub
// that returns a constant — cannot pass by coincidence.
const RUNNING = { id: 'wf_running', status: 'processing', cost: { total: 11 }, steps: [] };
const SUCCEEDED = { id: 'wf_succeeded', status: 'succeeded', cost: { total: 22 }, steps: [] };
const FAILED = { id: 'wf_failed', status: 'failed', cost: { total: 33 }, steps: [] };
const CANCELED = { id: 'wf_canceled', status: 'canceled', cost: { total: 44 }, steps: [] };

/** The `query` argument of the Nth `getWorkflow` call (undefined if none). */
function queryArg(n = 0): { wait?: number } | undefined {
  return (mockGetWorkflow.mock.calls[n]?.[0] as { query?: { wait?: number } } | undefined)?.query;
}

function validClaims() {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
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
    mockGetUserById,
    mockGetSessionUser,
    mockCheckBlockCatalogRateLimit,
    mockIsAppBlocksEnabled,
    mockIsAppBlocksAuthorEnabled,
    mockUpdateBlockWorkflowStatus,
    mockSettleCustomComfySpend,
  ]) {
    fn.mockReset();
  }
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
  mockGetUserById.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockUpdateBlockWorkflowStatus.mockResolvedValue(undefined);
  mockSettleCustomComfySpend.mockResolvedValue(undefined);
  mockCancelWorkflow.mockResolvedValue(undefined);
});

describe('blocks.pollWorkflow — long poll wiring', () => {
  it('BACK-COMPAT: without waitSeconds the orchestrator read carries NO query at all', async () => {
    mockGetWorkflow.mockResolvedValue(RUNNING);

    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: 'wf_running' });

    // Not `{ wait: 0 }` — absent. Every already-deployed block sends exactly
    // this input, and its request must remain byte-identical.
    expect(queryArg()).toBeUndefined();
    expect(result.snapshot.status).toBe('processing');
  });

  it('forwards waitSeconds to the orchestrator as ?wait=<seconds>', async () => {
    mockGetWorkflow.mockResolvedValue(SUCCEEDED);

    const result = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_succeeded',
      waitSeconds: 9,
    });

    expect(queryArg()).toEqual({ wait: 9 });
    expect(result.snapshot.status).toBe('succeeded');
  });

  it('CLAMPS an over-large waitSeconds rather than failing the poll', async () => {
    mockGetWorkflow.mockResolvedValue(SUCCEEDED);

    await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_succeeded',
      waitSeconds: 60,
    });

    expect(queryArg()).toEqual({ wait: MAX_BLOCK_POLL_WAIT_SECONDS });
  });

  it('drops waitSeconds: 0 back to a plain read', async () => {
    mockGetWorkflow.mockResolvedValue(RUNNING);

    await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_running',
      waitSeconds: 0,
    });

    expect(queryArg()).toBeUndefined();
  });

  it('rejects a nonsensical waitSeconds at the wire schema without calling the orchestrator', async () => {
    mockGetWorkflow.mockResolvedValue(RUNNING);

    await expect(
      caller().pollWorkflow({ blockToken: 'tok', workflowId: 'wf_running', waitSeconds: 99_999 })
    ).rejects.toThrow();
    await expect(
      caller().pollWorkflow({ blockToken: 'tok', workflowId: 'wf_running', waitSeconds: -3 })
    ).rejects.toThrow();

    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('COMPLETES INSIDE THE HOLD: terminal snapshot + terminal side effects fire', async () => {
    mockGetWorkflow.mockResolvedValue(SUCCEEDED);

    const result = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_succeeded',
      waitSeconds: 12,
    });

    expect(result.snapshot.status).toBe('succeeded');
    expect(result.snapshot.cost).toEqual({ total: 22 });
    expect(mockUpdateBlockWorkflowStatus).toHaveBeenCalledWith({
      workflowId: 'wf_succeeded',
      status: 'succeeded',
    });
    expect(mockSettleCustomComfySpend).toHaveBeenCalledWith({
      workflowId: 'wf_succeeded',
      actualCost: 22,
    });
  });

  it('🔴 HOLD ELAPSED (202): a still-running workflow is a NORMAL non-terminal reply', async () => {
    // The generated client surfaces a 202 as an ordinary `data` result carrying
    // the still-running workflow, so it reaches the block as a non-terminal
    // snapshot to re-arm on — NOT as an error, and NOT as a terminal status.
    mockGetWorkflow.mockResolvedValue(RUNNING);

    const result = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_running',
      waitSeconds: MAX_BLOCK_POLL_WAIT_SECONDS,
    });

    expect(result.snapshot.status).toBe('processing');
    expect(result.snapshot.cost).toEqual({ total: 11 });
    // 🔴 The terminal side effects must NOT fire on a 202. Mirroring a
    // still-running workflow into the durable read-model as finished, or
    // settling its post-paid spend, would be a real defect — and the hold
    // makes this branch far more frequently reached than a 2s timer poll did.
    expect(mockUpdateBlockWorkflowStatus).not.toHaveBeenCalled();
    expect(mockSettleCustomComfySpend).not.toHaveBeenCalled();
  });

  it('RE-ARM: a second poll after a 202 returns the later, terminal snapshot', async () => {
    mockGetWorkflow.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(SUCCEEDED);

    const first = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_x',
      waitSeconds: 5,
    });
    const second = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_x',
      waitSeconds: 5,
    });

    // Distinct costs: a poll that replayed the first read would report 11 twice.
    expect(first.snapshot.cost).toEqual({ total: 11 });
    expect(second.snapshot.cost).toEqual({ total: 22 });
    expect(second.snapshot.status).toBe('succeeded');
    expect(queryArg(0)).toEqual({ wait: 5 });
    expect(queryArg(1)).toEqual({ wait: 5 });
  });

  it('TERMINAL FAILURE under a hold is returned as a snapshot, not thrown', async () => {
    mockGetWorkflow.mockResolvedValue(FAILED);

    const result = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_failed',
      waitSeconds: 8,
    });

    expect(result.snapshot.status).toBe('failed');
    expect(result.snapshot.cost).toEqual({ total: 33 });
    expect(mockUpdateBlockWorkflowStatus).toHaveBeenCalledWith({
      workflowId: 'wf_failed',
      status: 'failed',
    });
  });

  it('CANCELLATION: a canceled workflow polled under a hold returns terminal at once', async () => {
    mockGetWorkflow.mockResolvedValue(CANCELED);

    const result = await caller().pollWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_canceled',
      waitSeconds: MAX_BLOCK_POLL_WAIT_SECONDS,
    });

    expect(result.snapshot.status).toBe('canceled');
    expect(mockUpdateBlockWorkflowStatus).toHaveBeenCalledWith({
      workflowId: 'wf_canceled',
      status: 'canceled',
    });
  });

  it('blocks.cancelWorkflow is UNCHANGED — it never asks for a hold', async () => {
    // A cancel has nothing to wait for: the read after it is a confirmation,
    // and holding it open would just delay the reply by up to 15s.
    mockGetWorkflow.mockResolvedValue(CANCELED);

    const result = await caller().cancelWorkflow({
      blockToken: 'tok',
      workflowId: 'wf_canceled',
    });

    expect(mockCancelWorkflow).toHaveBeenCalled();
    expect(queryArg()).toBeUndefined();
    expect(result.snapshot.status).toBe('canceled');
  });
});
