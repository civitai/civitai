import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * `POST /api/v1/blocks/user-checkpoint/set` — the REST twin of the SET_USER_CHECKPOINT
 * bridge message.
 *
 * This suite is about the ADAPTER, not the write. The write's own semantics — the keying,
 * the gates, the manifest filter, the ecosystem re-validation — belong to the shared body
 * and are pinned in `src/server/services/blocks/__tests__/user-settings.keying.test.ts`.
 * What can only go wrong HERE is the seam: the bearer token not reaching the body, a
 * refusal being converted into a 2xx, the wrong method being served, or the route quietly
 * growing an input the body does not expect.
 *
 * 🔴 THE SHARED BODY IS MOCKED, THE SCHEMA IS NOT. Stubbing `userCheckpointSetInput` too
 * would make every input-validation assertion below a restatement of the stub — so the real
 * schema is re-exported from the mock factory. That is the app-storage suite's convention
 * and it is load-bearing for the same reason there.
 *
 * `withBlockScope` is stubbed to a pass-through that injects `req.blockClaims`, so the
 * DEFAULT export is reachable without minting a real JWT. The wrapper's own behaviour (the
 * approval gate, CORS, the audit row) is covered by the middleware's suites and by
 * `no-unguarded-block-rest-token.test.ts`, which asserts this route IS wrapped — a claim
 * this file deliberately does not make, since its stub would satisfy it either way.
 */

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: (req: unknown, res: unknown) => unknown) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

const { mockSetOverride, mockHandleEndpointError } = vi.hoisted(() => ({
  mockSetOverride: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));

vi.mock('~/server/services/blocks/user-settings.service', async () => {
  const z = await import('zod');
  return {
    setUserCheckpointOverride: mockSetOverride,
    // The REAL schema, not a stub — see the docblock.
    userCheckpointSetInput: z.object({ versionId: z.number().int().positive().nullable() }),
  };
});
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

// eslint-disable-next-line import/first
import setHandler from '~/pages/api/v1/blocks/user-checkpoint/set';

function createMocks(opts: { method?: string; body?: unknown; authorization?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers.authorization = opts.authorization;
  const req = {
    method: opts.method ?? 'POST',
    body: opts.body,
    headers,
    url: '/api/v1/blocks/user-checkpoint/set',
    query: {},
    socket: {},
  } as any;

  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    setHeader: vi.fn(),
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
    _status: () => statusCode,
    _json: () => jsonBody,
  } as any;

  return { req, res };
}

const VALID_CLAIMS = {
  sub: 'user:7717',
  blockInstanceId: 'mbi_route_fixture',
  appBlockId: 'apb_route_fixture',
  ctx: { modelId: 4242, slotId: 'model-detail-below' },
} as unknown as BlockTokenClaims;

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = VALID_CLAIMS;
  mockSetOverride.mockResolvedValue({ ok: true });
});

