import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal NextApiRequest/Response stand-in (avoids node-mocks-http), mirroring
// the retool-endpoint test harness.
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
  mockSubmitVersion,
  mockRedis,
  mockMultiIncr,
} = vi.hoisted(() => {
  // `exec()` normally returns ['OK', <count>]. `malformedExec` simulates a Redis
  // hiccup / aborted MULTI where the result is null or short (F3 fail-closed).
  const mockMultiIncr = { value: 1, malformedExec: null as unknown[] | null | false };
  const multiFactory = () => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockImplementation(async () =>
      mockMultiIncr.malformedExec !== false
        ? mockMultiIncr.malformedExec
        : ['OK', mockMultiIncr.value]
    ),
  });
  return {
    mockGetSession: vi.fn(),
    mockIsAppBlocksEnabled: vi.fn(),
    mockSubmitVersion: vi.fn(),
    mockRedis: { multi: vi.fn(multiFactory), ttl: vi.fn().mockResolvedValue(60) },
    mockMultiIncr,
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: mockGetSession,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockRedis,
  REDIS_SYS_KEYS: { BLOCKS: { SUBMIT_RATE_LIMIT: 'blocks:submit-rate-limit' } },
}));
// The route dynamically imports env + the service; mock both so the heavy
// dependency tree never loads in the unit test.
vi.mock('~/env/server', () => ({
  env: { BUNDLE_S3_ENDPOINT: 'https://s3.example', BUNDLE_S3_BUCKET: 'bundles' },
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  submitVersion: mockSubmitVersion,
}));
// The schema module is real (we want its actual validation), but it pulls only
// zod — safe to load.

import handler from '../submit-version';

// Personal-access (user-type) key: `getSessionFromBearerToken` sets
// subject = { type: 'apiKey' } when the ApiKey row has clientId == null.
const MOD_SESSION = {
  user: { id: 7, isModerator: true },
  apiKeyId: 42,
  subject: { type: 'apiKey', id: 42 },
};
const NONMOD_SESSION = {
  user: { id: 8, isModerator: false },
  apiKeyId: 43,
  subject: { type: 'apiKey', id: 43 },
};
// OAuth-client-issued key: subject = { type: 'oauth', id: clientId }. The user
// is a moderator, so ONLY the personal-key gate should reject this.
const OAUTH_MOD_SESSION = {
  user: { id: 7, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'client_abc' },
};
const goodBody = { bundleBase64: Buffer.from('zipbytes').toString('base64') };

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  mockMultiIncr.malformedExec = false;
  mockRedis.ttl.mockResolvedValue(60);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockSubmitVersion.mockResolvedValue({
    publishRequestId: 'pubreq_abc',
    slug: 'my-block',
    version: '1.2.3',
    bundleSha256: 'deadbeef',
    fileSummary: {},
    manifestDiffSummary: {},
  });
});

describe('POST /api/v1/blocks/submit-version (token auth)', () => {
  it('405 for non-POST', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it('401 when Authorization header is missing', async () => {
    const { req, res } = createMocks({ body: goodBody });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('401 when the bearer token does not resolve to a session (invalid key)', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer bad-key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('403 when the resolved user is NOT a moderator', async () => {
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('403 when the resolved user is banned even if isModerator', async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: 9, isModerator: true, bannedAt: new Date() },
      apiKeyId: 44,
    });
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('403 when the key is OAuth-client-issued (subject.type === "oauth") even if the user is a mod', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer oauth-client-key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('personal API key');
    // Must reject BEFORE the heavy publish path runs.
    expect(mockSubmitVersion).not.toHaveBeenCalled();
    // Must reject BEFORE the flag check / rate-limit round-trip (no leak).
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockRedis.multi).not.toHaveBeenCalled();
  });

  it('passes the personal-key gate when subject.type is "apiKey" (user-type key) + mod', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer personal-key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
  });

  it('503 when the App Blocks flag is OFF for the user', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('429 when the per-key rate limit is exceeded', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 11; // > RATE_LIMIT.max (10)
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBeDefined();
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('F3: 503 (fail closed, NOT bypass) when exec() returns null (malformed limiter)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.malformedExec = null;
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    // The whole point: a malformed counter must NOT silently pass through to the
    // heavy publish path (the NaN > max fail-open bug).
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('F3: 503 (fail closed) when exec() returns a short array (missing INCR slot)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.malformedExec = ['OK']; // INCR reply absent → Number(undefined) = NaN
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('400 when the body fails the bundle schema', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: { bundleBase64: '' }, // min(1) fails
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('valid key + mod + flag-on → calls submitVersion and returns the CLI contract', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good-key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    // Reuses the shared service UNCHANGED (asserts it's called, not reimplemented).
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
    const callArg = mockSubmitVersion.mock.calls[0][0];
    expect(callArg.submittedByUserId).toBe(7);
    expect(Buffer.isBuffer(callArg.bundleBuffer)).toBe(true);
    // Stable CLI response contract.
    expect(res._getJSONData()).toEqual({
      publishRequestId: 'pubreq_abc',
      slug: 'my-block',
      version: '1.2.3',
      status: 'pending',
    });
  });

  it('surfaces a service-thrown error as 400', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockSubmitVersion.mockRejectedValueOnce(new Error('bundle exceeds 50 MiB'));
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { message: string }).message).toContain('50 MiB');
  });
});
