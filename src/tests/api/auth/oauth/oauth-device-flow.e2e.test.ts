import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope, ALL_SCOPES } from '~/shared/constants/token-scope.constants';

/**
 * END-TO-END SMOKE for the OAuth **device-authorization grant** — the exact
 * server contract chain the `civitai` CLI depends on.
 *
 * This test walks the ACTUAL endpoint handlers in sequence:
 *
 *   device  →  device-approve  →  device-token  →  submit-version  →  token (refresh)  →  submit-version
 *
 * and threads real state between them through a single shared in-memory Redis
 * (keyed exactly like production Redis keys) and a shared in-memory `ApiKey`
 * "table". Only the *infrastructure boundaries* are mocked (DB client, Redis
 * client, server env, the session-cookie reader, the heavy `submitVersion`
 * service, the Flipt-backed app-blocks flag, prom metrics). The OAuth machinery
 * UNDER TEST is REAL:
 *   - `~/server/oauth/server` (oauthServer) + `~/server/oauth/model` (oauthModel)
 *   - `~/server/oauth/token-helpers` (createOAuthTokenPair)
 *   - `~/server/auth/bearer-token` (getSessionFromBearerToken)
 *   - the scope constants + Flags bitmask logic
 *
 * ## Two contract drifts this MUST catch (bugs a per-endpoint unit test missed)
 *
 * 1. **Scope-shape drift (KNOWN TECH-DEBT — pinned, NOT blessed).** `device-token`
 *    returns `scope` as a **string** (`scope.toString()` → `"33554433"`); the
 *    `token` refresh route returns `scope` as the library's **array**
 *    (`["33554433"]`). This divergence is a wart the two endpoints SHOULD
 *    converge on — it is NOT a desirable contract. The test pins both shapes at
 *    the hop where each is produced so a regression can't *silently* flip one
 *    and break a consumer (the CLI handles both today). A DELIBERATE convergence
 *    PR (make both return the same shape) is expected to UPDATE these
 *    assertions — they document current behavior, they do not endorse it.
 *
 * 2. **`ALL_SCOPES` / bit-25 bound.** `AppBlocksSubmit` (bit 25 = 33554432) is
 *    opt-in and **excluded from `TokenScope.Full`** (33554431). The device-init
 *    bound, the device-token bound, AND the per-client `allowedScopes`
 *    intersection must all let it through, it must land in the minted token's
 *    `tokenScope`, and the resulting Bearer must be accepted by
 *    `/api/v1/blocks/submit-version` (which requires the bit + a moderator).
 *    If `ALL_SCOPES` regressed to `Full` anywhere on the chain, the bit would be
 *    dropped/rejected and the submit hop would 403 → this test fails.
 */

