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
 * RED/GREEN MATRIX, measured rather than asserted — at `7def68db71` (this branch's base) this file
 * is 17 failed / 10 passed; at HEAD it is 27 passed. The seventeen are the regression coverage.
 * The ten that pass BOTH WAYS are marked `INVARIANT GUARD` below and are NOT regression coverage:
 * six pin properties the base happened to satisfy for the trivial reason that it scoped nothing at
 * all, and four cover `publishGenerationOutputs`, whose two guards already existed there and had
 * no behavioural test anywhere. Counting any of the ten as proof of this change would be wrong.
 * Re-run both halves if the base moves again — the numbers are pinned to that sha, not to "main".
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
  mockCheckBlockPublishRateLimit,
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
  mockCheckBlockPublishRateLimit: vi.fn(async () => ({ allowed: true })),
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
  // `publishGenerationOutputs` charges its OWN (image-weighted) bucket, not the catalog one.
  checkBlockPublishRateLimit: (...a: unknown[]) => mockCheckBlockPublishRateLimit(...(a as [])),
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
// 🔴 A PREFIX NEAR-MISS — user 420's workflow, which `${VIEWER}` is a prefix of. It is the ONLY
// input under which an equality check and a `startsWith` check disagree, so without it the viewer
// binding can be "simplified" from one to the other with this whole file still green. The app-scope
// half has had its near-miss (`${APP_TAG}X`) from the start; this is the same idea on the other half.
const PREFIX_NEAR_MISS_ID = `${VIEWER}0-20260915120000000`;
// 🔴 THE SEAM FIXTURES. `workflowOwnerId`'s own suite pins that it rejects the forms `Number()`
// would accept; nothing pinned that THIS gate routes through that parser rather than re-deriving
// the owner inline. Each of these is refused by the parser and admitted as viewer `42` by a bare
// `Number(id.split('-')[0]) == userId`, so they are what separates the two.
const COERCION_IDS = [
  `0x2a-20260915120000000`,
  `+${VIEWER}-20260915120000000`,
  `4.2e1-20260915120000000`,
  ` ${VIEWER}-20260915120000000`,
];

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
    mockCheckBlockPublishRateLimit,
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
  mockCheckBlockPublishRateLimit.mockResolvedValue({ allowed: true });
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
    // The CODE as well as the message: a refusal downgraded to INTERNAL_SERVER_ERROR reaches the
    // block as a retryable 500 rather than a deny, and a message-only assertion cannot see it.
    await expect(
      caller().pollWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    for (const id of [
      'wf_1',
      'not-a-workflow',
      SYSTEM_ID,
      NEGATIVE_IDENTITY_ID,
      PREFIX_NEAR_MISS_ID,
      ...COERCION_IDS,
    ]) {
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

  it('🔴 EXEMPTS ONLY THE LITERAL `dev` — any other mode still enforces', async () => {
    // `server-schema.ts` declares ORCHESTRATOR_MODE as a bare `z.string()`, not an enum, so a third
    // spelling is reachable — and this file would otherwise exercise exactly two values, which
    // cannot tell `=== 'dev'` from `!== 'prod'`. Under that weakening a half-configured
    // `'staging'` would route to the REAL orchestrator with per-user credentials while the viewer
    // check sat disabled.
    // 🔴 THE VALUES ARE `dev`-ADJACENT ON PURPOSE. A single extra value kills `!== 'prod'` and
    // nothing else; `startsWith('dev')`, `includes('dev')` and `=== 'dev' || === 'test'` all
    // survive against `prod`/`dev`/`staging` alone, because none of those three is dev-adjacent.
    // A maintainer widening this to a dev-FAMILY mode reaches for exactly `startsWith('dev')`.
    for (const mode of ['staging', 'development', 'dev:live', 'DEV', 'test']) {
      setEnv({ ORCHESTRATOR_MODE: mode });

      await expect(
        caller().pollWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
      ).rejects.toThrow('workflow does not belong to this viewer');
    }
  });

  it('🔴 a dev:live token gets NO viewer exemption — poll', async () => {
    // The poll twin of the cancel case; see it for why `claims.dev` must not gate this. Site-local
    // weakenings are why both paths need their own: keying the POLL site on `if (!claims.dev)`
    // leaves the cancel case green and vice versa.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true, appId: 'local-myapp' }));

    await expect(
      caller().pollWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
    ).rejects.toThrow('workflow does not belong to this viewer');
    expect(mockGetWorkflow).not.toHaveBeenCalled();
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
    //
    // WHAT THIS PINS: a `claims.dev === true` token's synthetic `local-<slug>` appId goes through
    // the ordinary app-tag comparison. 🔴 It does NOT pin that the token gets no VIEWER exemption —
    // an earlier revision of this comment claimed it did, and it cannot: this case drives the
    // viewer's OWN id, so "not exempted" and "exempted" produce the same pass. That property has
    // its own cases below (`a dev:live token gets NO viewer exemption …`), on both paths.
    //
    // 🔴 WHAT IT DOES NOT PIN, stated because an earlier revision of this comment claimed it did:
    // it is NOT a tripwire on dev-token minting. `dev:live` survives the app scope only because a
    // dev token's appId is deterministic, and that determinism lives in `LOCAL_APP_ID_PREFIX`, a
    // module-private const in `src/pages/api/v1/blocks/dev-token.ts`. Both sides of the comparison
    // below are literals this file wrote, so making dev mints per-session unique leaves it green —
    // measured. Closing that would mean exporting the prefix and deriving both sides from it.
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
    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The property that matters on this path is not the throw but the absent side effect.
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    // Symmetry with the poll case: the refusal must also precede the token mint, or the check has
    // merely moved rather than being first.
    expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
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
    // The SAME id set the poll loop uses — including the coercion ids, which is the seam that
    // matters most here: the cancel site is the one with the irreversible side effect, and a
    // previous revision of this file pinned the seam only at the poll site.
    for (const id of [
      'wf_1',
      SYSTEM_ID,
      NEGATIVE_IDENTITY_ID,
      PREFIX_NEAR_MISS_ID,
      ...COERCION_IDS,
    ]) {
      await expect(caller().cancelWorkflow({ blockToken: 'tok', workflowId: id })).rejects.toThrow(
        'workflow does not belong to this viewer'
      );
    }
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  it('🔴 a dev:live token gets NO viewer exemption — cancel', async () => {
    // 🔴 `claims.dev` IS NOT `ORCHESTRATOR_MODE=dev`, and this is the case that pins the
    // difference. Both docblocks spend a paragraph on the distinction, and nothing tested it:
    // keying the call site on `if (!claims.dev)` left the whole set green. It matters because
    // `/api/v1/blocks/dev-token` mints self-bound `dev: true` tokens to an ordinary developer
    // against the REAL orchestrator, so a `claims.dev`-keyed exemption is a live cross-user stop.
    // Server mode stays at the `beforeEach` default 'prod' — only the TOKEN is dev.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ dev: true, appId: 'local-myapp' }));

    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
    ).rejects.toThrow('workflow does not belong to this viewer');
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('EXEMPTS ORCHESTRATOR_MODE=dev on the cancel path too', async () => {
    // INVARIANT GUARD (passes at base too, where nothing was scoped at all).
    setEnv({ ORCHESTRATOR_MODE: 'dev' });
    mockGetWorkflow.mockResolvedValue(workflowFixture({ id: STRANGERS_ID, cost: { total: 58 } }));

    const result = await caller().cancelWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID });

    expect(mockCancelWorkflow).toHaveBeenCalledWith({
      workflowId: STRANGERS_ID,
      token: 'orch_token',
    });
    // Read the fixture's distinct cost, as the poll twin does — an override nothing asserts reads
    // as if the returned snapshot were pinned here when only the cancel call is.
    expect(result.snapshot.cost).toEqual({ total: 58 });
  });

  it('🔴 EXEMPTS ONLY THE LITERAL `dev` — the cancel path still enforces in any other mode', async () => {
    // 🔴 THE MODE AXIS WAS STRUCTURALLY INVISIBLE ON THIS PATH. Every cancel case ran at the
    // `beforeEach` default `'prod'`, so the cancel site could inline a WIDENED exemption ahead of
    // the helper and the whole file stayed green — measured. That is the same loosening the poll
    // side already pins, on the path that has the irreversible side effect rather than the read.
    for (const mode of ['staging', 'development', 'dev:live', 'DEV', 'test']) {
      setEnv({ ORCHESTRATOR_MODE: mode });

      await expect(
        caller().cancelWorkflow({ blockToken: 'tok', workflowId: STRANGERS_ID })
      ).rejects.toThrow('workflow does not belong to this viewer');
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

  it('🔴 the app scope holds under ORCHESTRATOR_MODE=dev on the cancel path too', async () => {
    // The poll path has this case; the cancel path did not, and the gap was SITE-LOCAL rather than
    // helper-local — the helper's own docblock says the dev exemption is the viewer assertion's
    // alone, and a widening inside the helper does go red, but wrapping THIS CALL SITE in
    // `if (env.ORCHESTRATOR_MODE !== 'dev')` left the whole set green. Under that, in dev any block
    // could stop any other app's workflow. Same threat model the viewer mode-loop above names,
    // applied to the other half, on the path with the irreversible side effect.
    setEnv({ ORCHESTRATOR_MODE: 'dev' });
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['civitai', `app-block:${OTHER_APP_ID}`], cost: { total: 63 } })
    );

    await expect(
      caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toThrow('workflow is not tagged for this app');
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });
});

describe('blocks.publishGenerationOutputs — app scope', () => {
  // 🔴 THE FIFTH CALL SITE OF `assertBlockWorkflowTaggedForApp`, AND THE ONLY ONE THAT HAD NO
  // BEHAVIOURAL TEST ANYWHERE. Measured on this branch before this case existed: deleting the
  // assertion from `publishGenerationOutputs` left 717 files / 12,180 tests green. That matters
  // more here than at the other four — this is the procedure that fetches orchestrator blobs
  // server-side and persists them as public `Image` rows — and consolidating the predicate onto one
  // helper made the deletion a ONE-line edit rather than a five-line one.
  //
  // 🔴 WHAT THESE DO NOT PIN, said plainly because the obvious wording overclaims: they assert the
  // REFUSAL, not the absence of a publish. This fixture carries no outputs, so a mutant that moved
  // the assertion below the no-outputs check still turns them red — but on `workflow has no
  // available outputs to publish`, i.e. on the fixture rather than on the guard's position. Pinning
  // the ordering would need a fixture with a real output and the whole fetch/upload path mocked.
  it('refuses a workflow the calling app did not produce', async () => {
    // INVARIANT GUARD (passes at base too — the guard existed there, open-coded and untested).
    // Guard (a), the read-model row, says owned — so the ONLY thing that can refuse here is the
    // app-tag assertion, and a pass would mean that line is absent or mis-wired.
    mockBlockWorkflowOwnedByAppUser.mockResolvedValue(true);
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({
        status: 'succeeded',
        tags: ['civitai', `app-block:${OTHER_APP_ID}`],
        cost: { total: 71 },
      })
    );

    await expect(
      caller().publishGenerationOutputs({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'workflow is not tagged for this app' });
  });

  it('refuses when the read-model row does not bind this viewer to this app block', async () => {
    // INVARIANT GUARD (passes at base too). The case above takes guard (a) as a PREMISE — "the row
    // says owned, so the only thing that can refuse is the tag" — and a premise a test states but
    // does not exercise is how the guard it names gets deleted. Measured: before this case,
    // removing guard (a) from `publishGenerationOutputs` left the whole set green.
    mockBlockWorkflowOwnedByAppUser.mockResolvedValue(false);
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ status: 'succeeded', cost: { total: 79 } })
    );

    await expect(
      caller().publishGenerationOutputs({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'workflow is not in this app subqueue',
    });
    // Ahead of the orchestrator read, so a refused publish costs no upstream call.
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    // 🔴 WHICH viewer and WHICH app block — the title claims a BINDING, and toggling a mock's
    // return value observes only that the call happened. Both operands must come from the verified
    // token, so a site that asked about the wrong user, or passed `claims.appId` where
    // `claims.appBlockId` belongs, would otherwise read as covered.
    expect(mockBlockWorkflowOwnedByAppUser).toHaveBeenCalledWith({
      userId: VIEWER,
      appBlockId: validClaims().appBlockId,
      workflowId: OWN_ID,
    });
    // 🔴 AND EXACTLY ONCE. `toHaveBeenCalledWith` certifies that A correctly-bound query happened;
    // it is blind to an ADDITIONAL one bound differently, in either order. Measured: adding a
    // `claims.appId` fallback query — before OR after the correct one — left this case green, so
    // without this line the comment above claims coverage the assertion does not provide.
    expect(mockBlockWorkflowOwnedByAppUser).toHaveBeenCalledTimes(1);
  });

  it('🔴 the app scope holds under ORCHESTRATOR_MODE=dev on the publish path too', async () => {
    // INVARIANT GUARD (passes at base too — that guard already existed there, open-coded).
    // Third site, same site-local gap as the cancel one. This is the procedure that persists
    // public `Image` rows, so an app-scope bypass here publishes another app's outputs.
    setEnv({ ORCHESTRATOR_MODE: 'dev' });
    mockBlockWorkflowOwnedByAppUser.mockResolvedValue(true);
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({
        status: 'succeeded',
        tags: ['civitai', `app-block:${OTHER_APP_ID}`],
        cost: { total: 83 },
      })
    );

    await expect(
      caller().publishGenerationOutputs({ blockToken: 'tok', workflowId: OWN_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'workflow is not tagged for this app' });
  });

  it('a correctly-tagged workflow gets PAST the app-scope guard', async () => {
    // INVARIANT GUARD (passes at base too). Non-vacuous: verified to fail when the assertion is
    // mutated to refuse everything.
    // The positive control for the case above. Without it, a guard that refused EVERYTHING would
    // satisfy the refusal test — so this asserts the guard was reached and passed, by requiring the
    // procedure to get further than it (the orchestrator record was read, and the failure that
    // follows is no longer the tag one).
    mockBlockWorkflowOwnedByAppUser.mockResolvedValue(true);
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ status: 'succeeded', cost: { total: 73 } })
    );

    // 🔴 THE ASSERTION IS POSITIVE, NOT A NEGATION, and that is the whole point. An earlier
    // revision asserted `.not.toBe('workflow is not tagged for this app')` and claimed switching
    // `.catch` to `.then(onOk, onErr)` made it robust. It did not: on the resolve path `err` is
    // null, so the negation passes vacuously — measured, by making the procedure return early
    // below the guard, which left the whole set green. Naming the exact failure the procedure must
    // reach INSTEAD pins that it got past the tag assertion AND no further than expected.
    const err = await caller()
      .publishGenerationOutputs({ blockToken: 'tok', workflowId: OWN_ID })
      .then(
        () => null,
        (e: { message?: string }) => e
      );
    expect(err?.message).toBe('workflow has no available outputs to publish');
    expect(mockGetWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ path: { workflowId: OWN_ID } })
    );
  });
});
