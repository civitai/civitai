import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App generator SUBQUEUE bridges — `blocks.queryAppWorkflows` (tag-scoped read)
 * + `blocks.cancelAppWorkflow` (fail-closed cancel). These are the SECURITY-
 * critical, contract-defining half of App Blocks generator subqueue access: a
 * block reads + cancels ONLY its OWN tag-scoped slice of the viewer's workflows,
 * never the personal queue.
 *
 * We assert, per gate:
 *   - queryAppWorkflows forces the per-app tag on the orchestrator LIST and a
 *     malicious client `tags` input can NOT override/remove it (the tag is the
 *     security boundary), returns the projected AppWorkflow shape, and round-
 *     trips the cursor. Empty subqueue → empty list.
 *   - cancelAppWorkflow FAILS CLOSED: a workflow not in the app subqueue (no
 *     ownership row) OR one whose orchestrator record lacks the app tag →
 *     FORBIDDEN, orchestrator cancel NOT called. Happy path → cancel once.
 *   - the shared gates: invalid/anon token, missing scope, rate limit.
 *
 * Strategy mirrors blocks.router.workflow.test.ts: mock every dependency at the
 * module boundary so the router runs in-process and we assert exact arguments.
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
  mockCheckBlockCatalogRateLimit,
  mockGetSessionUser,
  mockDbRead,
  mockRedis,
  mockSysRedis,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockBlockWorkflowOwned,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  mockGetSessionUser: vi.fn(),
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
  mockIsAppBlocksAuthorEnabled: vi.fn(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  ),
  mockBlockWorkflowOwned: vi.fn(async () => true),
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
// cancelAppWorkflow dynamic-imports the ownership guard from here; query/list
// procedures also dynamic-import this module. Mock the whole surface.
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: (...a: unknown[]) => mockBlockWorkflowOwned(...a),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  listMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
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
        k in t ? (t as any)[k] : typeof k === 'string' ? `mock:${name}:${k}` : (t as any)[k],
    });
  const completeKeys = (explicit: Record<string, Record<string, string>>) =>
    new Proxy(explicit, {
      get: (t, g) =>
        g in t ? group((t as any)[g], g as string) : typeof g === 'string' ? group({}, g) : (t as any)[g],
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
// Cut the rateLimit middleware's heavy Prisma-validator import chain (mirrors the
// sibling blocks.router tests).
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
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
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: { slotId: 'none', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
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

// The per-app subqueue tag stamped on every app-submitted workflow.
const APP_TAG = 'app-block:app_test';

beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockParseSubjectUserId,
    mockGetOrchestratorToken,
    mockQueryWorkflows,
    mockGetWorkflow,
    mockCancelWorkflow,
    mockGetUserById,
    mockGetSessionUser,
    mockCheckBlockCatalogRateLimit,
    mockIsAppBlocksEnabled,
    mockIsAppBlocksAuthorEnabled,
    mockBlockWorkflowOwned,
  ]) {
    fn.mockReset();
  }
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  );
  mockGetUserById.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockBlockWorkflowOwned.mockResolvedValue(true);
  mockQueryWorkflows.mockResolvedValue({ items: [], nextCursor: null });
});