describe('POST /api/v1/blocks/user-checkpoint/set', () => {
  it('forwards the RAW bearer token and the parsed versionId to the shared body', async () => {
    const { req, res } = createMocks({
      body: { versionId: 8080 },
      authorization: 'Bearer tok_abc',
    });
    await setHandler(req, res);

    expect(mockSetOverride).toHaveBeenCalledTimes(1);
    // Positional: (blockToken, versionId). The token is the RAW bearer value — the route
    // must not re-wrap, trim differently, or substitute anything of its own.
    expect(mockSetOverride.mock.calls[0][0]).toBe('tok_abc');
    expect(mockSetOverride.mock.calls[0][1]).toBe(8080);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ ok: true });
  });

  it('forwards an explicit null (the SDK’s persist(null) clear)', async () => {
    const { req, res } = createMocks({
      body: { versionId: null },
      authorization: 'Bearer tok_clear',
    });
    await setHandler(req, res);

    expect(mockSetOverride).toHaveBeenCalledTimes(1);
    expect(mockSetOverride.mock.calls[0][1]).toBeNull();
    expect(res._status()).toBe(200);
  });

  it('🔴 passes NO caller-supplied instance or user id to the body', async () => {
    // The route's whole safety property. A body carrying these fields must not cause them to
    // reach the write — and the adapter's arity is what guarantees it: there is nowhere for
    // them to go. Asserted on the CALL, not on the schema, so a future widening of the
    // schema cannot make this pass vacuously.
    const { req, res } = createMocks({
      body: { versionId: 8080, blockInstanceId: 'mbi_attacker', userId: 9931 },
      authorization: 'Bearer tok_abc',
    });
    await setHandler(req, res);

    expect(res._status()).toBe(200);
    expect(mockSetOverride).toHaveBeenCalledTimes(1);
    expect(mockSetOverride.mock.calls[0]).toHaveLength(2);
    const forwarded = JSON.stringify(mockSetOverride.mock.calls[0]);
    expect(forwarded).not.toContain('mbi_attacker');
    expect(forwarded).not.toContain('9931');
  });

  it('routes a thrown refusal through handleEndpointError — never a 2xx "not written"', async () => {
    // 🔴 The contract the consumer depends on: `persist()` THROWS on failure, so a soft
    // `{ ok: false }` envelope at 200 would be read as a successful persist.
    mockSetOverride.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message: 'nope' }));
    const { req, res } = createMocks({
      body: { versionId: 8080 },
      authorization: 'Bearer tok_abc',
    });
    await setHandler(req, res);

    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    expect(mockHandleEndpointError.mock.calls[0][1]).toBeInstanceOf(TRPCError);
    // And it did NOT answer with a body of its own.
    expect(res._json()).toBeUndefined();
  });

  it('routes the ANONYMOUS refusal through the same path (401, from the body)', async () => {
    // Documented behaviour, asserted rather than left to prose: this route declares no
    // requiredScope, so an anon caller is refused by the BODY, not by enforceContextBinding.
    mockSetOverride.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'anon viewers cannot persist block settings' })
    );
    const { req, res } = createMocks({
      body: { versionId: 8080 },
      authorization: 'Bearer tok_anon',
    });
    await setHandler(req, res);

    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    expect(mockHandleEndpointError.mock.calls[0][1]).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(res._json()).toBeUndefined();
  });

  it('405s a GET and advertises Allow: POST', async () => {
    const { req, res } = createMocks({ method: 'GET', authorization: 'Bearer tok_abc' });
    await setHandler(req, res);

    expect(res._status()).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it('401s when no block claims reached the handler', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({
      body: { versionId: 8080 },
      authorization: 'Bearer tok_abc',
    });
    await setHandler(req, res);

    expect(res._status()).toBe(401);
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it('400s a MISSING versionId without calling the body', async () => {
    // Nullable, not optional: an absent field must not be coerced to `null` and silently
    // WIPE the viewer's override.
    const { req, res } = createMocks({ body: {}, authorization: 'Bearer tok_abc' });
    await setHandler(req, res);

    expect(res._status()).toBe(400);
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it('400s an absent body entirely', async () => {
    const { req, res } = createMocks({ body: undefined, authorization: 'Bearer tok_abc' });
    await setHandler(req, res);

    expect(res._status()).toBe(400);
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it.each([
    ['a float', 1.5],
    ['zero', 0],
    ['a negative', -3],
    ['a numeric string', '8080'],
    ['a boolean', true],
  ])('400s %s versionId without calling the body', async (_label, versionId) => {
    const { req, res } = createMocks({ body: { versionId }, authorization: 'Bearer tok_abc' });
    await setHandler(req, res);

    expect(res._status()).toBe(400);
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it('forwards an EMPTY token string rather than inventing one', async () => {
    // `blockBearerToken` returns '' when the header is absent — deliberately, so the
    // fail-closed direction is the default. The route must pass that through; the body's
    // own verification is what refuses it. A route that substituted a fallback here would
    // turn a missing header into some other token.
    const { req, res } = createMocks({ body: { versionId: 8080 } });
    await setHandler(req, res);

    expect(mockSetOverride).toHaveBeenCalledTimes(1);
    expect(mockSetOverride.mock.calls[0][0]).toBe('');
  });
});
