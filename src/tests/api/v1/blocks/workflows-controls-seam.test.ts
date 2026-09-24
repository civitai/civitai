import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE SEAM TEST. The four `/api/v1/blocks/workflows/*` routes and the four
 * `blocksRouter` procedures they twin are each covered in isolation — the routes in
 * `workflows-endpoints.test.ts` (delegation mocked), the procedures in
 * `blocks.router.workflow.test.ts` / `blocks.router.workflowScope.test.ts` (no REST
 * involved). NEITHER of those can see the defect that matters here: a route that
 * reaches the wrong procedure, or reaches the right one and then TRANSFORMS its
 * outcome on the way out. Both files would stay green through it.
 *
 * So this file builds the combined state. The real route handlers, the real
 * `blockWorkflowCaller`, the real `blocksRouter` procedures and the real
 * `handleEndpointError` all run; only the leaf dependencies (JWT verify,
 * orchestrator client, DB, redis, flags) are mocked — the same boundary
 * `blocks.router.workflowScope.test.ts` mocks at. What is asserted is the property
 * neither isolated file states: a control that refuses inside the procedure REACHES
 * THE WIRE as a refusal, with the right status, and a control that RESOLVES with a
 * priced refusal snapshot reaches the wire as a 200 carrying that price.
 *
 * 🔴 `ORCHESTRATOR_MODE` IS SET EXPLICITLY, AND IT IS LOAD-BEARING. The suite-wide
 * default is `dev`, the one mode in which `assertBlockWorkflowMintedForViewer`
 * deliberately short-circuits — a file that inherited it would be STRUCTURALLY
 * BLIND to the viewer gate and every assertion below would pass with the gate
 * deleted. Same reasoning, and same fix, as the router-level scope suite.
 */

const {
  mockVerifyBlockToken,
  mockGetOrchestratorToken,
  mockGetWorkflow,
  mockQueryWorkflows,
  mockCancelWorkflow,
  mockOrchSubmitWorkflow,
  mockGetUserById,
  mockGetSessionUser,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockCheckBlockCatalogRateLimit,
  mockCheckBlockPollRateLimit,
  mockResolveVersionContext,
  mockResolveCheckpoint,
  mockReserveAppSpend,
} = vi.hoisted(() => ({
  mockResolveVersionContext: vi.fn(),
  mockResolveCheckpoint: vi.fn(),
  mockReserveAppSpend: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockOrchSubmitWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockPollRateLimit: vi.fn(async () => ({ allowed: true })),
}));

/**
 * ONE mock for both consumers, which is the whole point of this file: the ROUTES
 * import `withBlockScope` from here and the ROUTER imports `verifyBlockToken` from
 * here, so the token the route forwards is the token the procedure verifies.
 * `withBlockScope` is a passthrough — the middleware's own gate has its own suites
 * — but it is the only thing mocked on the request path.
 */
const claimsBox: { claims: unknown } = { claims: undefined };
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withBlockScope: (handler: any) => (req: any, res: any) => {
      req.blockClaims = claimsBox.claims;
      return handler(req, res);
    },
    verifyBlockToken: mockVerifyBlockToken,
  };
});
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  // 🔴 A NAMED HOISTED MOCK, NOT A BARE `vi.fn()`. This is the exact call the
  // `/workflows/query` trust-boundary case below inspects: the whole claim is
  // about WHICH `tags` reach the orchestrator LIST, and a throwaway `vi.fn()`
  // records them nowhere.
  queryWorkflows: mockQueryWorkflows,
  getWorkflow: mockGetWorkflow,
  cancelWorkflow: mockCancelWorkflow,
  submitWorkflow: mockOrchSubmitWorkflow,
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: vi.fn(async () => true),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  updateBlockWorkflowStatus: vi.fn(async () => undefined),
  listMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settleCustomComfySpend: vi.fn(async () => undefined) };
});
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
// G8 — the PER-APP aggregate spend + velocity cap. Dynamic-imported by the submit
// resolver; mocked at the module boundary so a test can drive the deny and assert
// which LAYER refused.
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  reserveAppSpend: (...a: unknown[]) => mockReserveAppSpend(...(a as [])),
  refundAppSpend: vi.fn(async () => undefined),
  chargeAppSpendOverage: vi.fn(async () => undefined),
}));
/**
 * PARTIAL mocks — `importOriginal` spreads the real module and overrides only the
 * DATA SOURCES the submit preflight reads. Everything else in these modules stays
 * REAL, which matters: `snapshotFromWorkflow`, `appBlockTag` and `buildWorkflowTags`
 * live in `workflow.service` and are what the ownership gates above are made of, so
 * a bare factory here would have quietly replaced the controls under test.
 */
