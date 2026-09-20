import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUTER-LEVEL proof that each bridge procedure this change LIMITS actually REFUSES once its
 * limiter says no — clawgate #569, acceptance criterion 4.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE LIMITER'S OWN UNIT SUITE.
 * `src/server/utils/__tests__/block-catalog-rate-limit.test.ts` proves the BUCKET refuses past its
 * ceiling. That is a claim about the bucket. It says nothing about whether any procedure calls it,
 * or whether a procedure that calls it acts on the answer — "the helper is correct but nothing
 * calls it" is the exact shape of an inert guard, and a `checkBlock*RateLimit(...)` whose result is
 * computed and dropped type-checks perfectly. So these cases drive the REAL tRPC procedures with
 * the limiter stubbed to `{ allowed: false }` and assert the call is refused with
 * `TOO_MANY_REQUESTS`, i.e. the CODE, not just some throw.
 *
 * 🔴 THE CODE IS LOAD-BEARING, NOT DECORATION. Every one of these procedures throws for a dozen
 * other reasons, so an assertion of the form `.rejects.toThrow()` is satisfied by any of them and
 * would stay green with the limiter deleted. `toMatchObject({ code: 'TOO_MANY_REQUESTS' })` is the
 * thing only this limiter produces on these paths, and it is what makes the mutation
 * ("delete the `if (!rate.allowed) throw`") die for THIS guard's own reason rather than for a
 * neighbouring guard's.
 *
 * 🔴 AND THE FIXTURES REACH THE LIMITER. Each case sets up an otherwise-VALID call — a workflow the
 * viewer owns, an app-tagged record, the App Blocks flag on, the right consent scope — so no
 * earlier check can refuse it first. A case that is rejected upstream would pass with the limiter
 * absent, which is the unreachable-guard failure. Each describe carries a companion `allowed: true`
 * case as the control.
 *
 * ⚠️ WHAT THOSE CONTROLS DO AND DO NOT PROVE, because an earlier revision of this paragraph
 * oversold them. They prove the limiter is CONSULTED and does not refuse when it answers yes. They
 * do NOT prove the happy path works: `estimateWorkflow` and `updateUserSettings` both still throw
 * on their allowed path here (a missing model version, a missing `modelId` claim), because stubbing
 * those out is a different test's job. Where a control can assert a real returned value it does
 * (`pollWorkflow`, `cancelWorkflow`, `listMyWorkflows`, `getMyBuzzBalance`); where it cannot, it
 * says so rather than implying coverage it has not got.
 *
 * 🔴 `pollWorkflow` IS THE EXCEPTION, AND IT IS THE POINT. It does NOT throw when its bucket
 * refuses — it returns a non-terminal snapshot — because both hosts convert any throw from that
 * mutation into `status: 'failed'`, which the SDK treats as TERMINAL. A thrown 429 there would end
 * the watch loop on a generation the viewer has already paid for. So its cases assert the RETURNED
 * SHAPE and the absence of the orchestrator call, not an error code. See the procedure for the
 * full reasoning.
 *
 * RED/GREEN MATRIX, measured rather than asserted — and the numbers below were WRONG in an earlier
 * revision of this file (it claimed 6 failed / 7 passed, on a "one failure per newly-limited
 * procedure" rule that misses the two procedures carrying two RED cases each, and its own
 * enumeration of the pass-both-ways set added to 5 rather than the 7 it asserted). Re-measure
 * rather than trusting this paragraph; the current figures are in the PR body.
 *
 * Mock strategy mirrors `blocks.router.workflowScope.test.ts`: every dependency stubbed at the
 * module boundary so the router runs in-process.
 */

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
  // 🔴 Declared here even though it does not exist at this file's BASE. A `vi.mock` factory that
  // over-declares an export is harmless (the importer only binds what it names), and declaring it
  // is what lets the RED half of the matrix above be measured against the same file.
  checkBlockPollRateLimit: (...a: unknown[]) => mockCheckBlockPollRateLimit(...(a as [])),
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
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const APP_TAG = `app-block:${APP_ID}`;
const INSTANCE = 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C';
/** The orchestrator's own id shape: `<owning userId>-<yyyyMMddHHmmssfff>`. */
const OWN_ID = `${VIEWER}-20260915120000000`;

/**
 * 🔴 PAIRWISE-DISTINCT FIXTURE FIELDS, and distinct from every constant these assertions name, so
 * an `allowed: true` control cannot be satisfied by a stub returning a shared value.
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

/** What a refused bucket returns — the real `BlockCatalogRateLimitResult` shape. */
const REFUSED = { allowed: false as const, retryAfterSeconds: 7 };

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
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockCancelWorkflow.mockResolvedValue(undefined);
  mockGetWorkflow.mockResolvedValue(workflowFixture());
  mockListMyBlockWorkflows.mockResolvedValue({ items: [], nextCursor: null });
  mockGetUserBuzzAccounts.mockResolvedValue({ blue: 11, green: 22, yellow: 33 });
  mockResolveBlockInstance.mockResolvedValue(null);
  mockReserveAppSpend.mockResolvedValue({ allowed: true, dailyKey: null });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
});

