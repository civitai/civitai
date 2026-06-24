import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Handler-level coverage for GET /api/v1/blocks/submissions — the token-auth,
 * SELF-SCOPED submission-status read that unblocks `civitai app status`.
 *
 * Asserts the security-sensitive invariants:
 *   - auth: missing/invalid key → 401; un-scoped OAuth → 403; scoped OAuth
 *     (AppBlocksSubmit) → allowed.
 *   - gate: non-mod → 403; banned → 403; flag off → 503 (dark).
 *   - SELF-SCOPING (the crux): the DB query is ALWAYS filtered to the caller's
 *     `submittedByUserId`; user A cannot read user B's rows by listing OR by id.
 *   - happy path: returns the caller's rows newest-first with the safe shape
 *     (+ liveUrl only when serving), no-store header.
 *   - single-item: `?id=` not-owned → 404 (no ownership oracle).
 *   - rate-limit exceeded → 429; malformed limiter / redis incident → 503.
 *   - 405 for non-GET.
 */

function createMocks({
  method = 'GET',
  headers = {},
  query = {},
}: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const req = {
    method,
    headers,
    query,
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
  mockFindMany,
  mockFindFirst,
  mockSysRedis,
  mockMultiIncr,
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
  return {
    mockGetSession: vi.fn(),
    mockIsAppBlocksEnabled: vi.fn(),
    mockFindMany: vi.fn(),
    mockFindFirst: vi.fn(),
    mockSysRedis: {
      multi: vi.fn(multiFactory),
      ttl: vi.fn().mockResolvedValue(60),
      expire: vi.fn().mockResolvedValue(1),
    },
    mockMultiIncr,
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksEnabled: mockIsAppBlocksEnabled }));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlockPublishRequest: { findMany: mockFindMany, findFirst: mockFindFirst } },
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { SUBMISSIONS_RATE_LIMIT: 'system:blocks:submissions-rate-limit' } },
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));

import handler from '~/pages/api/v1/blocks/submissions';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER_ID = 7;

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

function dbRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pubreq_01',
    appBlockId: 'apb_abc',
    slug: 'my-page-app',
    version: '0.1.0',
    status: 'approved',
    rejectionReason: null,
    approvalNotes: null,
    deployState: 'live',
    deployDetail: null,
    deployUpdatedAt: new Date('2026-06-22T00:00:00Z'),
    submittedAt: new Date('2026-06-20T00:00:00Z'),
    reviewedAt: new Date('2026-06-21T00:00:00Z'),
    updatedAt: new Date('2026-06-22T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  mockMultiIncr.malformedExec = false;
  mockMultiIncr.throwExec = false;
  mockSysRedis.ttl.mockResolvedValue(60);
  mockSysRedis.expire.mockResolvedValue(1);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockFindMany.mockResolvedValue([dbRow()]);
  mockFindFirst.mockResolvedValue(dbRow());
});

function authGet(query: Record<string, string> = {}) {
  return createMocks({ headers: { authorization: 'Bearer personal-key' }, query });
}