vi.mock('~/server/services/blocks/workflow.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveBlockVersionContext: (...a: unknown[]) => mockResolveVersionContext(...(a as [])),
  };
});
vi.mock('~/server/services/blocks/checkpoint.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveBlockCheckpoint: (...a: unknown[]) => mockResolveCheckpoint(...(a as [])),
  };
});
/**
 * The graph→step builder. A bare factory (not `importOriginal`) because loading
 * the real `orchestration-new.service` drags the orchestrator client package into
 * the SSR transform, and because what it produces is not what this file is about:
 * the step is an OPAQUE payload here, and every assertion below is about the price
 * the whatIf returns for it and what the gates do with that price.
 */
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: async () => ({
    externalCtx: { modelSubstitutions: { list: () => [] } },
  }),
  createWorkflowStepsFromGraphInput: async () => ({
    steps: [{ $type: 'textToImage', input: {} }],
    workflowMetadata: undefined,
  }),
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveCanGenerateForVersions: async (versions: { id: number }[]) =>
      new Map(versions.map((v) => [v.id, { canGenerate: true }])),
  };
});
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
  checkBlockPublishRateLimit: async () => ({ allowed: true }),
  checkBlockPollRateLimit: (...a: unknown[]) => mockCheckBlockPollRateLimit(...(a as [])),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import pollHandler from '~/pages/api/v1/blocks/workflows/poll';
import cancelHandler from '~/pages/api/v1/blocks/workflows/cancel';
import estimateHandler from '~/pages/api/v1/blocks/workflows/estimate';
import submitHandler from '~/pages/api/v1/blocks/workflows/submit';
import queryHandler from '~/pages/api/v1/blocks/workflows/query';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';
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

/**
 * 🔴 PAIRWISE-DISTINCT, NON-ZERO FIXTURES — every id, cost and user below differs
 * from every other, and none coincides with a constant the implementation names.
 */
const VIEWER = 42;
const STRANGER = 77;
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const OTHER_APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6Z';
const APP_TAG = `app-block:${APP_ID}`;
const OWN_ID = `${VIEWER}-20260923110000000`;
const STRANGERS_ID = `${STRANGER}-20260923110000000`;
const OWN_COST = 313;

