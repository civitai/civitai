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
  mockPublishRequestFindFirst,
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
    mockPublishRequestFindFirst: vi.fn(),
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
  dbWrite: {
    appBlock: { findUnique: mockAppBlockFindUnique },
    appBlockPublishRequest: { findFirst: mockPublishRequestFindFirst },
  },
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

// A pending AppBlockPublishRequest the caller owns (local-manifest mode). There
// is NO AppBlock row + NO OauthClient yet — scopes come from the un-reviewed
// manifest and the OAuth-ceiling clamp is SKIPPED (7f is the spend gate).
function pendingRequest(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pubreq_01HXYZ',
    slug: 'my-pending-app',
    submittedByUserId: OWNER_ID,
    manifest: {
      page: { title: 'My Pending Page' },
      scopes: ['models:read:self', 'user:read:self', 'ai:write:budgeted', 'apps:storage:read'],
    },
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
  // Default: no pending request. The local-manifest path tests set this per-case.
  mockPublishRequestFindFirst.mockResolvedValue(null);
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

  it('404 with the bare "App not found" message when the app truly does not exist', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(null);
    const { req, res } = authPost({ appBlockId: 'apb_missing' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    expect((res._getJSONData() as { message: string }).message).toBe('App not found');
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('404 with an ACTIONABLE no-live-deployment message when an OWNED app is not approved (pending)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(pageApp({ status: 'pending' }));
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    const msg = (res._getJSONData() as { message: string }).message;
    // NOT the misleading bare message...
    expect(msg).not.toBe('App not found');
    // ...but an actionable one naming the block + pointing at dev:harness.
    expect(msg).toContain("block 'my-page-app' has no live deployment");
    expect(msg).toContain('dev:harness');
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
    // A non-owner gets the bare, indistinguishable message even though the row
    // exists and is approved — the actionable status detail is owner-only, so
    // ownership/approval-state is never a probe oracle.
    expect((res._getJSONData() as { message: string }).message).toBe('App not found');
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

  it('422 (approved path) when manifest.page is an ARRAY (not a plain object) — FIX 🟡-2', async () => {
    // `typeof [] === 'object'` and `[] !== null`, so the old check ACCEPTED an
    // array. The tightened check rejects arrays: a "declares a page block" gate
    // must require a plain object, never attacker-supplied non-object JSON.
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(pageApp({ manifest: { page: [] } }));
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(422);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('200 (approved path) when manifest.page is a plain object {} — still mints (FIX 🟡-2 regression guard)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockAppBlockFindUnique.mockResolvedValueOnce(pageApp({ manifest: { page: {} } }));
    const { req, res } = authPost({ appBlockId: 'apb_abc' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSign).toHaveBeenCalledTimes(1);
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

  // -------------------------------------------------------------------------
  // Local-manifest mode (Phase 4): mint against a caller's OWN pending app
  // before it is moderator-approved. Scopes come from the un-reviewed manifest,
  // clamped by the SAME belt minus the OAuth ceiling (7f is the spend gate).
  // -------------------------------------------------------------------------
  describe('local-manifest mode (owned pending app)', () => {
    // The approved lookup MUST find nothing so the pending path is reached.
    function noApprovedRow() {
      mockAppBlockFindUnique.mockResolvedValueOnce(null);
    }

    it('200: owned pending request + page manifest → mints from manifest.scopes (OAuth ceiling SKIPPED), spend-capable when bearer has AIServicesWrite', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION); // personal key, Full → can spend
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      expect(mockSign).toHaveBeenCalledTimes(1);
      const arg = mockSign.mock.calls[0][0];
      // Self-bound subject = the caller.
      expect(arg.userId).toBe(OWNER_ID);
      // Granted = manifest.scopes ∩ allowlist ∩ (¬page-forbidden), + force-granted
      // user:read:self. ai:write:budgeted survives (bearer has AIServicesWrite).
      expect(arg.scopes).toEqual([
        'ai:write:budgeted',
        'apps:storage:read',
        'models:read:self',
        'user:read:self',
      ]);
      // Budget defaulted + capped; forced SFW; page ctx.
      expect(arg.buzzBudget).toBe(50);
      expect(arg.maxBrowsingLevel).toBe(SFW);
      expect(arg.ctx).toEqual({ slotId: 'app.page', entityType: 'none' });
      // Synthetic, revocable instance id derived from the publish-request id.
      expect(arg.blockInstanceId).toBe('page_pubreq_pubreq_01HXYZ');
      // sign blockId = the slug; appId = the SYNTHETIC non-colliding id (audit S1).
      // NOT `appblk-<slug>` — that would resolve to a real OauthClient on spend.
      expect(arg.blockId).toBe('my-pending-app');
      expect(arg.appId).toBe('pending-pubreq_01HXYZ');
      expect(arg.appId).not.toBe('appblk-my-pending-app');
      expect(arg.appBlockId).toBe('pubreq_01HXYZ');
      // Ownership was enforced in the query.
      expect(mockPublishRequestFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'my-pending-app', status: 'pending', submittedByUserId: OWNER_ID },
        })
      );
    });

    it('200: owned pending request but bearer LACKS AIServicesWrite → ai:write:budgeted STRIPPED (7f spend gate), no budget claim', async () => {
      mockGetSession.mockResolvedValueOnce(READONLY_MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // ai:write:budgeted stripped by 7f; read/catalog/storage survive.
      expect(arg.scopes).toEqual(['apps:storage:read', 'models:read:self', 'user:read:self']);
      expect(arg.scopes).not.toContain('ai:write:budgeted');
      expect(arg.buzzBudget).toBeUndefined();
    });

    it('R1: an un-reviewed manifest declaring ESCALATED scopes has them STRIPPED, not minted', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(
        pendingRequest({
          manifest: {
            page: { title: 'evil' },
            scopes: [
              'models:read:self', // legit → kept
              'social:tip:self', // dev-excluded + page-forbidden → stripped
              'block:settings:write', // dev-excluded → stripped
              'buzz:read:self', // page-forbidden → stripped
              'totally:unknown:scope', // not a known block scope → stripped
            ],
          },
        })
      );
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // Only the legit scope + the force-granted user:read:self survive — proving
      // the un-reviewed manifest cannot escalate past the dev belt.
      expect(arg.scopes).toEqual(['models:read:self', 'user:read:self']);
      expect(arg.scopes).not.toContain('social:tip:self');
      expect(arg.scopes).not.toContain('block:settings:write');
      expect(arg.scopes).not.toContain('buzz:read:self');
      expect(arg.scopes).not.toContain('totally:unknown:scope');
    });

    it('no oracle when a pending request is owned by ANOTHER user: the foreign pending does not match the caller query, so it falls to the NO-ROW path (mints a read-only token, identical to no-row-at-all — never reveals the foreign row)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      // The ownership filter is in the QUERY (submittedByUserId === user.id), so a
      // pending row owned by another user simply does not match → findFirst null.
      // With the no-row local-manifest path live, `block == null` + no owned
      // pending → the caller reaches the NO-ROW mint, NOT a 404. With NO body
      // scopes the granted set is read-only (user:read:self) — INDISTINGUISHABLE
      // from a brand-new slug, so a foreign pending row is still never an oracle.
      mockPublishRequestFindFirst.mockResolvedValueOnce(null);
      const { req, res } = authPost({ slug: 'someone-elses-app' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // Read-only (no body scopes) → no oracle: same outcome as a slug with no row.
      expect(arg.scopes).toEqual(['user:read:self']);
      expect(arg.appId).toBe('local-someone-elses-app');
    });

    it('no-row mint when neither an approved row NOR an owned pending request exists (the no-row local-manifest path)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(null);
      const { req, res } = authPost({ slug: 'no-such-app' });
      await handler(req as never, res as never);
      // `block == null` + no owned pending → no-row mint (read-only, no body scopes).
      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      expect(arg.scopes).toEqual(['user:read:self']);
      expect(arg.appId).toBe('local-no-such-app');
    });

    it('422 when the owned pending manifest declares NO page block', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(
        pendingRequest({ manifest: { scopes: ['models:read:self'] } }) // no page
      );
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(422);
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('422 when the owned pending manifest sets page to an ARRAY — FIX 🟡-2', async () => {
      // On the PENDING path the manifest is developer-controlled + un-reviewed, so
      // a dev could set `page: []` (an array is `typeof 'object'`, non-null) to
      // satisfy the old "declares a page block" gate. The tightened check rejects
      // it → 422, never a mint.
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(
        pendingRequest({ manifest: { page: [], scopes: ['models:read:self'] } })
      );
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(422);
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('200 when the owned pending manifest page is a plain object {} (FIX 🟡-2 regression guard)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(
        pendingRequest({ manifest: { page: {}, scopes: ['models:read:self'] } })
      );
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      expect(mockSign).toHaveBeenCalledTimes(1);
    });

    it('FIX 🟡-1: emits the structured blocks.dev-token.pending-mint log with spendGranted=true (bearer has AIServicesWrite)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION); // Full → AIServicesWrite → can spend
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const log = (req as unknown as { log: { info: ReturnType<typeof vi.fn> } }).log;
      expect(log.info).toHaveBeenCalledWith(
        'blocks.dev-token.pending-mint',
        expect.objectContaining({
          mode: 'pending',
          userId: OWNER_ID,
          slug: 'my-pending-app',
          publishRequestId: 'pubreq_01HXYZ',
          spendGranted: true,
        })
      );
      // The granted scopes are logged for forensics; the token/secret is NEVER logged.
      const call = log.info.mock.calls.find((c) => c[0] === 'blocks.dev-token.pending-mint');
      expect(call?.[1].scopes).toEqual([
        'ai:write:budgeted',
        'apps:storage:read',
        'models:read:self',
        'user:read:self',
      ]);
      expect(JSON.stringify(call?.[1])).not.toContain('jwt.signed.value');
    });

    it('FIX 🟡-1: pending-mint log reflects spendGranted=false when the bearer LACKS AIServicesWrite (7f clamp)', async () => {
      mockGetSession.mockResolvedValueOnce(READONLY_MOD_SESSION); // no AIServicesWrite
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const log = (req as unknown as { log: { info: ReturnType<typeof vi.fn> } }).log;
      const call = log.info.mock.calls.find((c) => c[0] === 'blocks.dev-token.pending-mint');
      expect(call).toBeDefined();
      expect(call?.[1].spendGranted).toBe(false);
      expect(call?.[1].scopes).not.toContain('ai:write:budgeted');
    });

    it('FIX 🟡-1: the APPROVED path does NOT emit the pending-mint log', async () => {
      // The approved path has durable AppBlock-backed audit rows, so the structured
      // pending-mint event must not fire for it (it is pending-path-only).
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const { req, res } = authPost({ appBlockId: 'apb_abc' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const log = (req as unknown as { log: { info: ReturnType<typeof vi.fn> } }).log;
      const call = log.info.mock.calls.find((c) => c[0] === 'blocks.dev-token.pending-mint');
      expect(call).toBeUndefined();
    });

    it('an appBlockId-only request can NEVER reach the pending path (pending apps have no appBlockId)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      // approved lookup misses; no slug → pending findFirst must not be consulted.
      mockAppBlockFindUnique.mockResolvedValueOnce(null);
      const { req, res } = authPost({ appBlockId: 'apb_missing' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(404);
      expect((res._getJSONData() as { message: string }).message).toBe('App not found');
      expect(mockPublishRequestFindFirst).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('CAPS an over-cap budget on the pending path to DEV_BUZZ_BUDGET_CAP', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({ slug: 'my-pending-app', buzzBudget: 100000 });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      expect(mockSign.mock.calls[0][0].buzzBudget).toBe(250);
    });

    it('forced SFW + self-bound sub hold on the pending path', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);
      const arg = mockSign.mock.calls[0][0];
      expect(arg.maxBrowsingLevel).toBe(SFW);
      expect(arg.domain).toBeNull();
      expect(arg.userId).toBe(OWNER_ID);
    });

    it('mod-only: a NON-mod is blocked BEFORE the pending lookup', async () => {
      mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(403);
      expect(mockPublishRequestFindFirst).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('rate-limit applies to the pending path too', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockMultiIncr.value = 31;
      const { req, res } = authPost({ slug: 'my-pending-app' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(429);
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('S1: a foreign-owned APPROVED app for the same slug does NOT pin the token appId to appblk-<slug> (no forged attribution row)', async () => {
      // ADVERSARIAL: a mod-tier dev files a *pending* request for a slug that an
      // APPROVED app owned by a DIFFERENT user already holds. The submit guard
      // blocks only same-slug *pending* collisions, not pending-vs-approved, so
      // this is reachable. The dev-token APPROVED branch is skipped (the approved
      // row's owner != caller), so the caller falls through to the PENDING branch.
      // Were the pending path to mint appId=`appblk-<slug>`, recordSpendAttribution
      // would resolve the VICTIM's real OauthClient on spend and write a forged
      // blockSpendAttribution row (the #2605 payout rail reads exactly that row).
      // The fix mints a synthetic `pending-<pubreqId>` instead, which can never
      // resolve to a real OauthClient.id → the attribution write is skipped.
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      // The approved lookup by blockId=slug FINDS a row — but owned by user 999,
      // NOT the caller (OWNER_ID). The same `appId` a real approved app would hold.
      mockAppBlockFindUnique.mockResolvedValueOnce(
        pageApp({
          blockId: 'contested-slug',
          appId: 'appblk-contested-slug',
          app: { allowedScopes: 0x1ffffff, userId: 999 },
        })
      );
      // The caller DOES own a pending request for the SAME slug.
      mockPublishRequestFindFirst.mockResolvedValueOnce(
        pendingRequest({ id: 'pubreq_CALLER1', slug: 'contested-slug' })
      );
      const { req, res } = authPost({ slug: 'contested-slug' });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      expect(mockSign).toHaveBeenCalledTimes(1);
      const arg = mockSign.mock.calls[0][0];
      // (a) The caller reached the PENDING path, not the approved branch: the
      //     appBlockId claim is the caller's OWN pending-request id, and the
      //     instance id is derived from it (NOT the foreign approved AppBlock.id).
      expect(arg.appBlockId).toBe('pubreq_CALLER1');
      expect(arg.blockInstanceId).toBe('page_pubreq_pubreq_CALLER1');
      // (b) appId is the SYNTHETIC value — NOT the colliding appblk-<slug> that
      //     would resolve to the foreign victim's OauthClient on spend.
      expect(arg.appId).toBe('pending-pubreq_CALLER1');
      expect(arg.appId).not.toBe('appblk-contested-slug');
      // Self-bound to the caller (the spend would be the caller's own Buzz).
      expect(arg.userId).toBe(OWNER_ID);
    });

    it('body-narrowing applies on the pending path; user:read:self still force-granted', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noApprovedRow();
      mockPublishRequestFindFirst.mockResolvedValueOnce(pendingRequest());
      const { req, res } = authPost({
        slug: 'my-pending-app',
        scopes: ['models:read:self'], // subset; excludes user:read:self
      });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      expect(mockSign.mock.calls[0][0].scopes).toEqual(['models:read:self', 'user:read:self']);
    });
  });

  // -------------------------------------------------------------------------
  // No-row local-manifest mode (Phase 4 — deferred): mint for a BRAND-NEW app
  // the dev has NOT submitted. NO approved AppBlock + NO owned pending request.
  // The scope SOURCE is the CLIENT-SUPPLIED body `scopes` (the dev's local
  // manifest, sent by the CLI), clamped by the SAME belt minus the OAuth ceiling
  // (7f is the spend gate). Synthetic non-resolving appId `local-<slug>` so no
  // forged attribution row. GUARDED: never fires when an approved row exists.
  // -------------------------------------------------------------------------
  describe('no-row local-manifest mode (brand-new, unsubmitted app)', () => {
    // Both server lookups MUST miss so the no-row path is reached.
    function noRow() {
      mockAppBlockFindUnique.mockResolvedValueOnce(null); // no approved row
      mockPublishRequestFindFirst.mockResolvedValueOnce(null); // no owned pending
    }

    it('200: no approved row + no pending + body scopes → mints from the body scopes, appId=local-<slug>, spend-capable when bearer has AIServicesWrite', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION); // personal key, Full → can spend
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: ['ai:write:budgeted', 'user:read:self'],
      });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      expect(mockSign).toHaveBeenCalledTimes(1);
      const arg = mockSign.mock.calls[0][0];
      // Self-bound subject = the caller (never from the body).
      expect(arg.userId).toBe(OWNER_ID);
      // Granted = body.scopes ∩ allowlist ∩ (¬page-forbidden), + force-granted
      // user:read:self. ai:write:budgeted survives (bearer has AIServicesWrite).
      expect(arg.scopes).toContain('ai:write:budgeted');
      expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
      // Budget defaulted + capped; forced SFW; page ctx.
      expect(arg.buzzBudget).toBe(50);
      expect(arg.maxBrowsingLevel).toBe(SFW);
      expect(arg.ctx).toEqual({ slotId: 'app.page', entityType: 'none' });
      // sign blockId = the slug; SYNTHETIC non-resolving appId; synthetic ids.
      expect(arg.blockId).toBe('brand-new-app');
      expect(arg.appId).toBe('local-brand-new-app');
      expect(arg.appBlockId).toBe('page_local_brand-new-app');
      expect(arg.blockInstanceId).toBe('page_local_brand-new-app');
    });

    it('GUARD (no-shadow): an APPROVED app for the slug owned by ANOTHER user → no-row path does NOT fire → bare 404 (NOT a local mint)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      // An approved row for the slug EXISTS but is owned by user 999, not the
      // caller. `block != null`, so the no-row branch (gated on `block == null`)
      // must NOT fire even though the caller passes body scopes.
      mockAppBlockFindUnique.mockResolvedValueOnce(
        pageApp({
          blockId: 'owned-by-someone',
          appId: 'appblk-owned-by-someone',
          app: { allowedScopes: 0x1ffffff, userId: 999 },
        })
      );
      // No caller-owned pending request either.
      mockPublishRequestFindFirst.mockResolvedValueOnce(null);
      const { req, res } = authPost({
        slug: 'owned-by-someone',
        scopes: ['ai:write:budgeted', 'user:read:self'],
      });
      await handler(req as never, res as never);
      // Bare 404 — NOT a local mint, no shadowing of a real published app.
      expect(res._getStatusCode()).toBe(404);
      expect((res._getJSONData() as { message: string }).message).toBe('App not found');
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('7f on the no-row path: bearer LACKS AIServicesWrite → ai:write:budgeted STRIPPED, no budget claim', async () => {
      mockGetSession.mockResolvedValueOnce(READONLY_MOD_SESSION); // no AIServicesWrite
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: ['ai:write:budgeted', 'models:read:self', 'user:read:self'],
      });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // ai:write:budgeted stripped by 7f; read/catalog survive.
      expect(arg.scopes).toEqual(['models:read:self', 'user:read:self']);
      expect(arg.scopes).not.toContain('ai:write:budgeted');
      expect(arg.buzzBudget).toBeUndefined();
    });

    it('R1: an un-reviewed body manifest declaring ESCALATED scopes has them STRIPPED, not minted', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: [
          'models:read:self', // legit → kept
          'social:tip:self', // dev-excluded + page-forbidden → stripped
          'block:settings:write', // dev-excluded → stripped
          'buzz:read:self', // page-forbidden → stripped
          'totally:unknown', // not a known block scope → stripped
        ],
      });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // Only the legit scope + force-granted user:read:self survive — proving the
      // un-reviewed CLIENT manifest cannot escalate past the dev belt.
      expect(arg.scopes).toEqual(['models:read:self', 'user:read:self']);
      expect(arg.scopes).not.toContain('social:tip:self');
      expect(arg.scopes).not.toContain('block:settings:write');
      expect(arg.scopes).not.toContain('buzz:read:self');
      expect(arg.scopes).not.toContain('totally:unknown');
    });

    it('200: absent body scopes → a read-only token (user:read:self only), NOT a 404', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noRow();
      const { req, res } = authPost({ slug: 'brand-new-app' }); // no scopes
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // Empty source → only the force-granted read scope; no spend, no budget.
      expect(arg.scopes).toEqual(['user:read:self']);
      expect(arg.buzzBudget).toBeUndefined();
      expect(arg.appId).toBe('local-brand-new-app');
    });

    it('synthetic appId never equals appblk-<slug> (no real OauthClient resolves → no attribution row)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: ['ai:write:budgeted'],
      });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const arg = mockSign.mock.calls[0][0];
      // The S1 protection: `local-<slug>` can never collide with the deterministic
      // `appblk-<slug>` an approved app holds, so recordSpendAttribution misses.
      expect(arg.appId).toBe('local-brand-new-app');
      expect(arg.appId).not.toBe('appblk-brand-new-app');
    });

    it('CAPS an over-cap budget on the no-row path to DEV_BUZZ_BUDGET_CAP', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: ['ai:write:budgeted'],
        buzzBudget: 100000,
      });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      expect(mockSign.mock.calls[0][0].buzzBudget).toBe(250);
    });

    it('forced SFW + self-bound sub hold on the no-row path', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      noRow();
      const { req, res } = authPost({ slug: 'brand-new-app', scopes: ['models:read:self'] });
      await handler(req as never, res as never);
      const arg = mockSign.mock.calls[0][0];
      expect(arg.maxBrowsingLevel).toBe(SFW);
      expect(arg.domain).toBeNull();
      expect(arg.userId).toBe(OWNER_ID);
    });

    it('mod-only: a NON-mod is blocked BEFORE any lookup on the no-row path', async () => {
      mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
      const { req, res } = authPost({ slug: 'brand-new-app', scopes: ['models:read:self'] });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(403);
      expect(mockAppBlockFindUnique).not.toHaveBeenCalled();
      expect(mockPublishRequestFindFirst).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('rate-limit applies to the no-row path too', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockMultiIncr.value = 31;
      const { req, res } = authPost({ slug: 'brand-new-app', scopes: ['models:read:self'] });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(429);
      expect(mockSign).not.toHaveBeenCalled();
    });

    it('emits the structured blocks.dev-token.local-mint log (spendGranted reflects the 7f clamp)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION); // Full → can spend
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: ['ai:write:budgeted', 'models:read:self'],
      });
      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(200);
      const log = (req as unknown as { log: { info: ReturnType<typeof vi.fn> } }).log;
      expect(log.info).toHaveBeenCalledWith(
        'blocks.dev-token.local-mint',
        expect.objectContaining({
          mode: 'local',
          userId: OWNER_ID,
          slug: 'brand-new-app',
          spendGranted: true,
        })
      );
      const call = log.info.mock.calls.find((c) => c[0] === 'blocks.dev-token.local-mint');
      expect(call?.[1].scopes).toEqual([
        'ai:write:budgeted',
        'models:read:self',
        'user:read:self',
      ]);
      // The token/secret is NEVER logged.
      expect(JSON.stringify(call?.[1])).not.toContain('jwt.signed.value');
      // The pending-mint event must NOT fire on the no-row path.
      const pendingCall = log.info.mock.calls.find(
        (c) => c[0] === 'blocks.dev-token.pending-mint'
      );
      expect(pendingCall).toBeUndefined();
    });

    it('the local-mint log reflects spendGranted=false when the bearer LACKS AIServicesWrite', async () => {
      mockGetSession.mockResolvedValueOnce(READONLY_MOD_SESSION);
      noRow();
      const { req, res } = authPost({
        slug: 'brand-new-app',
        scopes: ['ai:write:budgeted'],
      });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const log = (req as unknown as { log: { info: ReturnType<typeof vi.fn> } }).log;
      const call = log.info.mock.calls.find((c) => c[0] === 'blocks.dev-token.local-mint');
      expect(call).toBeDefined();
      expect(call?.[1].spendGranted).toBe(false);
      expect(call?.[1].scopes).not.toContain('ai:write:budgeted');
    });

    it('the APPROVED path does NOT emit the local-mint log', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const { req, res } = authPost({ appBlockId: 'apb_abc' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const log = (req as unknown as { log: { info: ReturnType<typeof vi.fn> } }).log;
      const call = log.info.mock.calls.find((c) => c[0] === 'blocks.dev-token.local-mint');
      expect(call).toBeUndefined();
    });

    it('an appBlockId-only request can NEVER reach the no-row path (it returns the bare 404)', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockAppBlockFindUnique.mockResolvedValueOnce(null); // approved miss
      const { req, res } = authPost({ appBlockId: 'apb_missing', scopes: ['ai:write:budgeted'] });
      await handler(req as never, res as never);
      // No slug → the `else if (slug)` branch is skipped entirely → bare 404.
      expect(res._getStatusCode()).toBe(404);
      expect((res._getJSONData() as { message: string }).message).toBe('App not found');
      expect(mockPublishRequestFindFirst).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    });

    // audit N1 + 🟡-1 (slug bounds): a malformed OR out-of-bounds slug that the
    // OLD `min(1).max(128)` accepted but the canonical `min(3).max(40).regex(
    // SLUG_REGEX)` rejects must 400 at body validation — BEFORE any lookup or
    // synthetic-id construction. This makes the "`local-<slug>` can never collide
    // with a real OauthClient.id" guarantee airtight BY CONSTRUCTION rather than
    // by prefix-collision reasoning: a non-conforming slug never reaches the
    // `local-<slug>` constructor at all. The bounds now MATCH the canonical app-
    // slug schema (publish-request.schema.ts min(3).max(40)) — real app slugs are
    // min(3).max(40).regex(SLUG_REGEX) at submit/create time, so no legitimate
    // approved/pending slug regresses; the 'ab' (2-char) and 41-char cases below
    // pass SLUG_REGEX shape but fail the min(3)/max(40) bound a real app can't
    // violate.
    it.each([
      ['-leading', 'leading hyphen'],
      ['trailing-', 'trailing hyphen'],
      ['UPPER', 'uppercase'],
      ['BadSlug', 'mixed case'],
      ['has space', 'whitespace'],
      ['under_score', 'underscore'],
      ['emoji😀', 'non-alnum'],
      ['ab', 'too short (2 chars, < min(3))'],
      ['a'.repeat(41), 'too long (41 chars, > max(40))'],
    ])('400 (audit N1/🟡-1) for malformed slug %p (%s) — no mint, no lookup', async (slug) => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const { req, res } = authPost({ slug, scopes: ['models:read:self'] });
      await handler(req as never, res as never);
      // Rejected at step-4 body validation (zod .regex), before step-5 rate
      // limit and BOTH server lookups — and before the synthetic-id builder.
      expect(res._getStatusCode()).toBe(400);
      expect((res._getJSONData() as { message: string }).message).toBe('Invalid request body');
      expect(mockAppBlockFindUnique).not.toHaveBeenCalled();
      expect(mockPublishRequestFindFirst).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    });
  });
});
