import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module load
// (same posture as block-scope.anytoken-mode.test.ts).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Per-scope AUTHZ contract for the App Blocks collections + tip endpoints, run
 * through the REAL `withBlockScope` + a REAL minted token (mirrors
 * block-scope.anytoken-mode.test.ts). Business logic lives in the per-endpoint
 * handler tests; THIS locks the shared authz layer for each endpoint's
 * requiredScope:
 *   - a valid token CARRYING the scope (non-anon subject)  → handler runs (200)
 *   - a valid token MISSING the scope                      → 403
 *   - an ANON token (sub:'anon') carrying the scope        → 403 (self-scope
 *       binding — the collections + tip scopes require a real subject)
 *   - a REVOKED instance                                   → 403
 *
 * Covers `collections:read:self` (GET collections + detail), `collections:write:self`
 * (follow), and `social:tip:self` (tip).
 */

const { isFliptMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));

const { isRevokedMock } = vi.hoisted(() => ({ isRevokedMock: vi.fn(async () => false) }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));

import { withBlockScope } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

async function mintToken(opts: { userId: number | null; scopes: string[] }): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: opts.userId,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    scopes: opts.scopes,
    ctx: { entityType: 'none', slotId: 'app.page' },
    maxBrowsingLevel: 3,
    domain: 'green',
  });
  return r.token;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    setHeader(k: string, v: unknown) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    removeHeader() {
      return this;
    },
    writeHead() {
      return this;
    },
    getHeader(k: string) {
      return this.headers[k.toLowerCase()];
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq(authHeader?: string, method = 'POST'): NextApiRequest {
  return {
    method,
    headers: authHeader ? { authorization: authHeader } : {},
    query: {},
    url: '/api/v1/blocks/collections',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  isFliptMock.mockClear();
  isRevokedMock.mockClear();
  isRevokedMock.mockResolvedValue(false);
});

const SCOPES = [
  'collections:read:self',
  'collections:write:self',
  'social:tip:self',
] as const;

describe.each(SCOPES)('withBlockScope authz — %s', (scope) => {
  it('accepts a valid token carrying the scope (non-anon subject) → handler runs', async () => {
    const token = await mintToken({ userId: 42, scopes: [scope] });
    const wrapped = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ ok: true });
    });
    const route = withBlockScope(wrapped as never, { requiredScope: scope });

    const res = makeRes();
    await route(makeReq(`Bearer ${token}`) as never, res as never);

    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a valid token MISSING the scope → 403', async () => {
    const token = await mintToken({ userId: 42, scopes: [] });
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { requiredScope: scope });

    const res = makeRes();
    await route(makeReq(`Bearer ${token}`) as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it('rejects an ANON token carrying the scope → 403 (self-scope requires a real subject)', async () => {
    const token = await mintToken({ userId: null, scopes: [scope] });
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { requiredScope: scope });

    const res = makeRes();
    await route(makeReq(`Bearer ${token}`) as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it('rejects a REVOKED instance → 403', async () => {
    isRevokedMock.mockResolvedValue(true);
    const token = await mintToken({ userId: 42, scopes: [scope] });
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { requiredScope: scope });

    const res = makeRes();
    await route(makeReq(`Bearer ${token}`) as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it('rejects an INVALID token → 401', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'x' })
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user:1' })).toString('base64url');
    const bogus = `${header}.${payload}.bad`;
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { requiredScope: scope });

    const res = makeRes();
    await route(makeReq(`Bearer ${bogus}`) as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(wrapped).not.toHaveBeenCalled();
  });
});
