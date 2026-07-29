import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/collections/[id]/follow. Authz
 * is in collections-tip-authz.test.ts; this exercises the follow/unfollow reuse
 * (self-bound to the subject) + TRPCError→HTTP mapping.
 */

function createMocks({
  method = 'POST',
  query = {},
  body = {},
}: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}) {
  const req = { method, query, body, headers: {}, socket: { remoteAddress: '203.0.113.7' } } as unknown as Record<
    string,
    unknown
  >;
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
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };
class ForbiddenError extends Error {
  readonly status = 403 as const;
}

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  parseSubjectUserId: (sub: string): number | null => {
    if (sub === 'anon') return null;
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('bad');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockAdd, mockRemove } = vi.hoisted(() => ({ mockAdd: vi.fn(), mockRemove: vi.fn() }));
vi.mock('~/server/services/collection.service', () => ({
  addContributorToCollection: mockAdd,
  removeContributorFromCollection: mockRemove,
}));

import handler from '~/pages/api/v1/blocks/collections/[id]/follow';

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
    scopes: ['collections:write:self'],
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockAdd.mockResolvedValue({});
  mockRemove.mockResolvedValue({});
});

describe('POST /api/v1/blocks/collections/[id]/follow', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: '7' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('403 for an anonymous token', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
  });

  it('400 for a non-numeric id', async () => {
    const { req, res } = createMocks({ query: { id: 'x' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
  });

  it('400 for a non-boolean follow body', async () => {
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: 'yes' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
  });

  it('follow=true → addContributorToCollection self-bound → { followed: true }', async () => {
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ followed: true });
    expect(mockAdd).toHaveBeenCalledWith({ collectionId: 7, userId: 42, targetUserId: 42 });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('follow=false → removeContributorFromCollection self-bound → { followed: false }', async () => {
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: false } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ followed: false });
    expect(mockRemove).toHaveBeenCalledWith({ collectionId: 7, userId: 42, targetUserId: 42 });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('maps a service FORBIDDEN (e.g. cannot follow a private collection) → 403', async () => {
    mockAdd.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'no permission' })
    );
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect((res._json() as any).error).toBe('no permission');
  });

  it('maps an unexpected non-TRPC error → 500', async () => {
    mockAdd.mockRejectedValueOnce(new Error('boom'));
    const { req, res } = createMocks({ query: { id: '7' }, body: { follow: true } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(500);
  });
});