// ──────────────────────────────────────────────────────────────────────────
// req/res stand-in (same minimal shape the sibling OAuth tests use)
// ──────────────────────────────────────────────────────────────────────────
function createMocks({
  method = 'POST',
  headers = {},
  body = {},
  query = {},
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
} = {}) {
  const req = {
    method,
    headers,
    body,
    query,
    socket: { remoteAddress: '203.0.113.7' },
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
    once() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeaders: () => responseHeaders,
  };
  return { req, res };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared in-memory infrastructure (Redis + DB), wired through vi.hoisted so the
// mock factories can reference it.
// ──────────────────────────────────────────────────────────────────────────
const CLI_CLIENT_ID = 'civitai-cli';
const CLI_SCOPE = TokenScope.UserRead | TokenScope.AppBlocksSubmit; // 33554433
const THIRD_PARTY_CLIENT_ID = 'third-party-full';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const MOD_USER_ID = 7;
const NONMOD_USER_ID = 8;

const h = vi.hoisted(() => {
  // ── In-memory Redis: one Map per hash key, mirroring production key strings.
  // Values are stored already-decoded (objects), matching what `packed.hGet`
  // returns after msgpack-unpack; `packed.hSet` accepts the object directly.
  const hashes = new Map<string, Map<string, unknown>>();
  const getHash = (key: string) => {
    let m = hashes.get(key);
    if (!m) {
      m = new Map();
      hashes.set(key, m);
    }
    return m;
  };

  // ── In-memory ApiKey "table": rows keyed by the hashed `key` value (what the
  // model + bearer-token helper look up by). createOAuthTokenPair writes here;
  // getAccessToken/getRefreshToken/getSessionFromBearerToken read here.
  interface ApiKeyRow {
    id: number;
    key: string;
    name: string;
    tokenScope: number;
    userId: number;
    type: 'Access' | 'Refresh';
    expiresAt: Date | null;
    clientId: string | null;
    lastUsedAt: Date | null;
    buzzLimit: unknown;
  }
  const apiKeys: ApiKeyRow[] = [];
  let nextApiKeyId = 1;

  // ── In-memory OauthClient table.
  const oauthClients = new Map<
    string,
    {
      id: string;
      grants: string[];
      redirectUris: string[];
      allowedScopes: number;
      allowedOrigins: string[];
      isConfidential: boolean;
      secret: string | null;
      userId: number;
    }
  >();

  // ── In-memory User table (only the fields bearer-token / mod gate read).
  const users = new Map<number, { id: number; isModerator: boolean; bannedAt: Date | null }>();

  // ── submit-version rate-limit counters (sysRedis MULTI path). Lives in the
  // hoisted state so seed() can reset it per test — otherwise a gate-passing
  // submit in one test would accumulate toward RATE_LIMIT.max across tests and
  // could spuriously 429 once more such tests are added.
  const counters = new Map<string, number>();

  return { hashes, getHash, apiKeys, oauthClients, users, counters, nextApiKeyIdRef: { v: nextApiKeyId } };
});

// Helper used inside the redis mock to satisfy the `expiresAt >= now` filter.
function matchesExpiry(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() >= now.getTime();
}

// ──────────────────────────────────────────────────────────────────────────
// Mocks — ONLY the infrastructure boundaries. Everything in ~/server/oauth/*
// and ~/server/auth/bearer-token is the REAL code under test.
// ──────────────────────────────────────────────────────────────────────────

// prom http-errors instrumentation is a no-op listener.
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

// CORS helper: behaviour-only (don't drag the real env loader). Never stops.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  addCorsHeaders: (
    req: { method?: string },
    res: { setHeader: (k: string, v: string) => void },
  ) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return false;
  },
}));

// Rate limit: always allow (the device/device-token/token routes call this).
vi.mock('~/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn().mockResolvedValue(true),
  sendRateLimitResponse: vi.fn(),
}));

// Audit log: no-op.
vi.mock('~/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('request-ip', () => ({ default: { getClientIp: () => '203.0.113.7' } }));

// Session-cookie reader for device-approve. Controlled per-test.
const mockGetServerAuthSession = vi.hoisted(() => vi.fn());
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

// withAxiom passthrough + axiom log shim (submit-version is wrapped).
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));

// app-blocks flag → ON (it normally calls Flipt). Controlled per-test if needed.
const mockIsAppBlocksEnabled = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));

// The heavy publish service — mock so submit-version doesn't really build a
// bundle. We only need to know it was *reached* (auth+scope+mod all satisfied).
const mockSubmitVersion = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    publishRequestId: 'pubreq_e2e',
    slug: 'my-block',
    version: '1.0.0',
    bundleSha256: 'deadbeef',
    fileSummary: {},
    manifestDiffSummary: {},
  }),
);
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  submitVersion: mockSubmitVersion,
}));

// env for the submit-version route (it dynamically imports ~/env/server).
vi.mock('~/env/server', () => ({
  env: {
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXTAUTH_SECRET: 'test-secret',
    BUNDLE_S3_ENDPOINT: 'https://s3.example',
    BUNDLE_S3_BUCKET: 'bundles',
  },
}));

// session-user: resolve userId → the in-memory user row (bearer-token calls it).
vi.mock('~/server/auth/session-user', () => ({
  getSessionUser: vi.fn(async ({ userId }: { userId?: number }) => {
    if (userId == null) return undefined;
    const u = h.users.get(userId);
    return u ? { id: u.id, isModerator: u.isModerator, bannedAt: u.bannedAt } : undefined;
  }),
}));

