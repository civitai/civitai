import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Handler-level coverage for POST /api/v1/blocks/dev-token — the dev/preview
 * block-token mint (scope doc: app-blocks-dev-token-endpoint-scope.md).
 *
 * Asserts the security-sensitive invariants:
 *   - mod + flag-on + owned approved page app → token with capped scopes/budget,
 *     forced-SFW maxBrowsingLevel, self-bound sub (userId), page ctx.
 *   - rejections: non-mod → 403, flag off → 503 (dark), not-owner → 404,
 *     OAuth (cookie/non-personal) key → 403, missing/invalid key → 401.
 *   - scope clamp: a scope outside the app's approved set OR in the dev-excluded
 *     list (social:tip:self / block:settings:*) is STRIPPED.
 *   - budget over the dev cap → capped.
 *   - rate-limit exceeded → 429; malformed limiter → 503 (fail closed).
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
  mockSign,
  mockAppBlockFindUnique,
  mockSysRedis,
  mockMultiIncr,
} = vi.hoisted(() => {
  const mockMultiIncr = { value: 1, malformedExec: false as unknown[] | null | false };
  const multiFactory = () => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockImplementation(async () =>
      mockMultiIncr.malformedExec !== false ? mockMultiIncr.malformedExec : ['OK', mockMultiIncr.value]
    ),
  });
  return {
    mockGetSession: vi.fn(),
    mockIsAppBlocksEnabled: vi.fn(),
    mockSign: vi.fn(),
    mockAppBlockFindUnique: vi.fn(),
    mockSysRedis: { multi: vi.fn(multiFactory), ttl: vi.fn().mockResolvedValue(60) },
    mockMultiIncr,
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksEnabled: mockIsAppBlocksEnabled }));
vi.mock('~/server/services/block-token.service', () => ({
  BlockTokenService: { sign: mockSign },
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: { appBlock: { findUnique: mockAppBlockFindUnique } },
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { DEV_TOKEN_RATE_LIMIT: 'system:blocks:dev-token-rate-limit' } },
}));
vi.mock('~/env/server', () => ({
  env: { BLOCK_TOKEN_PRIVATE_KEY: 'priv', BLOCK_TOKEN_PUBLIC_KEY: 'pub' },
}));

import handler from '~/pages/api/v1/blocks/dev-token';
import { domainBrowsingCeiling } from '~/shared/constants/browsingLevel.constants';

const SFW = domainBrowsingCeiling(null);

const OWNER_ID = 7;

// Personal-access (user-type) key + moderator.
const MOD_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 42,
  subject: { type: 'apiKey', id: 42 },
};
const NONMOD_SESSION = {
  user: { id: 8, isModerator: false },
  apiKeyId: 43,
  subject: { type: 'apiKey', id: 43 },
};
const OAUTH_MOD_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'client_abc' },
};

// An approved, owned PAGE app. allowedScopes is the OAuth ceiling — set every
// relevant bit so the OAuth-clamp doesn't drop the scopes under test (the
// approved-snapshot + dev-allowlist are the gates we exercise here).
function pageApp(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'apb_abc',
    blockId: 'my-page-app',
    appId: 'appblk-my-page-app',
    status: 'approved',
    manifest: { page: { title: 'My Page' } },
    approvedScopes: ['models:read:self', 'user:read:self', 'ai:write:budgeted', 'apps:storage:read'],
    // 0x1FFFFFF = all 25 bits → no OAuth-ceiling stripping in these tests.
    app: { allowedScopes: 0x1ffffff, userId: OWNER_ID },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  mockMultiIncr.malformedExec = false;
  mockSysRedis.ttl.mockResolvedValue(60);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockAppBlockFindUnique.mockResolvedValue(pageApp());
  mockSign.mockResolvedValue({
    token: 'jwt.signed.value',
    expiresAt: '2099-01-01T00:00:00Z',
    jti: 'j',
  });
});

function authPost(body: unknown) {
  return createMocks({ headers: { authorization: 'Bearer personal-key' }, body });
}

