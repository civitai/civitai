import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { mockFindUnique, mockOauthToken, mockLogEvent } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockOauthToken: vi.fn(),
  mockLogEvent: vi.fn(),
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

// addCorsHeaders pulls in the full server env. Stub it to a behaviour-only
// double so we don't drag the real env loader into a unit test.
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
// validation we don't care about for this unit. Stub them to passthrough shells.
vi.mock('@node-oauth/oauth2-server', () => ({
  Request: class {
    constructor(public init: unknown) {}
  },
  Response: class {
    constructor(public res: unknown) {}
  },
}));

// Import after mocks so the handler picks them up.
import handler from '../token';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/oauth/token — origin enforcement', () => {
  it('returns 200 for a public client when Origin is in allowedOrigins', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'pub-1',
      isConfidential: false,
      allowedOrigins: ['https://app.example.com'],
    });
    mockOauthToken.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      scope: '1',
      user: { id: 42 },
      accessTokenLifetime: 3600,
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
    expect(res._getHeaders()['Access-Control-Allow-Credentials']).toBe('true');
    expect(mockLogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'origin.rejected' })
    );
  });

  it('returns 403 for a public client when Origin is not in allowedOrigins', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'pub-1',
      isConfidential: false,
      allowedOrigins: ['https://app.example.com'],
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
      body: { client_id: 'pub-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toBe('origin_not_allowed');
    expect(mockOauthToken).not.toHaveBeenCalled();
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'origin.rejected', clientId: 'pub-1' })
    );
  });

  it('returns 403 for a public client when Origin header is missing', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'pub-1',
      isConfidential: false,
      allowedOrigins: ['https://app.example.com'],
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: {},
      body: { client_id: 'pub-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect(mockOauthToken).not.toHaveBeenCalled();
  });

  it('keeps wildcard CORS for confidential clients regardless of Origin', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'conf-1',
      isConfidential: true,
      allowedOrigins: [],
    });
    mockOauthToken.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      scope: '1',
      user: { id: 42 },
    });

    const { req, res } = createMocks({
      method: 'POST',
      headers: {},
      body: { client_id: 'conf-1', grant_type: 'authorization_code' },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    // The stubbed addCorsHeaders always emits the wildcard.
    expect(res._getHeaders()['Access-Control-Allow-Origin']).toBe('*');
  });

  it('keeps wildcard CORS for confidential clients even when an Origin is sent', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'conf-1',
      isConfidential: true,
      allowedOrigins: [],
    });
    mockOauthToken.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      scope: '1',
      user: { id: 42 },
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

  it('returns 405 for non-POST/OPTIONS methods', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it('handles OPTIONS preflight without touching the client lookup', async () => {
    const { req, res } = createMocks({ method: 'OPTIONS' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
