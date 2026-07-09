import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Decision 4 — JWKS runtime gate.
 *
 * GET /api/v1/block-tokens/jwks serves the public RSA key(s) used to VERIFY
 * already-minted block JWTs. After Decision 4 this endpoint gates on the
 * dedicated GLOBAL `app-blocks-runtime-enabled` flag (NOT the mod-segmented
 * `app-blocks-enabled` user flag, whose global eval is always false → the
 * endpoint was permanently dark).
 *
 * Asserted contract:
 *   - runtime flag OFF / absent → 503 (stays dark — the exact prior behaviour);
 *   - runtime flag ON → serves the keys (200, JWKS body);
 *   - the endpoint reads the LITERAL 'app-blocks-runtime-enabled' key and NEVER
 *     'app-blocks-enabled' (no accidental repoint / widening).
 *
 * `isFlipt` is mocked PER-KEY so each branch can be driven independently and the
 * key the handler reads can be asserted exactly.
 */

const { mockFlipt, mockGetJwks, isFliptMock } = vi.hoisted(() => {
  // Per-key flag state. Only the runtime key gates this endpoint.
  const mockFlipt = { runtime: false, user: false };
  return {
    mockFlipt,
    mockGetJwks: vi.fn(() => ({
      keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'kid-test', n: 'n', e: 'AQAB' }],
    })),
    // Per-key Flipt stand-in: the runtime key reflects mockFlipt.runtime, the
    // user key reflects mockFlipt.user, everything else false. Proves that
    // turning the USER flag on does NOT serve the keys, and that the handler
    // only ever reads the runtime key.
    isFliptMock: vi.fn(async (flag: string) => {
      if (flag === 'app-blocks-runtime-enabled') return mockFlipt.runtime;
      if (flag === 'app-blocks-enabled') return mockFlipt.user;
      return false;
    }),
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: {
    BLOCK_TOKEN_PUBLIC_KEY: 'fake-public',
  },
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));

vi.mock('~/server/services/block-token.service', () => ({
  BlockTokenService: { getJwks: mockGetJwks },
}));

import handler from '~/pages/api/v1/block-tokens/jwks';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

function makeReq(): NextApiRequest {
  return { method: 'GET', headers: {} } as unknown as NextApiRequest;
}

beforeEach(() => {
  mockFlipt.runtime = false;
  mockFlipt.user = false;
  isFliptMock.mockClear();
  mockGetJwks.mockClear();
});

describe('GET /api/v1/block-tokens/jwks — Decision 4 runtime gate', () => {
  it('stays DARK (503) when the runtime flag is OFF — even if the USER flag is ON', async () => {
    mockFlipt.runtime = false;
    mockFlipt.user = true; // the user flag being on must NOT serve the keys
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Apps are not enabled' });
    // It must never have served a key.
    expect(mockGetJwks).not.toHaveBeenCalled();
    // It read the runtime key, NOT the user key.
    expect(isFliptMock).toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(isFliptMock).not.toHaveBeenCalledWith('app-blocks-enabled');
  });

  it('FAIL-SAFE: 503 when the runtime flag is ABSENT (isFlipt → false)', async () => {
    // mockFlipt.runtime defaults false (== flag absent / Flipt down).
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(mockGetJwks).not.toHaveBeenCalled();
  });

  it('serves the JWKS keys (200) when the runtime flag is ON', async () => {
    mockFlipt.runtime = true;
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // Non-vacuous: the served body is the JWKS the service produced.
    const parsed = JSON.parse(res.body as string) as {
      keys: Array<{ kid: string; alg: string }>;
    };
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]).toMatchObject({ kid: 'kid-test', alg: 'RS256' });
    expect(mockGetJwks).toHaveBeenCalledTimes(1);
    // It read the runtime key, NOT the user key.
    expect(isFliptMock).toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(isFliptMock).not.toHaveBeenCalledWith('app-blocks-enabled');
  });
});