function workflowFixture(over: Record<string, unknown> = {}) {
  return {
    id: OWN_ID,
    status: 'processing',
    createdAt: '2026-09-23T11:00:00.000Z',
    cost: { total: OWN_COST },
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
    jti: 'jti_seam',
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

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  url = '/api/v1/blocks/workflows/poll',
}: { method?: string; body?: unknown; url?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url,
    headers: { authorization: 'Bearer tok_seam', host: 'civitai.test' },
    socket: { remoteAddress: '203.0.113.11' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    headersSent: false,
    statusCode: 200,
    status(c: number) {
      statusCode = c;
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
    on() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

const TXT2IMG_BODY = {
  kind: 'textToImage' as const,
  modelId: 4201,
  modelVersionId: 9307,
  params: { prompt: 'a brass astrolabe on slate', width: 512, height: 512 },
};

// `/workflows/submit` REQUIRES an idempotency key (round 1 F5) — a submit without
// one is refused at the schema before reaching any control this file exercises, so
// every submit below carries it.
//
// `estimate` takes no key. Stated precisely, because an earlier wording of this
// comment overstated it twice: it said estimate "must NOT be given one", and that
// the asymmetry was "pinned in workflows-endpoints.test.ts". Neither held —
// `estimate.ts`'s `z.object` is NON-strict, so a key sent to estimate is silently
// STRIPPED rather than refused, and that file carried only the same prose, no
// assertion. Nothing pins it today. Do not cite this comment as a guard.
const IDEMPOTENCY_KEY = 'c4e81b02-6d39-4f57-8a1e-90b7d2f46c3a';

beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockGetOrchestratorToken,
    mockGetWorkflow,
    mockQueryWorkflows,
    mockCancelWorkflow,
    mockOrchSubmitWorkflow,
    mockGetUserById,
    mockGetSessionUser,
    mockIsAppBlocksEnabled,
    mockIsAppBlocksAuthorEnabled,
    mockCheckBlockCatalogRateLimit,
    mockCheckBlockPollRateLimit,
    mockResolveVersionContext,
    mockResolveCheckpoint,
    mockReserveAppSpend,
  ]) {
    fn.mockReset();
  }
  resetEnv();
  // The REAL orchestrator posture — per-user tokens and per-user workflow ids. See
  // the file header for why inheriting the `dev` default would make this file inert.
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
  claimsBox.claims = validClaims();
  mockVerifyBlockToken.mockResolvedValue(validClaims());
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
  mockGetUserById.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockCheckBlockPollRateLimit.mockResolvedValue({ allowed: true });
  mockGetWorkflow.mockResolvedValue(workflowFixture());
  mockQueryWorkflows.mockResolvedValue({ items: [], nextCursor: null });
  mockCancelWorkflow.mockResolvedValue(undefined);
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
  mockResolveVersionContext.mockResolvedValue({
    modelId: TXT2IMG_BODY.modelId,
    modelVersionId: TXT2IMG_BODY.modelVersionId,
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    gate: { id: TXT2IMG_BODY.modelVersionId, modelId: TXT2IMG_BODY.modelId },
  });
  mockResolveCheckpoint.mockResolvedValue({
    versionId: TXT2IMG_BODY.modelVersionId,
    baseModel: 'SDXL 1.0',
  });
});

afterEach(() => {
  resetEnv();
});

/** Drive a route end-to-end and hand back its wire outcome. */
async function call(
  handler: unknown,
  body: unknown,
  url: string
): Promise<{ status: number; json: any }> {
  const { req, res } = createMocks({ body, url });
  await (handler as any)(req, res);
  return { status: res._status(), json: res._json() };
}

const READ_ROUTES = [
  { name: 'poll', handler: pollHandler, url: '/api/v1/blocks/workflows/poll' },
  { name: 'cancel', handler: cancelHandler, url: '/api/v1/blocks/workflows/cancel' },
] as const;

const ALL_ROUTES = [
  ...READ_ROUTES.map((r) => ({ ...r, body: { workflowId: OWN_ID } as unknown })),
  {
    name: 'estimate',
    handler: estimateHandler,
    url: '/api/v1/blocks/workflows/estimate',
    body: { body: TXT2IMG_BODY } as unknown,
  },
  {
    name: 'submit',
    handler: submitHandler,
    url: '/api/v1/blocks/workflows/submit',
    body: { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY } as unknown,
  },
  // The app-subqueue READ. It is not in `READ_ROUTES` — that list means "reads ONE
  // workflow by id", i.e. the population the two by-id ownership gates apply to, and
  // this route takes no id at all. Its own scoping boundary is the host-forced tag,
  // which has its own describe below.
  {
    name: 'query',
    handler: queryHandler,
    url: '/api/v1/blocks/workflows/query',
    body: {} as unknown,
  },
];

describe('the scope gate reaches the wire', () => {
  it.each(ALL_ROUTES)(
    '$name refuses a token WITHOUT ai:write:budgeted with a 403',
    async ({ handler, url, body }) => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ scopes: ['buzz:read:self'] }));
      const out = await call(handler, body, url);
      expect(out.status).toBe(403);
      expect(out.json.message).toContain('ai:write:budgeted');
      // Nothing downstream may run — a refusal that still spent an orchestrator
      // token fetch is a refusal that leaked work.
      expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
    }
  );

  it.each(ALL_ROUTES)(
    '$name refuses an ANON subject with a 401',
    async ({ handler, url, body }) => {
      mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
      const out = await call(handler, body, url);
      expect(out.status).toBe(401);
      expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
    }
  );
});