afterEach(() => {
  resetEnv();
});

describe('blocks.pollWorkflow — the POLL bucket', () => {
  it('SHEDS THE WORK past the ceiling — no orchestrator read, no settle, no fee reversal', async () => {
    mockCheckBlockPollRateLimit.mockResolvedValue(REFUSED);

    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    // The point of the bucket: everything expensive is skipped.
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
    expect(result.snapshot.workflowId).toBe(OWN_ID);
  });

  it('🔴 DOES NOT THROW, and returns a NON-TERMINAL status — a throw would kill a paid generation', async () => {
    // 🔴 THE REGRESSION THIS FILE EXISTS FOR, pinned as a VALUE rather than a shape. Both hosts
    // wrap this mutation in `catch (err) { send('WORKFLOW_STATUS', failureSnapshot(err)) }`, and
    // `failureSnapshot` returns `status: 'failed'` — a member of the SDK's TERMINAL set. So a
    // thrown 429 reaches the block as a finished, failed workflow and its watch loop stops, on a
    // generation whose Buzz is already spent and which the orchestrator is still running.
    //
    // Asserting "does not throw" alone would be satisfied by a throw-free path that returned
    // `failed` anyway, which is the same bug. The status is checked against the terminal set by
    // value, so any future edit that returns a terminal status here goes red.
    const TERMINAL = ['succeeded', 'failed', 'expired', 'canceled'];
    mockCheckBlockPollRateLimit.mockResolvedValue(REFUSED);

    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    // 🔴 THIS LINE IS WHAT STOPS THE CASE BEING VACUOUS, and it was added after measuring that it
    // WAS. With no limiter at all the poll simply succeeds, returns the fixture's non-terminal
    // `processing` and the caller's own id, and every assertion below passes — an invariant guard
    // wearing a regression guard's name. Requiring that the orchestrator was NOT read is the only
    // part that cannot be true unless the limiter refused.
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(TERMINAL).not.toContain(result.snapshot.status);
    // And the id must be the caller's own, non-empty: the SDK's inbound validator DROPS a
    // snapshot with an empty workflowId, which hangs the block to its transport timeout instead
    // of letting it re-poll — the failure mode `failureSnapshot`'s own docblock records.
    expect(result.snapshot.workflowId).toBe(OWN_ID);
    expect(result.snapshot.workflowId).not.toBe('');
  });

  it('charges the POLL bucket keyed on the install AND the viewer, not the catalog one', async () => {
    await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });

    // 🔴 THE VIEWER HALF IS ASSERTED, not just the instance. `blockInstanceId` is
    // `page_<appBlockId>` for a page app — shared by every viewer of it — so a key without the
    // viewer would make this an app-wide poll ceiling and one viewer's generations would be
    // throttled by strangers'. A call asserted on the instance alone cannot see that.
    expect(mockCheckBlockPollRateLimit).toHaveBeenCalledWith(INSTANCE, VIEWER);
    // The whole argument for a dedicated bucket is that a generation in flight must not be able
    // to exhaust a catalog read's allowance.
    expect(mockCheckBlockCatalogRateLimit).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD — an allowed poll still returns its snapshot', async () => {
    const result = await caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID });
    // Distinct from every other fixture value in this file: a constant-returning stub cannot
    // satisfy this by coincidence.
    expect(result.snapshot.cost).toEqual({ total: 13 });
  });
});

