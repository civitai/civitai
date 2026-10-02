import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import { IMAGE_IDS_BATCH_MAX } from '~/server/common/constants';

/**
 * ADAPTER-level coverage for `GET /api/v1/blocks/gated-images`.
 *
 * The shared body is MOCKED here, deliberately: this file tests that the route is
 * a faithful adapter and adds no decision of its own. What the body decides —
 * the anon refusal, the kill-switch, the maturity clamp, the app scoping — is
 * exercised for real, THROUGH THIS HANDLER, in
 * `gated-images-clamp.seam.test.ts`. Neither file is sufficient alone: this one
 * would pass with the clamp deleted, and that one would pass with the query
 * schema wide open.
 *
 * The four properties a consumer's correctness depends on:
 *   1. The route NEVER answers 200 with an empty envelope when the shared body
 *      throws. Every consumer of this surface maps a non-`visible` entry to a
 *      withheld tile — but an EMPTY list means "nothing to show", and
 *      `civitai-app-custom-generators` would silently render a board with no
 *      covers rather than surfacing an error.
 *   2. The body's result is passed through UNTOUCHED, `hidden` entries included.
 *      The whole point of the route is that `hidden` survives to the wire; an
 *      adapter that filtered it would reproduce the omission behaviour this route
 *      exists to avoid, with nothing failing.
 *   3. The `ids` bound is the bridge's bound, and an over-cap batch is a 400
 *      rather than a silent truncation.
 *   4. The claims stamped by `withBlockScope` — not anything from the request —
 *      are what reach the shared body.
 */

/**
 * The claims `withBlockScope` would have stamped. Set on the REQUEST by
 * `createMocks` rather than by the middleware mock, because these cases drive
 * `baseHandler` — the UNWRAPPED export — directly. Driving the wrapped default
 * export instead would put the mocked wrapper between the test and the assertion
 * for no gain: the wrapper's real behaviour is asserted from its options literal
 * in `gated-images-cors-wiring.test.ts`, which is the only place it can be.
 */
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

// Module-eval stub only: the route calls `withBlockScope` at import time to build
// its default export. It stamps nothing — see the note above.
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => handler,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockResolve, mockRateLimit, mockHandleEndpointError } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockRateLimit: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-gated-images-read.service', () => ({
  resolveGatedImagesForBlockClaims: mockResolve,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockRateLimit,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import { baseHandler } from '~/pages/api/v1/blocks/gated-images';

function fakeClaims(): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:29',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: 'app_a',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: [],
    maxBrowsingLevel: 3,
  } as unknown as BlockTokenClaims;
}

function createMocks({
  method = 'GET',
  query = { ids: '1,2' } as Record<string, unknown>,
}: { method?: string; query?: Record<string, unknown> } = {}) {
  const req = {
    method,
    query,
    // Exactly what `withBlockScope` stamps on a verified request.
    blockClaims: claimsBox.claims,
    headers: { authorization: 'Bearer tok_gated', host: 'civitai.test' },
    url: '/api/v1/blocks/gated-images',
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
      return res;
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

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockResolve.mockResolvedValue({ images: [] });
});

