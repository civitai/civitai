import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUTER-LEVEL proof that `blocks.pollWorkflow` and `blocks.cancelWorkflow` scope the `workflowId`
 * they are handed.
 *
 * Every other binding on those two procedures is read off the verified block JWT. `workflowId` is
 * not — it is a free-form string the sandboxed iframe chooses — so the properties under test are
 * the two that turn it back into a scoped reference: the workflow must belong to the CALLING
 * VIEWER, and it must have been produced by the CALLING APP. Both are asserted here through the
 * real tRPC procedures rather than against the helpers, because "the helper is correct but nothing
 * calls it" is the exact shape of an inert guard.
 *
 * 🔴 `ORCHESTRATOR_MODE` IS SET EXPLICITLY IN EVERY TEST BELOW, AND THAT IS LOAD-BEARING.
 * `server-schema.ts` declares `ORCHESTRATOR_MODE: z.string().default('dev')`, so the suite-wide
 * default is `dev` — the one mode in which the viewer check deliberately short-circuits (in dev
 * every user shares the system orchestrator credential, so no workflow id can carry the viewer's
 * own id). A test file that simply inherited the default would be STRUCTURALLY BLIND to this
 * guard: every assertion would pass with the guard deleted. The dev branch itself is covered by
 * its own case below, with a stranger's id, so the exemption is pinned rather than assumed.
 *
 * Mock strategy mirrors `blocks.router.pollWorkflowLongPoll.test.ts`: every dependency at the
 * module boundary, so the router runs in-process.
 *
 * RED/GREEN MATRIX, measured rather than asserted — at `a89b6e36a0` (this branch's base) this file
 * is 12 failed / 5 passed; at HEAD it is 17 passed. The twelve are the regression coverage. The
 * five that pass BOTH WAYS are marked `INVARIANT GUARD` below and are NOT regression coverage:
 * they pin properties the base happened to satisfy for the trivial reason that it scoped nothing
 * at all, and exist to stop a LATER change from breaking them. Counting them as proof of this
 * change would be wrong. Re-run both halves if the base moves again — the numbers are pinned to
 * that sha, not to "main".
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
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockUpdateBlockWorkflowStatus,
  mockBlockWorkflowOwnedByAppUser,
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
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockUpdateBlockWorkflowStatus: vi.fn(async () => undefined),
  mockBlockWorkflowOwnedByAppUser: vi.fn(async () => true),
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
  blockWorkflowOwnedByAppUser: (...a: unknown[]) => mockBlockWorkflowOwnedByAppUser(...(a as [])),
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
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckBlockCatalogRateLimit(...(a as [])),
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
const STRANGER = 77;
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const OTHER_APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6Z';
const APP_TAG = `app-block:${APP_ID}`;

// The orchestrator's own id shape: `<owning userId>-<yyyyMMddHHmmssfff>`.
const OWN_ID = `${VIEWER}-20260915120000000`;
const STRANGERS_ID = `${STRANGER}-20260915120000000`;
// The two non-`<positive int>-` shapes the orchestrator really does mint.
const SYSTEM_ID = '0-0195f1a2b3c44d5e6f708192a3b4c5d6';
const NEGATIVE_IDENTITY_ID = '-100-20260915120000000';

/**
 * 🔴 PAIRWISE-DISTINCT FIXTURE FIELDS. The `cost` of each differs, so an assertion that a
 * legitimate call returned the RIGHT workflow cannot be satisfied by a stub returning a constant.
 */
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
    mockBlockWorkflowOwnedByAppUser,
    mockSettleCustomComfySpend,
  ]) {
    fn.mockReset();
  }
  resetEnv();
  // The real orchestrator, i.e. per-user tokens and per-user workflow ids. See the file header.
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
  mockGetUserById.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : VIEWER));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockUpdateBlockWorkflowStatus.mockResolvedValue(undefined);
  mockBlockWorkflowOwnedByAppUser.mockResolvedValue(true);
  mockSettleCustomComfySpend.mockResolvedValue(undefined);
  mockCancelWorkflow.mockResolvedValue(undefined);
  mockGetWorkflow.mockResolvedValue(workflowFixture());
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
});

afterEach(() => {
  resetEnv();
});

