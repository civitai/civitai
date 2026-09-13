import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal NextApiRequest/Response stand-in (avoids node-mocks-http), mirroring
// the moderator-endpoint test harness.
function createMocks({
  method = 'POST',
  headers = {},
  body = {},
  rawBody,
  declaredLength,
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer;
  declaredLength?: number | null;
}) {
  // The route sets `bodyParser: false` and reads the stream itself, so a request here
  // must be ASYNC-ITERABLE rather than carrying a pre-parsed `body`. `rawBody` /
  // `declaredLength` let a size case diverge from that default deliberately:
  //   - rawBody         : send these exact bytes instead of JSON.stringify(body)
  //   - declaredLength  : announce a Content-Length that differs from what is sent,
  //                       which is how an in-transit truncation is simulated.
  const sent = rawBody ?? Buffer.from(JSON.stringify(body), 'utf8');
  const announced = declaredLength ?? sent.byteLength;
  const req = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(announced === null ? {} : { 'content-length': String(announced) }),
      ...headers,
    },
    socket: { remoteAddress: '203.0.113.7' },
    [Symbol.asyncIterator]: async function* () {
      if (sent.byteLength > 0) yield sent;
    },
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
  mockIsAppBlocksAuthorEnabled,
  mockSubmitVersion,
  mockRedis,
  mockMultiIncr,
  mockWithSysReadDeadline,
  sysDeadline,
} = vi.hoisted(() => {
  // `exec()` normally returns ['OK', <count>]. `malformedExec` simulates a Redis
  // hiccup / aborted MULTI where the result is null or short (F3 fail-closed).
  // `hangExec` (#28) simulates a SILENT half-open where `.exec()` never settles —
  // withSysReadDeadline must reject it within the deadline → fail closed (503).
  const mockMultiIncr = {
    value: 1,
    malformedExec: null as unknown[] | null | false,
    hangExec: false,
  };
  const multiFactory = () => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockImplementation(async () => {
      if (mockMultiIncr.hangExec) return new Promise(() => {}); // never settles
      return mockMultiIncr.malformedExec !== false
        ? mockMultiIncr.malformedExec
        : ['OK', mockMultiIncr.value];
    }),
  });
  // Faithful stand-in for the real withSysReadDeadline (sys-read-deadline.ts): race
  // the wrapped promise against a rejecting timer; `<= 0` disables (no-op). A tiny
  // default ms keeps the never-settles tests fast without fake timers.
  const sysDeadline = { ms: 50 };
  const mockWithSysReadDeadline = <T>(p: Promise<T>, ms = sysDeadline.ms): Promise<T> => {
    if (!ms || ms <= 0) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sysRedis read timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
  return {
    mockGetSession: vi.fn(),
    mockIsAppBlocksEnabled: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
    mockSubmitVersion: vi.fn(),
    mockRedis: { multi: vi.fn(multiFactory), ttl: vi.fn().mockResolvedValue(60) },
    mockMultiIncr,
    mockWithSysReadDeadline,
    sysDeadline,
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: mockGetSession,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
// 🔴 Spread the REAL package for the key constants rather than re-typing them. The
// hand-typed SUBMIT_RATE_LIMIT here read 'blocks:submit-rate-limit' while production uses
// 'system:blocks:submit-rate-limit', so the rate-limit path was exercised against a key
// Redis never sees. Client and control surface stay overridden.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  sysRedis: mockRedis,
  withSysReadDeadline: mockWithSysReadDeadline,
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

import handler from '~/pages/api/v1/blocks/submit-version';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Personal-access (user-type) key: `getSessionFromBearerToken` sets
// subject = { type: 'apiKey' } when the ApiKey row has clientId == null.
// tokenScope = Full is what real personal keys persist; the value is irrelevant
// to the type gate for personal keys (they pass regardless of scope).
const MOD_SESSION = {
  user: { id: 7, isModerator: true },
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
// OAuth-client-issued key WITHOUT the AppBlocksSubmit scope: subject =
// { type: 'oauth', id: clientId }. Even though the user is a moderator, the
// missing scope must reject this at the token-type gate.
const OAUTH_MOD_NO_SCOPE_SESSION = {
  user: { id: 7, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'client_abc' },
  tokenScope: TokenScope.UserRead | TokenScope.ModelsRead, // no AppBlocksSubmit
};
// OAuth-client-issued key WITH the AppBlocksSubmit scope + a moderator user:
// this is the new accepted path (the civitai-cli case).
const OAUTH_MOD_SCOPED_SESSION = {
  user: { id: 7, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'civitai-cli' },
  tokenScope: TokenScope.UserRead | TokenScope.AppBlocksSubmit,
};
// OAuth-client-issued key WITH the scope but a NON-moderator user: the mod gate
// must still reject (scope alone does not bypass the mod requirement).
const OAUTH_NONMOD_SCOPED_SESSION = {
  user: { id: 8, isModerator: false },
  apiKeyId: 100,
  subject: { type: 'oauth', id: 'civitai-cli' },
  tokenScope: TokenScope.UserRead | TokenScope.AppBlocksSubmit,
};
const goodBody = { bundleBase64: Buffer.from('zipbytes').toString('base64') };

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  mockMultiIncr.malformedExec = false;
  mockMultiIncr.hangExec = false;
  sysDeadline.ms = 50;
  mockRedis.ttl.mockResolvedValue(60);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  // Author gate mirrors the mod floor by default; the widening test overrides it.
  mockIsAppBlocksAuthorEnabled.mockImplementation(async (opts) => !!opts?.user?.isModerator);
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

  it('403 when the resolved user is NOT an app author (non-mod, no cohort grant)', async () => {
    // Default author mock = mod floor only → a random non-mod is denied on the
    // authz line (developer soft-launch: authoring stays gated).
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('accepts an author-capable NON-MOD (cohort widening): passes the authz line', async () => {
    // A curated non-mod author granted the `app-blocks-author` capability is NOT
    // rejected on the authz line — the submit proceeds through the flag +
    // rate-limit gates to the real service.
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    mockIsAppBlocksAuthorEnabled.mockResolvedValueOnce(true);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
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

  it('403 when the key is OAuth-client-issued WITHOUT the AppBlocksSubmit scope, even if the user is a mod', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_MOD_NO_SCOPE_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer oauth-client-key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('Apps submit scope');
    // Must reject BEFORE the heavy publish path runs.
    expect(mockSubmitVersion).not.toHaveBeenCalled();
    // Must reject BEFORE the flag check / rate-limit round-trip (no leak).
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockRedis.multi).not.toHaveBeenCalled();
  });

  it('accepts an OAuth-client-issued key WITH the AppBlocksSubmit scope + mod (the civitai-cli path)', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_MOD_SCOPED_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer oauth-cli-token' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledTimes(1);
    // Attribution is the resolved user, not the client.
    expect(mockSubmitVersion.mock.calls[0][0].submittedByUserId).toBe(7);
  });

  it('403 for an OAuth key WITH the AppBlocksSubmit scope but a NON-moderator user (mod gate still holds)', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_NONMOD_SCOPED_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer oauth-cli-token' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    // Rejected by the mod gate (not the scope gate) — scope alone is insufficient.
    expect((res._getJSONData() as { message: string }).message).toContain('Civitai team');
    expect(mockSubmitVersion).not.toHaveBeenCalled();
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

  it('#28: 503 (fail closed) when the rate-limit exec() HANGS (silent half-open never settles) — deadline-bounded, no park', async () => {
    // The #28 root cause: this route's raw sysRedis MULTI runs on the critical path
    // with NO try/catch. On a silent half-open the written command parks the handler
    // (no throw). withSysReadDeadline races the never-settling exec() → rejects → the
    // new try/catch fails closed (503) instead of hanging ~11min to TCP keepalive.
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.hangExec = true;
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never); // must RESOLVE (not hang)
    expect(res._getStatusCode()).toBe(503);
    // A hung limiter must never silently bypass the heavy publish path.
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('#28: 429 path does not park when the retry-after sysRedis.ttl HANGS — falls back to the window', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 11; // > RATE_LIMIT.max (10)
    mockRedis.ttl.mockReturnValueOnce(new Promise(() => {})); // never settles
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: goodBody,
    });
    await handler(req as never, res as never); // must RESOLVE
    expect(res._getStatusCode()).toBe(429);
    // Fallback Retry-After = RATE_LIMIT.windowSeconds (60).
    expect(res._getHeaders()['Retry-After']).toBe('60');
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

  // ---------------------------------------------------------------------------
  // #4059 build provenance. 🔴 THIS is the route the `civitai` CLI posts to —
  // the session route beside it is the mod-browser front door. Wiring only that
  // one would leave the CLI's provenance silently stripped, which is exactly the
  // inert-feature shape #4059 exists to close. Both routes are wired; both are
  // pinned.
  // ---------------------------------------------------------------------------
  const SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';

  it('passes sourceCommit + sourceDirty through to the service verbatim', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good-key' },
      body: { ...goodBody, sourceCommit: SHA, sourceDirty: true },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const callArg = mockSubmitVersion.mock.calls[0][0];
    expect(callArg.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    expect(callArg.sourceDirty).toBe(true);
  });

  it('passes sourceDirty:false through as FALSE, not as absent', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good-key' },
      body: { ...goodBody, sourceCommit: SHA, sourceDirty: false },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSubmitVersion.mock.calls[0][0].sourceDirty).toBe(false);
  });

  it('a submit with NO provenance still reaches the service with both undefined', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good-key' },
      body: goodBody,
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const callArg = mockSubmitVersion.mock.calls[0][0];
    expect(callArg.sourceCommit).toBeUndefined();
    expect(callArg.sourceDirty).toBeUndefined();
  });

  // 🔴 JSON `null` = UNKNOWN, and it MUST NOT 400. Asserted at the ROUTE and not
  // only at the schema: the schema test exercises one surface, and "verified in
  // isolation" is how a seam defect survives. This is the surface an actual CLI
  // hits, and a 400 here rejects the WHOLE SUBMIT over an advisory field.
  it('JSON null on both provenance fields is a 200 (UNKNOWN), reaching the service as undefined', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good-key' },
      body: { ...goodBody, sourceCommit: null, sourceDirty: null },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSubmitVersion).toHaveBeenCalledOnce();
    const callArg = mockSubmitVersion.mock.calls[0][0];
    // undefined, NOT null — undefined is what makes Prisma omit the column.
    expect(callArg.sourceCommit).toBeUndefined();
    expect(callArg.sourceDirty).toBeUndefined();
    expect(callArg.sourceCommit).not.toBeNull();
    expect(callArg.sourceDirty).not.toBeNull();
  });

  it('JSON null on ONE field does not take a valid SIBLING down with it', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer good-key' },
      body: { ...goodBody, sourceCommit: SHA, sourceDirty: null },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const callArg = mockSubmitVersion.mock.calls[0][0];
    expect(callArg.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    expect(callArg.sourceDirty).toBeUndefined();
  });

  it('400s a malformed sourceCommit with a message NAMING the field, and never submits', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: { ...goodBody, sourceCommit: 'not-a-sha' },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    const msg = (res._getJSONData() as { message: string }).message;
    expect(msg).toContain('sourceCommit');
    expect(msg).not.toBe('Invalid bundle payload');
    expect(mockSubmitVersion).not.toHaveBeenCalled();
  });

  it('BUNDLE rejections keep the exact legacy message (unchanged by #4059)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = createMocks({
      headers: { authorization: 'Bearer key' },
      body: { bundleBase64: '' },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ message: 'Invalid bundle payload' });
  });

  // civitai/cli #423: an oversize bundle used to return `400 Invalid JSON` — an error
  // about the PARSE, downstream of the real cause — because the proxy truncated the body
  // and Next's parser saw half a document. These pin the SIZE error that replaced it.
  //
  // 🔴 Regression guards, red against the pre-change route: it declared
  // `bodyParser: { sizeLimit: '72mb' }` and never inspected Content-Length, so the
  // oversize cases below reached the schema and answered 400, not 413.
  describe('oversize and truncated bodies answer with a SIZE error (cli #423)', () => {
    // Each case authenticates: the size refusal sits AFTER the auth gate on purpose, so
    // an unauthenticated oversize request is rejected 401 and its body is never read.
    it('refuses on the declared Content-Length WITHOUT reading the body', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      let pulled = 0;
      const { req, res } = createMocks({
        headers: { authorization: 'Bearer key' },
        body: goodBody,
      });
      // Replace the iterator so consumption is observable: a status code cannot witness
      // "did not read", and reading-then-measuring is the thing that cannot work here.
      (req as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<Buffer> })[
        Symbol.asyncIterator
      ] = async function* () {
        pulled += 1;
        yield Buffer.from('{}');
      };
      (req as { headers: Record<string, string> }).headers['content-length'] = String(12_000_000);

      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(413);
      expect(pulled).toBe(0);
      expect(String((res._getJSONData() as { message: string }).message)).toContain('12000000');
    });

    it('refuses a body that OVERRUNS the cap with no Content-Length (chunked)', async () => {
      // A chunked request announces nothing, so only the running total can catch it.
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const { req, res } = createMocks({
        headers: { authorization: 'Bearer key' },
        rawBody: Buffer.alloc(11 * 1024 * 1024, 0x61),
        declaredLength: null,
      });

      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(413);
    });

    it('refuses a body TRUNCATED in transit — arrived shorter than announced', async () => {
      // Exactly the proxy's behaviour: the header still states what the client sent,
      // the bytes do not. Parsing this could fail confusingly or, on an unlucky cut,
      // succeed on a partial bundle.
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const full = Buffer.from(JSON.stringify(goodBody), 'utf8');
      const { req, res } = createMocks({
        headers: { authorization: 'Bearer key' },
        rawBody: full.subarray(0, full.byteLength - 10),
        declaredLength: full.byteLength,
      });

      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(413);
      expect(String((res._getJSONData() as { message: string }).message)).toContain('truncated');
    });

    it('still answers 400 for genuinely malformed JSON, not 413', async () => {
      // The size errors must not swallow the ordinary parse failure — that would trade
      // one misleading message for another.
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const { req, res } = createMocks({
        headers: { authorization: 'Bearer key' },
        rawBody: Buffer.from('{"bundleBase64":', 'utf8'),
      });

      await handler(req as never, res as never);

      expect(res._getStatusCode()).toBe(400);
    });
  });
});
