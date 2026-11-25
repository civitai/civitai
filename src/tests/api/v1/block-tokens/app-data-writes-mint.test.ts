import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as CivitaiAuth from '@civitai/auth';
import type * as FliptClientModule from '~/server/flipt/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.incrBy.mockImplementation(async () => 1);
redisMock.redis.expire.mockImplementation(async () => true);
redisMock.redis.ttl.mockImplementation(async () => 60);
const mockDbWrite = dbMock.dbWrite;

/**
 * POST /api/v1/block-tokens — the App Storage writes cutover (`app-data-writes-routing.ts`).
 * The mint's answer carries `appData: { url, slug }` only for a production page run of an app the
 * `app-data-writes-via-service` flag is on for, with a block token and the service URL set. Each
 * case below flips ONE of those and asserts the key is ABSENT from the answer.
 *
 * Fixture values are pairwise distinct (app block id, blockId, appId, service URL), and the flag
 * answers `true` only for the exact flag key, entity and context, so a call with any of them
 * transposed reads as off.
 */

const SERVICE_URL = 'https://records.example.test/edge';
const FLAG = 'app-data-writes-via-service';

const { mockEnv, mockSession, mockTokenService, mockBlockRegistry, mockHub, mockFlipt } =
  vi.hoisted(() => ({
    mockEnv: {
      NEXTAUTH_URL: 'https://civitai.com',
      TRPC_ORIGINS: [] as string[],
      BLOCK_TOKEN_PRIVATE_KEY: 'fake-private',
      BLOCK_TOKEN_PUBLIC_KEY: 'fake-public',
      APP_BLOCK_OAUTH_TOKENS_ENABLED: false,
      APP_DATA_SERVICE_PUBLIC_URL: undefined as string | undefined,
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
    mockFlipt: {
      on: true,
      read: vi.fn(),
      override: vi.fn((_flag: string): string | undefined => undefined),
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
  isAppBlocksPrivateRunEnabled: vi.fn(async () => false),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  mintAppToken: mockHub.mintAppToken,
}));
vi.mock('~/server/services/blocks/oauth-consent-sync.service', () => ({
  syncOauthConsentFromGrant: mockHub.syncOauthConsentFromGrant,
  revokeOauthConsentForBlock: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  getFliptLocalOverride: mockFlipt.override,
  getFliptBoolean: mockFlipt.read,
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

const appBlock = (manifestExtra: Record<string, unknown> = {}) => ({
  id: 'apb_wren_3318',
  blockId: 'lantern-notes',
  appId: 'appblk-heron-7702',
  status: 'approved',
  currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
  manifest: { scopes: SCOPES, page: { path: '/', title: 'Notes' }, ...manifestExtra },
  approvedScopes: SCOPES,
  app: { allowedScopes: TokenScope.UserRead | TokenScope.ModelsRead },
});

const PAGE_BODY = {
  blockInstanceId: 'page_apb_wren_3318',
  slotContext: { entityType: 'none', slotId: 'app.page' },
};
const MODEL_BODY = {
  blockInstanceId: 'bki_x',
  slotContext: { modelId: 12345, slotId: 'model.sidebar_top' },
};

async function mint(body: unknown) {
  const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

describe('POST /api/v1/block-tokens — BLOCK_INIT.appData (writes via the app-data service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = false;
    mockEnv.APP_DATA_SERVICE_PUBLIC_URL = SERVICE_URL;
    mockFlipt.on = true;
    mockFlipt.override.mockImplementation(() => undefined);
    mockFlipt.read.mockImplementation(
      async (flag: string, entityId: string, context: Record<string, string>) =>
        mockFlipt.on &&
        flag === FLAG &&
        entityId === 'apb_wren_3318' &&
        context?.blockId === 'lantern-notes'
    );
    // A model-slot token mints for moderators only.
    mockSession.value = { user: { id: 42, isModerator: true, bannedAt: null } };
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: SCOPES,
      revokedAt: null,
    });
    mockBlockRegistry.resolvePageBlock.mockResolvedValue({ appBlock: appBlock() });
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      source: 'install',
      modelId: 12345,
      slotId: 'model.sidebar_top',
      enabled: true,
      settings: {},
      installedByUserId: 42,
      appBlock: appBlock(),
    });
    mockHub.syncOauthConsentFromGrant.mockResolvedValue({
      clientId: 'appblk-heron-7702',
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
      impersonatedBy: null,
    });
    mockHub.mintAppToken.mockResolvedValue({
      accessToken: 'civ_oauth_access',
      expiresAt: '2099-01-01T00:15:00Z',
      expiresIn: 900,
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
      impersonatedBy: null,
    });
  });

  it('a production page run of a flagged app, with a block token and the URL set, carries { url, slug }', async () => {
    const res = await mint(PAGE_BODY);
    expect(res._status).toBe(200);
    expect(res._body.kind).toBe('block');
    expect(res._body.appData).toEqual({ url: SERVICE_URL, slug: 'lantern-notes' });
    expect(mockFlipt.read).toHaveBeenCalledWith(FLAG, 'apb_wren_3318', {
      blockId: 'lantern-notes',
    });
  });

  it('flag off for the app: the key is absent', async () => {
    mockFlipt.on = false;
    const res = await mint(PAGE_BODY);
    expect(res._status).toBe(200);
    expect(res._body).not.toHaveProperty('appData');
  });

  it('URL unset: the key is absent, and the flag is never read', async () => {
    mockEnv.APP_DATA_SERVICE_PUBLIC_URL = undefined;
    const res = await mint(PAGE_BODY);
    expect(res._status).toBe(200);
    expect(res._body).not.toHaveProperty('appData');
    expect(mockFlipt.read).not.toHaveBeenCalled();
  });

  it('URL not plain https (the env parse fell through): the key is absent', async () => {
    mockEnv.APP_DATA_SERVICE_PUBLIC_URL = 'http://records.example.test/edge';
    const res = await mint(PAGE_BODY);
    expect(res._status).toBe(200);
    expect(res._body).not.toHaveProperty('appData');
  });

  it('a dev-tunnel preview of the same app: the key is absent', async () => {
    const res = await mint({ ...PAGE_BODY, devTunnel: true });
    expect(res._status).toBe(200);
    expect(res._body).not.toHaveProperty('appData');
  });

  it('the model-slot path of the same app: the key is absent', async () => {
    const res = await mint(MODEL_BODY);
    expect(res._status).toBe(200);
    expect(res._body.kind).toBe('block');
    expect(res._body).not.toHaveProperty('appData');
  });

  it('an OAuth token for the same app: the key is absent', async () => {
    mockEnv.APP_BLOCK_OAUTH_TOKENS_ENABLED = true;
    mockBlockRegistry.resolvePageBlock.mockResolvedValue({ appBlock: appBlock({ auth: 'oauth' }) });
    const res = await mint(PAGE_BODY);
    expect(res._status).toBe(200);
    expect(res._body.kind).toBe('oauth');
    expect(res._body).not.toHaveProperty('appData');
  });

  it('a flag read that throws reads as off: the key is absent and the mint still answers', async () => {
    mockFlipt.read.mockImplementation(async () => {
      throw new Error('Flag not found');
    });
    const res = await mint(PAGE_BODY);
    expect(res._status).toBe(200);
    expect(res._body).not.toHaveProperty('appData');
  });
});
