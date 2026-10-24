import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/buzz (per-pool balance readout).
 *
 * Exercises the method guard, the missing-claims 401, both 403 subject gates
 * (unparseable subject / anonymous subject), the self-bound read itself, and the
 * 502 on a buzz-service failure. The withBlockScope opts are captured and
 * asserted too, so the scope/endpoint/CORS declaration cannot silently drift —
 * `scoped-endpoints-cors-wiring.test.ts` guards the same thing across the whole
 * scoped set.
 *
 * 🔴 THE SHAPE ASSERTION IS THE POINT OF THIS FILE. The response must match
 * `blocks.getMyBuzzBalance` (the page-host bridge `useBuzzBalance()` reads)
 * field for field: a BARE `{ blue, green, yellow }`, each a number, missing pool
 * defaulted to 0, and NO other key — so a consumer can move between the two
 * transports without a shape change. The three fixture values below are
 * pairwise-distinct AND distinct from 0 on purpose: a handler that transposed
 * two pools, or that hardcoded the `?? 0` default, would still be green against
 * equal or zero fixtures.
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

// Capture the withBlockScope opts so the scope/endpoint/CORS declaration is
// asserted here too. Hoisted so it exists before the (hoisted) vi.mock factory
// runs — the endpoint's `export default withBlockScope(...)` touches it during
// module load.
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

const { mockAccounts } = vi.hoisted(() => ({ mockAccounts: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: mockAccounts }));

import handler from '~/pages/api/v1/blocks/buzz';

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
    scopes: ['buzz:read:self'],
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  // Pairwise-distinct, all non-zero, none equal to the subject id — see the
  // docblock. `getUserBuzzAccounts` returns a Record<BuzzSpendType, number>, and
  // it carries pools beyond the three the response projects to.
  mockAccounts.mockResolvedValue({ blue: 11, green: 222, yellow: 3333 });
});

describe('GET /api/v1/blocks/buzz', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it('403 for an unparseable subject claim', async () => {
    claimsBox.claims = fakeClaims({ sub: 'not-a-subject' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(res._json()).toEqual({ error: 'Invalid subject claim' });
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it('403 for an anonymous token (no "self" balance)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it('200: returns the subject-bound { blue, green, yellow } balance, matching the bridge', async () => {
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    // toEqual pins the WHOLE object: an extra key (a leaked `red`, a stray
    // `balance` from the pre-restoration shape) fails here.
    expect(res._json()).toEqual({ blue: 11, green: 222, yellow: 3333 });
    // Keyed on the verified subject (42), never client input.
    expect(mockAccounts).toHaveBeenCalledWith({ userId: 42 });
  });

  it('200: projects away the non-spendable pools the bridge omits', async () => {
    mockAccounts.mockResolvedValueOnce({
      blue: 11,
      green: 222,
      yellow: 3333,
      red: 44444,
      creatorProgramBank: 555555,
      cashSettled: 6666666,
    });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ blue: 11, green: 222, yellow: 3333 });
  });

  it('200: a missing pool reads as 0, not undefined (bridge parity)', async () => {
    mockAccounts.mockResolvedValueOnce({ yellow: 3333 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as Record<string, unknown>;
    expect(body).toEqual({ blue: 0, green: 0, yellow: 3333 });
    // `toEqual` treats a missing key and an explicit `undefined` alike, so pin
    // the keys are actually PRESENT — the consumer reads numbers, not holes.
    expect(Object.keys(body).sort()).toEqual(['blue', 'green', 'yellow']);
  });

  it('200: a genuine zero balance is preserved, not confused with a missing pool', async () => {
    mockAccounts.mockResolvedValueOnce({ blue: 0, green: 222, yellow: 3333 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._json()).toEqual({ blue: 0, green: 222, yellow: 3333 });
  });

  it('502 when the balance service throws', async () => {
    mockAccounts.mockRejectedValueOnce(new Error('buzz down'));
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(502);
    expect(res._json()).toEqual({ error: 'Failed to read balance' });
  });

  it('declares the scope, endpoint label and opaque-origin opt-in', () => {
    expect(capturedOpts.opts).toEqual({
      endpoint: 'buzz',
      requiredScope: 'buzz:read:self',
      allowOpaqueOrigin: true,
    });
  });
});