describe('blocks.cancelWorkflow — the asymmetry with cancelAppWorkflow, resolved', () => {
  it('REFUSES past the ceiling, with TOO_MANY_REQUESTS, before the orchestrator PATCH', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue(REFUSED);

    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD — an allowed cancel still reaches the orchestrator', async () => {
    await caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID });
    expect(mockCancelWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('blocks.listMyWorkflows — the queue read', () => {
  it('REFUSES past the ceiling, with TOO_MANY_REQUESTS, before the read-model query', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue(REFUSED);

    await expect(caller().listMyWorkflows({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockListMyBlockWorkflows).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD — an allowed list still queries the read model', async () => {
    await caller().listMyWorkflows({ blockToken: 'tok' });
    expect(mockListMyBlockWorkflows).toHaveBeenCalledTimes(1);
  });
});

describe('blocks.estimateWorkflow — above the kind branch', () => {
  it('REFUSES past the ceiling, with TOO_MANY_REQUESTS', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue(REFUSED);

    await expect(
      caller().estimateWorkflow({ blockToken: 'tok', body: validBody() })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('REACHABILITY CONTROL — the limiter is consulted, and does not refuse when allowed', async () => {
    // The control the file header promises for every describe. It does NOT assert success (the
    // txt2img estimate needs far more of the world stubbed than this file provides) — it asserts
    // that the limiter was CONSULTED and that whatever refuses the call, it is not this limiter.
    // 🔴 NOT labelled an invariant guard: the `toHaveBeenCalledWith` half goes RED at base, where
    // no limiter is consulted at all, so this is regression coverage. Measuring that is what
    // caught two earlier cases in this file wearing the wrong label.
    await caller()
      .estimateWorkflow({ blockToken: 'tok', body: validBody() })
      .catch((e: { code?: string }) => {
        expect(e.code).not.toBe('TOO_MANY_REQUESTS');
      });
    expect(mockCheckBlockCatalogRateLimit).toHaveBeenCalledWith(INSTANCE);
  });

  it('refuses a customComfy estimate too — the branch that returns before the flag gate', async () => {
    // 🔴 THE PLACEMENT TEST, not a duplicate of the case above. `estimateWorkflow` returns early
    // for `kind: 'customComfy'` and `kind: 'step'`, BEFORE the point every other limiter in this
    // router sits at. A limiter placed at the house position would leave two of the three branches
    // unbounded while the txt2img case above stayed green — which is exactly the shape of a guard
    // whose description is wider than its implementation.
    mockCheckBlockCatalogRateLimit.mockResolvedValue(REFUSED);

    await expect(
      caller().estimateWorkflow({
        blockToken: 'tok',
        // A body that really PARSES. An invalid one is refused by `.input()` before the resolver
        // runs at all, which would make this case pass for a reason that has nothing to do with
        // the limiter — the unreachable-guard failure, arrived at through zod.
        body: { kind: 'customComfy', recipe: 'starter-comfy-txt2img', params: {} } as never,
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('blocks.getMyBuzzBalance — the one buzz read outside the helper', () => {
  it('REFUSES past the ceiling, with TOO_MANY_REQUESTS, before the buzz service call', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue(REFUSED);

    await expect(caller().getMyBuzzBalance({ blockToken: 'tok' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockGetUserBuzzAccounts).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD — an allowed balance read still returns the three pools', async () => {
    const result = await caller().getMyBuzzBalance({ blockToken: 'tok' });
    // Pairwise-distinct pool values: a stub returning one number for all three cannot pass.
    expect(result).toEqual({ blue: 11, green: 22, yellow: 33 });
  });
});

describe('blocks.updateUserSettings — the settings write', () => {
  it('REFUSES past the ceiling, with TOO_MANY_REQUESTS, before the install resolve', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue(REFUSED);

    await expect(
      caller().updateUserSettings({ blockToken: 'tok', settings: { checkpointVersionId: 5 } })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('REACHABILITY CONTROL — the limiter is consulted, and does not refuse when allowed', async () => {
    // Same control as the estimate one, and RED at base for the same reason: it proves the fixture
    // reaches the limiter rather than being rejected upstream, without requiring the whole write
    // path to be stubbed.
    await caller()
      .updateUserSettings({ blockToken: 'tok', settings: { checkpointVersionId: 5 } })
      .catch((e: { code?: string }) => {
        expect(e.code).not.toBe('TOO_MANY_REQUESTS');
      });
    expect(mockCheckBlockCatalogRateLimit).toHaveBeenCalledWith(INSTANCE);
  });
});

describe('blocks.submitWorkflow — DELIBERATELY unlimited, pinned as a fact', () => {
  it('INVARIANT GUARD — charges NEITHER per-request bucket', async () => {
    // 🔴 THIS IS THE DECISION, PINNED. `submitWorkflow` takes no per-request rate limit: what
    // bounds it server-side is the per-app generation VELOCITY ceiling inside `reserveAppSpend`
    // plus the per-user and per-app daily Buzz caps — a generation-count bound that is strictly
    // tighter than any request-rate limit we would be willing to ship on the spend path. The
    // rationale and its two STATED HOLES live at the procedure. This case exists so that ADDING a
    // per-request bucket here is a deliberate act that fails a test and gets read, rather than a
    // reflex — which is the failure mode clawgate #569 names in its own non-goals.
    //
    // The call is expected to throw (the txt2img path needs far more of the world stubbed than
    // this file provides); what is asserted is which buckets were charged on the way, which is
    // independent of where it stops.
    await caller()
      .submitWorkflow({ blockToken: 'tok', body: validBody() })
      .catch(() => undefined);

    expect(mockCheckBlockPollRateLimit).not.toHaveBeenCalled();
    expect(mockCheckBlockCatalogRateLimit).not.toHaveBeenCalled();
  });
});
