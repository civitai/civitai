import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Verifies the device-flow plumbing change: a device code approved with the
// opt-in AppBlocksSubmit bit (which exceeds TokenScope.Full) survives the
// device-token endpoint's scope bound + per-client allowedScopes intersection
// and reaches createOAuthTokenPair INTACT (so the minted token carries the bit).
// Before the ALL_SCOPES fix, the `rawScope > TokenScope.Full` bound rejected it
// with invalid_scope.

function createMocks({ body = {} }: { body?: unknown }) {
  const req = { method: 'POST', headers: {}, body } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {},
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
  };
  return { req, res };
}

const { mockHGet, mockHDel, mockCreatePair, mockClientFindUnique } = vi.hoisted(() => ({
  mockHGet: vi.fn(),
  mockHDel: vi.fn().mockResolvedValue(undefined),
  mockCreatePair: vi.fn(),
  mockClientFindUnique: vi.fn(),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/endpoint-helpers', () => ({ addCorsHeaders: () => false }));
vi.mock('~/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn().mockResolvedValue(true),
  sendRateLimitResponse: vi.fn(),
}));
vi.mock('~/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('~/server/redis/client', () => ({
  redis: { packed: { hGet: mockHGet }, hDel: mockHDel },
  REDIS_KEYS: { OAUTH: { DEVICE_CODES: 'oauth:device-codes' } },
}));
vi.mock('~/server/oauth/token-helpers', () => ({ createOAuthTokenPair: mockCreatePair }));
vi.mock('~/server/db/client', () => ({
  dbRead: { oauthClient: { findUnique: mockClientFindUnique } },
}));
vi.mock('request-ip', () => ({ default: { getClientIp: () => '203.0.113.7' } }));

import handler from '~/pages/api/auth/oauth/device-token';

const CLI_SCOPE = TokenScope.UserRead | TokenScope.AppBlocksSubmit; // 33554433

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePair.mockResolvedValue({
    accessToken: 'civitai_access',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshToken: 'civitai_refresh',
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
  });
});

describe('device-token endpoint — AppBlocksSubmit scope survives into the minted token', () => {
  it('mints a token carrying AppBlocksSubmit when the approved device code requested it', async () => {
    mockHGet.mockResolvedValueOnce({
      clientId: 'civitai-cli',
      userCode: 'ABCD-EFGH',
      scope: CLI_SCOPE.toString(),
      status: 'approved',
      userId: 7,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // Client allows exactly UserRead|AppBlocksSubmit.
    mockClientFindUnique.mockResolvedValueOnce({ allowedScopes: CLI_SCOPE });

    const { req, res } = createMocks({
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'devcode',
        client_id: 'civitai-cli',
      },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    // The scope bound (now ALL_SCOPES) did NOT reject the bit-25 value.
    expect(res._getJSONData()).toMatchObject({
      token_type: 'Bearer',
      scope: CLI_SCOPE.toString(),
    });
    const json = res._getJSONData() as { refresh_token: string; expires_in: number };
    expect(json.refresh_token).toBe('civitai_refresh');
    expect(json.expires_in).toBe(3600);
    // createOAuthTokenPair received the scope INTACT (bit 25 preserved).
    expect(mockCreatePair).toHaveBeenCalledTimes(1);
    expect(mockCreatePair).toHaveBeenCalledWith(7, 'civitai-cli', CLI_SCOPE);
  });

  it('rejects when the client allowedScopes does NOT include AppBlocksSubmit', async () => {
    mockHGet.mockResolvedValueOnce({
      clientId: 'civitai-cli',
      userCode: 'ABCD-EFGH',
      scope: CLI_SCOPE.toString(),
      status: 'approved',
      userId: 7,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // Client only allows UserRead — intersection must reject the submit bit.
    mockClientFindUnique.mockResolvedValueOnce({ allowedScopes: TokenScope.UserRead });

    const { req, res } = createMocks({
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'devcode',
        client_id: 'civitai-cli',
      },
    });
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { error: string }).error).toBe('invalid_scope');
    expect(mockCreatePair).not.toHaveBeenCalled();
  });
});