describe('blocks.queryAppWorkflows', () => {
  it('calls the orchestrator LIST with the host-forced per-app tag + the viewer token', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.queryAppWorkflows({ blockToken: 'tok' });
    expect(mockQueryWorkflows).toHaveBeenCalledTimes(1);
    const arg = mockQueryWorkflows.mock.calls[0][0] as { token: string; tags: string[] };
    expect(arg.token).toBe('orch_token'); // the viewer's OWN orchestrator token
    expect(arg.tags).toEqual([APP_TAG]); // the ONLY tag — the security boundary
  });

  it('projects orchestrator items to the clean AppWorkflow shape and round-trips the cursor', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockQueryWorkflows.mockResolvedValue({
      nextCursor: 'cur_2',
      items: [
        {
          id: 'wf_1',
          createdAt: '2026-07-15T00:00:00.000Z',
          status: 'succeeded',
          cost: { total: 20 },
          tags: ['civitai', APP_TAG],
          steps: [
            {
              $type: 'textToImage',
              name: 's',
              status: 'succeeded',
              metadata: {},
              output: {
                images: [
                  {
                    id: 'b',
                    url: 'https://cdn/i.png',
                    available: true,
                    width: 512,
                    height: 512,
                    nsfwLevel: 'pg',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.queryAppWorkflows({ blockToken: 'tok', cursor: 'cur_1', limit: 5 });
    expect(result).toEqual({
      workflows: [
        {
          workflowId: 'wf_1',
          status: 'succeeded',
          images: [{ url: 'https://cdn/i.png', width: 512, height: 512, nsfwLevel: 1 }],
          cost: 20,
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ],
      cursor: 'cur_2',
    });
    // The input cursor + limit were forwarded to the orchestrator LIST.
    const arg = mockQueryWorkflows.mock.calls[0][0] as { cursor?: string; take?: number };
    expect(arg.cursor).toBe('cur_1');
    expect(arg.take).toBe(5);
  });

  it('an empty subqueue returns an empty list + null cursor', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockQueryWorkflows.mockResolvedValue({ items: [], nextCursor: undefined });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.queryAppWorkflows({ blockToken: 'tok' });
    expect(result).toEqual({ workflows: [], cursor: null });
  });

  it('the app tag is bound from the TOKEN appId, not a client-supplied value', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ appId: 'app_other' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    // Even if a malicious client tries to smuggle `tags`, the input schema has no
    // such field so it is stripped by zod — the handler forces exactly one tag,
    // derived from the verified token appId.
    await caller.queryAppWorkflows({
      blockToken: 'tok',
      // @ts-expect-error — `tags` is NOT part of the input contract (the whole point).
      tags: ['app-block:victim', 'civitai'],
    });
    const arg = mockQueryWorkflows.mock.calls[0][0] as { tags: string[] };
    expect(arg.tags).toEqual(['app-block:app_other']); // token-derived, not client 'victim'
    expect(arg.tags).not.toContain('app-block:victim');
  });

  it('rejects an invalid block token with UNAUTHORIZED (no orchestrator call)', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.queryAppWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('rejects a token missing ai:write:budgeted scope with FORBIDDEN', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.queryAppWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('rejects anon subjects with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.queryAppWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects with TOO_MANY_REQUESTS when the per-instance rate limit trips (no orchestrator call)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(caller.queryAppWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });
});

describe('blocks.cancelAppWorkflow', () => {
  function ownedAppTaggedWorkflow() {
    mockBlockWorkflowOwned.mockResolvedValue(true);
    mockGetWorkflow.mockResolvedValue({
      id: 'wf_1',
      createdAt: '2026-07-15T00:00:00.000Z',
      status: 'canceled',
      cost: { total: 0 },
      tags: ['civitai', APP_TAG],
      steps: [],
    });
  }

  it('happy path: guards pass → cancels once and returns the projected AppWorkflow', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    ownedAppTaggedWorkflow();
    mockCancelWorkflow.mockResolvedValue(undefined);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.cancelAppWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(result.workflow).toEqual({
      workflowId: 'wf_1',
      status: 'canceled',
      images: [],
      cost: 0,
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    // Ownership was checked with the server-derived (userId, appBlockId, workflowId).
    expect(mockBlockWorkflowOwned).toHaveBeenCalledWith({
      userId: 42,
      appBlockId: 'apb_test',
      workflowId: 'wf_1',
    });
    expect(mockCancelWorkflow).toHaveBeenCalledTimes(1);
    expect(mockCancelWorkflow).toHaveBeenCalledWith({ workflowId: 'wf_1', token: 'orch_token' });
  });

  it('FAILS CLOSED when the workflow is not in the app subqueue (no ownership row) — cancel NOT called', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockBlockWorkflowOwned.mockResolvedValue(false); // not owned by this user/app
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelAppWorkflow({ blockToken: 'tok', workflowId: 'wf_other' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    // Fails on the ownership gate BEFORE any orchestrator read.
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the orchestrator record lacks the app tag — cancel NOT called', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockBlockWorkflowOwned.mockResolvedValue(true);
    // The ownership row says owned, but the orchestrator's own record is NOT tagged
    // for this app (defense-in-depth guard b) → still FORBIDDEN.
    mockGetWorkflow.mockResolvedValue({
      id: 'wf_1',
      createdAt: '2026-07-15T00:00:00.000Z',
      status: 'processing',
      cost: { total: 0 },
      tags: ['civitai', 'app-block:someone_else'],
      steps: [],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelAppWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an invalid block token with UNAUTHORIZED and never calls cancel', async () => {
    mockVerifyBlockToken.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelAppWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    expect(mockBlockWorkflowOwned).not.toHaveBeenCalled();
  });

  it('rejects a token missing ai:write:budgeted scope with FORBIDDEN (no ownership check, no cancel)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['models:read:self'] }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelAppWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockBlockWorkflowOwned).not.toHaveBeenCalled();
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('rejects anon subjects with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.cancelAppWorkflow({ blockToken: 'tok', workflowId: 'wf_1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });
});
