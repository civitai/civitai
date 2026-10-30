import { beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the ~/env/server mock before the middleware reads env.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * A block calls the REST routes cross-origin, so it can read `Retry-After` on a 429 only when
 * the block-CORS response exposes it. Both arms that grant CORS (an allowlisted origin and the
 * opted-in opaque `Origin: null`) must expose it; an unrecognised origin gets no CORS at all.
 */

const ALLOWED_ORIGIN = 'https://rl-app.example';

const { isFliptMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: vi.fn(async () => false) },
}));
vi.mock('~/server/services/blocks/block-approval.service', () => ({
  resolveRestApprovalVerdict: vi.fn(async () => 'ok' as const),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { _internalsForTests, withBlockScope } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

async function mintToken(): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: 42,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    scopes: [],
    ctx: { modelId: 1 },
    maxBrowsingLevel: 3,
    domain: 'green',
  });
  return r.token;
}

function makeRes() {
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    headers,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json() {
      return res;
    },
    end() {
      return res;
    },
    setHeader(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    removeHeader() {
      return res;
    },
    writeHead() {
      return res;
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()];
    },
    on() {
      return res;
    },
  };
  return res;
}

async function call(origin: string) {
  const token = await mintToken();
  const route = withBlockScope(
    (async (_req: NextApiRequest, res: NextApiResponse) => {
      res.setHeader('Retry-After', '17');
      res.status(429).json({ code: 'TOO_MANY_REQUESTS' });
    }) as never,
    { endpoint: 'models', allowOpaqueOrigin: true }
  );
  const res = makeRes();
  await route(
    {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${token}` },
      query: {},
      url: '/api/v1/blocks/models',
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    res as never
  );
  return res;
}

beforeEach(() => {
  _internalsForTests.resetOriginCache();
  dbMock.dbRead.oauthClient.findMany.mockResolvedValue([{ allowedOrigins: [ALLOWED_ORIGIN] }]);
});

describe('block CORS exposes Retry-After', () => {
  it('on an allowlisted origin', async () => {
    const res = await call(ALLOWED_ORIGIN);
    expect(res.statusCode).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('on the opted-in opaque origin', async () => {
    const res = await call('null');
    expect(res.statusCode).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('INVARIANT GUARD: not on an unrecognised origin, which gets no block CORS', async () => {
    const res = await call('https://not-listed.example');
    expect(res.statusCode).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });
});