describe('GET /api/v1/blocks/submissions', () => {
  it('405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it('401 when Authorization header is missing', async () => {
    const { req, res } = createMocks({});
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('401 when the bearer key does not resolve to a session', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('403 when the OAuth token lacks the AppBlocksSubmit scope', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_UNSCOPED_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('submit scope');
    // Rejected before flag / db — no leak.
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('allows a scoped OAuth token (AppBlocksSubmit) — same token that submitted can read', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_SCOPED_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { submittedByUserId: OWNER_ID } })
    );
  });

  it('403 when the resolved user is NOT a moderator', async () => {
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('403 when the mod is banned', async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: OWNER_ID, isModerator: true, bannedAt: new Date() },
      apiKeyId: 44,
      subject: { type: 'apiKey', id: 44 },
    });
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('503 (dark) when the App Blocks flag is OFF for the user', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('SELF-SCOPING: list query is ALWAYS filtered to the caller submittedByUserId', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const arg = mockFindMany.mock.calls[0][0];
    // The ownership-deciding clause is present and equal to the caller.
    expect(arg.where.submittedByUserId).toBe(OWNER_ID);
    // Newest-first, bounded.
    expect(arg.orderBy).toEqual({ submittedAt: 'desc' });
    expect(arg.take).toBe(100);
  });

  it('CROSS-USER ISOLATION: user A cannot read user B by listing — query filters on A only', async () => {
    // User A authenticates. Even though the DB mock would happily return any
    // rows, the handler must scope the WHERE to A's id, so B's rows are
    // unreachable. We assert on the query the handler issues (the real DB
    // enforces the filter).
    const USER_A = { ...MOD_SESSION, user: { id: 101, isModerator: true } };
    mockGetSession.mockResolvedValueOnce(USER_A);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { submittedByUserId: 101 } })
    );
    // No way for A to pass a userId that widens the scope (no such param exists).
  });

  it('CROSS-USER ISOLATION: ?id= for a not-owned submission → 404 (no ownership oracle)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    // Self-scoped findFirst finds nothing because the id belongs to user B.
    mockFindFirst.mockResolvedValueOnce(null);
    const { req, res } = authGet({ id: 'pubreq_owned_by_B' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    // The findFirst query must still carry the self-scope clause.
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { submittedByUserId: OWNER_ID, id: 'pubreq_owned_by_B' },
      })
    );
  });

  it('happy path: lists the caller rows with the safe shape + no-store header', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['Cache-Control']).toBe('no-store');
    const out = res._getJSONData() as { submissions: Array<Record<string, unknown>> };
    expect(Array.isArray(out.submissions)).toBe(true);
    const s = out.submissions[0];
    expect(s).toEqual({
      id: 'pubreq_01',
      blockId: 'my-page-app',
      appBlockId: 'apb_abc',
      version: '0.1.0',
      status: 'approved',
      rejectionReason: null,
      approvalNotes: null,
      deployState: 'live',
      deployDetail: null,
      deployUpdatedAt: '2026-06-22T00:00:00.000Z',
      submittedAt: '2026-06-20T00:00:00.000Z',
      reviewedAt: '2026-06-21T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
      createdAt: '2026-06-20T00:00:00.000Z',
      liveUrl: 'https://my-page-app.civit.ai/',
    });
    // No internal-only columns leaked.
    expect(s).not.toHaveProperty('bundleKey');
    expect(s).not.toHaveProperty('forgejoCommitSha');
    expect(s).not.toHaveProperty('submittedByUserId');
    expect(s).not.toHaveProperty('manifest');
  });

  it('liveUrl is null when the row is approved but not yet serving (deployState building)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([dbRow({ status: 'approved', deployState: 'building' })]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBeNull();
  });

  it('liveUrl is null for a pending (not-approved) submission', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([
      dbRow({ status: 'pending', deployState: null, reviewedAt: null }),
    ]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBeNull();
  });

  it('single-item by ?id= returns { submission } with the safe shape', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet({ id: 'pubreq_01' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const out = res._getJSONData() as { submission: { id: string; blockId: string } };
    expect(out.submission.id).toBe('pubreq_01');
    expect(out.submission.blockId).toBe('my-page-app');
  });

  it('?blockId= narrows the self-scoped list to one app (slug filter)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet({ blockId: 'my-page-app' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { submittedByUserId: OWNER_ID, slug: 'my-page-app' },
      })
    );
  });

  it('429 when the per-user rate limit is exceeded', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 61; // > RATE_LIMIT.max (60)
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBeDefined();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() is malformed', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.malformedExec = null;
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() THROWS (redis incident)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.throwExec = true;
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('self-heals a TTL-less rate-limit key (re-arms expiry when ttl < 0)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 2; // not first hit → self-heal branch runs
    mockSysRedis.ttl.mockResolvedValueOnce(-1); // key exists but lost its TTL
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSysRedis.expire).toHaveBeenCalledWith(
      'system:blocks:submissions-rate-limit:u:7',
      60
    );
  });
});