describe('POST /api/v1/blocks/dev-token', () => {
  it('405 for non-POST', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it('401 when Authorization header is missing', async () => {
    const { req, res } = createMocks({ body: { appBlockId: 'apb_abc' } });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('401 when the bearer key does not resolve to a session', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('403 when the key is OAuth-client-issued (personal key only)', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_MOD_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('personal API key');
    expect(mockSign).not.toHaveBeenCalled();
    // Rejected before flag / db / sign — no leak.
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockAppBlockFindUnique).not.toHaveBeenCalled();
  });

  it('403 when the resolved user is NOT a moderator', async () => {
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('403 when the mod is banned', async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: 9, isModerator: true, bannedAt: new Date() },
      apiKeyId: 44,
      subject: { type: 'apiKey', id: 44 },
    });
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('503 (dark) when the App Blocks flag is OFF for the user', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('400 when neither appBlockId nor slug is provided', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({});
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404 when the app is not found', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(null);
    const { req, res } = authPost({ appBlockId: 'apb_missing' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404 when the app is not approved', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(pageApp({ status: 'pending' }));
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404 when the caller does NOT own the app (no probe oracle)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({ app: { allowedScopes: 0x1ffffff, userId: 999 } })
    );
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('422 when the owned app declares no page block', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(pageApp({ manifest: { scopes: [] } }));
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(422);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('429 when the per-user rate limit is exceeded', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 31; // > RATE_LIMIT.max (30)
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBeDefined();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() is malformed', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.malformedExec = null;
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('happy path: mod + owned page app → token with capped claims (self-sub, SFW, page ctx)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    // The bearer-JWT body must never be cached by an intermediary.
    expect(res._getHeaders()['Cache-Control']).toBe('no-store');
    expect(mockSign).toHaveBeenCalledTimes(1);
    const arg = mockSign.mock.calls[0][0];
    // Self-bound subject.
    expect(arg.userId).toBe(OWNER_ID);
    // Forced SFW ceiling.
    expect(arg.maxBrowsingLevel).toBe(SFW);
    // No request-host domain read → null advisory domain.
    expect(arg.domain).toBeNull();
    // Page ctx — no model binding.
    expect(arg.ctx).toEqual({ slotId: 'app.page', entityType: 'none' });
    // Revocable synthetic page instance id.
    expect(arg.blockInstanceId).toBe('page_apb_abc');
    // All of the app's approved + dev-allowed scopes, sorted.
    expect(arg.scopes).toEqual(
      ['ai:write:budgeted', 'apps:storage:read', 'models:read:self', 'user:read:self']
    );
    // Budget defaulted + capped.
    expect(arg.buzzBudget).toBe(50);

    const out = res._getJSONData() as Record<string, unknown>;
    expect(out.token).toBe('jwt.signed.value');
    expect(out.maxBrowsingLevel).toBe(SFW);
    expect(out.scopes).toEqual(arg.scopes);
  });

  it('resolves by slug (blockId) too', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({ slug: 'my-page-app' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockAppBlockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockId: 'my-page-app' } })
    );
  });

  it('STRIPS dev-excluded scopes (social:tip:self, block:settings:*) even if approved', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({
        approvedScopes: [
          'models:read:self',
          'social:tip:self', // dev-excluded + page-forbidden
          'block:settings:read', // dev-excluded
          'apps:storage:write',
        ],
      })
    );
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    expect(arg.scopes).toEqual(['apps:storage:write', 'models:read:self']);
    expect(arg.scopes).not.toContain('social:tip:self');
    expect(arg.scopes).not.toContain('block:settings:read');
  });

  it('STRIPS a requested scope that is NOT in the app approved set', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    // App approves only models:read:self; the body requests user:read:self too.
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({ approvedScopes: ['models:read:self'] })
    );
    const { req, res } = authPost({
      appBlockId: 'apb_abc',
      scopes: ['models:read:self', 'user:read:self'],
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    expect(arg.scopes).toEqual(['models:read:self']);
  });

  it('narrows scopes to the requested subset', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({
      appBlockId: 'apb_abc',
      scopes: ['models:read:self'], // subset of approved
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSign.mock.calls[0][0].scopes).toEqual(['models:read:self']);
  });

  it('CAPS an over-cap requested budget to the dev cap', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc', buzzBudget: 100000 });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSign.mock.calls[0][0].buzzBudget).toBe(250); // DEV_BUZZ_BUDGET_CAP
  });

  it('omits buzzBudget when ai:write:budgeted is not granted', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({ approvedScopes: ['models:read:self'] })
    );
    const { req, res } = authPost({ appBlockId: 'apb_abc', buzzBudget: 200 });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSign.mock.calls[0][0].buzzBudget).toBeUndefined();
  });

  it('drops a scope outside the app OAuth ceiling', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    // Ceiling = 0 → every bitmask-requiring scope is dropped; only the
    // SKIP_OAUTH_CHECK apps:storage:* survives.
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({
        approvedScopes: ['models:read:self', 'apps:storage:read'],
        app: { allowedScopes: 0, userId: OWNER_ID },
      })
    );
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSign.mock.calls[0][0].scopes).toEqual(['apps:storage:read']);
  });
});
