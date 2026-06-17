import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * W10 — handler-level coverage for the PAGE token-mint path of
 * POST /api/v1/block-tokens (entityType: 'none').
 *
 * Mirrors the model-path harness in index.test.ts (mocks auth/registry/redis/
 * token-service/flags) and asserts the W10 invariants:
 *   - page mint carries NO money scopes (the page hard rule rejects them)
 *   - page mint is gated on the `appBlocksPages` flag (in ADDITION to appBlocks)
 *     and on the app being approved (resolvePageBlock → null ⇒ 404, no token)
 *   - a stateless page resolves with NO subscription row (resolvePageBlock, not
 *     resolveBlockInstance) and stamps ctx { slotId, entityType:'none' } (no
 *     modelId — so it can never satisfy a model-bound check)
 *   - the MODEL path stays byte-identical: ctx is exactly { modelId, slotId }
 *     (no entityType field) for the canonical generate-from-model manifest.
 */

const {
  mockDbWrite,
  mockRedis,
  mockSession,
  mockTokenService,
  mockBlockRegistry,
  mockFlags,
} = vi.hoisted(() => {
  const dbWrite = {
    user: { findUnique: vi.fn<(...args: any[]) => Promise<any>>() },
    appUserScopeGrant: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    },
  };
  const redis = {
    incrBy: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => 60),
  };
  const session = { value: null as { user: { id: number; bannedAt: Date | null } } | null };
  const tokenService = {
    sign: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
      token: 'jwt.signed.value',
      expiresAt: '2099-01-01T00:00:00Z',
      jti: 'j',
    })),
    checkRateLimit: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
  };
  const blockRegistry = {
    resolveBlockInstance: vi.fn<(...args: any[]) => Promise<any>>(),
    resolvePageBlock: vi.fn<(...args: any[]) => Promise<any>>(),
  };
  // Flag mock that both the master + pages flag default ON for a mod.
  const flags = {
    getFeatureFlags: vi.fn(
      ({ user }: { user?: { isModerator?: boolean } }) => ({
        appBlocks: !!user?.isModerator,
        appBlocksPages: !!user?.isModerator,
      })
    ),
  };
  return {
    mockDbWrite: dbWrite,
    mockRedis: redis,
    mockSession: session,
    mockTokenService: tokenService,
    mockBlockRegistry: blockRegistry,
    mockFlags: flags,
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
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: mockBlockRegistry,
}));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'rl' } },
}));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: () => ['civitai.com'] }));
vi.mock('~/server/services/feature-flags.service', () => mockFlags);