describe('blocks.pollWorkflow — viewer scope', () => {
  it("refuses another viewer's workflow, and never reads it", async () => {
    // The fetch would be the disclosure, so the guard has to run ahead of it: asserting the
    // rejection alone would still pass if the workflow had been read and then discarded.
    mockGetWorkflow.mockResolvedValue(workflowFixture({ id: STRANGERS_ID, cost: { total: 99 } }));

    await expect(
      caller().pollWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
    ).rejects.toThrow('workflow does not belong to this viewer');
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
  });

  it('allows the viewer’s OWN workflow and returns that workflow', async () => {
    // INVARIANT GUARD (passes at base too): the legitimate path must not become collateral.
    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    expect(result.snapshot.status).toBe('processing');
    // Distinct from every other fixture cost in this file — a constant-returning stub cannot
    // satisfy this by coincidence.
    expect(result.snapshot.cost).toEqual({ total: 13 });
    expect(mockGetWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ path: { workflowId: OWN_ID } })
    );
    expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses every id that does not name this viewer — FAIL-CLOSED, unlike the submit-path guard', async () => {
    for (const id of ['wf_1', 'not-a-workflow', SYSTEM_ID, NEGATIVE_IDENTITY_ID]) {
      await expect(caller().pollWorkflow({ blockToken: 'tok', workflowId: id })).rejects.toThrow(
        'workflow does not belong to this viewer'
      );
    }
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('does NOT consult the block_workflows read-model, so a dev:live or lost-row submit still polls', async () => {
    // INVARIANT GUARD (passes at base too): pins the DESIGN choice against a later tightening.
    // `upsertBlockWorkflowOnSubmit` is fire-and-forget behind its own swallowing try/catch, and the
    // submit path skips it entirely for `dev:true` tokens — so a row is NOT a precondition a live
    // poll can be gated on. Answering `false` here is that world; the poll must still succeed.
    mockBlockWorkflowOwnedByAppUser.mockResolvedValue(false);

    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    expect(result.snapshot.status).toBe('processing');
    expect(mockBlockWorkflowOwnedByAppUser).not.toHaveBeenCalled();
  });

  it('EXEMPTS ORCHESTRATOR_MODE=dev, where every user shares the system credential', async () => {
    // INVARIANT GUARD (passes at base too, where nothing was scoped at all).
    setEnv({ ORCHESTRATOR_MODE: 'dev' });
    mockGetWorkflow.mockResolvedValue(workflowFixture({ id: STRANGERS_ID, cost: { total: 55 } }));

    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID });

    expect(result.snapshot.cost).toEqual({ total: 55 });
  });

  it('🔴 EXEMPTS ONLY THE VIEWER CHECK — the app scope still holds under dev', async () => {
    // WITHOUT THIS CASE THE EXEMPTION'S WIDTH IS UNPINNED, which is the loosening this file exists
    // to catch: every app-scope case runs under `'prod'`, and the dev case above uses a
    // correctly-tagged fixture, so copying `if (env.ORCHESTRATOR_MODE === 'dev') return;` into
    // `assertBlockWorkflowTaggedForApp` passed the whole file. The dev credential is an argument
    // about WHO SUBMITTED; it says nothing about WHICH APP a record is tagged for.
    setEnv({ ORCHESTRATOR_MODE: 'dev' });
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['civitai', `app-block:${OTHER_APP_ID}`], cost: { total: 57 } })
    );

    await expect(caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID })).rejects.toThrow(
      'workflow is not tagged for this app'
    );
  });

  it('a dev:live token polls its own workflow normally — it is NOT ORCHESTRATOR_MODE=dev', async () => {
    // INVARIANT GUARD (passes at base too, where nothing was scoped at all).
    // TRIPWIRE ON THE MINTING SIDE. `dev:live` survives the app scope only because a dev token's
    // `appId` is deterministic (`block.appId` / `pending-<id>` / `local-<slug>`), so the tag a
    // submit stamps is the tag a later poll reads. Nothing in the procedure branches on
    // `claims.dev`, so this case is thin by construction — its job is to go red if dev mints ever
    // become per-session unique.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true, appId: 'local-myapp' }));
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['civitai', 'app-block:local-myapp'], cost: { total: 61 } })
    );

    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    expect(result.snapshot.cost).toEqual({ total: 61 });
  });
});

