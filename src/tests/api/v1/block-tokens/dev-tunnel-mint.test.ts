import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * PHASE 2 — App Dev Tunnel author-own SCOPED mint on POST /api/v1/block-tokens.
 *
 * When `resolvePageBlock` misses (a PRE-APPROVAL ephemeral app), the cookie-authed
 * AUTHOR who OWNS the app mints a SCOPED, forced-SFW, self-bound, budget-capped dev
 * token so real Buzz-spend generation works pre-approval. Asserts:
 *   - OWN pending submission → scope source = server-read manifest.scopes,
 *   - OWN brand-new (no pending) → scope source = self-declared body devScopes,
 *   - App Storage scope is STRIPPED (Decision 1),
 *   - the synthetic non-resolving ids + forced-SFW + dev:true are signed,
 *   - foreign / approved-elsewhere (resolver → null) → the SAME bare 404, no token,
 *   - the dev-tunnel kill-switch OFF → 404 (no mint),
 *   - a resolved non-ephemeral status → 404 (fail-closed).
 */

const {
  mockDbWrite,
  mockRedis,
  mockSession,
  mockTokenService,
  mockBlockRegistry,
  mockFlags,
  mockAppBlocksFlag,
} = vi.hoisted(() => {
  const dbWrite = {
    user: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
        deletedAt: null,
        bannedAt: null,
      })),
    },
    appBlockPublishRequest: {
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    },
    appUserScopeGrant: { findUnique: vi.fn<(...args: any[]) => Promise<any>>(async () => null) },
  };
  const redis = {
    incrBy: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => 60),
  };
  const session = { value: null as any };
  const tokenService = {
    sign: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
      token: 'jwt.dev.signed',
      expiresAt: '2099-01-01T00:00:00Z',
      jti: 'j',
    })),
    checkRateLimit: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
  };
  const blockRegistry = {
    resolveBlockInstance: vi.fn<(...args: any[]) => Promise<any>>(),
    resolvePageBlock: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    resolveDevPageBlockForAuthor: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
  };
  const flags = {
    getFeatureFlags: vi.fn(({ user }: { user?: { isModerator?: boolean } }) => ({
      appBlocks: !!user?.isModerator,
      appBlocksPages: !!user?.isModerator,
    })),
  };
  const appBlocksFlag = {
    isAppBlocksAuthorEnabled: vi.fn(async () => true),
    isAppBlocksDevTunnelEnabled: vi.fn(async () => true),
  };
  return {
    mockDbWrite: dbWrite,
    mockRedis: redis,
    mockSession: session,
    mockTokenService: tokenService,
    mockBlockRegistry: blockRegistry,
    mockFlags: flags,
    mockAppBlocksFlag: appBlocksFlag,
  };
});

vi.mock('~/env/server', () => ({
  env: {
    NEXTAUTH_URL: 'https://civitai.com',
    TRPC_ORIGINS: [],
    BLOCK_TOKEN_PRIVATE_KEY: 'fake-private',
    BLOCK_TOKEN_PUBLIC_KEY: 'fake-public',
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mockSession.value),
}));
vi.mock('~/server/services/block-token.service', () => ({ BlockTokenService: mockTokenService }));
vi.mock('~/server/services/block-registry.service', () => ({ BlockRegistry: mockBlockRegistry }));
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
vi.mock('~/server/services/feature-flags.service', () => mockFlags);
vi.mock('~/server/services/app-blocks-flag', () => mockAppBlocksFlag);

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
    _headers: {} as Record<string, string>,
    setHeader: vi.fn(function (this: any, name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
      return this;
    }),
    status: vi.fn(function (this: any, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: any, b: unknown) {
      this._body = b;
      return this;
    }),
    end: vi.fn(function (this: any) {
      return this;
    }),
    send: vi.fn(function (this: any, b: unknown) {
      this._body = b;
      return this;
    }),
  };
  return res as unknown as NextApiResponse & { _status: number; _body: any; _headers: Record<string, string> };
}

const MOD = { user: { id: 4242, isModerator: true, bannedAt: null } };