// ── In-memory Redis client (drives device.ts, device-approve.ts, device-token.ts
// AND the submit-version rate limiter via sysRedis.multi()).
vi.mock('~/server/redis/client', () => {
  const REDIS_KEYS = {
    OAUTH: {
      AUTHORIZATION_CODES: 'packed:oauth:authorization-codes',
      DEVICE_CODES: 'packed:oauth:device-codes',
      DEVICE_USER_CODES: 'packed:oauth:device-user-codes',
    },
  };
  const REDIS_SYS_KEYS = { BLOCKS: { SUBMIT_RATE_LIMIT: 'system:blocks:submit-rate-limit' } };

  const redis = {
    packed: {
      hSet: vi.fn(async (key: string, hashKey: string, value: unknown) => {
        h.getHash(key).set(hashKey, value);
        return 1;
      }),
      hGet: vi.fn(async (key: string, hashKey: string) => {
        const v = h.getHash(key).get(hashKey);
        return v === undefined ? null : v;
      }),
    },
    hExpire: vi.fn(async () => [1]),
    hDel: vi.fn(async (key: string, hashKey: string) => {
      return h.getHash(key).delete(hashKey) ? 1 : 0;
    }),
    // hSetWithTTL (atomic.ts) uses .eval — not exercised by the device chain but
    // stubbed so any incidental call is harmless.
    eval: vi.fn(async () => 1),
  };

  // sysRedis: only the MULTI rate-limit path + ttl is exercised by submit-version.
  // Counters live in the hoisted `h` so seed() resets them per test.
  const sysRedis = {
    multi: () => {
      let pendingKey = '';
      return {
        set(key: string, _v: string, _opts: unknown) {
          pendingKey = key;
          if (!h.counters.has(key)) h.counters.set(key, 0);
          return this;
        },
        incr(_key?: string) {
          return this;
        },
        async exec() {
          const next = (h.counters.get(pendingKey) ?? 0) + 1;
          h.counters.set(pendingKey, next);
          return ['OK', next];
        },
      };
    },
    ttl: vi.fn().mockResolvedValue(60),
  };

  return { redis, sysRedis, REDIS_KEYS, REDIS_SYS_KEYS };
});

// ── In-memory DB client (oauthClient + apiKey + oauthConsent).
vi.mock('~/server/db/client', () => {
  const now = () => new Date();

  const apiKeyCreate = async ({ data }: { data: any }) => {
    const row = {
      id: h.nextApiKeyIdRef.v++,
      key: data.key,
      name: data.name,
      tokenScope: data.tokenScope,
      userId: data.userId,
      type: data.type,
      expiresAt: data.expiresAt ?? null,
      clientId: data.clientId ?? null,
      lastUsedAt: null,
      buzzLimit: null,
    };
    h.apiKeys.push(row);
    return row;
  };

  const apiKeyFindFirst = async ({ where, select }: { where: any; select?: any }) => {
    const n = now();
    const row = h.apiKeys.find((r) => {
      if (where.key && r.key !== where.key) return false;
      if (where.type && r.type !== where.type) return false;
      // OR: [{ expiresAt: { gte: now } }, { expiresAt: null }]
      if (where.OR) {
        if (!matchesExpiry(r.expiresAt, n)) return false;
      }
      return true;
    });
    if (!row) return null;
    // Honor `select` so callers that select a narrow shape behave like prisma.
    if (select) {
      const out: any = {};
      for (const k of Object.keys(select)) out[k] = (row as any)[k];
      return out;
    }
    return row;
  };

  const apiKeyDeleteMany = async ({ where }: { where: any }) => {
    let count = 0;
    for (let i = h.apiKeys.length - 1; i >= 0; i--) {
      const r = h.apiKeys[i];
      if (where.key !== undefined && r.key !== where.key) continue;
      if (where.type !== undefined && r.type !== where.type) continue;
      if (where.clientId !== undefined && r.clientId !== where.clientId) continue;
      if (where.userId !== undefined && r.userId !== where.userId) continue;
      h.apiKeys.splice(i, 1);
      count++;
    }
    return { count };
  };

  const oauthClientFindUnique = async ({ where, select }: { where: any; select?: any }) => {
    const c = h.oauthClients.get(where.id);
    if (!c) return null;
    if (select) {
      const out: any = {};
      for (const k of Object.keys(select)) out[k] = (c as any)[k];
      return out;
    }
    return c;
  };

  const dbWrite = {
    apiKey: {
      create: vi.fn(apiKeyCreate),
      findFirst: vi.fn(apiKeyFindFirst),
      deleteMany: vi.fn(apiKeyDeleteMany),
      update: vi.fn(async () => ({})),
    },
  };
  const dbRead = {
    // The REAL oauthModel reads tokens via dbRead.apiKey (getAccessToken /
    // getRefreshToken); share the same in-memory store + matcher as dbWrite so
    // a token minted by createOAuthTokenPair (dbWrite) is found on the refresh
    // path (dbRead).
    apiKey: { findFirst: vi.fn(apiKeyFindFirst) },
    oauthClient: { findUnique: vi.fn(oauthClientFindUnique) },
    oauthConsent: { findUnique: vi.fn(async () => null) },
  };
  return { dbRead, dbWrite };
});