describe('GET /api/v1/blocks/gated-images — method and auth', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
    'refuses %s with 405 + Allow: GET',
    async (method) => {
      const { req, res } = createMocks({ method });
      await (baseHandler as any)(req, res);

      expect(res._status()).toBe(405);
      expect(res._headers().Allow).toBe('GET');
      expect(mockResolve).not.toHaveBeenCalled();
    }
  );

  it('answers 401 when no claims were stamped (defense in depth)', async () => {
    claimsBox.claims = undefined;

    const { req, res } = createMocks();
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/blocks/gated-images — input validation', () => {
  it.each([
    ['no ids at all', {}],
    ['an empty ids value', { ids: '' }],
    ['a non-numeric id', { ids: 'abc' }],
    ['a zero id', { ids: '0' }],
    ['a negative id', { ids: '-3' }],
    ['a fractional id', { ids: '1.5' }],
  ])('rejects %s with 400 and never calls the shared body', async (_label, query) => {
    const { req, res } = createMocks({ query: query as Record<string, unknown> });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('accepts exactly IMAGE_IDS_BATCH_MAX ids and rejects one more', async () => {
    // 🔴 BOTH SIDES OF THE BOUNDARY, and the over-cap side is the load-bearing
    // one: a schema that silently TRUNCATED instead of refusing would hand a grid
    // a short answer it would read as "these ids resolved, the rest did not" —
    // i.e. the omission semantics this route exists to avoid, arriving by the
    // back door.
    const atCap = Array.from({ length: IMAGE_IDS_BATCH_MAX }, (_, i) => i + 1).join(',');
    const overCap = `${atCap},${IMAGE_IDS_BATCH_MAX + 1}`;

    const ok = createMocks({ query: { ids: atCap } });
    await (baseHandler as any)(ok.req, ok.res);
    expect(ok.res._status()).toBe(200);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect((mockResolve.mock.calls[0][0] as any).imageIds).toHaveLength(IMAGE_IDS_BATCH_MAX);

    mockResolve.mockClear();
    const bad = createMocks({ query: { ids: overCap } });
    await (baseHandler as any)(bad.req, bad.res);
    expect(bad.res._status()).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/blocks/gated-images — delegation and pass-through', () => {
  it('hands the STAMPED CLAIMS and the parsed ids to the shared body, and nothing else', async () => {
    const { req, res } = createMocks({ query: { ids: '5,6,7' } });
    await (baseHandler as any)(req, res);

    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith({
      claims: claimsBox.claims,
      imageIds: [5, 6, 7],
    });
    expect(res._status()).toBe(200);
  });

  it('returns the body’s envelope VERBATIM — `hidden` entries reach the wire', async () => {
    // Property 2. An adapter that dropped or rewrote `hidden` would reproduce the
    // `/api/v1/blocks/images?ids=` omission behaviour with every other test green,
    // and a consumer could no longer tell a withheld image from a deleted one.
    const envelope = {
      images: [
        { imageId: 5, status: 'visible', url: 'https://edge/x', width: 1, height: 2, nsfwLevel: 1 },
        { imageId: 6, status: 'hidden' },
      ],
    };
    mockResolve.mockResolvedValue(envelope);

    const { req, res } = createMocks({ query: { ids: '5,6,7' } });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(200);
    // Deep-equal against the exact object, so a field added, renamed or filtered
    // on the way out fails — not merely a spot-check of the one field we expected
    // to be at risk.
    expect(res._json()).toEqual(envelope);
    // And id 7, which the body omitted, is STILL omitted — the route invents no
    // placeholder entry for an unresolvable id.
    expect((res._json() as any).images.map((i: any) => i.imageId)).toEqual([5, 6]);
  });

  it('REJECTS on a body failure — never 200 with an empty envelope', async () => {
    // Property 1. This asserts IDENTITY, so any code passes — which is how a code
    // the body never throws survives here. Use one it does.
    const failure = new TRPCError({ code: 'UNAUTHORIZED', message: 'nope' });
    mockResolve.mockRejectedValue(failure);

    const { req, res } = createMocks();
    await (baseHandler as any)(req, res);

    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    expect(mockHandleEndpointError.mock.calls[0][1]).toBe(failure);
    // The handler did not additionally answer 200 with an empty list.
    expect(res._json()).toBeUndefined();
  });
});

describe('GET /api/v1/blocks/gated-images — rate limiting', () => {
  it('sheds with 429 + Retry-After from the limiter, before the read', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 4 });

    const { req, res } = createMocks();
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBe('4');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('charges the CATALOG bucket on the token’s blockInstanceId — the bridge’s key', async () => {
    // Same bucket, same key as `blocks.getImagesByIds`, so porting an app from the
    // bridge to REST does not hand it a second allowance.
    const { req, res } = createMocks();
    await (baseHandler as any)(req, res);

    expect(mockRateLimit).toHaveBeenCalledWith('bki');
  });
});
