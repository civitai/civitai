import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateOauthClient, mockUserFindUnique, mockRateLimit } = vi.hoisted(() => ({
  mockCreateOauthClient: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock('~/env/server', () => ({
  env: { OAUTH_DCR_OWNER_USER_ID: 999, NEXTAUTH_URL: 'https://civitai.com' },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { user: { findUnique: mockUserFindUnique } },
  dbWrite: {},
}));

vi.mock('~/server/oauth/rate-limit', () => ({
  checkRegisterRateLimit: mockRateLimit,
}));

vi.mock('~/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));

vi.mock('~/server/services/oauth-client.service', () => ({
  createOauthClient: mockCreateOauthClient,
  DCR_GRANTS: ['authorization_code', 'refresh_token'],
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  addCorsHeaders: vi.fn().mockReturnValue(false),
}));

vi.mock('request-ip', () => ({ default: { getClientIp: () => '203.0.113.7' } }));

import handler from '../register';

function createMocks(body: unknown, method = 'POST') {
  const req = { method, headers: {}, body, query: {} } as any;
  let statusCode = 200;
  let payload: any = undefined;
  const headers: Record<string, unknown> = {};
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: unknown) {
      headers[k] = v;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(true);
  mockUserFindUnique.mockResolvedValue({ id: 999 });
  mockCreateOauthClient.mockResolvedValue({
    clientId: 'generated-client-id',
    clientSecret: null,
    redirectUris: ['https://app.example.com/cb'],
    allowedOrigins: ['https://app.example.com'],
    allowedScopes: 1,
    grants: ['authorization_code', 'refresh_token'],
    isConfidential: false,
  });
});

describe('POST /register — happy path', () => {
  it('returns 201 with a client_id and NO client_secret', async () => {
    const { req, res } = createMocks({
      redirect_uris: ['https://app.example.com/cb'],
      client_name: 'My MCP App',
      scope: 'models:read media:write',
    });
    await handler(req, res);

    expect(res._status()).toBe(201);
    const body = res._json();
    expect(body.client_id).toBe('generated-client-id');
    expect(body).not.toHaveProperty('client_secret');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types).toEqual(['code']);
    expect(typeof body.scope).toBe('string');
  });

  it('forces a public client with the DCR grants', async () => {
    const { req, res } = createMocks({ redirect_uris: ['http://127.0.0.1:8080/cb'] });
    await handler(req, res);
    expect(mockCreateOauthClient).toHaveBeenCalledWith(
      expect.objectContaining({
        isConfidential: false,
        isDynamicallyRegistered: true,
        userId: 999,
      })
    );
  });
});

describe('POST /register — scope clamp', () => {
  it('drops models:delete (cap excludes Delete scopes)', async () => {
    const { req, res } = createMocks({
      redirect_uris: ['https://app.example.com/cb'],
      scope: 'models:read models:delete',
    });
    await handler(req, res);
    expect(res._status()).toBe(201);
    const passedScopes = mockCreateOauthClient.mock.calls[0][0].allowedScopes as number;
    // ModelsDelete = 1<<4 = 16 must NOT be present; ModelsRead = 1<<2 = 4 must be.
    expect(passedScopes & 16).toBe(0);
    expect(passedScopes & 4).toBe(4);
  });
});

describe('POST /register — redirect_uri allowlist', () => {
  it('rejects non-loopback http with invalid_redirect_uri', async () => {
    const { req, res } = createMocks({ redirect_uris: ['http://evil.example.com/cb'] });
    await handler(req, res);
    expect(res._status()).toBe(400);
    expect(res._json().error).toBe('invalid_redirect_uri');
    expect(mockCreateOauthClient).not.toHaveBeenCalled();
  });

  it('rejects custom scheme', async () => {
    const { req, res } = createMocks({ redirect_uris: ['myapp://cb'] });
    await handler(req, res);
    expect(res._status()).toBe(400);
    expect(res._json().error).toBe('invalid_redirect_uri');
  });
});

describe('POST /register — confidential / client_credentials rejection', () => {
  it('rejects client_credentials grant', async () => {
    const { req, res } = createMocks({
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['client_credentials'],
    });
    await handler(req, res);
    expect(res._status()).toBe(400);
    expect(res._json().error).toBe('invalid_client_metadata');
  });

  it('rejects token_endpoint_auth_method other than none', async () => {
    const { req, res } = createMocks({
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    await handler(req, res);
    expect(res._status()).toBe(400);
    expect(res._json().error).toBe('invalid_client_metadata');
  });
});

describe('POST /register — rate limit', () => {
  it('returns 429 when the IP limit is exceeded', async () => {
    mockRateLimit.mockResolvedValue(false);
    const { req, res } = createMocks({ redirect_uris: ['https://app.example.com/cb'] });
    await handler(req, res);
    expect(res._status()).toBe(429);
    expect(res._json().error).toBe('rate_limit_exceeded');
    expect(mockCreateOauthClient).not.toHaveBeenCalled();
  });
});

describe('POST /register — owner not configured (fail-safe)', () => {
  it('returns 503 temporarily_unavailable when the owner user is missing', async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const { req, res } = createMocks({ redirect_uris: ['https://app.example.com/cb'] });
    await handler(req, res);
    expect(res._status()).toBe(503);
    expect(res._json().error).toBe('temporarily_unavailable');
  });
});