describe('assertBlockWorkflowMintedForViewer reaches the wire', () => {
  it.each(READ_ROUTES)(
    "$name refuses another viewer's workflow with a 403, and never reads it",
    async ({ handler, url }) => {
      const out = await call(handler, { workflowId: STRANGERS_ID }, url);
      expect(out.status).toBe(403);
      expect(out.json.message).toBe('workflow does not belong to this viewer');
      // The fetch WOULD be the disclosure, so the gate has to run ahead of it —
      // asserting the 403 alone would still pass if the workflow had been read and
      // then discarded.
      expect(mockGetWorkflow).not.toHaveBeenCalled();
      expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
    }
  );

  it.each(READ_ROUTES)('$name allows the viewer’s OWN workflow', async ({ handler, url }) => {
    const out = await call(handler, { workflowId: OWN_ID }, url);
    expect(out.status).toBe(200);
    // Distinct from every other fixture cost in this file, so a constant-returning
    // stub cannot satisfy it by coincidence.
    expect(out.json.snapshot.cost).toEqual({ total: OWN_COST });
    // 🔴 THE RAW BEARER CROSSED THE SEAM. `blockWorkflowBearer` strips the scheme
    // and the procedure verifies what it is handed, so this is what pins the route
    // to the SAME token the middleware admitted — a stripped-wrong or hardcoded
    // value would still reach a mocked verifier, and every other assertion here
    // would stay green.
    expect(mockVerifyBlockToken).toHaveBeenCalledWith('tok_seam');
  });
});

describe('assertBlockWorkflowTaggedForApp reaches the wire', () => {
  it.each(READ_ROUTES)(
    '$name refuses a workflow tagged for ANOTHER app with a 403',
    async ({ handler, url }) => {
      mockGetWorkflow.mockResolvedValue(
        workflowFixture({ tags: ['civitai', `app-block:${OTHER_APP_ID}`] })
      );
      const out = await call(handler, { workflowId: OWN_ID }, url);
      expect(out.status).toBe(403);
      expect(out.json.message).toBe('workflow is not tagged for this app');
    }
  );

  it.each(READ_ROUTES)(
    '$name refuses an UNTAGGED workflow with a 403',
    async ({ handler, url }) => {
      mockGetWorkflow.mockResolvedValue(workflowFixture({ tags: [] }));
      const out = await call(handler, { workflowId: OWN_ID }, url);
      expect(out.status).toBe(403);
      expect(out.json.message).toBe('workflow is not tagged for this app');
    }
  );

  it('cancel asserts the tag BEFORE issuing the stop', async () => {
    mockGetWorkflow.mockResolvedValue(
      workflowFixture({ tags: ['civitai', `app-block:${OTHER_APP_ID}`] })
    );
    const out = await call(
      cancelHandler,
      { workflowId: OWN_ID },
      '/api/v1/blocks/workflows/cancel'
    );
    expect(out.status).toBe(403);
    // The point of the read-first ordering: a scope check that runs after the stop
    // has not scoped anything.
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });
});

describe('the rate-limit postures reach the wire unchanged', () => {
  /**
   * The poll limiter deliberately RETURNS a non-terminal snapshot rather than
   * throwing: the SDK host turns a throw into a TERMINAL failure snapshot, so a 429
   * here would tell the block that a running, PAID generation had finished and stop
   * its watch loop. A route that re-mapped this resolve to a 429 would re-introduce
   * exactly that, and only a test that spans both halves can see it.
   */
  it('a shed poll is a 200 non-terminal snapshot, not a 429', async () => {
    mockCheckBlockPollRateLimit.mockResolvedValue({ allowed: false });
    const out = await call(pollHandler, { workflowId: OWN_ID }, '/api/v1/blocks/workflows/poll');
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ snapshot: { workflowId: OWN_ID, status: 'processing' } });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('a shed cancel is a 200 non-terminal snapshot, not a 429', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false });
    const out = await call(
      cancelHandler,
      { workflowId: OWN_ID },
      '/api/v1/blocks/workflows/cancel'
    );
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ snapshot: { workflowId: OWN_ID, status: 'processing' } });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  /**
   * The estimate limiter, by contrast, really does THROW — and that decision is
   * recorded at the procedure. So the same class of event maps to two different
   * wire outcomes on two routes of the same surface, which is precisely the kind of
   * thing an adapter quietly flattens.
   */
  it('a shed estimate is a 429, because that limiter throws', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false });
    const out = await call(
      estimateHandler,
      { body: TXT2IMG_BODY },
      '/api/v1/blocks/workflows/estimate'
    );
    expect(out.status).toBe(429);
  });
});