// The ephemeral resolution BlockRegistry.resolveDevPageBlockForAuthor returns for
// an OWNED pre-approval app (synthetic, non-resolving ids; empty display scopes).
const EPHEMERAL_RESOLUTION = {
  appBlockId: 'ephemeral-my-app',
  appId: 'ephemeral-my-app',
  blockId: 'my-app',
  status: 'ephemeral',
  trustTier: 'unverified',
  name: 'my-app',
  pageTitle: 'my-app',
  sandbox: 'allow-scripts allow-forms',
  scopes: [],
  contentRating: null,
};

const DEV_BODY = (extra?: Record<string, unknown>) => ({
  blockInstanceId: 'page_ephemeral-my-app',
  slotContext: { entityType: 'none', slotId: 'app.page' },
  ...extra,
});

async function invoke(body: unknown) {
  const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

describe('POST /api/v1/block-tokens — Phase 2 dev-tunnel author-own mint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.value = MOD;
    mockRedis.incrBy.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(60);
    mockTokenService.checkRateLimit.mockResolvedValue(true);
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(null); // pre-approval miss
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue(EPHEMERAL_RESOLUTION);
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    mockDbWrite.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(true);
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(true);
  });

  it('OWN pending submission → mints a scoped token from the SERVER-READ manifest scopes (App Storage STRIPPED)', async () => {
    mockDbWrite.appBlockPublishRequest.findFirst.mockResolvedValue({
      manifest: { scopes: ['ai:write:budgeted', 'apps:storage:read', 'apps:storage:write'] },
    });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    expect(res._body.token).toBe('jwt.dev.signed');
    expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    // spend scope granted + user:read:self force-grant; App Storage stripped.
    expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    expect(arg.scopes).not.toContain('apps:storage:read');
    expect(arg.scopes).not.toContain('apps:storage:write');
    // self-bound, dev:true, forced-SFW, synthetic non-resolving ids.
    expect(arg.userId).toBe(MOD.user.id);
    expect(arg.dev).toBe(true);
    expect(arg.domain).toBeNull();
    expect(arg.appId).toBe('ephemeral-my-app');
    expect(arg.appBlockId).toBe('ephemeral-my-app');
    expect(arg.blockInstanceId).toBe('page_ephemeral-my-app');
    expect(typeof arg.buzzBudget).toBe('number'); // budget set (spend granted)
    // The pending lookup was ownership-scoped.
    expect(mockDbWrite.appBlockPublishRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'my-app', status: 'pending', submittedByUserId: MOD.user.id },
      })
    );
    // Ownership resolved on the slug (not the raw appBlockId).
    expect(mockBlockRegistry.resolveDevPageBlockForAuthor).toHaveBeenCalledWith(
      'my-app',
      MOD.user.id,
      { db: 'write' }
    );
  });

  it('OWN brand-new (no pending) → mints from SELF-DECLARED body devScopes', async () => {
    mockDbWrite.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await invoke(DEV_BODY({ devScopes: ['ai:write:budgeted', 'social:tip:self'] }));
    expect(res._status).toBe(200);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    // social:tip:self is out-of-allowlist + forbidden → stripped; spend kept.
    expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
  });

  it('OWN brand-new with NO scopes → a valid READ-ONLY token (no spend), still 200', async () => {
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    expect(arg.scopes).toEqual(['user:read:self']);
    expect(arg.buzzBudget).toBeUndefined();
  });

  it('foreign / already-claimed / absent app (resolver → null) → the SAME bare 404, NO token', async () => {
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue(null);
    const res = await invoke(DEV_BODY({ devScopes: ['ai:write:budgeted'] }));
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Page app not found' });
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('dev-tunnel kill-switch OFF → 404, NO token (defense-in-depth over the SSR gate)', async () => {
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(false);
    const res = await invoke(DEV_BODY({ devScopes: ['ai:write:budgeted'] }));
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('author capability OFF → 404, NO token', async () => {
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(false);
    const res = await invoke(DEV_BODY({ devScopes: ['ai:write:budgeted'] }));
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('resolved to a NON-ephemeral status (e.g. approved mid-session) → 404, fail-closed', async () => {
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...EPHEMERAL_RESOLUTION,
      status: 'approved',
      appBlockId: 'apb_real',
      appId: 'appblk-my-app',
    });
    const res = await invoke(DEV_BODY({ devScopes: ['ai:write:budgeted'] }));
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('a soft-deleted account never mints (M1 parity)', async () => {
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: new Date(), bannedAt: null });
    const res = await invoke(DEV_BODY({ devScopes: ['ai:write:budgeted'] }));
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });
});