// ── @node-oauth/oauth2-server: REAL library (the refresh path runs through it).
// We do NOT mock it — that's the whole point of exercising the real contract.

// Import handlers AFTER mocks.
import deviceHandler from '~/pages/api/auth/oauth/device';
import deviceApproveHandler from '~/pages/api/auth/oauth/device-approve';
import deviceTokenHandler from '~/pages/api/auth/oauth/device-token';
import tokenHandler from '~/pages/api/auth/oauth/token';
import submitVersionHandler from '~/pages/api/v1/blocks/submit-version';
// Real hash fn — same one createOAuthTokenPair/bearer-token use to store/lookup
// keys (reads NEXTAUTH_SECRET from the mocked env). Lets us find a minted row by
// its plaintext token, instead of guessing "most recent".
import { generateSecretHash } from '~/server/utils/key-generator';

const goodBody = { bundleBase64: Buffer.from('zipbytes').toString('base64') };

// ──────────────────────────────────────────────────────────────────────────
// Test fixtures: seed the in-memory tables.
// ──────────────────────────────────────────────────────────────────────────
function seed() {
  h.hashes.clear();
  h.apiKeys.length = 0;
  h.nextApiKeyIdRef.v = 1;
  h.oauthClients.clear();
  h.users.clear();
  h.counters.clear();

  // civitai-cli: public client allowed UserRead|AppBlocksSubmit, device grant.
  h.oauthClients.set(CLI_CLIENT_ID, {
    id: CLI_CLIENT_ID,
    grants: [DEVICE_GRANT, 'refresh_token'],
    redirectUris: [],
    allowedScopes: CLI_SCOPE,
    allowedOrigins: [],
    isConfidential: false,
    secret: null,
    userId: MOD_USER_ID,
  });
  // Pre-existing third-party client: Full scope (no bit 25), device grant.
  h.oauthClients.set(THIRD_PARTY_CLIENT_ID, {
    id: THIRD_PARTY_CLIENT_ID,
    grants: [DEVICE_GRANT, 'refresh_token'],
    redirectUris: [],
    allowedScopes: TokenScope.Full, // 33554431 — excludes AppBlocksSubmit
    allowedOrigins: [],
    isConfidential: false,
    secret: null,
    userId: MOD_USER_ID,
  });

  h.users.set(MOD_USER_ID, { id: MOD_USER_ID, isModerator: true, bannedAt: null });
  h.users.set(NONMOD_USER_ID, { id: NONMOD_USER_ID, isModerator: false, bannedAt: null });
}

