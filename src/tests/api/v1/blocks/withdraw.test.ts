import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Handler-level coverage for POST /api/v1/blocks/withdraw — the token-auth,
 * SELF-SCOPED submission withdrawal that unblocks `civitai app withdraw`
 * (cli #29). It exposes the already-ownership-safe `withdrawRequest` service to
 * a bearer key, mirroring submissions.ts's auth posture.
 *
 * Asserts the security-sensitive invariants:
 *   - auth: missing/invalid key → 401; un-scoped OAuth → 403; scoped OAuth
 *     (AppBlocksSubmit) → allowed.
 *   - gate: non-mod → 403; banned → 403; flag off → 503 (dark).
 *   - body: malformed / missing publishRequestId → 400.
 *   - SELF-SCOPING (the crux): `withdrawRequest` is always called with the
 *     caller's `user.id`; a not-found AND a not-owned id both collapse to the
 *     SAME 404 (no ownership oracle).
 *   - non-pending row → 409 (the caller's own row, status disclosed to owner).
 *   - happy path → 200 { ok: true }; idempotent re-withdraw → 200.
 *   - rate-limit exceeded → 429; malformed limiter / redis incident → 503.
 *   - 405 for non-POST.
 */

function createMocks({
  method = 'POST',
  headers = {},
  body = {},
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const req = {
    method,
    headers,
    body,
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const responseHeaders: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(key: string, value: string) {
      responseHeaders[key] = value;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeaders: () => responseHeaders,
  };
  return { req, res };
}

const {
  mockGetSession,
  mockIsAppBlocksEnabled,
  mockWithdrawRequest,
  mockSysRedis,
  mockMultiIncr,
  WithdrawRequestError,
} = vi.hoisted(() => {
  const mockMultiIncr = {
    value: 1,
    malformedExec: false as unknown[] | null | false,
    throwExec: false,
  };
  const multiFactory = () => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockImplementation(async () => {
      if (mockMultiIncr.throwExec) throw new Error('redis down');
      return mockMultiIncr.malformedExec !== false
        ? mockMultiIncr.malformedExec
        : ['OK', mockMultiIncr.value];
    }),
  });
  // A faithful stand-in for the service's typed error so the handler's
  // `err instanceof WithdrawRequestError` + `.code` switch is exercised against
  // the REAL discriminant (not a substring). Mirrors the service shape. Defined
  // inside vi.hoisted so it exists when the (hoisted) vi.mock factory runs.
  class WithdrawRequestError extends Error {
    code: 'NOT_FOUND' | 'NOT_OWNED' | 'NOT_PENDING';
    constructor(code: 'NOT_FOUND' | 'NOT_OWNED' | 'NOT_PENDING', message: string) {
      super(message);
      this.name = 'WithdrawRequestError';
      this.code = code;
    }
  }
  return {
    mockGetSession: vi.fn(),
    mockIsAppBlocksEnabled: vi.fn(),
    mockWithdrawRequest: vi.fn(),
    mockSysRedis: {
      multi: vi.fn(multiFactory),
      ttl: vi.fn().mockResolvedValue(60),
      expire: vi.fn().mockResolvedValue(1),
    },
    mockMultiIncr,
    WithdrawRequestError,
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksEnabled: mockIsAppBlocksEnabled }));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  withdrawRequest: mockWithdrawRequest,
  WithdrawRequestError,
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { WITHDRAW_RATE_LIMIT: 'system:blocks:withdraw-rate-limit' } },
}));

import handler from '~/pages/api/v1/blocks/withdraw';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER_ID = 7;
const PUBREQ = 'pubreq_01';

// Personal-access (user-type) key + moderator.
const MOD_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 42,
  subject: { type: 'apiKey', id: 42 },
  tokenScope: TokenScope.Full,
};
const NONMOD_SESSION = {
  user: { id: 8, isModerator: false },
  apiKeyId: 43,
  subject: { type: 'apiKey', id: 43 },
  tokenScope: TokenScope.Full,
};
// An OAuth-client token WITHOUT the AppBlocksSubmit bit (TokenScope.Full excludes it).
const OAUTH_UNSCOPED_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'client_abc' },
  tokenScope: TokenScope.Full,
};
// An OAuth-client token that carries the dedicated AppBlocksSubmit bit (the
// first-party civitai-cli client).
const OAUTH_SCOPED_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 100,
  subject: { type: 'oauth', id: 'civitai-cli' },
  tokenScope: TokenScope.UserRead | TokenScope.AppBlocksSubmit,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  mockMultiIncr.malformedExec = false;
  mockMultiIncr.throwExec = false;
  mockSysRedis.ttl.mockResolvedValue(60);
  mockSysRedis.expire.mockResolvedValue(1);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockWithdrawRequest.mockResolvedValue(undefined);
});

