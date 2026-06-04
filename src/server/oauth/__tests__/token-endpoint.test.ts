import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OriginNotAllowedError } from '~/server/oauth/errors';

// Minimal NextApiRequest/Response stand-in. Same shape used in
// retool-endpoint.test.ts so behaviour stays consistent across OAuth tests.
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
}) {
  const req = { method, headers, body, query } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const responseHeaders: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
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

const { mockOauthToken, mockLogEvent, mockFindUnique } = vi.hoisted(() => ({
  mockOauthToken: vi.fn(),
  mockLogEvent: vi.fn(),
  mockFindUnique: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { oauthClient: { findUnique: mockFindUnique } },
}));

vi.mock('~/server/oauth/server', () => ({
  oauthServer: { token: mockOauthToken },
}));

vi.mock('~/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn().mockResolvedValue(true),
  sendRateLimitResponse: vi.fn(),
}));

vi.mock('~/server/oauth/audit-log', () => ({
  logOAuthEvent: mockLogEvent,
}));

vi.mock('~/server/oauth/constants', () => ({
  ACCESS_TOKEN_TTL: 3600,
}));

// addCorsHeaders pulls in the full server env. Stub to behaviour-only so the
// unit doesn't drag the real env loader in.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  addCorsHeaders: (
    req: { method?: string },
    res: { setHeader: (k: string, v: string) => void; status: (n: number) => { end: () => void } },
    methods: string[]
  ) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return true;
    }
    return false;
  },
}));

vi.mock('request-ip', () => ({
  default: { getClientIp: () => '127.0.0.1' },
}));

// `@node-oauth/oauth2-server` constructs Request/Response objects with internal
// validation we don't care about for this unit. Stub them to passthrough shells
// that preserve the headers field so handler/model can read it.
vi.mock('@node-oauth/oauth2-server', () => ({
  Request: class {
    headers: Record<string, string>;
    body: unknown;
    method: string;
    query: Record<string, string>;
    constructor(init: {
      headers: Record<string, string>;
      body: unknown;
      method: string;
      query: Record<string, string>;
    }) {
      this.headers = init.headers;
      this.body = init.body;
      this.method = init.method;
      this.query = init.query;
    }
  },
  Response: class {
    constructor(public res: unknown) {}
  },
}));

// Import after mocks so the handler picks them up.
import handler from '~/pages/api/auth/oauth/token';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/oauth/token — origin enforcement', () => {
  it('returns 200 + per-origin CORS for a public client on success', async () => {
    // Simulate what oauthModel.getClient does: stash the client on the
    // Request so the handler can read it back for CORS.
    mockOauthToken.mockImplementation(async (request: any) => {
      request.oauthClient = {
        id: 'pub-1',
        isConfidential: false,
        allowedOrigins: ['https://app.example.com'],
      };
      return {
        accessToken: 'at',
        refreshToken: 'rt',
        scope: '1',
        user: { id: 42 },
        accessTokenLifetime: 3600,
      };
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: { origin: 'https://app.example.com' },
      body: { client_id: 'pub-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(res._getHeaders()['Vary']).toBe('Origin');
    expect(res._getHeaders()['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(mockLogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'origin.rejected' })
    );
  });

  it('returns 403 + logs origin.rejected when getClient throws OriginNotAllowedError', async () => {
    mockOauthToken.mockRejectedValue(
      new OriginNotAllowedError('pub-1', 'https://evil.example.com')
    );

    const { req, res } = createMocks({
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
      body: { client_id: 'pub-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toBe('origin_not_allowed');
    // No CORS header set on a rejected origin — browser surfaces a network
    // error rather than reading the 403 body.
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBeUndefined();
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'origin.rejected',
        clientId: 'pub-1',
        metadata: expect.objectContaining({ origin: 'https://evil.example.com', endpoint: 'token' }),
      })
    );
  });

  it('keeps wildcard CORS for confidential clients on success', async () => {
    mockOauthToken.mockImplementation(async (request: any) => {
      request.oauthClient = { id: 'conf-1', isConfidential: true };
      return {
        accessToken: 'at',
        refreshToken: 'rt',
        scope: '1',
        user: { id: 42 },
      };
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: {},
      body: { client_id: 'conf-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBe('*');
  });

  it('keeps wildcard CORS for confidential clients even when an Origin is sent', async () => {
    mockOauthToken.mockImplementation(async (request: any) => {
      request.oauthClient = { id: 'conf-1', isConfidential: true };
      return {
        accessToken: 'at',
        refreshToken: 'rt',
        scope: '1',
        user: { id: 42 },
      };
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: { origin: 'https://random.example.com' },
      body: { client_id: 'conf-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBe('*');
  });

  it('falls back to wildcard CORS on non-origin errors so callers can read the error body', async () => {
    const err = Object.assign(new Error('Invalid grant'), {
      name: 'invalid_grant',
      statusCode: 400,
    });
    mockOauthToken.mockRejectedValue(err);

    const { req, res } = createMocks({
      method: 'POST',
      headers: {},
      body: { client_id: 'conf-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBe('*');
    expect((res._getJSONData() as { error: string }).error).toBe('invalid_grant');
  });

  it('returns 405 for non-POST/OPTIONS methods', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it('handles OPTIONS preflight without invoking the OAuth server', async () => {
    const { req, res } = createMocks({ method: 'OPTIONS' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockOauthToken).not.toHaveBeenCalled();
  });

  it('fails closed with a fallback lookup if the OAuth library skipped stashing', async () => {
    // Simulate a library/grant where getClient didn't run with our wiring —
    // no oauthClient is attached. Handler must do a fallback DB lookup and
    // pick the correct CORS policy rather than defaulting to wildcard.
    mockOauthToken.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      scope: '1',
      user: { id: 42 },
      accessTokenLifetime: 3600,
    });
    mockFindUnique.mockResolvedValueOnce({
      id: 'pub-1',
      isConfidential: false,
      allowedOrigins: ['https://app.example.com'],
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: { origin: 'https://app.example.com' },
      body: { client_id: 'pub-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pub-1' } })
    );
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBe('https://app.example.com');
  });
});