describe('blocks.pollWorkflow — app scope', () => {
  it('refuses a workflow the calling app did not produce', async () => {
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['civitai', `app-block:${OTHER_APP_ID}`], cost: { total: 21 } })
    );

    await expect(caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID })).rejects.toThrow(
      'workflow is not tagged for this app'
    );
  });

  it('refuses a workflow carrying no provenance tag at all — empty AND absent', async () => {
    // Both arms. `Workflow.tags` is required on the wire type, so `undefined` is the `?? []` belt
    // the helper documents; without this case that belt can be deleted with the file still green.
    for (const tags of [[], undefined]) {
      mockGetWorkflow.mockResolvedValue(workflowFixture({ tags, cost: { total: 23 } }));

      await expect(
        caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID })
      ).rejects.toThrow('workflow is not tagged for this app');
    }
  });

  it('does not let a NEAR-MISS tag through', async () => {
    // A prefix/suffix match is not a tag match — `app-block:<appId>` is compared whole.
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['app-block', `${APP_TAG}X`], cost: { total: 24 } })
    );

    await expect(caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID })).rejects.toThrow(
      'workflow is not tagged for this app'
    );
  });

  it('refuses BEFORE the terminal read-model write and the spend settle', async () => {
    mockGetWorkflow.mockResolvedValue(workflowFixture({ status: 'succeeded', tags: [] }));

    await expect(caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID })).rejects.toThrow(
      'workflow is not tagged for this app'
    );
    // The terminal side effects sit below the guard; reaching them would mean the refusal came too
    // late to have prevented the read-model write and the spend settle.
    expect(mockUpdateBlockWorkflowStatus).not.toHaveBeenCalled();
    expect(mockSettleCustomComfySpend).not.toHaveBeenCalled();
  });
});

describe('blocks.cancelWorkflow — viewer scope', () => {
  it("refuses another viewer's workflow, and issues NO cancel", async () => {
    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
    ).rejects.toThrow('workflow does not belong to this viewer');
    // The property that matters on this path is not the throw but the absent side effect.
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('allows the viewer’s OWN workflow and returns the terminal snapshot', async () => {
    mockGetWorkflow
      .mockResolvedValueOnce(workflowFixture())
      .mockResolvedValueOnce(workflowFixture({ status: 'canceled', cost: { total: 17 } }));

    const result = await caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    expect(mockCancelWorkflow).toHaveBeenCalledWith({ workflowId: OWN_ID, token: 'orch_token' });
    // ONCE. `toHaveBeenCalledWith` alone cannot see a doubled stop, and this is the one mutation
    // in the procedure.
    expect(mockCancelWorkflow).toHaveBeenCalledTimes(1);
    expect(result.snapshot.status).toBe('canceled');
    // The SECOND read is what the caller gets back — a resolver that returned the pre-cancel read
    // would report 13 here.
    expect(result.snapshot.cost).toEqual({ total: 17 });
  });

  it('refuses every id that does not name this viewer, and issues no cancel', async () => {
    for (const id of ['wf_1', SYSTEM_ID, NEGATIVE_IDENTITY_ID]) {
      await expect(caller().cancelWorkflow({ blockToken: 'tok', workflowId: id })).rejects.toThrow(
        'workflow does not belong to this viewer'
      );
    }
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('does NOT consult the block_workflows read-model, so a dev:live or lost-row submit still cancels', async () => {
    // INVARIANT GUARD (passes at base too): pins the DESIGN choice against a later tightening.
    mockBlockWorkflowOwnedByAppUser.mockResolvedValue(false);

    await caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    expect(mockCancelWorkflow).toHaveBeenCalledWith({ workflowId: OWN_ID, token: 'orch_token' });
    expect(mockCancelWorkflow).toHaveBeenCalledTimes(1);
    expect(mockBlockWorkflowOwnedByAppUser).not.toHaveBeenCalled();
  });
});

describe('blocks.cancelWorkflow — app scope', () => {
  it('refuses a workflow the calling app did not produce, BEFORE the cancel is issued', async () => {
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['civitai', `app-block:${OTHER_APP_ID}`] })
    );

    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toThrow('workflow is not tagged for this app');
    // 🔴 The whole point of reading the record first: the stop must not have happened.
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses a workflow carrying no provenance tag at all', async () => {
    mockGetWorkflow.mockResolvedValue(workflowFixture({ tags: [] }));

    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toThrow('workflow is not tagged for this app');
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });
});