/**
 * 🔴 THE MONEY CONTRACT, END TO END. These are the assertions the whole change
 * exists for, and they are the ones neither isolated suite can make.
 *
 * `blocks.submitWorkflow` answers a budget or cap breach by RESOLVING with a
 * failure-shaped snapshot that QUOTES THE PRICE it refused to charge. The consuming
 * SDK (`useBuzzWorkflow`) reads exactly that pair — `status === 'failed'` AND a
 * numeric `cost.total` — to decide the outcome is RECOVERABLE and open a top-up
 * flow; a cost-LESS failure is what it rejects. So on this transport the refusal
 * has to arrive as a 2xx carrying the snapshot. A route that mapped it to a 4xx
 * would compile, pass every procedure test (the procedure still resolves) and pass
 * every adapter test written against a stub — and would turn every recoverable
 * top-up into a hard failure on a spend path.
 *
 * Each of the four exits below is a DIFFERENT layer, and each is identified by the
 * layer's own message rather than by "some failure happened".
 */
describe('the budget and cap ladder reaches the wire as a PRICED 200, not an error', () => {
  /** The whatIf price the orchestrator quotes for the preflight step. */
  const QUOTED = 999;

  beforeEach(() => {
    mockOrchSubmitWorkflow.mockResolvedValue({
      id: OWN_ID,
      status: 'pending',
      cost: { total: QUOTED, base: QUOTED },
      steps: [],
      tags: [APP_TAG],
    });
    mockReserveAppSpend.mockResolvedValue({ allowed: true, dailyKey: 'appspend:key' });
  });

  it('LAYER 1 — over the per-call buzzBudget: 200, priced, and no orchestrator submit', async () => {
    // buzzBudget 50 (the default claims) against a 999 quote.
    const out = await call(
      submitHandler,
      { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
      '/api/v1/blocks/workflows/submit'
    );

    expect(out.status).toBe(200);
    expect(out.json.snapshot.status).toBe('failed');
    // 🔴 THE PRICE IS PRESENT AND NUMERIC. This single field is what makes the
    // outcome recoverable for the block — it is the number a top-up CTA quotes.
    expect(out.json.snapshot.cost).toEqual({ total: QUOTED });
    expect(out.json.snapshot.error).toContain('insufficient buzz budget');
    // Only the whatIf ran. A REAL submit would have been a charge.
    expect(mockOrchSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(mockOrchSubmitWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ query: { whatif: true } })
    );
  });

  it('LAYER 2 — over the PER-VIEWER daily Buzz cap: 200, priced, refused by reserveBlockBuzzSpend', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 5000 }));
    // The per-(user, UTC-day) reservation is an atomic INCRBY on sysRedis; drive its
    // running total past BLOCK_BUZZ_CAP_PER_DAY so the platform cap is what refuses.
    redisMock.sysRedis.incrBy.mockImplementation(async () => BLOCK_BUZZ_CAP_PER_DAY + QUOTED);

    const out = await call(
      submitHandler,
      { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
      '/api/v1/blocks/workflows/submit'
    );

    expect(out.status).toBe(200);
    expect(out.json.snapshot.status).toBe('failed');
    expect(out.json.snapshot.cost).toEqual({ total: QUOTED });
    // The LAYER, named: this is the per-user platform ceiling, not the per-call
    // budget above it and not the per-app aggregate below it.
    expect(out.json.snapshot.error).toContain('daily Buzz cap reached');
    expect(out.json.snapshot.error).toContain(String(BLOCK_BUZZ_CAP_PER_DAY));
    // Still no real submit — the reservation is taken BEFORE the orchestrator call.
    expect(mockOrchSubmitWorkflow).toHaveBeenCalledTimes(1);
    redisMock.sysRedis.incrBy.mockImplementation(async () => 0);
  });

  it('LAYER 3 — over the PER-APP aggregate cap (G8): 200, priced, refused by reserveAppSpend', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 5000 }));
    mockReserveAppSpend.mockResolvedValue({ allowed: false, reason: 'daily' });

    const out = await call(
      submitHandler,
      { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
      '/api/v1/blocks/workflows/submit'
    );

    expect(out.status).toBe(200);
    expect(out.json.snapshot.status).toBe('failed');
    expect(out.json.snapshot.cost).toEqual({ total: QUOTED });
    expect(out.json.snapshot.error).toContain('app daily spend cap reached');
    // 🔴 The aggregate ceiling is deliberately number-free on the wire — a
    // (potentially hostile) app must not learn it. Pinned so a later "helpful"
    // message cannot leak it through this transport.
    expect(out.json.snapshot.error).not.toMatch(/\d/);
    expect(mockOrchSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('LAYER 3b — the VELOCITY half of G8 is a distinct, retryable message', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 5000 }));
    mockReserveAppSpend.mockResolvedValue({ allowed: false, reason: 'velocity' });

    const out = await call(
      submitHandler,
      { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
      '/api/v1/blocks/workflows/submit'
    );

    expect(out.status).toBe(200);
    expect(out.json.snapshot.error).toContain('app generation rate limit reached');
  });

  /**
   * INVARIANT GUARD, and labelled as one: the legitimate path must not become
   * collateral of the four refusals above. It is not regression coverage for
   * anything — it passes for any route that forwards at all.
   */
  it('under every ceiling the submit goes through and returns the real workflow id', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ buzzBudget: 5000 }));
    mockOrchSubmitWorkflow
      .mockResolvedValueOnce({
        id: 'whatif',
        status: 'pending',
        cost: { total: QUOTED, base: QUOTED },
        steps: [],
        tags: [APP_TAG],
      })
      .mockResolvedValueOnce({
        id: OWN_ID,
        status: 'pending',
        cost: { total: QUOTED },
        steps: [],
        tags: [APP_TAG],
      });

    const out = await call(
      submitHandler,
      { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
      '/api/v1/blocks/workflows/submit'
    );

    expect(out.status).toBe(200);
    expect(out.json.snapshot.workflowId).toBe(OWN_ID);
    expect(out.json.snapshot.status).not.toBe('failed');
    // whatIf THEN the real submit — two calls, and the second carries no `whatif`.
    expect(mockOrchSubmitWorkflow).toHaveBeenCalledTimes(2);
  });
});

