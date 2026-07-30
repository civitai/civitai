import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/tip-allowance (item 4). Exercises
 * the method guard, subject/anon gates, the read of the authoritative tip-cap
 * counter (cap/spent/remaining), and fail-closed-on-redis-error. Scope enforcement
 * (social:tip:self) is asserted by the withBlockScope wiring in the default export.
 */

function createMocks({ method = 'GET' }: { method?: string } = {}) {
  const req = {
    method,
    query: {},
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
    _headers: () => headers,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };
class ForbiddenError extends Error {
  readonly status = 403 as const;
}

// Capture the withBlockScope opts so we can assert the endpoint declares the
// correct scope + endpoint label (the real authz gate at runtime). Hoisted so it
// is initialized before the (hoisted) vi.mock factory runs at import time — the
// endpoint's `export default withBlockScope(...)` touches it during module load.
const { capturedOpts } = vi.hoisted(() => ({ capturedOpts: { opts: undefined as unknown } }));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any, opts: unknown) => {
    capturedOpts.opts = opts;
    return (req: any, res: any) => {
      req.blockClaims = claimsBox.claims;
      return handler(req, res);
    };
  },
  parseSubjectUserId: (sub: string): number | null => {
    if (sub === 'anon') return null;
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('bad');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockReadAllowance } = vi.hoisted(() => ({ mockReadAllowance: vi.fn() }));
vi.mock('~/server/utils/block-tip-rate-limit', () => ({
  readBlockTipAllowance: mockReadAllowance,
}));

import handlerDefault from '~/pages/api/v1/blocks/tip-allowance';

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: ['social:tip:self'],
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockReadAllowance.mockResolvedValue({ cap: 25_000, spent: 4_000, remaining: 21_000 });
});

describe('GET /api/v1/blocks/tip-allowance', () => {
  it('declares the social:tip:self scope + tip_allowance endpoint label', () => {
    expect(capturedOpts.opts).toMatchObject({
      endpoint: 'tip_allowance',
      requiredScope: 'social:tip:self',
      allowOpaqueOrigin: true,
    });
  });

  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handlerDefault(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks();
    await handlerDefault(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('403 for an anonymous token (no "self" allowance to read)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks();
    await handlerDefault(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(mockReadAllowance).not.toHaveBeenCalled();
  });

  it('200: returns {cap, spent, remaining} read for the verified subject', async () => {
    const { req, res } = createMocks();
    await handlerDefault(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ cap: 25_000, spent: 4_000, remaining: 21_000 });
    // Self-bound: the read is for the TOKEN subject (42), never a client-supplied id.
    expect(mockReadAllowance).toHaveBeenCalledWith(42);
  });

  it('503 (fail-closed) when the allowance read throws (redis error)', async () => {
    mockReadAllowance.mockRejectedValueOnce(new Error('redis down'));
    const { req, res } = createMocks();
    await handlerDefault(req as never, res as never);
    expect(res._status()).toBe(503);
  });
});