function makeReq(opts: {
  method?: string;
  origin?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    headers: { origin: opts.origin, ...opts.headers },
    body: opts.body,
    socket: { remoteAddress: '127.0.0.1' },
    query: {},
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
    setHeader: vi.fn(function (this: any, name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
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
    send: vi.fn(function (this: any, body: unknown) {
      this._body = body;
      return this;
    }),
  };
  return res as unknown as NextApiResponse & {
    _status: number;
    _body: any;
    _headers: Record<string, string>;
  };
}

// OAuth bits for the money scopes (token-scope.constants): AIServicesWrite
// (1<<15), BuzzRead (1<<16), SocialTip (1<<20). The page hard rule must reject
// a money scope EVEN WHEN the OAuth client allows it (otherwise the earlier
// OAuth-allowlist check would be what rejects, not the page rule).
const MONEY_BITS = (1 << 15) | (1 << 16) | (1 << 20);

// An approved page app (no install row). resolvePageBlock returns this.
const PAGE_BLOCK = (
  manifestScopes: string[],
  approvedScopes = manifestScopes,
  allowedScopes = 0
) => ({
  appBlock: {
    id: 'apb_page',
    blockId: 'hello-page',
    appId: 'appblk-hello-page',
    status: 'approved',
    manifest: { scopes: manifestScopes, page: { path: '/', title: 'Hello' } },
    approvedScopes,
    app: { allowedScopes },
  },
});

const pageBody = (overrides: Record<string, unknown> = {}) => ({
  blockInstanceId: 'page_apb_page',
  slotContext: { entityType: 'none', slotId: 'app.page', ...overrides },
});

// The canonical generate-from-model model install (for the byte-identical test).
const MODEL_INSTALL = {
  source: 'install' as const,
  modelId: 12345,
  slotId: 'model.sidebar_top',
  enabled: true,
  settings: {},
  installedByUserId: 42,
  appBlock: {
    id: 'apb_gen',
    blockId: 'generate-from-model',
    appId: 'appblk-generate-from-model',
    status: 'approved',
    manifest: { scopes: ['models:read:self'] },
    approvedScopes: ['models:read:self'],
    app: { allowedScopes: 4 /* TokenScope.ModelsRead */ },
  },
};
const modelBody = () => ({
  blockInstanceId: 'bki_x',
  slotContext: { modelId: 12345, slotId: 'model.sidebar_top' },
});

const MOD = { user: { id: 42, isModerator: true, bannedAt: null } } as any;

describe('POST /api/v1/block-tokens — W10 page mint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.value = MOD;
    mockBlockRegistry.resolveBlockInstance.mockReset();
    mockBlockRegistry.resolvePageBlock.mockReset();
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['apps:storage:read', 'apps:storage:write'],
      revokedAt: null,
    });
    mockRedis.incrBy.mockResolvedValue(1);
    mockTokenService.checkRateLimit.mockResolvedValue(true);
    (mockFlags.getFeatureFlags as any).mockImplementation(
      ({ user }: { user?: { isModerator?: boolean } }) => ({
        appBlocks: !!user?.isModerator,
        appBlocksPages: !!user?.isModerator,
      })
    );
  });

  it('mints a viewer-scoped page token via resolvePageBlock (no subscription row)', async () => {
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(
      PAGE_BLOCK(['apps:storage:read', 'apps:storage:write'])
    );
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

    expect(res._status).toBe(200);
    // Stateless: the page path NEVER touches resolveBlockInstance.
    expect(mockBlockRegistry.resolveBlockInstance).not.toHaveBeenCalled();
    expect(mockBlockRegistry.resolvePageBlock).toHaveBeenCalledWith('apb_page', { db: 'write' });
    expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
    const signArg = mockTokenService.sign.mock.calls[0][0];
    // ctx is { slotId, entityType:'none' } with NO modelId — can't satisfy a
    // model-bound check.
    expect(signArg.ctx).toEqual({ slotId: 'app.page', entityType: 'none' });
    expect(signArg.ctx.modelId).toBeUndefined();
    expect(signArg.scopes).toEqual(['apps:storage:read', 'apps:storage:write']);
  });

  it('rejects a page manifest that declares a money scope (page hard rule)', async () => {
    // The OAuth client ALLOWS the money scope + it's in the approved set — so
    // the earlier OAuth/approved gates pass and the PAGE HARD RULE is what
    // rejects (proves the page-specific gate, not the generic allowlist).
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(
      PAGE_BLOCK(
        ['apps:storage:read', 'ai:write:budgeted'],
        ['apps:storage:read', 'ai:write:budgeted'],
        MONEY_BITS
      )
    );
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

    expect(res._status).toBe(403);
    expect(res._body.error).toMatch(/money\/spend scopes/);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it.each([['buzz:read:self'], ['social:tip:self'], ['ai:write:budgeted']])(
    'rejects forbidden page scope %s',
    async (scope) => {
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(
        PAGE_BLOCK([scope], [scope], MONEY_BITS)
      );
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);
      expect(res._status).toBe(403);
      expect(mockTokenService.sign).not.toHaveBeenCalled();
    }
  );

  it('is flag-gated on appBlocksPages (appBlocks alone is not enough → 403, no token)', async () => {
    (mockFlags.getFeatureFlags as any).mockImplementation(() => ({
      appBlocks: true,
      appBlocksPages: false,
    }));
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BLOCK(['apps:storage:read']));
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);
    expect(res._status).toBe(403);
    expect(mockBlockRegistry.resolvePageBlock).not.toHaveBeenCalled();
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('404s (no token) for an unapproved / unknown page app (resolvePageBlock → null)', async () => {
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(null);
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('rejects a page request whose instance id is not page_<appBlockId>', async () => {
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { blockInstanceId: 'bki_smuggled', slotContext: { entityType: 'none', slotId: 'app.page' } },
      }),
      res
    );
    expect(res._status).toBe(400);
    expect(mockBlockRegistry.resolvePageBlock).not.toHaveBeenCalled();
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('rejects entityType=none with a non-page slot', async () => {
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { blockInstanceId: 'page_apb_page', slotContext: { entityType: 'none', slotId: 'model.sidebar_top' } },
      }),
      res
    );
    expect(res._status).toBe(400);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('BYTE-IDENTICAL model path: ctx is exactly { modelId, slotId } (no entityType) for generate-from-model', async () => {
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue(MODEL_INSTALL);
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['models:read:self'],
      revokedAt: null,
    });
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: modelBody() }), res);

    expect(res._status).toBe(200);
    expect(mockBlockRegistry.resolvePageBlock).not.toHaveBeenCalled();
    const signArg = mockTokenService.sign.mock.calls[0][0];
    // The model ctx MUST be byte-identical to pre-W10: { modelId, slotId } only.
    expect(signArg.ctx).toEqual({ modelId: 12345, slotId: 'model.sidebar_top' });
    expect('entityType' in signArg.ctx).toBe(false);
    expect(signArg.scopes).toEqual(['models:read:self']);
    expect(signArg.blockInstanceId).toBe('bki_x');
  });
});