/**
 * 🔴 THE TRUST BOUNDARY ON `/workflows/query`, PROVED END TO END.
 *
 * The app scope on this read is a HOST-FORCED positive tag filter, built inside
 * `blocks.queryAppWorkflows` from `claims.appId` off the VERIFIED token. The
 * bridge's contract is that the block can never widen it, and the reason this file
 * — not the adapter file — is where it has to be proved is the seam: the adapter
 * suite mocks the caller away, so it can see that the route sends no `tags` and
 * nothing at all about what the ORCHESTRATOR is asked for. Only the combined state
 * answers "could a forged tag broaden the result set".
 *
 * ⚠️ THE SUBSTITUTE THAT MOTIVATES THIS SUITE — STATED AT ITS TRUE WIDTH, WHICH IS
 * NARROWER THAN AN EARLIER DRAFT OF THIS PARAGRAPH CLAIMED. `app.orchestration
 * .queryWorkflows({ tags })` in `@civitai/sdk` does take `tags` FROM THE CALLER,
 * and adopting it in place of this route really does move a server-enforced
 * boundary into the iframe while type-checking and passing tests.
 *
 * 🔴 BUT THIS ROUTE DOES NOT INTERCEPT THAT CLIENT, AND THE RETRACTION LIVES IN
 * `query.ts` — read it before re-deriving the wider claim from this file. That
 * client is a GET to a DIFFERENT HOST with `tags` in the query string; aimed here
 * it meets the 405 method guard, so the strict schema never sees a `tags` at all.
 * What these cases prove is the reachable half: a POST *to this route* carrying a
 * forged `tags` cannot broaden the result set, and the tag the orchestrator is
 * asked for is `appBlockTag(claims.appId)` off the verified token. That is worth a
 * suite of its own; it is not the same claim as "the SDK substitute is caught".
 *
 * `mockQueryWorkflows` is given a FILTERING implementation here rather than a
 * constant, which is the positive control: it genuinely returns a different app's
 * row when asked for a different app's tag (`the fake orchestrator CAN return the
 * other app's workflow` below), so "the forged request did not broaden" cannot be
 * satisfied by a fake that returns nothing whatever it is asked.
 */
