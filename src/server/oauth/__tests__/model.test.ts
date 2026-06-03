import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OriginNotAllowedError } from '~/server/oauth/errors';

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { oauthClient: { findUnique: mockFindUnique } },
  dbWrite: { apiKey: {} },
}));

vi.mock('~/server/redis/client', () => ({
  redis: { packed: {}, hExpire: vi.fn(), hDel: vi.fn() },
  REDIS_KEYS: { OAUTH: {} },
}));

vi.mock('~/server/utils/key-generator', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
}));

vi.mock('~/server/oauth/constants', () => ({
  ACCESS_TOKEN_TTL: 3600,
  AUTH_CODE_TTL: 600,
  REFRESH_TOKEN_TTL: 2592000,
}));

vi.mock('~/server/oauth/token-helpers', () => ({
  createOAuthTokenPair: vi.fn(),
}));

vi.mock('~/shared/utils/flags', () => ({ Flags: { hasFlag: () => true } }));
vi.mock('~/shared/constants/token-scope.constants', () => ({
  TokenScope: { Full: 33554431, UserRead: 1 },
}));

import { oauthModel } from '../model';

const baseClient = {
  id: 'pub-1',
  isConfidential: false,
  secret: null,
  grants: ['authorization_code', 'refresh_token'],
  redirectUris: ['https://app.example.com/cb'],
  allowedOrigins: ['https://app.example.com'],
  allowedScopes: 33554431,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// Token-exchange requests are detected by the presence of `grant_type` in
// the body. Authorize-flow requests have `response_type` instead.
const tokenExchangeBody = { grant_type: 'authorization_code', code: 'abc' };
const authorizeBody = { response_type: 'code', code_challenge: 'x' };

describe('oauthModel.getClient — origin enforcement', () => {
  it('returns enriched Client and stashes record on Request when origin matches', async () => {
    mockFindUnique.mockResolvedValue(baseClient);
    const request: any = {
      headers: { origin: 'https://app.example.com' },
      body: tokenExchangeBody,
    };

    const client = await oauthModel.getClient('pub-1', null, request);

    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
    expect(request.oauthClient).toMatchObject({
      id: 'pub-1',
      allowedOrigins: ['https://app.example.com'],
    });
  });

  it('throws OriginNotAllowedError when public client Origin is not allowlisted', async () => {
    mockFindUnique.mockResolvedValue(baseClient);
    const request: any = {
      headers: { origin: 'https://evil.example.com' },
      body: tokenExchangeBody,
    };

    await expect(oauthModel.getClient('pub-1', null, request)).rejects.toBeInstanceOf(
      OriginNotAllowedError
    );
  });

  it('allows public client request with no Origin header (native/mobile path)', async () => {
    // Native/mobile public clients don't send an Origin. We still want them
    // to share an OAuth client with their browser SPA counterpart so the
    // end user only consents once.
    mockFindUnique.mockResolvedValue(baseClient);
    const request: any = { headers: {}, body: tokenExchangeBody };

    const client = await oauthModel.getClient('pub-1', null, request);
    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
  });

  it('throws OriginNotAllowedError when a browser sends an Origin not on the allowlist (empty allowlist)', async () => {
    // Owner registered no origins but a browser still calls in with one —
    // can't be a legitimate registered SPA, reject.
    mockFindUnique.mockResolvedValue({ ...baseClient, allowedOrigins: [] });
    const request: any = {
      headers: { origin: 'https://random.example.com' },
      body: tokenExchangeBody,
    };

    await expect(oauthModel.getClient('pub-1', null, request)).rejects.toBeInstanceOf(
      OriginNotAllowedError
    );
  });

  it('skips origin enforcement for confidential clients', async () => {
    mockFindUnique.mockResolvedValue({
      ...baseClient,
      isConfidential: true,
      secret: 'hash:s3cret',
      allowedOrigins: [],
    });
    const request: any = {
      headers: { origin: 'https://random.example.com' },
      body: tokenExchangeBody,
    };

    const client = await oauthModel.getClient('conf-1', 's3cret', request);
    expect(client).toMatchObject({ isConfidential: true });
  });

  it('skips origin enforcement when called without a request (legacy authorize callers)', async () => {
    mockFindUnique.mockResolvedValue(baseClient);

    const client = await oauthModel.getClient('pub-1', null);
    expect(client).toMatchObject({ id: 'pub-1' });
  });

  it('allows native client with no Origin even when allowlist is empty', async () => {
    // No allowlist configured + no Origin (native PKCE call) — must pass.
    mockFindUnique.mockResolvedValue({ ...baseClient, allowedOrigins: [] });
    const request: any = { headers: {}, body: tokenExchangeBody };

    const client = await oauthModel.getClient('native-1', null, request);
    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
  });

  it('skips origin enforcement on the authorize flow (no grant_type in body)', async () => {
    mockFindUnique.mockResolvedValue(baseClient);
    // /authorize constructs a synthetic Request with no Origin header. The
    // public-client check must not fire here — the flow is a top-level
    // browser nav, not an XHR.
    const request: any = {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: authorizeBody,
    };

    const client = await oauthModel.getClient('pub-1', null, request);
    expect(client).toMatchObject({ id: 'pub-1', isConfidential: false });
  });

  it('returns false when the client does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);
    const client = await oauthModel.getClient('nope', null, { headers: {} } as any);
    expect(client).toBe(false);
  });

  it('returns false for confidential client with wrong secret', async () => {
    mockFindUnique.mockResolvedValue({
      ...baseClient,
      isConfidential: true,
      secret: 'hash:right',
    });
    const client = await oauthModel.getClient('conf-1', 'wrong', { headers: {} } as any);
    expect(client).toBe(false);
  });
});
