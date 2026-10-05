import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/shared-storage/withdraw.
 *
 * The authorization ladder — write-scope, anon refusal, min-trust gate, and the
 * OWN per-(user, app) 30/min bucket this op spends (it had none at all before PR
 * 1 of this pair) — lives in `withdrawSharedRow` and is pinned in
 * `apps-shared.router.test.ts`, including a block that calls that function with
 * a bare bearer, which is exactly the shape this route uses. Here: method guard,
 * body shape, bearer + key passthrough, the `deleted: false` contract, the audit
 * stash and delegation of failures to the shared chokepoint.
 */

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  authorization = 'Bearer tok_withdraw',
}: { method?: string; body?: unknown; authorization?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url: '/api/v1/blocks/shared-storage/withdraw',
    headers: { authorization, host: 'civitai.test' },
    socket: { remoteAddress: '203.0.113.7' },
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

const { mockStash } = vi.hoisted(() => ({ mockStash: vi.fn() }));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  stashBlockActionDetail: (...args: unknown[]) => mockStash(...args),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockWithdraw, mockHandleEndpointError } = vi.hoisted(() => ({
  mockWithdraw: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  withdrawSharedRow: mockWithdraw,
  SHARED_KEY_MAX: 64,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/withdraw';

const KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';

function fakeClaims(): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:23',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: ['apps:storage:shared:write'],
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockWithdraw.mockResolvedValue({ ok: true, deleted: true });
});

describe('POST /api/v1/blocks/shared-storage/withdraw', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'DELETE', body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token + the key down and returns { ok, deleted }', async () => {
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledWith('tok_withdraw', KEY);
    expect(res._json()).toEqual({ ok: true, deleted: true });
  });

  it('🔴 a key that deleted NOTHING is a 200 with deleted:false — NOT a 404', async () => {
    // The status is the contract. Another user's key, an already-withdrawn row
    // and a key that never existed must all be indistinguishable here; a 404 for
    // one of them would turn this route into an existence oracle over other
    // users' rows, which no caller is entitled to.
    mockWithdraw.mockResolvedValueOnce({ ok: true, deleted: false });
    const { req, res } = createMocks({ body: { key: 'someone-elses-key' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ ok: true, deleted: false });
  });

  it('records a no-op withdrawal as outcome:failed in the audit detail', async () => {
    // So an abuse sweep over block_scope_invocations can tell a real deletion
    // from a key-probing loop — both of which answer 200 on the wire.
    mockWithdraw.mockResolvedValueOnce({ ok: true, deleted: false });
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(mockStash).toHaveBeenCalledWith(res, {
      action: 'shared.withdraw',
      key: KEY,
      outcome: 'failed',
    });
  });

  it('records a real deletion as outcome:ok', async () => {
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(mockStash).toHaveBeenCalledWith(res, {
      action: 'shared.withdraw',
      key: KEY,
      outcome: 'ok',
    });
  });

  it('400 for a missing body, a missing key and an empty key', async () => {
    for (const body of [undefined, {}, { key: '' }]) {
      const { req, res } = createMocks({ body });
      await handler(req as never, res as never);
      expect(res._status(), JSON.stringify(body)).toBe(400);
    }
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('400 for an over-long key — the bound bites at 65, not 64', async () => {
    const a = createMocks({ body: { key: 'k'.repeat(65) } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(400);
    expect(mockWithdraw).not.toHaveBeenCalled();

    const ok = 'k'.repeat(64);
    const b = createMocks({ body: { key: ok } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledWith('tok_withdraw', ok);
  });

  it('a throwing audit stash does NOT change the 200 — the row is already gone', async () => {
    mockStash.mockImplementationOnce(() => {
      throw new Error('stash exploded');
    });
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ ok: true, deleted: true });
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('a failure goes to the shared error chokepoint, not a body built here', async () => {
    const boom = new Error('update or delete on table "shared_kv" violates foreign key constraint');
    mockWithdraw.mockRejectedValueOnce(boom);
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
    expect(mockStash).not.toHaveBeenCalled();
  });
});
