import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/shared-storage/update.
 *
 * As with `append`, the authorization ladder and the author gate live in
 * `updateSharedRow` and are pinned in `apps-shared.router.test.ts` (which calls
 * the exported function with a bare bearer — the exact shape this route uses).
 * Here: method guard, body shape, bearer + key + value passthrough, the audit
 * stash, and delegation of failures to the shared chokepoint.
 */

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  authorization = 'Bearer tok_update',
}: { method?: string; body?: unknown; authorization?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url: '/api/v1/blocks/shared-storage/update',
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

const { mockUpdate, mockHandleEndpointError } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', async () => {
  const zod = await import('zod');
  return {
    updateSharedRow: mockUpdate,
    SHARED_KEY_MAX: 64,
    sharedValueInput: zod.object({
      title: zod.string().min(1).max(200),
      body: zod.string().max(4096).optional(),
      data: zod.unknown().optional(),
    }),
  };
});
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/update';

const KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';
const VALUE = { title: 'revised mount', body: 'now a 43mm bore', data: { rev: 9 } };

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
  mockUpdate.mockResolvedValue({ ok: true });
});

describe('POST /api/v1/blocks/shared-storage/update', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'PUT', body: { key: KEY, value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { key: KEY, value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token, the key and the value down IN THAT ORDER', async () => {
    // The three arguments are pairwise distinct and none is falsy, so a
    // transposition (key and value swapped) fails here rather than passing.
    const { req, res } = createMocks({ body: { key: KEY, value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('tok_update', KEY, VALUE);
    expect(res._json()).toEqual({ ok: true });
  });

  it('400 for a missing key, a missing value, and a value with no title', async () => {
    for (const body of [undefined, {}, { key: KEY }, { value: VALUE }, { key: KEY, value: {} }]) {
      const { req, res } = createMocks({ body });
      await handler(req as never, res as never);
      expect(res._status(), JSON.stringify(body)).toBe(400);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400 for an empty key and an over-long key (>64) — the bound bites at 65, not 64', async () => {
    const a = createMocks({ body: { key: '', value: VALUE } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(400);

    const b = createMocks({ body: { key: 'k'.repeat(65), value: VALUE } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(400);

    expect(mockUpdate).not.toHaveBeenCalled();

    const ok = 'k'.repeat(64);
    const c = createMocks({ body: { key: ok, value: VALUE } });
    await handler(c.req as never, c.res as never);
    expect(c.res._status()).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('tok_update', ok, VALUE);
  });

  it('stashes the audit detail with the edited key', async () => {
    const { req, res } = createMocks({ body: { key: KEY, value: VALUE } });
    await handler(req as never, res as never);
    expect(mockStash).toHaveBeenCalledWith(res, {
      action: 'shared.update',
      key: KEY,
      outcome: 'ok',
    });
  });

  it('a throwing audit stash does NOT change the 200 — the edit already happened', async () => {
    mockStash.mockImplementationOnce(() => {
      throw new Error('stash exploded');
    });
    const { req, res } = createMocks({ body: { key: KEY, value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ ok: true });
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('a non-author FORBIDDEN goes to the shared chokepoint, not a body built here', async () => {
    // The author gate is the router's; what this pins is that its refusal is not
    // reshaped into a hand-rolled envelope on the way out.
    const refusal = Object.assign(new Error('you can only edit your own submissions'), {
      code: 'FORBIDDEN',
    });
    mockUpdate.mockRejectedValueOnce(refusal);
    const { req, res } = createMocks({ body: { key: KEY, value: VALUE } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, refusal);
    expect(res._json()).toBeUndefined();
    expect(mockStash).not.toHaveBeenCalled();
  });
});