describe('/workflows/query — the app tag is TOKEN-derived and the body cannot reach it', () => {
  const OTHER_APP_TAG = `app-block:${OTHER_APP_ID}`;
  const OWN_ROW_ID = `${VIEWER}-20260923120000001`;
  const OTHER_APP_ROW_ID = `${VIEWER}-20260923120000002`;
  const OWN_ROW_COST = 419;
  const OTHER_ROW_COST = 523;

  /** Two rows in one viewer's orchestrator queue, belonging to two DIFFERENT apps. */
  const ORCH_ROWS = [
    {
      id: OWN_ROW_ID,
      status: 'succeeded',
      createdAt: '2026-09-23T12:00:00.000Z',
      cost: { total: OWN_ROW_COST },
      steps: [],
      tags: ['civitai', APP_TAG],
    },
    {
      id: OTHER_APP_ROW_ID,
      status: 'succeeded',
      createdAt: '2026-09-23T12:00:01.000Z',
      cost: { total: OTHER_ROW_COST },
      steps: [],
      tags: ['civitai', OTHER_APP_TAG],
    },
  ];

  beforeEach(() => {
    // A fake orchestrator that actually honours the tag AND-match, so the returned
    // SET is a function of what was asked for. This is what turns every assertion
    // below from "the argument was X" into "the rows the block received were Y".
    mockQueryWorkflows.mockImplementation(async ({ tags = [] }: { tags?: string[] } = {}) => ({
      items: ORCH_ROWS.filter((row) => tags.every((t) => row.tags.includes(t))),
      nextCursor: null,
    }));
  });

  /** The workflow ids a `/workflows/query` reply carried, in order. */
  function idsFrom(json: any): string[] {
    return (json?.workflows ?? []).map((w: { workflowId: string }) => w.workflowId);
  }

  /**
   * 🔴 THE POSITIVE CONTROL, and it runs FIRST on purpose. Every assertion after
   * this one is a claim that a row did NOT come back; a zero is indistinguishable
   * from a fake wired to nothing until something makes the number move. Here the
   * token names the OTHER app and the other app's row — and only it — comes back.
   */
  it('the fake orchestrator CAN return the other app’s workflow, when the TOKEN says so', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ appId: OTHER_APP_ID }));
    const out = await call(queryHandler, {}, '/api/v1/blocks/workflows/query');
    expect(out.status).toBe(200);
    expect(idsFrom(out.json)).toEqual([OTHER_APP_ROW_ID]);
    expect(mockQueryWorkflows.mock.calls[0][0].tags).toEqual([OTHER_APP_TAG]);
  });

  /**
   * The ordinary path, and the other half of the pair above: the SAME fake, the
   * SAME two rows, a different verified token — a different single row back. The
   * tag therefore tracks `claims.appId` and is not a constant the implementation
   * could have hardcoded (the two app ids differ in the fixture, deliberately).
   */
  it('a clean request gets ONLY this app’s row, under the token-derived tag', async () => {
    const out = await call(queryHandler, {}, '/api/v1/blocks/workflows/query');
    expect(out.status).toBe(200);
    expect(idsFrom(out.json)).toEqual([OWN_ROW_ID]);
    expect(mockQueryWorkflows).toHaveBeenCalledTimes(1);
    // ONE tag, and it is the token's. Not `toContain` — a filter that also carried
    // a caller tag would satisfy that and would be the defect.
    expect(mockQueryWorkflows.mock.calls[0][0].tags).toEqual([APP_TAG]);
  });

  /**
   * 🔴 THE GUARD ITSELF: `bodySchema` is a `z.strictObject`, so a `tags` key in the
   * body is `unrecognized_keys` at the door.
   *
   * REACHABILITY IS PART OF THE CLAIM, so the body is otherwise entirely valid —
   * POST, claims present, `limit: 3` inside 1..50. No earlier check can reject it,
   * which is why `fieldErrors` must be EMPTY: a non-empty one would mean some other
   * rejection got there first and this assertion had stopped being about the strict
   * schema at all.
   *
   * MUTATION RESULT (measured, `z.strictObject` → `z.object` in query.ts, nothing
   * else changed): this case FAILS with `expected 200 to be 400`, i.e. the widened
   * body was accepted and forwarded. Its sibling below stays green under that same
   * mutation — by design; that one is the defence-in-depth layer, and the two
   * failing together would mean one of them was not measuring what it says.
   */
  it('REFUSES a body carrying `tags`, by name, without reaching the orchestrator', async () => {
    const out = await call(
      queryHandler,
      { limit: 3, tags: [OTHER_APP_TAG, 'civitai'] },
      '/api/v1/blocks/workflows/query'
    );
    expect(out.status).toBe(400);
    expect(out.json.error).toBe('Invalid request body');
    expect(out.json.details.formErrors.join(' ')).toContain('tags');
    // Nothing else objected — this IS the strict-key refusal, not a bound check.
    expect(out.json.details.fieldErrors).toEqual({});
    // The refusal is at the door: no token minted, no LIST issued, no row read.
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
    expect(mockGetOrchestratorToken).not.toHaveBeenCalled();
  });

  it.each([
    ['appId', { appId: OTHER_APP_ID }],
    ['userId', { userId: STRANGER }],
    ['blockToken', { blockToken: 'tok_forged' }],
  ])('REFUSES a body carrying a forged `%s` the same way', async (_name, extra) => {
    const out = await call(queryHandler, extra, '/api/v1/blocks/workflows/query');
    expect(out.status).toBe(400);
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  /**
   * 🔴 DEFENCE IN DEPTH, AND IT IS THE LAYER THAT SURVIVES LOSING THE ONE ABOVE.
   * `parsed.data` is forwarded field by field — never `...req.body` — and the
   * procedure's own input schema declares no `tags`, so a `tags` that somehow
   * reached the caller is stripped before the resolver and the orchestrator is
   * still asked for `[appBlockTag(claims.appId)]` alone.
   *
   * This drives the caller the way a widened route would: the request body is
   * spread into the seam through the tRPC caller, bypassing the strict schema
   * entirely, and the result set is asserted to be unchanged.
   *
   * MUTATION RESULT (same `z.strictObject` → `z.object` mutation): this case stays
   * GREEN, which is the point — it is measuring the second layer, and it would go
   * red only if the procedure started reading a caller `tags`.
   */
  it('a `tags` smuggled PAST the schema still cannot broaden the set', async () => {
    const { blockWorkflowCaller } = await import('~/server/services/blocks/block-workflow-rest');
    const { req, res } = createMocks({
      body: {},
      url: '/api/v1/blocks/workflows/query',
    });
    const caller = await blockWorkflowCaller(req as any, res as any);
    const result = await caller.queryAppWorkflows({
      blockToken: 'tok_seam',
      // @ts-expect-error — `tags` is NOT part of the procedure's input contract.
      // Passing it anyway is the whole experiment: zod must strip it.
      tags: [OTHER_APP_TAG, 'civitai'],
    });

    expect(result.workflows.map((w) => w.workflowId)).toEqual([OWN_ROW_ID]);
    expect(mockQueryWorkflows).toHaveBeenCalledTimes(1);
    expect(mockQueryWorkflows.mock.calls[0][0].tags).toEqual([APP_TAG]);
  });

  /**
   * The rate-limit posture, stated because it differs from `/poll`'s and a block
   * that got them confused would misread a throttle as a drained queue: this
   * procedure THROWS `TOO_MANY_REQUESTS`, so it reaches the wire as a 429 rather
   * than as an empty, successful page.
   */
  it('surfaces the catalog rate-limit refusal as a 429, not an empty page', async () => {
    mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: false });
    const out = await call(queryHandler, {}, '/api/v1/blocks/workflows/query');
    expect(out.status).toBe(429);
    expect(out.json).not.toHaveProperty('workflows');
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('passes cursor and limit through, and returns the orchestrator cursor verbatim', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [], nextCursor: 'cur_next_7' });
    const out = await call(
      queryHandler,
      { cursor: 'cur_prev_3', limit: 7 },
      '/api/v1/blocks/workflows/query'
    );
    expect(out.status).toBe(200);
    expect(out.json.cursor).toBe('cur_next_7');
    expect(mockQueryWorkflows.mock.calls[0][0]).toMatchObject({
      cursor: 'cur_prev_3',
      take: 7,
      tags: [APP_TAG],
    });
  });
});
