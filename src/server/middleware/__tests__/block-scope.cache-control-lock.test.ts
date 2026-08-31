import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module
// load (same posture as block-scope.anytoken-mode.test.ts).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The block API's response-cache isolation contract.
 *
 * A block-JWT request carries a per-viewer identity in its claims, so its
 * response must never be storable by any shared cache. The middleware
 * enforces that by forcing
 *
 *   Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0
 *
 * and by owning that header: an `ownedHeaders` interceptor drops any later
 * attempt by the wrapped handler to change it. That interception is not
 * defensive paranoia — the wrapped handlers are ordinary
 * PublicEndpoint/AuthedEndpoint routes that run their own
 * `addPublicCacheHeaders`, so a handler setting a public Cache-Control is
 * the NORMAL case on this path, not a hypothetical.
 *
 * Why the assertions below pin the WHOLE header string rather than a
 * substring: a shared cache's storage decision is made from the directive
 * SET, so any check that passes on a partial match can be satisfied by a
 * value that is still storable. `Vary` is not a substitute — it is
 * unreliable across CDNs and must never be treated as the isolation
 * mechanism. Treat this header as the contract, and do not weaken it in
 * favour of a caching win without replacing the guarantee first.
 *
 * So: assert the exact normalised string, and assert each of the three
 * override vectors the middleware wraps (setHeader / removeHeader /
 * writeHead) is actually neutralised.
 */

const BLOCK_CACHE_CONTROL = 'private, no-store, no-cache, must-revalidate, max-age=0';

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

async function mintToken(scopes: string[] = []): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: 42,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    scopes,
    ctx: { modelId: 1 },
    maxBrowsingLevel: 3,
    domain: 'green',
  });
  return r.token;
}

/**
 * A response double that HONOURS removeHeader and writeHead.
 *
 * This is load-bearing, and it is why this file does not reuse the fake in
 * the sibling tests: there, `removeHeader()` and `writeHead()` are no-ops
 * that never touch the header bag. Against such a fake, "the handler could
 * not strip the header" passes whether or not the middleware's lock exists
 * — the fake encodes the same assumption as the code under test, so the
 * assertion is unfalsifiable.
 *
 * `describe('the response double itself')` below proves this fake CAN
 * express the failure, before any test relies on it not happening.
 */
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
    removeHeader(k: string) {
      delete this.headers[k.toLowerCase()];
      return this;
    },
    writeHead(statusCode: number, ...rest: unknown[]) {
      this.statusCode = statusCode;
      for (const arg of rest) {
        if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
        for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
          this.headers[k.toLowerCase()] = v;
        }
      }
      return this;
    },
    getHeader(k: string) {
      return this.headers[k.toLowerCase()];
    },
    // Success path registers a fire-and-forget res.on('finish', …) logger.
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, unknown>;
  };
}

function makeReq(authHeader: string): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: authHeader },
    query: {},
    url: '/api/v1/blocks/models',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

/** Drive the real middleware with a handler that mutates response headers. */
async function runWithHandler(handler: (req: NextApiRequest, res: NextApiResponse) => void) {
  const token = await mintToken();
  const wrapped = vi.fn(async (req: NextApiRequest, res: NextApiResponse) => {
    handler(req, res);
    res.status(200).json({ ok: true });
  });
  const route = withBlockScope(wrapped as never, { endpoint: 'models' });
  const res = makeRes();
  await route(makeReq(`Bearer ${token}`) as never, res as never);
  return { res, wrapped };
}

beforeEach(() => {
  isFliptMock.mockClear();
  isRevokedMock.mockClear();
  isRevokedMock.mockResolvedValue(false);
});

describe('the response double itself (fake-fidelity control)', () => {
  // Without these, every "the handler could not X" assertion below is
  // vacuous — a fake that cannot perform the attack cannot witness the
  // defence.
  it('removeHeader actually deletes, and writeHead actually merges a header bag', () => {
    const res = makeRes();
    res.setHeader('Cache-Control', 'seed');
    expect(res.headers['cache-control']).toBe('seed');

    res.removeHeader('Cache-Control');
    expect(res.headers['cache-control']).toBeUndefined();

    (res as unknown as { writeHead: (s: number, h: Record<string, string>) => void }).writeHead(
      200,
      { 'Cache-Control': 'from-writehead' }
    );
    expect(res.headers['cache-control']).toBe('from-writehead');
  });
});

describe('withBlockScope — Cache-Control is forced and locked', () => {
  it('sets the EXACT normalised Cache-Control on a block-JWT request', async () => {
    const { res, wrapped } = await runWithHandler(() => undefined);

    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    // Whole string, not a substring: a reworded-but-weaker value must fail.
    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
  });

  it('drops a handler setHeader that would make the response publicly cacheable', async () => {
    const { res } = await runWithHandler((_req, r) => {
      // Exactly what addPublicCacheHeaders does on a PublicEndpoint route.
      r.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    });

    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
  });

  it('drops a handler setHeader regardless of header-name casing', async () => {
    const { res } = await runWithHandler((_req, r) => {
      r.setHeader('CACHE-CONTROL', 'public, s-maxage=300');
      r.setHeader('cache-control', 'public, s-maxage=300');
    });

    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
  });

  it('drops a handler removeHeader that would strip the protection entirely', async () => {
    const { res } = await runWithHandler((_req, r) => {
      r.removeHeader('Cache-Control');
    });

    // Stripping is the worst case: no header at all means the edge applies
    // its own heuristics to an authenticated, per-viewer response.
    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
  });

  it('filters Cache-Control out of a writeHead header bag (2-arg form)', async () => {
    const { res } = await runWithHandler((_req, r) => {
      (r as unknown as { writeHead: (s: number, h: Record<string, string>) => void }).writeHead(
        200,
        { 'Cache-Control': 'public, max-age=600', 'X-Passthrough': 'kept' }
      );
    });

    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
    // Positive control: the interceptor filters ONLY owned keys. Without
    // this, a writeHead wrapper that dropped its bag wholesale would pass
    // the assertion above for the wrong reason.
    expect(res.headers['x-passthrough']).toBe('kept');
  });

  it('filters Cache-Control out of a writeHead header bag (3-arg form)', async () => {
    const { res } = await runWithHandler((_req, r) => {
      (
        r as unknown as {
          writeHead: (s: number, m: string, h: Record<string, string>) => void;
        }
      ).writeHead(200, 'OK', { 'Cache-Control': 'public, max-age=600', 'X-Also': 'kept' });
    });

    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
    expect(res.headers['x-also']).toBe('kept');
  });

  it('also owns Vary, so a handler cannot re-point the edge cache key', async () => {
    const { res } = await runWithHandler((_req, r) => {
      r.setHeader('Vary', 'Authorization');
    });

    // Vary is owned by the middleware, so the handler's value does not
    // land. This is defence in depth only — see the file header on why
    // Vary must never be relied on as the isolation mechanism.
    expect(res.headers['vary']).not.toBe('Authorization');
  });

  it('lets non-owned headers set by the handler through untouched', async () => {
    // The overall positive control for the interceptor: it must be a
    // filter, not a blanket block. If this fails, every assertion above
    // could be passing simply because nothing the handler writes lands.
    const { res } = await runWithHandler((_req, r) => {
      r.setHeader('Content-Type', 'application/json');
      r.setHeader('ETag', 'W/"abc123"');
    });

    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['etag']).toBe('W/"abc123"');
    expect(res.headers['cache-control']).toBe(BLOCK_CACHE_CONTROL);
  });
});