// ──────────────────────────────────────────────────────────────────────────
// Small helpers to drive each hop.
// ──────────────────────────────────────────────────────────────────────────
async function deviceInit(client_id: string, scope: string) {
  const { req, res } = createMocks({ body: { client_id, scope } });
  await deviceHandler(req as never, res as never);
  return res;
}

async function approve(user_code: string, session: unknown) {
  mockGetServerAuthSession.mockResolvedValueOnce(session);
  const { req, res } = createMocks({ body: { user_code } });
  await deviceApproveHandler(req as never, res as never);
  return res;
}

async function poll(device_code: string, client_id: string) {
  const { req, res } = createMocks({
    body: { grant_type: DEVICE_GRANT, device_code, client_id },
  });
  await deviceTokenHandler(req as never, res as never);
  return res;
}

async function refresh(refresh_token: string, client_id: string) {
  const { req, res } = createMocks({
    // The REAL @node-oauth/oauth2-server TokenHandler requires the OAuth-spec
    // form content-type + a POST body it can read params from. Its `type-is`
    // check also needs a `content-length` (or transfer-encoding) header to treat
    // the request as having a body — a real Next.js POST always carries one.
    // token.ts builds its library Request straight from req.headers/req.body.
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '128',
    },
    body: { grant_type: 'refresh_token', refresh_token, client_id },
  });
  await tokenHandler(req as never, res as never);
  return res;
}

async function submit(accessToken: string) {
  const { req, res } = createMocks({
    headers: { authorization: `Bearer ${accessToken}` },
    body: goodBody,
  });
  await submitVersionHandler(req as never, res as never);
  return res;
}

// Look up the minted ApiKey row's tokenScope by the PLAINTEXT token string. The
// DB stores the sha512 hash; recompute it the same way createOAuthTokenPair did
// (generateSecretHash) and find the exact row — no "most recent" guessing.
function tokenScopeOf(token: string, type: 'Access' | 'Refresh'): number | undefined {
  const hash = generateSecretHash(token);
  const row = h.apiKeys.find((r) => r.key === hash && r.type === type);
  return row?.tokenScope;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockSubmitVersion.mockResolvedValue({
    publishRequestId: 'pubreq_e2e',
    slug: 'my-block',
    version: '1.0.0',
    bundleSha256: 'deadbeef',
    fileSummary: {},
    manifestDiffSummary: {},
  });
  seed();
});

