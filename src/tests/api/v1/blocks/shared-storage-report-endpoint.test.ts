import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/shared-storage/report.
 *
 * The authorization ladder — the WRITE scope (a report creates a row and raises
 * an alert, so it is not a read), the anon refusal, the min-trust gate and the
 * per-(user, app) daily report bucket — lives in `reportSharedRow` and is pinned
 * in `apps-shared.router.test.ts`, including a block that calls that function
 * with a bare bearer, which is exactly the shape this route uses. Here: method
 * guard, body shape, bearer + key + reason passthrough, the audit stash, and
 * delegation of failures to the shared chokepoint.
 */

function createMocks({
  method = 'POST',
  body = undefined as unknown,
  authorization = 'Bearer tok_report',
}: { method?: string; body?: unknown; authorization?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    url: '/api/v1/blocks/shared-storage/report',
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

const { mockReport, mockHandleEndpointError } = vi.hoisted(() => ({
  mockReport: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  reportSharedRow: mockReport,
  SHARED_KEY_MAX: 64,
  SHARED_REASON_MAX: 500,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/report';

const KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';
const REASON = 'duplicate of an existing request';

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
  mockReport.mockResolvedValue({ ok: true });
});

describe('POST /api/v1/blocks/shared-storage/report', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET', body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token, the key and the REASON down IN THAT ORDER', async () => {
    // All three are distinct non-empty strings, so a transposition (reason passed
    // as key) fails here rather than filing a report against the wrong row.
    const { req, res } = createMocks({ body: { key: KEY, reason: REASON } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockReport).toHaveBeenCalledWith('tok_report', KEY, REASON);
    expect(res._json()).toEqual({ ok: true });
  });

  it('an omitted reason is passed as undefined — the ROUTER owns the default', async () => {
    // Not defaulted here, deliberately: two surfaces defaulting the same field
    // independently is how they drift, and the tRPC twin has no way to inherit a
    // default written in a REST route.
    const { req, res } = createMocks({ body: { key: KEY } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockReport).toHaveBeenCalledWith('tok_report', KEY, undefined);
  });

  it('400 for a missing body, a missing key and an empty key', async () => {
    for (const body of [undefined, {}, { key: '' }, { reason: REASON }]) {
      const { req, res } = createMocks({ body });
      await handler(req as never, res as never);
      expect(res._status(), JSON.stringify(body)).toBe(400);
    }
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('400 for an over-long key (>64) and an over-long reason (>500)', async () => {
    // Two DIFFERENT bounds on one route; asserting only one would leave the other
    // free to be absent. Both are checked at their own boundary.
    const a = createMocks({ body: { key: 'k'.repeat(65) } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(400);

    const b = createMocks({ body: { key: KEY, reason: 'r'.repeat(501) } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(400);

    expect(mockReport).not.toHaveBeenCalled();

    const c = createMocks({ body: { key: 'k'.repeat(64), reason: 'r'.repeat(500) } });
    await handler(c.req as never, c.res as never);
    expect(c.res._status()).toBe(200);
  });

  it('stashes the reported key — and NOT the caller-supplied reason text', async () => {
    // `detail` stores ids, never user-authored prose; the reason is already on
    // the shared_kv_reports row a moderator reads.
    const { req, res } = createMocks({ body: { key: KEY, reason: REASON } });
    await handler(req as never, res as never);
    expect(mockStash).toHaveBeenCalledWith(res, {
      action: 'shared.report',
      key: KEY,
      outcome: 'ok',
    });
    expect(JSON.stringify(mockStash.mock.calls[0][1])).not.toContain(REASON);
  });

  it('a throwing audit stash does NOT change the 200 — the report is already filed', async () => {
    mockStash.mockImplementationOnce(() => {
      throw new Error('stash exploded');
    });
    const { req, res } = createMocks({ body: { key: KEY, reason: REASON } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ ok: true });
    expect(mockHandleEndpointError).not.toHaveBeenCalled();
  });

  it('a failure goes to the shared error chokepoint, not a body built here', async () => {
    const boom = new Error('relation "app_voting.shared_kv_reports" does not exist');
    mockReport.mockRejectedValueOnce(boom);
    const { req, res } = createMocks({ body: { key: KEY, reason: REASON } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
    expect(mockStash).not.toHaveBeenCalled();
  });
});
