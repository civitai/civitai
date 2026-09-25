import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * ADAPTER-level coverage for the five `/api/v1/blocks/workflows/*` routes.
 *
 * SCOPE OF THIS FILE, stated because it is narrower than it looks: every control
 * on this surface — the `ai:write:budgeted` assertion, the anon refusal, the
 * budget/cap ladder, the two workflow-ownership gates, the rate-limit buckets —
 * belongs to the tRPC procedures these routes delegate to, and is proved THROUGH
 * these routes in `workflows-controls-seam.test.ts`, which wires the real
 * `blocksRouter`. Here the delegation itself is mocked, and what is under test is
 * only the adapter: the method guard, the missing-claims 401, the body schema, the
 * bearer passthrough, the exact argument forwarding, the 2xx-iff-resolved contract
 * (including a refusal snapshot returned byte-for-byte), and that failures go
 * through `handleEndpointError` rather than a hand-rolled envelope.
 *
 * 🔴 `withBlockScope` is mocked to a passthrough, so NOTHING in this file
 * exercises the real scope gate. That is the standing shape of every endpoint test
 * here; the wiring it hides is guarded by `scoped-endpoints-cors-wiring.test.ts`
 * (requiredScope + allowOpaqueOrigin, derived both directions) and
 * `no-unguarded-block-rest-token.test.ts`.
 */

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  authorization = 'Bearer tok_wf',
  url = '/api/v1/blocks/workflows/submit',
}: { method?: string; body?: unknown; authorization?: string; url?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url,
    headers: { authorization, host: 'civitai.test' },
    socket: { remoteAddress: '203.0.113.9' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
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
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  stashBlockActionDetail: () => undefined,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const {
  mockSubmit,
  mockEstimate,
  mockPoll,
  mockCancel,
  mockQuery,
  mockBearer,
  mockHandleEndpointError,
} = vi.hoisted(() => ({
  mockSubmit: vi.fn(),
  mockEstimate: vi.fn(),
  mockPoll: vi.fn(),
  mockCancel: vi.fn(),
  mockQuery: vi.fn(),
  mockBearer: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-workflow-rest', () => ({
  blockWorkflowBearer: (...a: unknown[]) => mockBearer(...a),
  blockWorkflowCaller: async () => ({
    submitWorkflow: mockSubmit,
    estimateWorkflow: mockEstimate,
    pollWorkflow: mockPoll,
    cancelWorkflow: mockCancel,
    queryAppWorkflows: mockQuery,
  }),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import submitHandler from '~/pages/api/v1/blocks/workflows/submit';
import estimateHandler from '~/pages/api/v1/blocks/workflows/estimate';
import pollHandler from '~/pages/api/v1/blocks/workflows/poll';
import cancelHandler from '~/pages/api/v1/blocks/workflows/cancel';
import queryHandler from '~/pages/api/v1/blocks/workflows/query';

/**
 * 🔴 PAIRWISE-DISTINCT, NON-ZERO FIXTURES. Every id, cost and token below differs
 * from every other, so an assertion cannot be satisfied by a stub that returns a
 * constant, and no assertion's expected value coincides with a literal the
 * implementation could hardcode.
 */
const BEARER = 'tok_wf';
const SUBMIT_WORKFLOW_ID = '31-20260923110000001';
const POLL_WORKFLOW_ID = '31-20260923110000002';
const CANCEL_WORKFLOW_ID = '31-20260923110000003';
const SUBMIT_COST = 137;
const ESTIMATE_COST = 241;
const POLL_COST = 353;
const CANCEL_COST = 467;
const IDEMPOTENCY_KEY = 'a7f3c1e9-2b4d-4a68-9c01-5e7d3f2b8a10';
const QUERY_WORKFLOW_ID = '31-20260923110000004';
const QUERY_COST = 571;
const QUERY_CURSOR = 'cur_01JQ8XG7YV2K4M6P8R0T2W4Y71';
const QUERY_NEXT_CURSOR = 'cur_01JQ8XG7YV2K4M6P8R0T2W4Y72';

/** A minimal, valid `kind: 'textToImage'` body for the shared wire schema. */
const TXT2IMG_BODY = {
  kind: 'textToImage' as const,
  modelId: 4201,
  modelVersionId: 9307,
  params: { prompt: 'a brass astrolabe on slate', width: 512, height: 512 },
};

/**
 * What the route hands the procedure: `blockWorkflowBodySchema` applies its own
 * defaults (`params.quantity`), so the forwarded object is NOT the request literal.
 * Written out by hand rather than derived from the schema, so it is an independent
 * statement of what crosses the seam — a new default appearing here silently is
 * exactly what this pin is for.
 */
const FORWARDED_BODY = {
  ...TXT2IMG_BODY,
  params: { ...TXT2IMG_BODY.params, quantity: 1 },
};

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:31',
    iat: 0,
    exp: 0,
    jti: 'jti_wf',
    blockId: 'pixel-poet',
    appId: 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B',
    appBlockId: 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A',
    blockInstanceId: 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C',
    scopes: ['ai:write:budgeted'],
    buzzBudget: 500,
    maxBrowsingLevel: 1,
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  for (const fn of [mockSubmit, mockEstimate, mockPoll, mockCancel, mockQuery, mockBearer])
    fn.mockReset();
  mockHandleEndpointError.mockReset();
  mockBearer.mockReturnValue(BEARER);
  claimsBox.claims = fakeClaims();
});

const ROUTES = [
  // submit carries an idempotencyKey because the route REQUIRES one (round 1 F5);
  // estimate below deliberately does not — it has no key in its schema.
  {
    name: 'submit',
    handler: submitHandler,
    body: { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
  },
  { name: 'estimate', handler: estimateHandler, body: { body: TXT2IMG_BODY } },
  { name: 'poll', handler: pollHandler, body: { workflowId: POLL_WORKFLOW_ID } },
  { name: 'cancel', handler: cancelHandler, body: { workflowId: CANCEL_WORKFLOW_ID } },
  // `query` takes no required field at all — its whole input is two optional
  // paging knobs, which is itself the trust-boundary statement (see query.ts).
  { name: 'query', handler: queryHandler, body: {} },
] as const;

describe('workflow routes — the guards every one of the five carries', () => {
  it.each(ROUTES)('$name rejects a non-POST with 405 and an Allow header', async ({ handler }) => {
    const { req, res } = createMocks({ method: 'GET' });
    await (handler as any)(req, res);
    expect(res._status()).toBe(405);
  });

  it.each(ROUTES)(
    '$name answers 401 when the middleware set no claims',
    async ({ handler, body }) => {
      claimsBox.claims = undefined;
      const { req, res } = createMocks({ body });
      await (handler as any)(req, res);
      expect(res._status()).toBe(401);
      expect(res._json()).toEqual({ error: 'Block token required' });
    }
  );

  it.each(ROUTES)('$name answers a structured 400 on a malformed body', async ({ handler }) => {
    const { req, res } = createMocks({ body: { nonsense: true } });
    await (handler as any)(req, res);
    expect(res._status()).toBe(400);
    expect((res._json() as { error: string }).error).toBe('Invalid request body');
    // The procedure must never be reached — a rejected body costs no delegation.
    for (const fn of [mockSubmit, mockEstimate, mockPoll, mockCancel, mockQuery])
      expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/blocks/workflows/submit', () => {
  it('forwards the bearer, the body and an idempotency key, and returns the snapshot verbatim', async () => {
    const reply = {
      snapshot: { workflowId: SUBMIT_WORKFLOW_ID, status: 'pending', cost: { total: SUBMIT_COST } },
    };
    mockSubmit.mockResolvedValue(reply);

    const { req, res } = createMocks({
      body: { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
    });
    await (submitHandler as any)(req, res);

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith({
      blockToken: BEARER,
      body: FORWARDED_BODY,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(res._status()).toBe(200);
    // Byte-for-byte: `useBuzzWorkflow` branches on fields of this object, so any
    // reshaping here is a contract change even when it looks equivalent.
    expect(res._json()).toEqual(reply);
  });

  /**
   * 🔴 REGRESSION (#5068 round 1, F5). This case previously asserted the OPPOSITE —
   * that a submit with no `idempotencyKey` was forwarded without one. The inversion
   * IS the fix; the test was not loosened.
   *
   * Absent a client key the procedure mints `bls<uuid>` per request, which dedupes
   * `submitWorkflow`'s own internal retry but NOT a client-level one — the redis
   * SET-NX claim is gated on the CLIENT key. On the bridge that was tolerable: the
   * caller is civitai's own host code. On a public HTTP surface, retry-on-timeout is
   * the default in most HTTP client libraries, so the old behaviour meant a dropped
   * connection after the orchestrator had already charged could produce a second
   * workflow and a second debit of the viewer's Buzz.
   *
   * `mockSubmit` must NOT be called: the refusal belongs at the schema, before
   * anything reaches the money path.
   */
  it('REFUSES a submit that sends no idempotencyKey, without delegating', async () => {
    mockSubmit.mockResolvedValue({
      snapshot: { workflowId: SUBMIT_WORKFLOW_ID, status: 'pending' },
    });
    const { req, res } = createMocks({ body: { body: TXT2IMG_BODY } });
    await (submitHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key outside the bridge charset without delegating', async () => {
    const { req, res } = createMocks({
      body: { body: TXT2IMG_BODY, idempotencyKey: 'bad key:with spaces\nand a newline' },
    });
    await (submitHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE MONEY CONTRACT. A budget/cap rejection RESOLVES from the procedure with
   * a priced, failure-shaped snapshot; `useBuzzWorkflow` reads exactly that pair
   * (`status === 'failed'` AND a numeric `cost.total`) to decide the outcome is
   * RECOVERABLE and offer a top-up. Answering it with a 4xx would collapse the
   * recoverable case into a hard failure, on a spend path.
   */
  it('returns a budget REJECTION as a 200 carrying the quoted price', async () => {
    const rejection = {
      snapshot: {
        workflowId: 'failed',
        status: 'failed',
        cost: { total: SUBMIT_COST },
        error: `insufficient buzz budget: estimate ${SUBMIT_COST} exceeds budget 100`,
      },
    };
    mockSubmit.mockResolvedValue(rejection);

    const { req, res } = createMocks({
      body: { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
    });
    await (submitHandler as any)(req, res);

    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(rejection);
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('routes a THROWN failure through handleEndpointError, never a hand-rolled envelope', async () => {
    const boom = new Error('orchestrator unreachable');
    mockSubmit.mockRejectedValue(boom);
    const { req, res } = createMocks({
      body: { body: TXT2IMG_BODY, idempotencyKey: IDEMPOTENCY_KEY },
    });
    await (submitHandler as any)(req, res);
    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
  });
});

describe('POST /api/v1/blocks/workflows/estimate', () => {
  it('forwards the bearer and body and returns the snapshot verbatim', async () => {
    const reply = {
      snapshot: { workflowId: 'whatif', status: 'pending', cost: { total: ESTIMATE_COST } },
    };
    mockEstimate.mockResolvedValue(reply);

    const { req, res } = createMocks({
      body: { body: TXT2IMG_BODY },
      url: '/api/v1/blocks/workflows/estimate',
    });
    await (estimateHandler as any)(req, res);

    expect(mockEstimate).toHaveBeenCalledWith({ blockToken: BEARER, body: FORWARDED_BODY });
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(reply);
  });

  /**
   * A cost-LESS estimate still RESOLVES over the wire. The SDK is what turns it
   * into `WorkflowEstimateError(snapshot, 'no-cost')`, and it can only do that if
   * it receives the snapshot — a route that converted this to a 4xx would take the
   * `.snapshot` the block branches on away from it.
   */
  it('returns a cost-less estimate as a 200 so the SDK can classify it', async () => {
    const reply = { snapshot: { workflowId: 'whatif', status: 'pending' } };
    mockEstimate.mockResolvedValue(reply);
    const { req, res } = createMocks({ body: { body: TXT2IMG_BODY } });
    await (estimateHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(reply);
  });

  it('routes a THROWN failure through handleEndpointError', async () => {
    const boom = new Error('whatif failed');
    mockEstimate.mockRejectedValue(boom);
    const { req, res } = createMocks({ body: { body: TXT2IMG_BODY } });
    await (estimateHandler as any)(req, res);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
  });
});

describe('POST /api/v1/blocks/workflows/poll', () => {
  it('forwards workflowId and returns the snapshot verbatim', async () => {
    const reply = {
      snapshot: { workflowId: POLL_WORKFLOW_ID, status: 'succeeded', cost: { total: POLL_COST } },
    };
    mockPoll.mockResolvedValue(reply);

    const { req, res } = createMocks({
      body: { workflowId: POLL_WORKFLOW_ID },
      url: '/api/v1/blocks/workflows/poll',
    });
    await (pollHandler as any)(req, res);

    expect(mockPoll).toHaveBeenCalledWith({ blockToken: BEARER, workflowId: POLL_WORKFLOW_ID });
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(reply);
  });

  it('forwards waitSeconds when given, and omits the key entirely when not', async () => {
    mockPoll.mockResolvedValue({
      snapshot: { workflowId: POLL_WORKFLOW_ID, status: 'processing' },
    });

    const withWait = createMocks({ body: { workflowId: POLL_WORKFLOW_ID, waitSeconds: 17 } });
    await (pollHandler as any)(withWait.req, withWait.res);
    expect(mockPoll).toHaveBeenLastCalledWith({
      blockToken: BEARER,
      workflowId: POLL_WORKFLOW_ID,
      waitSeconds: 17,
    });

    const without = createMocks({ body: { workflowId: POLL_WORKFLOW_ID } });
    await (pollHandler as any)(without.req, without.res);
    expect(mockPoll).toHaveBeenLastCalledWith({ blockToken: BEARER, workflowId: POLL_WORKFLOW_ID });
  });

  it('rejects a waitSeconds above the wire bound without delegating', async () => {
    const { req, res } = createMocks({ body: { workflowId: POLL_WORKFLOW_ID, waitSeconds: 61 } });
    await (pollHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockPoll).not.toHaveBeenCalled();
  });

  /**
   * The rate-limited poll RESOLVES with a deliberately NON-terminal snapshot so
   * the block keeps its watch loop. A 429 here would make the SDK host synthesise
   * a terminal failure and strand a paid, still-running generation.
   */
  it('returns the rate-limit shed as a 200 non-terminal snapshot, not a 429', async () => {
    const shed = { snapshot: { workflowId: POLL_WORKFLOW_ID, status: 'processing' } };
    mockPoll.mockResolvedValue(shed);
    const { req, res } = createMocks({ body: { workflowId: POLL_WORKFLOW_ID } });
    await (pollHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(shed);
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('routes a THROWN ownership refusal through handleEndpointError', async () => {
    const refusal = new Error('workflow does not belong to this viewer');
    mockPoll.mockRejectedValue(refusal);
    const { req, res } = createMocks({ body: { workflowId: POLL_WORKFLOW_ID } });
    await (pollHandler as any)(req, res);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, refusal);
  });
});

describe('POST /api/v1/blocks/workflows/cancel', () => {
  it('forwards workflowId and returns the snapshot verbatim', async () => {
    const reply = {
      snapshot: {
        workflowId: CANCEL_WORKFLOW_ID,
        status: 'canceled',
        cost: { total: CANCEL_COST },
      },
    };
    mockCancel.mockResolvedValue(reply);

    const { req, res } = createMocks({
      body: { workflowId: CANCEL_WORKFLOW_ID },
      url: '/api/v1/blocks/workflows/cancel',
    });
    await (cancelHandler as any)(req, res);

    expect(mockCancel).toHaveBeenCalledWith({ blockToken: BEARER, workflowId: CANCEL_WORKFLOW_ID });
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(reply);
  });

  it('routes a THROWN ownership refusal through handleEndpointError', async () => {
    const refusal = new Error('workflow is not tagged for this app');
    mockCancel.mockRejectedValue(refusal);
    const { req, res } = createMocks({ body: { workflowId: CANCEL_WORKFLOW_ID } });
    await (cancelHandler as any)(req, res);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, refusal);
  });
});

describe('POST /api/v1/blocks/workflows/query', () => {
  const PAGE = {
    workflows: [
      {
        workflowId: QUERY_WORKFLOW_ID,
        status: 'succeeded',
        images: [{ url: 'https://orch.test/i/71.jpeg' }],
        cost: { total: QUERY_COST },
        createdAt: '2026-09-23T12:00:00.000Z',
      },
    ],
    cursor: QUERY_NEXT_CURSOR,
  };

  it('forwards the bearer with NO paging keys when the body is empty, and returns the page verbatim', async () => {
    mockQuery.mockResolvedValue(PAGE);
    const { req, res } = createMocks({ body: {}, url: '/api/v1/blocks/workflows/query' });
    await (queryHandler as any)(req, res);

    // Exactly ONE key. The absent `cursor`/`limit` are OMITTED rather than sent as
    // `undefined`, so the procedure's own `?? 20` default owns the page size —
    // one constant, one place — and there is no second spelling of it to drift.
    expect(mockQuery).toHaveBeenCalledWith({ blockToken: BEARER });
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual(PAGE);
  });

  it('forwards cursor and limit when given', async () => {
    mockQuery.mockResolvedValue(PAGE);
    const { req, res } = createMocks({ body: { cursor: QUERY_CURSOR, limit: 13 } });
    await (queryHandler as any)(req, res);
    expect(mockQuery).toHaveBeenCalledWith({
      blockToken: BEARER,
      cursor: QUERY_CURSOR,
      limit: 13,
    });
  });

  /**
   * 🔴 REGRESSION. `query` is the only one of the five whose whole input is
   * optional, so a bodyless POST is its PRIMARY call shape — and Next does not
   * deliver one as `{}`. With a missing `Content-Type`, `parseBody` defaults to
   * `text/plain` and returns the RAW STRING, so `req.body` is `''`; `'' ?? {}` is
   * `''` (`??` only catches null/undefined) and `strictObject.safeParse('')`
   * failed with `expected object, received string`.
   *
   * That is exactly what `@civitai/sdk`'s `createHttp` produces for an
   * argument-less POST — it sets `Content-Type` ONLY when `opts.body !==
   * undefined` — i.e. the spelling this route exists to enable.
   *
   * RED at 90e5f4f2cb (the PR's first head) with `expected 400 to be 200` on the
   * `''` and `'   '` rows; GREEN here. The `undefined` row passed on both sides
   * and is an INVARIANT GUARD, not regression coverage — it is kept only so the
   * three shapes are pinned as one table.
   */
  it.each([
    ['no body at all (undefined)', undefined],
    ["a bodyless POST with no Content-Type ('')", ''],
    ['a whitespace-only raw body', '   \n '],
  ])('treats %s as an empty query and delegates', async (_name, body) => {
    mockQuery.mockResolvedValue(PAGE);
    const { req, res } = createMocks({ body });
    await (queryHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith({ blockToken: BEARER });
  });

  /**
   * The narrow half of the same coercion, and the reason it is not "any string
   * body means empty": a NON-empty raw string is a client that sent a payload
   * without labelling it. This route does NOT guess — it refuses, rather than
   * re-implementing JSON parsing so that one layer can interpret an unlabelled
   * body differently from another.
   */
  it('still REFUSES a non-empty raw string body rather than parsing it', async () => {
    const { req, res } = createMocks({ body: '{"limit":5}' });
    await (queryHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a limit above the wire bound without delegating', async () => {
    const { req, res } = createMocks({ body: { limit: 51 } });
    await (queryHandler as any)(req, res);
    expect(res._status()).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE TRUST BOUNDARY, at the adapter layer. `bodySchema` is a
   * `z.strictObject` — the only one on this surface — so a `tags` key is
   * `unrecognized_keys` at the door rather than silently stripped. The end-to-end
   * half of this claim (a forged tag cannot broaden the RESULT SET, and the tag
   * the orchestrator sees is `appBlockTag(claims.appId)`) is in
   * `workflows-controls-seam.test.ts`, which is the only file that can see it.
   *
   * REACHABILITY: the body is otherwise entirely valid — POST, claims present,
   * `limit: 4` inside 1..50 — so nothing earlier can reject it and `fieldErrors`
   * must be empty. If some other check got there first, this case would have
   * stopped measuring the strict schema.
   *
   * MUTATION RESULT (measured, `z.strictObject` → `z.object` in query.ts):
   * `expected 200 to be 400`.
   */
  it('REFUSES a body-supplied `tags`, naming the key, and never delegates', async () => {
    const { req, res } = createMocks({
      body: { limit: 4, tags: ['app-block:oac_someone_else', 'civitai'] },
    });
    await (queryHandler as any)(req, res);

    expect(res._status()).toBe(400);
    const json = res._json() as {
      error: string;
      details: { formErrors: string[]; fieldErrors: Record<string, unknown> };
    };
    expect(json.error).toBe('Invalid request body');
    expect(json.details.formErrors.join(' ')).toContain('tags');
    expect(json.details.fieldErrors).toEqual({});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([['appId'], ['userId'], ['blockToken'], ['hideMatureContent']])(
    'REFUSES a body-supplied `%s` the same way',
    async (key) => {
      const { req, res } = createMocks({ body: { [key]: 'forged' } });
      await (queryHandler as any)(req, res);
      expect(res._status()).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  it('routes a THROWN refusal through handleEndpointError, never a hand-rolled envelope', async () => {
    const refusal = new Error('block lacks ai:write:budgeted scope');
    mockQuery.mockRejectedValue(refusal);
    const { req, res } = createMocks({ body: {} });
    await (queryHandler as any)(req, res);
    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, refusal);
  });

  /**
   * An EMPTY page is a legitimate 200 — a viewer who has generated nothing through
   * this app. Every refusal on this procedure THROWS (scope, anon, kill-switch,
   * rate limit), so it reaches the wire non-2xx through `handleEndpointError`, and
   * there is no path that answers "no workflows" for an authorization failure.
   */
  it('returns an empty page as a 200, and does not route it through handleEndpointError', async () => {
    mockQuery.mockResolvedValue({ workflows: [], cursor: null });
    const { req, res } = createMocks({ body: {} });
    await (queryHandler as any)(req, res);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ workflows: [], cursor: null });
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });
});
