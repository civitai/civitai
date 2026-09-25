import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as CivitaiAuth from '@civitai/auth';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockRedis = redisMock.redis;
redisMock.redis.incrBy.mockImplementation(async () => 1);
redisMock.redis.expire.mockImplementation(async () => true);
redisMock.redis.ttl.mockImplementation(async () => 60);
const mockDbWrite = dbMock.dbWrite;

/**
 * POST /api/v1/block-tokens for a manifest that opts into hub-minted OAuth
 * tokens (`auth: "oauth"`), behind APP_BLOCK_OAUTH_TOKENS_ENABLED.
 */

const { mockEnv, mockSession, mockTokenService, mockBlockRegistry, mockHub } = vi.hoisted(() => ({
  mockEnv: {
    NEXTAUTH_URL: 'https://civitai.com',
    TRPC_ORIGINS: [] as string[],
    BLOCK_TOKEN_PRIVATE_KEY: 'fake-private',
    BLOCK_TOKEN_PUBLIC_KEY: 'fake-public',
    APP_BLOCK_OAUTH_TOKENS_ENABLED: false,
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
// Needed only by the REAL consent mirror, which the last describe below swaps in via
// `vi.importActual` — the real module imports these at module scope.
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: vi.fn(async () => undefined),
  deleteAuthSubject: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
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

  // ⚠ NARROWED (#5127). This pins ONE thing: the endpoint's WIRING for a null mirror
  // — `consent_required` → block JWT + consent signal, never a 500. It says nothing
  // about WHEN the mirror returns null, because the mirror is mocked here, and
  // believing otherwise is exactly how #5127 shipped: this case used to be titled "no
  // active grant to mirror", and the stub returned `null` for a missing grant row
  // while the real function returned a freshly-written consent row carrying
  // `UserRead`. The `describe` below exercises the real mirror for that case.
  it('a null mirror falls back to the JWT with the consent signal rather than a 500', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockHub.syncOauthConsentFromGrant.mockResolvedValue(null);
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
    const res = await mint();
    expect(res._status).toBe(200);
    expect(mockHub.mintAppToken).not.toHaveBeenCalled();
    expect(res._body).toMatchObject({ kind: 'block', needsConsent: true });
  });

  /**
   * #5127 — the REAL `syncOauthConsentFromGrant`, reached through the endpoint.
   *
   * Every case above stubs the consent mirror, and `beforeEach` grants the full
   * manifest, so no case in this file ever put an ungranted viewer in front of real
   * consent code. That combination is why the bypass shipped.
   */
  describe('with the REAL consent mirror', () => {
    beforeEach(async () => {
      const actual = await vi.importActual<
        typeof import('~/server/services/blocks/oauth-consent-sync.service')
      >('~/server/services/blocks/oauth-consent-sync.service');
      mockHub.syncOauthConsentFromGrant.mockImplementation(actual.syncOauthConsentFromGrant);
      mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(pageBlock({ auth: 'oauth' }));
      dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ appId: 'appblk-hello-page' });
      mockDbWrite.oauthConsent.findUnique.mockResolvedValue(null);
      mockDbWrite.oauthConsent.upsert.mockResolvedValue({ id: 1 });
    });

    it('a signed-in viewer with no grant row gets no OAuth token and no consent row', async () => {
      mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);

      const res = await mint();

      expect(res._status).toBe(200);
      // The invariant is a RELATIONSHIP, not a field: nothing may mint a scope that
      // this same response reports as missing. Before the fix the response said
      // `missingScopes: ['user:read:self']` AND handed back an OAuth token whose
      // bitmask carried `TokenScope.UserRead`.
      expect(res._body.missingScopes).toContain('user:read:self');
      const mintedWithUserRead = mockHub.mintAppToken.mock.calls.filter(
        ([args]) => ((args as { scope: number }).scope & TokenScope.UserRead) !== 0
      );
      expect(mintedWithUserRead).toEqual([]);
      // …and the platform must not have written the consent record it then validates.
      expect(mockDbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
      expect(res._body).toMatchObject({
        token: 'jwt.signed.value',
        kind: 'block',
        needsConsent: true,
      });
    });

    /**
     * 🔴 #5127 SECOND SHAPE, through the endpoint. The grant row EXISTS but omits
     * `user:read:self`, which the same response reports in `missingScopes`. Pre-fix
     * the mirror wrote a row ORing `UserRead` in and the hub minted against it.
     */
    it('a viewer whose grant omits user:read:self gets no OAuth token and no consent row', async () => {
      mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: ['models:read:self', 'apps:storage:read'],
        revokedAt: null,
        buzzBudgetPerDay: null,
      });

      const res = await mint();

      expect(res._status).toBe(200);
      expect(res._body.missingScopes).toContain('user:read:self');
      const mintedWithUserRead = mockHub.mintAppToken.mock.calls.filter(
        ([args]) => ((args as { scope: number }).scope & TokenScope.UserRead) !== 0
      );
      expect(mintedWithUserRead).toEqual([]);
      expect(mockDbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
      expect(res._body).toMatchObject({ kind: 'block', needsConsent: true });
    });

    /**
     * 🔴 #5127 (F1) — the non-terminating consent loop, closed at the branch
     * condition rather than inside the mirror.
     *
     * An APPROVED manifest declaring `auth: "oauth"` but NOT `user:read:self`, for a
     * viewer who granted everything it declares. The mirror cannot claim `UserRead`,
     * the hub would refuse, and `withheld` would come back as
     * `consentGatedScopes(signable)` — `collections:read:private`, a scope THIS VIEWER
     * ALREADY GRANTED. It would be stripped from the token and reported missing, the
     * host would render its persistent "missing permissions" banner, and re-consent
     * would re-offer the same already-granted set for ever.
     *
     * The assertion is that relationship, not a field: no scope the viewer granted may
     * be reported missing. `manifestCanMintOauthToken` keeps the branch unentered, so
     * the block gets a clean JWT carrying everything it declared.
     */
    it('an approved auth: "oauth" manifest with no user:read:self mints a clean JWT, not a consent loop', async () => {
      const DECLARED = ['models:read:self', 'collections:read:private'];
      const base = pageBlock({ auth: 'oauth', scopes: DECLARED });
      mockBlockRegistry.resolvePageBlock.mockResolvedValue({
        appBlock: { ...base.appBlock, approvedScopes: DECLARED },
      });
      mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: DECLARED,
        revokedAt: null,
        buzzBudgetPerDay: null,
      });

      const res = await mint();

      expect(res._status).toBe(200);
      expect(res._body.missingScopes).toEqual([]);
      for (const granted of DECLARED) expect(res._body.scopes).toContain(granted);
      expect(res._body).toMatchObject({ kind: 'block', needsConsent: false });
      // The branch was never entered — not merely refused inside it.
      expect(mockHub.syncOauthConsentFromGrant).not.toHaveBeenCalled();
      expect(mockHub.mintAppToken).not.toHaveBeenCalled();
      expect(mockDbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    });

    it('a viewer who granted user:read:self still mints through the hub', async () => {
      // grantedScopes: SCOPES from the outer beforeEach — includes user:read:self.
      mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: SCOPES,
        revokedAt: null,
        buzzBudgetPerDay: null,
      });

      const res = await mint();

      expect(res._status).toBe(200);
      expect(res._body).toMatchObject({
        token: 'civ_oauth_access',
        kind: 'oauth',
        needsConsent: false,
        missingScopes: [],
      });
      expect(mockHub.mintAppToken).toHaveBeenCalledWith({
        userId: 42,
        clientId: 'appblk-hello-page',
        scope: TokenScope.UserRead | TokenScope.ModelsRead,
      });
      expect(mockDbWrite.oauthConsent.upsert.mock.calls[0][0].update.scope).toBe(
        TokenScope.UserRead | TokenScope.ModelsRead
      );
    });
  });
});