function authPost(body: unknown = { publishRequestId: PUBREQ }) {
  return createMocks({ headers: { authorization: 'Bearer personal-key' }, body });
}

describe('POST /api/v1/blocks/withdraw', () => {
  it('405 for non-POST', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('401 when Authorization header is missing', async () => {
    const { req, res } = createMocks({ body: { publishRequestId: PUBREQ } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('401 when the bearer key does not resolve to a session', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('403 when the OAuth token lacks the AppBlocksSubmit scope', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_UNSCOPED_SESSION);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('submit scope');
    // Rejected before flag / service — no leak.
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('allows a scoped OAuth token (AppBlocksSubmit) — same token that submitted can withdraw', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_SCOPED_SESSION);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockWithdrawRequest).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      userId: OWNER_ID,
    });
  });

  it('403 when the resolved user is NOT a moderator', async () => {
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('403 when the mod is banned', async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: OWNER_ID, isModerator: true, bannedAt: new Date() },
      apiKeyId: 44,
      subject: { type: 'apiKey', id: 44 },
    });
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('503 (dark) when the App Blocks flag is OFF for the user', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('400 when the body is missing publishRequestId', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({});
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('400 when publishRequestId is an empty string', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({ publishRequestId: '' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('SELF-SCOPING: withdrawRequest is ALWAYS called with the caller user.id', async () => {
    const USER_A = { ...MOD_SESSION, user: { id: 101, isModerator: true } };
    mockGetSession.mockResolvedValueOnce(USER_A);
    const { req, res } = authPost({ publishRequestId: 'pubreq_x' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockWithdrawRequest).toHaveBeenCalledWith({
      publishRequestId: 'pubreq_x',
      userId: 101,
    });
  });

  it('404 when the publish request does not exist (NOT_FOUND code, no ownership oracle)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockWithdrawRequest.mockRejectedValueOnce(
      new WithdrawRequestError('NOT_FOUND', 'publish request pubreq_01 not found')
    );
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    expect((res._getJSONData() as { message: string }).message).toBe('Publish request not found');
  });

  it('404 when the publish request is NOT_OWNED — identical body to NOT_FOUND (no oracle)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockWithdrawRequest.mockRejectedValueOnce(
      new WithdrawRequestError('NOT_OWNED', 'you can only withdraw your own publish requests')
    );
    const { req, res } = authPost();
    await handler(req as never, res as never);
    // SAME status AND SAME body as the NOT_FOUND case — a caller cannot tell
    // "exists but someone else's" from "doesn't exist". Mapped by CODE, not by
    // substring-matching the service message.
    expect(res._getStatusCode()).toBe(404);
    expect((res._getJSONData() as { message: string }).message).toBe('Publish request not found');
  });

  it('409 { message } when the request is not pending (NOT_PENDING code) — disclosed to owner', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockWithdrawRequest.mockRejectedValueOnce(
      new WithdrawRequestError('NOT_PENDING', 'cannot withdraw a request in status approved')
    );
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(409);
    // N3 fix: the endpoint ALWAYS returns `{ message }` on error (was `{ error }`).
    expect((res._getJSONData() as { message: string }).message).toBe(
      'cannot withdraw a request in status approved'
    );
    expect((res._getJSONData() as Record<string, unknown>).error).toBeUndefined();
  });

  it('200 { ok: true } on the happy path + no-store header', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ ok: true });
    expect(res._getHeaders()['Cache-Control']).toBe('no-store');
    expect(mockWithdrawRequest).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      userId: OWNER_ID,
    });
  });

  it('200 { ok: true } on an idempotent re-withdraw (service is a no-op)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    // The service resolves (returns) for an already-withdrawn row.
    mockWithdrawRequest.mockResolvedValueOnce(undefined);
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ ok: true });
  });

  it('500 on an unexpected service error', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockWithdrawRequest.mockRejectedValueOnce(new Error('db connection lost'));
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(500);
  });

  it('429 when the per-user rate limit is exceeded', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 31; // > RATE_LIMIT.max (30)
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBeDefined();
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() is malformed', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.malformedExec = null;
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() THROWS (redis incident)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.throwExec = true;
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockWithdrawRequest).not.toHaveBeenCalled();
  });

  it('self-heals a TTL-less rate-limit key (re-arms expiry when ttl < 0)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 2; // not first hit → self-heal branch runs
    mockSysRedis.ttl.mockResolvedValueOnce(-1); // key exists but lost its TTL
    const { req, res } = authPost();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSysRedis.expire).toHaveBeenCalledWith('system:blocks:withdraw-rate-limit:u:7', 60);
  });
});
