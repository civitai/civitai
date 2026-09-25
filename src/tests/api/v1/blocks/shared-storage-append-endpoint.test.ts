import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/shared-storage/append.
 *
 * SCOPE OF THIS FILE, stated because it is narrower than it looks: the
 * authorization ladder (token verification, approved-block, revocation, the
 * write-scope assertion, the anon refusal, the min-trust gate and the rate-limit
 * bucket) lives in `appendSharedRow` and is pinned in
 * `apps-shared.router.test.ts` — including a block that calls the exported
 * function with a bare bearer, which is exactly what this route does. Here we
 * cover the REST wrapper only: method guard, body shape, bearer passthrough,
 * the audit stash, and delegation of failures to the shared chokepoint.
 *
 * 🔴 `withBlockScope` is mocked to a passthrough, so NOTHING in this file
 * exercises the real scope gate. That is the standing shape of every endpoint
 * test here; the wiring it hides is guarded by
 * `scoped-endpoints-cors-wiring.test.ts` (requiredScope + allowOpaqueOrigin,
 * derived both directions) and `no-unguarded-block-rest-token.test.ts`.
 */

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  authorization = 'Bearer tok_append',
}: { method?: string; body?: unknown; authorization?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url: '/api/v1/blocks/shared-storage/append',
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

const { mockAppend, mockHandleEndpointError } = vi.hoisted(() => ({
  mockAppend: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', async () => {
  // Real zod, because `append.ts` builds its body schema from this at module
  // scope — a `vi.fn()` here would throw during the import under test.
  const zod = await import('zod');
  return {
    appendSharedRow: mockAppend,
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

import handler from '~/pages/api/v1/blocks/shared-storage/append';

const VALUE = { title: 'ceiling fan mount', body: 'with a 41mm bore', data: { rev: 7 } };
const NEW_KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';

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
  mockAppend.mockResolvedValue({ key: NEW_KEY });
});

describe('POST /api/v1/blocks/shared-storage/append', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET', body: { value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token + the value down and returns { key }', async () => {
    const { req, res } = createMocks({ body: { value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockAppend).toHaveBeenCalledWith('tok_append', VALUE);
    expect(res._json()).toEqual({ key: NEW_KEY });
  });

  it('🔴 a client-supplied `key` is NOT forwarded — the server generates it', async () => {
    // Design C1. If the route ever widened its schema to pass a key through,
    // user B could overwrite user A's row. The strict-object check is the only
    // thing standing between this route and that, and it is invisible in a
    // happy-path test.
    const { req, res } = createMocks({
      body: { value: VALUE, key: 'attacker-chosen-key' },
    });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockAppend).toHaveBeenCalledWith('tok_append', VALUE);
    expect(JSON.stringify(mockAppend.mock.calls)).not.toContain('attacker-chosen-key');
  });

  it('400 for a missing body, a missing value, and a value with no title', async () => {
    for (const body of [undefined, {}, { value: {} }, { value: { body: 'orphan body' } }]) {
      const { req, res } = createMocks({ body });
      await handler(req as never, res as never);
      expect(res._status(), JSON.stringify(body)).toBe(400);
    }
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('400 on an over-long title — the bound bites at 201, not 200', async () => {
    // Both sides of the boundary, so a `<` / `<=` slip is visible.
    const a = createMocks({ body: { value: { title: 't'.repeat(201) } } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();

    const b = createMocks({ body: { value: { title: 't'.repeat(200) } } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(200);
  });

  it('stashes the audit detail with the SERVER-generated key', async () => {
    const { req, res } = createMocks({ body: { value: VALUE } });
    await handler(req as never, res as never);
    expect(mockStash).toHaveBeenCalledWith(res, {
      action: 'shared.append',
      key: NEW_KEY,
      outcome: 'ok',
    });
  });

  it('a throwing audit stash does NOT change the 200 — the write already happened', async () => {
    mockStash.mockImplementationOnce(() => {
      throw new Error('stash exploded');
    });
    const { req, res } = createMocks({ body: { value: VALUE } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ key: NEW_KEY });
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('a write failure goes to the shared error chokepoint, not a body built here', async () => {
    const boom = new Error(
      'duplicate key value violates unique constraint on app_voting.shared_kv'
    );
    mockAppend.mockRejectedValueOnce(boom);
    const { req, res } = createMocks({ body: { value: VALUE } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
  });

  it('the value schema this route enforces is the ROUTER’s, not a local copy', () => {
    // Structural, and deliberately so: the behavioural cases above pass just as
    // well against a re-declared local copy of the shape, so they cannot see the
    // drift this is about — two definitions of the one input that reaches the
    // content-safety belt.
    const src = readFileSync(
      path.join(process.cwd(), 'src/pages/api/v1/blocks/shared-storage/append.ts'),
      'utf8'
    );
    expect(src).toContain("from '~/server/routers/apps-shared.router'");
    expect(src).toContain('sharedValueInput');
    expect(src).not.toMatch(/title:\s*z\s*\.\s*string\(\)/);
  });
});
