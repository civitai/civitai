import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/shared-storage/vote.
 *
 * The authorization ladder — write-scope, anon refusal, min-trust gate, and the
 * per-(user, app) per-minute VOTE bucket this op spends — lives in
 * `voteSharedRow` and is pinned in `apps-shared.router.test.ts`, including a
 * block that calls that function with a bare bearer, which is exactly the shape
 * this route uses. Here: method guard, body shape, bearer + key passthrough, the
 * audit stash, and delegation of failures to the shared chokepoint.
 */

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  authorization = 'Bearer tok_vote',
}: { method?: string; body?: unknown; authorization?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url: '/api/v1/blocks/shared-storage/vote',
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

const { mockVote, mockHandleEndpointError } = vi.hoisted(() => ({
  mockVote: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  voteSharedRow: mockVote,
  SHARED_KEY_MAX: 64,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/vote';

const KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';
// Non-zero and not equal to any bound in this file, so a hardcoded 0 or a
// transposed constant fails rather than passing on a coincidence.
const COUNT = 17;

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
  mockVote.mockResolvedValue({ count: COUNT });
});

describe('POST /api/v1/blocks/shared-storage/vote', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET', body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockVote).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockVote).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token + the key down and returns the new tally', async () => {
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockVote).toHaveBeenCalledWith('tok_vote', KEY);
    expect(res._json()).toEqual({ count: COUNT });
  });

  it('🔴 the RAW vote rows are never in the response — only the aggregate', async () => {
    // The router never returns them; this pins that the route does not enrich the
    // body on the way out either. `votes` being unlistable is a design invariant
    // of the whole shared surface, not a property of one query.
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(Object.keys(res._json() as object)).toEqual(['count']);
  });

  it('400 for a missing body, a missing key and an empty key', async () => {
    for (const body of [undefined, {}, { key: '' }]) {
      const { req, res } = createMocks({ body });
      await handler(req as never, res as never);
      expect(res._status(), JSON.stringify(body)).toBe(400);
    }
    expect(mockVote).not.toHaveBeenCalled();
  });

  it('400 for an over-long key — the bound bites at 65, not 64', async () => {
    const a = createMocks({ body: { key: 'k'.repeat(65) } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(400);
    expect(mockVote).not.toHaveBeenCalled();

    const ok = 'k'.repeat(64);
    const b = createMocks({ body: { key: ok } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(200);
    expect(mockVote).toHaveBeenCalledWith('tok_vote', ok);
  });

  it('stashes the audit detail with the voted key', async () => {
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(mockStash).toHaveBeenCalledWith(res, {
      action: 'shared.vote',
      key: KEY,
      outcome: 'ok',
    });
  });

  it('a throwing audit stash does NOT change the 200 — the tally already moved', async () => {
    mockStash.mockImplementationOnce(() => {
      throw new Error('stash exploded');
    });
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ count: COUNT });
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('a failure goes to the shared error chokepoint, not a body built here', async () => {
    const boom = new Error('relation "app_voting.votes" does not exist');
    mockVote.mockRejectedValueOnce(boom);
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
    expect(mockStash).not.toHaveBeenCalled();
  });
});