describe('OAuth device-authorization grant — e2e server contract chain', () => {
  // ────────────────────────────────────────────────────────────────────────
  // HEADLINE: full happy chain init→approve→token→use→refresh→use
  // ────────────────────────────────────────────────────────────────────────
  it('happy path: civitai-cli device grant carries AppBlocksSubmit through every hop', async () => {
    // 1. device init — request 33554433 (UserRead|AppBlocksSubmit).
    const initRes = await deviceInit(CLI_CLIENT_ID, CLI_SCOPE.toString());
    expect(initRes._getStatusCode()).toBe(200);
    const init = initRes._getJSONData() as { device_code: string; user_code: string };
    expect(init.device_code).toBeTruthy();
    expect(init.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // The stored device-code kept bit 25 (didn't clamp to Full).
    const stored = h.getHash('packed:oauth:device-codes').get(init.device_code) as {
      scope: string;
      status: string;
    };
    expect(parseInt(stored.scope, 10) & TokenScope.AppBlocksSubmit).toBe(TokenScope.AppBlocksSubmit);
    expect(stored.status).toBe('pending');

    // 2a. poll BEFORE approve → authorization_pending.
    const pendingRes = await poll(init.device_code, CLI_CLIENT_ID);
    expect(pendingRes._getStatusCode()).toBe(400);
    expect((pendingRes._getJSONData() as { error: string }).error).toBe('authorization_pending');

    // 2b. approve as the MODERATOR session.
    const approveRes = await approve(init.user_code, { user: { id: MOD_USER_ID } });
    expect(approveRes._getStatusCode()).toBe(200);
    expect((approveRes._getJSONData() as { success: boolean }).success).toBe(true);

    // 3. poll AFTER approve → 200 with tokens. SCOPE IS A STRING here.
    const tokenRes = await poll(init.device_code, CLI_CLIENT_ID);
    expect(tokenRes._getStatusCode()).toBe(200);
    const tok = tokenRes._getJSONData() as {
      access_token: string;
      refresh_token: string;
      scope: unknown;
    };
    expect(tok.access_token).toBeTruthy();
    expect(tok.refresh_token).toBeTruthy();
    // CONTRACT: device-token returns scope as a STRING (not an array).
    expect(typeof tok.scope).toBe('string');
    expect(tok.scope).toBe(CLI_SCOPE.toString());

    // The minted ACCESS token row carries AppBlocksSubmit (bit 25 survived the
    // device-token bound + allowedScopes intersection + createOAuthTokenPair).
    const accessScope = tokenScopeOf(tok.access_token, 'Access');
    expect(accessScope! & TokenScope.AppBlocksSubmit).toBe(TokenScope.AppBlocksSubmit);

    // 4. use the access token on submit-version → accepted (mod + scope ok).
    const submitRes = await submit(tok.access_token);
    expect(submitRes._getStatusCode()).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
    // Attribution is the resolved (moderator) user, not the client.
    expect(mockSubmitVersion.mock.calls[0][0].submittedByUserId).toBe(MOD_USER_ID);

    // 5. refresh → 200. SCOPE IS AN ARRAY here (the real library contract).
    const refreshRes = await refresh(tok.refresh_token, CLI_CLIENT_ID);
    expect(refreshRes._getStatusCode()).toBe(200);
    const refreshed = refreshRes._getJSONData() as {
      access_token: string;
      refresh_token: string;
      scope: unknown;
    };
    expect(refreshed.access_token).toBeTruthy();
    // CONTRACT DRIFT (tech-debt to converge — see file header): the refresh route
    // returns scope as an ARRAY, whereas device-token returned a STRING. Pinned to
    // catch SILENT drift; a deliberate convergence PR should update this assertion.
    expect(Array.isArray(refreshed.scope)).toBe(true);
    expect(refreshed.scope).toEqual([CLI_SCOPE.toString()]);

    // The refreshed ACCESS token still carries AppBlocksSubmit (no downscope).
    const refreshedAccessScope = tokenScopeOf(refreshed.access_token, 'Access');
    expect(refreshedAccessScope! & TokenScope.AppBlocksSubmit).toBe(TokenScope.AppBlocksSubmit);

    // 6. the NEW access token is also accepted by submit-version.
    const submit2 = await submit(refreshed.access_token);
    expect(submit2._getStatusCode()).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(2);
  });

  // ────────────────────────────────────────────────────────────────────────
  // NEGATIVE: device grant WITHOUT bit 25 → minted token → submit 403 (scope).
  // ────────────────────────────────────────────────────────────────────────
  it('a device token WITHOUT AppBlocksSubmit is rejected 403 at submit-version (scope gate)', async () => {
    // Request only UserRead (bit 25 omitted). civitai-cli allows it.
    const initRes = await deviceInit(CLI_CLIENT_ID, TokenScope.UserRead.toString());
    expect(initRes._getStatusCode()).toBe(200);
    const init = initRes._getJSONData() as { device_code: string; user_code: string };

    await approve(init.user_code, { user: { id: MOD_USER_ID } });
    const tokenRes = await poll(init.device_code, CLI_CLIENT_ID);
    expect(tokenRes._getStatusCode()).toBe(200);
    const tok = tokenRes._getJSONData() as { access_token: string; scope: string };
    // Scope is UserRead only — no AppBlocksSubmit.
    expect(parseInt(tok.scope, 10) & TokenScope.AppBlocksSubmit).toBe(0);

    const submitRes = await submit(tok.access_token);
    expect(submitRes._getStatusCode()).toBe(403);
    expect((submitRes._getJSONData() as { message: string }).message).toContain(
      'App Blocks submit scope',
    );
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────
  // NEGATIVE: token HAS bit 25 but the resolved user is NON-mod → submit 403.
  // ────────────────────────────────────────────────────────────────────────
  it('a scoped device token whose user is NOT a moderator is rejected 403 at submit-version (mod gate)', async () => {
    const initRes = await deviceInit(CLI_CLIENT_ID, CLI_SCOPE.toString());
    const init = initRes._getJSONData() as { device_code: string; user_code: string };

    // Approve as the NON-moderator user.
    await approve(init.user_code, { user: { id: NONMOD_USER_ID } });
    const tokenRes = await poll(init.device_code, CLI_CLIENT_ID);
    expect(tokenRes._getStatusCode()).toBe(200);
    const tok = tokenRes._getJSONData() as { access_token: string; scope: string };
    // Scope carries the bit (so it passes the scope gate)...
    expect(parseInt(tok.scope, 10) & TokenScope.AppBlocksSubmit).toBe(TokenScope.AppBlocksSubmit);

    // ...but the mod gate still rejects (scope alone is insufficient).
    const submitRes = await submit(tok.access_token);
    expect(submitRes._getStatusCode()).toBe(403);
    expect((submitRes._getJSONData() as { message: string }).message).toContain('civitai team');
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────
  // NEGATIVE: device-token error cases.
  // ────────────────────────────────────────────────────────────────────────
  it('device-token with an unknown device_code → expired_token', async () => {
    const res = await poll('deadbeef-not-a-real-code', CLI_CLIENT_ID);
    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { error: string }).error).toBe('expired_token');
  });

  it('device-token with an EXPIRED device code → expired_token (and the code is purged)', async () => {
    const initRes = await deviceInit(CLI_CLIENT_ID, CLI_SCOPE.toString());
    const init = initRes._getJSONData() as { device_code: string; user_code: string };
    await approve(init.user_code, { user: { id: MOD_USER_ID } });

    // Force the stored code to be expired.
    const hash = h.getHash('packed:oauth:device-codes');
    const data = hash.get(init.device_code) as { expiresAt: string };
    hash.set(init.device_code, { ...data, expiresAt: new Date(Date.now() - 1000).toISOString() });

    const res = await poll(init.device_code, CLI_CLIENT_ID);
    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { error: string }).error).toBe('expired_token');
    // The expired code was deleted.
    expect(hash.has(init.device_code)).toBe(false);
  });

  it('device-token after a DENY → access_denied', async () => {
    const initRes = await deviceInit(CLI_CLIENT_ID, CLI_SCOPE.toString());
    const init = initRes._getJSONData() as { device_code: string };

    // Simulate a deny by flipping the stored status to 'denied'.
    const hash = h.getHash('packed:oauth:device-codes');
    const data = hash.get(init.device_code) as object;
    hash.set(init.device_code, { ...data, status: 'denied' });

    const res = await poll(init.device_code, CLI_CLIENT_ID);
    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { error: string }).error).toBe('access_denied');
  });

  // ────────────────────────────────────────────────────────────────────────
  // NEGATIVE: an existing third-party Full client can't escalate to bit 25.
  // ────────────────────────────────────────────────────────────────────────
  it('a third-party Full-scope client cannot request AppBlocksSubmit (rejected at device init)', async () => {
    // 33554433 requests UserRead|AppBlocksSubmit; the client allows only Full
    // (33554431, no bit 25). The allowedScopes intersection must reject it.
    const res = await deviceInit(THIRD_PARTY_CLIENT_ID, CLI_SCOPE.toString());
    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { error: string }).error).toBe('invalid_scope');
    // Nothing was stored.
    expect(h.getHash('packed:oauth:device-codes').size).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // GUARD: the ALL_SCOPES upper bound actually admits bit 25 (so a regression
  // to `Full` would be caught both here and by the happy-path submit hop).
  // ────────────────────────────────────────────────────────────────────────
  it('sanity: AppBlocksSubmit (bit 25) is within ALL_SCOPES but outside Full', () => {
    expect(CLI_SCOPE).toBeLessThanOrEqual(ALL_SCOPES);
    expect(CLI_SCOPE).toBeGreaterThan(TokenScope.Full);
  });
});
