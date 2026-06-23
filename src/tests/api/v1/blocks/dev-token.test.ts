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
    mockSign: vi.fn(),
    mockAppBlockFindUnique: vi.fn(),
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
import { TokenScope } from '~/shared/constants/token-scope.constants';

const SFW = domainBrowsingCeiling(null);

const OWNER_ID = 7;

// Personal-access (user-type) key + moderator. A normal personal key carries
// the Full scope bitmask (incl. AIServicesWrite), so ai:write:budgeted survives
// the personal-key-ceiling clamp.
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
// OAuth token WITHOUT AppBlocksSubmit. `TokenScope.Full` deliberately EXCLUDES
// AppBlocksSubmit (bit 25), so a "full" OAuth consent still fails the mint gate.
const OAUTH_MOD_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'client_abc' },
  tokenScope: TokenScope.Full,
};
// OAuth token WITH AppBlocksSubmit + AIServicesWrite (the civitai-cli client
// provisioned with both): mints AND keeps the budgeted-spend scope.
const OAUTH_SUBMIT_SPEND_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 100,
  subject: { type: 'oauth', id: 'civitai-cli' },
  tokenScope: TokenScope.UserRead | TokenScope.AppBlocksSubmit | TokenScope.AIServicesWrite,
};
// OAuth token WITH AppBlocksSubmit but WITHOUT AIServicesWrite: mints (read/
// estimate dev token) but the uniform spend ceiling STRIPS ai:write:budgeted.
const OAUTH_SUBMIT_NOSPEND_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 101,
  subject: { type: 'oauth', id: 'civitai-cli' },
  tokenScope: TokenScope.UserRead | TokenScope.AppBlocksSubmit,
};
// A personal key deliberately scoped WITHOUT AIServicesWrite (e.g. read-only).
const READONLY_MOD_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 44,
  subject: { type: 'apiKey', id: 44 },
  tokenScope: TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.MediaRead,
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
  mockMultiIncr.throwExec = false;
  mockSysRedis.ttl.mockResolvedValue(60);
  mockSysRedis.expire.mockResolvedValue(1);
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

  it('403 when an OAuth token LACKS the AppBlocksSubmit scope', async () => {
    // TokenScope.Full excludes AppBlocksSubmit, so even a "full" OAuth consent
    // is rejected at the mint gate (mirrors submit-version's OAuth gate).
    mockGetSession.mockResolvedValueOnce(OAUTH_MOD_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    const msg = (res._getJSONData() as { message: string }).message;
    // Actionable: tells the dev both how to fix it (personal key) and the OAuth path.
    expect(msg).toContain('personal API key');
    expect(msg).toContain('App Blocks submit scope');
    expect(mockSign).not.toHaveBeenCalled();
    // Rejected before flag / db / sign — no leak.
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockAppBlockFindUnique).not.toHaveBeenCalled();
  });

  it('200: OAuth token WITH AppBlocksSubmit + AIServicesWrite mints a spend-capable dev token (self-bound sub)', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_SUBMIT_SPEND_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSign).toHaveBeenCalledTimes(1);
    const arg = mockSign.mock.calls[0][0];
    // Self-bound subject = the OAuth user (never settable from the body).
    expect(arg.userId).toBe(OWNER_ID);
    // AppBlocksSubmit gated the MINT; AIServicesWrite kept the spend scope.
    expect(arg.scopes).toContain('ai:write:budgeted');
    expect(arg.buzzBudget).toBe(50);
    // Every other belt unchanged: forced SFW + page ctx.
    expect(arg.maxBrowsingLevel).toBe(SFW);
    expect(arg.ctx).toEqual({ slotId: 'app.page', entityType: 'none' });
  });

  it('200: OAuth token WITH AppBlocksSubmit but WITHOUT AIServicesWrite mints, but the uniform spend ceiling STRIPS ai:write:budgeted', async () => {
    // Proves AppBlocksSubmit is the MINT gate, NOT a spend grant — spend stays
    // uniformly gated by AIServicesWrite for OAuth exactly as for personal keys.
    mockGetSession.mockResolvedValueOnce(OAUTH_SUBMIT_NOSPEND_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    expect(arg.userId).toBe(OWNER_ID);
    // Read/catalog/storage scopes survive; the budgeted-spend scope is gone.
    expect(arg.scopes).toEqual(['apps:storage:read', 'models:read:self', 'user:read:self']);
    expect(arg.scopes).not.toContain('ai:write:budgeted');
    // No spend scope → no budget claim.
    expect(arg.buzzBudget).toBeUndefined();
    const out = res._getJSONData() as Record<string, unknown>;
    expect(out.buzzBudget).toBeUndefined();
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

  it('503 (fail closed) when the rate-limit exec() THROWS (redis incident)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.throwExec = true;
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    // A Redis incident must never silently bypass the mint.
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('self-heals a TTL-less rate-limit key (re-arms expiry when ttl < 0)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 2; // not first hit → self-heal branch runs
    mockSysRedis.ttl.mockResolvedValueOnce(-1); // key exists but lost its TTL
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSysRedis.expire).toHaveBeenCalledWith('system:blocks:dev-token-rate-limit:u:7', 60);
  });

  it('does NOT re-arm expiry when the window is still active (ttl >= 0)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 2;
    mockSysRedis.ttl.mockResolvedValueOnce(45); // active window — must not be extended
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSysRedis.expire).not.toHaveBeenCalled();
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
    // user:read:self is FORCE-GRANTED post-clamp (dev:live viewer identity).
    expect(arg.scopes).toEqual(['apps:storage:write', 'models:read:self', 'user:read:self']);
    expect(arg.scopes).not.toContain('social:tip:self');
    expect(arg.scopes).not.toContain('block:settings:read');
  });

  it('STRIPS a requested OTHER scope that is NOT in the app approved set (user:read:self is force-granted)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    // App approves only models:read:self; the body requests ai:write:budgeted too
    // (which is NOT approved → stripped). user:read:self is force-granted post-
    // clamp regardless of approval, so it is present even though the app did not
    // approve it.
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({ approvedScopes: ['models:read:self'] })
    );
    const { req, res } = authPost({
      appBlockId: 'apb_abc',
      scopes: ['models:read:self', 'ai:write:budgeted'],
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    // ai:write:budgeted stripped (not approved); user:read:self force-granted.
    expect(arg.scopes).toEqual(['models:read:self', 'user:read:self']);
    expect(arg.scopes).not.toContain('ai:write:budgeted');
  });

  it('narrows scopes to the requested subset, but user:read:self is force-granted regardless of body narrowing', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authPost({
      appBlockId: 'apb_abc',
      scopes: ['models:read:self'], // subset of approved — excludes user:read:self
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    // Body narrowing dropped everything but models:read:self; user:read:self is
    // force-granted POST-clamp, so it survives the narrowing.
    expect(mockSign.mock.calls[0][0].scopes).toEqual(['models:read:self', 'user:read:self']);
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
    // models:read:self dropped by the 0 OAuth ceiling; apps:storage:read survives
    // (SKIP_OAUTH_CHECK); user:read:self is force-granted POST-clamp so it is
    // present even though the ceiling would otherwise drop it.
    expect(mockSign.mock.calls[0][0].scopes).toEqual(['apps:storage:read', 'user:read:self']);
  });

  it('STRIPS ai:write:budgeted when the personal key lacks AIServicesWrite', async () => {
    // The minted token can never authorize MORE spend than the dev's own key.
    mockGetSession.mockResolvedValueOnce(READONLY_MOD_SESSION);
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    // Read/catalog/storage scopes survive; the budgeted-spend scope is gone.
    expect(arg.scopes).toEqual(['apps:storage:read', 'models:read:self', 'user:read:self']);
    expect(arg.scopes).not.toContain('ai:write:budgeted');
    // No spend scope → no budget claim.
    expect(arg.buzzBudget).toBeUndefined();
    const out = res._getJSONData() as Record<string, unknown>;
    expect(out.buzzBudget).toBeUndefined();
  });

  it('PAGE-MONEY case: OAuth dev token for an app that approves ONLY ai:write:budgeted, with a credential lacking AIServicesWrite, still mints user:read:self', async () => {
    // The exact root-cause scenario: the page-money scaffold manifest declares
    // ONLY ai:write:budgeted, so user:read:self is never in approvedScopes and
    // would never be minted by the clamp → /blocks/me 403 → dev:live falls back
    // to an anonymous viewer. The OAuth credential here also lacks AIServicesWrite,
    // so ai:write:budgeted is stripped by the spend ceiling. The token therefore
    // carries NO spend scope, but user:read:self IS present (force-granted) so the
    // harness can resolve the viewer identity.
    mockGetSession.mockResolvedValueOnce(OAUTH_SUBMIT_NOSPEND_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({ approvedScopes: ['ai:write:budgeted'] })
    );
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    // Identity present; no spend (credential lacked AIServicesWrite).
    expect(arg.scopes).toEqual(['user:read:self']);
    expect(arg.scopes).not.toContain('ai:write:budgeted');
    expect(arg.buzzBudget).toBeUndefined();
    // Self-bound subject = the caller — so /blocks/me only ever returns this user.
    expect(arg.userId).toBe(OWNER_ID);
    const out = res._getJSONData() as Record<string, unknown>;
    expect(out.scopes).toEqual(['user:read:self']);
  });

  it('FORCE-GRANTS user:read:self even when the app approves ONLY ai:write:budgeted (personal-key page-money app)', async () => {
    // Same page-money manifest, but via a personal key that CAN spend
    // (AIServicesWrite). user:read:self is added regardless, alongside the spend
    // scope the app approved.
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(
      pageApp({ approvedScopes: ['ai:write:budgeted'] })
    );
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const arg = mockSign.mock.calls[0][0];
    expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
  });
});
