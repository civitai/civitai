import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as CivitaiAuth from '@civitai/auth';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
const mockDbWrite = dbMock.dbWrite;

/**
 * POST /api/v1/block-tokens for a manifest that opts into hub-minted OAuth
 * tokens (`auth: "oauth"`), behind APP_BLOCK_OAUTH_TOKENS_ENABLED.
 */

const { mockEnv, mockRedis, mockSession, mockTokenService, mockBlockRegistry, mockHub } =
  vi.hoisted(() => ({
    mockEnv: {
      NEXTAUTH_URL: 'https://civitai.com',
      TRPC_ORIGINS: [] as string[],
      BLOCK_TOKEN_PRIVATE_KEY: 'fake-private',
      BLOCK_TOKEN_PUBLIC_KEY: 'fake-public',
      APP_BLOCK_OAUTH_TOKENS_ENABLED: false,
    },
    mockRedis: {
      incrBy: vi.fn(async () => 1),
      expire: vi.fn(async () => true),
      ttl: vi.fn(async () => 60),
    },
    mockSession: { value: null as unknown },
    mockTokenService: {
      sign: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
        token: 'jwt.signed.value',
        expiresAt: '2099-01-01T00:00:00Z',
        jti: 'j',
      })),
      checkRateLimit: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
    },
    mockBlockRegistry: {
      resolveBlockInstance: vi.fn<(...args: any[]) => Promise<any>>(),
      resolvePageBlock: vi.fn<(...args: any[]) => Promise<any>>(),
      resolveDevPageBlockForAuthor: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
      resolveOwnedNonApprovedPageBlock: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    },
    mockHub: {
      mintAppToken: vi.fn<(...args: any[]) => Promise<any>>(),
      syncOauthConsentFromGrant: vi.fn<(...args: any[]) => Promise<any>>(),
    },
  }));

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mockSession.value),
}));
vi.mock('~/server/services/block-token.service', () => ({ BlockTokenService: mockTokenService }));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: mockBlockRegistry,
}));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'rl' } },
}));
vi.mock('~/server/utils/server-domain', () => ({
  getAllServerHosts: () => ['civitai.com'],
  getRequestDomainColor: () => undefined,
  isHostForColor: () => false,
  isMatureContentRating: () => false,
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true, canViewNsfw: false }),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorEnabled: vi.fn(async () => false),
  isAppBlocksDevTunnelEnabled: vi.fn(async () => false),
  isAppBlocksDevTunnelUnsubmittedSpendEnabled: vi.fn(async () => false),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  mintAppToken: mockHub.mintAppToken,
}));
vi.mock('~/server/services/blocks/oauth-consent-sync.service', () => ({
  syncOauthConsentFromGrant: mockHub.syncOauthConsentFromGrant,
  revokeOauthConsentForBlock: vi.fn(),
}));

function makeReq(body: unknown): NextApiRequest {
  return {
    method: 'POST',
    headers: { origin: 'https://civitai.com' },
    body,
    socket: { remoteAddress: '127.0.0.1' },
    query: {},
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    _status: 0,
    _body: null as any,
    setHeader: vi.fn(function (this: any) {
      return this;
    }),
    status: vi.fn(function (this: any, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: any, body: unknown) {
      this._body = body;
      return this;
    }),
    end: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & { _status: number; _body: any };
}

const SCOPES = ['user:read:self', 'models:read:self', 'apps:storage:read'];

const pageBlock = (manifestExtra: Record<string, unknown> = {}) => ({
  appBlock: {
    id: 'apb_page',
    blockId: 'hello-page',
    appId: 'appblk-hello-page',
    status: 'approved',
    currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
    manifest: { scopes: SCOPES, page: { path: '/', title: 'Hello' }, ...manifestExtra },
    approvedScopes: SCOPES,
    app: { allowedScopes: TokenScope.UserRead | TokenScope.ModelsRead },
  },
});

const BODY = {
  blockInstanceId: 'page_apb_page',
  slotContext: { entityType: 'none', slotId: 'app.page' },
};

const VIEWER = { user: { id: 42, isModerator: false, bannedAt: null } };

async function mint() {
  const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
  const res = makeRes();
  await handler(makeReq(BODY), res);
  return res;
}

describe('POST /api/v1/block-tokens — auth: "oauth" manifests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = false;
    mockSession.value = VIEWER;
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: SCOPES,
      revokedAt: null,
    });
    mockHub.syncOauthConsentFromGrant.mockResolvedValue({
      clientId: 'appblk-hello-page',
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
    });
    mockHub.mintAppToken.mockResolvedValue({
      accessToken: 'civ_oauth_access',
      expiresAt: '2099-01-01T00:15:00Z',
      expiresIn: 900,
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
    });
  });

  it('a manifest without `auth` mints the JWT with kind block and never calls the hub', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock());
    const res = await mint();
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ token: 'jwt.signed.value', kind: 'block', scopes: SCOPES });
    expect(mockHub.syncOauthConsentFromGrant).not.toHaveBeenCalled();
    expect(mockHub.mintAppToken).not.toHaveBeenCalled();
  });

  it('auth: "oauth" with the flag off still mints the JWT', async () => {
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
    const res = await mint();
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ token: 'jwt.signed.value', kind: 'block' });
    expect(mockHub.mintAppToken).not.toHaveBeenCalled();
  });

  it('flag on + signed-in viewer mints through the hub with the mapped bits', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
    const res = await mint();
    expect(res._status).toBe(200);
    expect(mockHub.syncOauthConsentFromGrant).toHaveBeenCalledWith({
      userId: 42,
      appBlockId: 'apb_page',
      scopes: expect.arrayContaining(['models:read:self']),
    });
    expect(mockHub.mintAppToken).toHaveBeenCalledWith({
      userId: 42,
      clientId: 'appblk-hello-page',
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
    });
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    expect(res._body).toMatchObject({
      token: 'civ_oauth_access',
      expiresAt: '2099-01-01T00:15:00Z',
      kind: 'oauth',
      scopes: SCOPES,
      needsConsent: false,
      missingScopes: [],
    });
  });

  it('flag on + anonymous viewer keeps the stripped anonymous JWT', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockSession.value = null;
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
    const res = await mint();
    expect(res._status).toBe(200);
    expect(mockHub.mintAppToken).not.toHaveBeenCalled();
    expect(res._body).toMatchObject({
      kind: 'block',
      scopes: ['models:read:self', 'apps:storage:read'],
    });
  });

  it('hub consent_required falls back to the JWT with the consent signal, not a 500', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockHub.mintAppToken.mockRejectedValue(
      Object.assign(new Error('consent_required'), { code: 'consent_required' })
    );
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
    const res = await mint();
    expect(res._status).toBe(200);
    expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
    expect(mockTokenService.sign.mock.calls[0][0].scopes).toEqual([
      'models:read:self',
      'apps:storage:read',
    ]);
    expect(res._body).toMatchObject({
      token: 'jwt.signed.value',
      kind: 'block',
      needsConsent: true,
      missingScopes: ['user:read:self'],
    });
  });

  it('no active grant to mirror is reported as needsConsent', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockHub.syncOauthConsentFromGrant.mockResolvedValue(null);
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
    const res = await mint();
    expect(res._status).toBe(200);
    expect(mockHub.mintAppToken).not.toHaveBeenCalled();
    expect(res._body).toMatchObject({ kind: 'block', needsConsent: true });
  });
});
