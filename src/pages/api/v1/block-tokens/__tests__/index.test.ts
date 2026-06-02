import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Handler-level coverage for POST /api/v1/block-tokens. The token-issuance
 * route had no direct tests before — the audit flagged the CSRF gate, IP
 * rate limit, scope allowlist, and settings ownership as uncovered.
 *
 * We mock the auth, registry, redis, and token-service modules so the handler
 * runs end-to-end in unit-test scope. The signing path itself is covered
 * by block-token.service.test.ts; the per-source resolution by
 * block-registry.resolve-instance.test.ts.
 */

const { mockDbWrite, mockRedis, mockSession, mockTokenService, mockBlockRegistry } = vi.hoisted(() => {
  const dbWrite = {
    user: { findUnique: vi.fn() },
    // A6: the per-user scope-grant ledger. getGrantedScopes reads this at mint
    // time to intersect the signable scopes with what the viewer has granted.
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
  };
  return {
    mockDbWrite: dbWrite,
    mockRedis: redis,
    mockSession: session,
    mockTokenService: tokenService,
    mockBlockRegistry: blockRegistry,
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
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: vi.fn(async () => true),
}));

function makeReq(opts: {
  method?: string;
  origin?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    headers: {
      origin: opts.origin,
      ...opts.headers,
    },
    body: opts.body,
    socket: { remoteAddress: '127.0.0.1' },
    query: {},
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: unknown; _headers: Record<string, string> } {
  const res: NextApiResponse & { _status: number; _body: unknown; _headers: Record<string, string> } = {
    _status: 0,
    _body: null,
    _headers: {},
    setHeader: vi.fn(function (this: typeof res, name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
      return this;
    }),
    status: vi.fn(function (this: typeof res, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: typeof res, body: unknown) {
      this._body = body;
      return this;
    }),
    end: vi.fn(function (this: typeof res) {
      return this;
    }),
    send: vi.fn(function (this: typeof res, body: unknown) {
      this._body = body;
      return this;
    }),
  } as unknown as NextApiResponse & { _status: number; _body: unknown; _headers: Record<string, string> };
  return res;
}

// What resolveBlockInstance returns for a successfully-resolved install.
const RESOLVED_INSTALL = {
  source: 'install' as const,
  modelId: 12345,
  slotId: 'model.sidebar_top',
  enabled: true,
  settings: {},
  installedByUserId: 42,
  appBlock: {
    id: 'ab_x',
    blockId: 'blk',
    appId: 'app',
    status: 'approved',
    manifest: { scopes: ['models:read:self'] },
    approvedScopes: ['models:read:self'],
    app: { allowedScopes: 4 /* TokenScope.ModelsRead */ },
  },
};

// Every body needs modelId/slotId now — slotContext.{modelId,slotId} are the
// auth pin the resolver uses for synthetic ids and are now schema-required.
const validBody = (overrides: Record<string, unknown> = {}) => ({
  blockInstanceId: 'bki_x',
  slotContext: { modelId: 12345, slotId: 'model.sidebar_top', ...overrides },
});

describe('POST /api/v1/block-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.value = null;
    // mockReset (not just clearAllMocks) so a leaked mockResolvedValueOnce
    // from a prior test (e.g. the 404-null case that 403s at the mod-gate
    // before consuming its once-value) doesn't bleed into the next test.
    mockBlockRegistry.resolveBlockInstance.mockReset();
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue(RESOLVED_INSTALL);
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    // A6: default to "user has granted everything the app declares" so the
    // pre-A6 tests (which assert sign was called for the manifest scopes) keep
    // passing. The consent-specific tests below override this per-case.
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['models:read:self', 'buzz:read:self', 'ai:write:budgeted'],
      revokedAt: null,
    });
    mockRedis.incrBy.mockResolvedValue(1);
    mockTokenService.checkRateLimit.mockResolvedValue(true);
  });

  it('B1: rejects cross-origin POST with 403 (no Origin header) instead of silent token-mint', async () => {
    const { default: handler } = await import('../index');
    const req = makeReq({ body: validBody() });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(403);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    expect(mockBlockRegistry.resolveBlockInstance).not.toHaveBeenCalled();
  });

  it('B1: rejects cross-origin POST from non-allowlisted origin', async () => {
    const { default: handler } = await import('../index');
    const req = makeReq({
      origin: 'https://civitai.com.attacker.tld',
      body: validBody(),
    });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(403);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('H-2: returns 503 when the appBlocks flag is off', async () => {
    const flagMod = await import('~/server/services/app-blocks-flag');
    (flagMod.isAppBlocksEnabled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false
    );
    const { default: handler } = await import('../index');
    const req = makeReq({ origin: 'https://civitai.com', body: validBody() });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    expect(mockBlockRegistry.resolveBlockInstance).not.toHaveBeenCalled();
  });

  it('H1: rejects cross-origin requests via exact-host match (no startsWith bypass)', async () => {
    const { default: handler } = await import('../index');
    const req = makeReq({ origin: 'https://civitai.com.attacker.tld', body: validBody() });
    const res = makeRes();
    await handler(req, res);
    expect(res._headers['access-control-allow-origin']).toBeUndefined();
  });

  it('H1: accepts the canonical civitai.com origin', async () => {
    const { default: handler } = await import('../index');
    const req = makeReq({ origin: 'https://civitai.com', body: validBody() });
    const res = makeRes();
    await handler(req, res);
    expect(res._headers['access-control-allow-origin']).toBe('https://civitai.com');
  });

  it('M1: banned user is rejected at issuance', async () => {
    mockSession.value = { user: { id: 99, bannedAt: new Date() } };
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(403);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('M1: soft-deleted user is rejected at issuance', async () => {
    mockSession.value = { user: { id: 99, bannedAt: null } };
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: new Date(), bannedAt: null });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(403);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('C8: block:settings:* tokens require caller == installer', async () => {
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      ...RESOLVED_INSTALL,
      appBlock: {
        ...RESOLVED_INSTALL.appBlock,
        manifest: { scopes: ['block:settings:read'] },
        approvedScopes: ['block:settings:read'],
      },
    });
    mockSession.value = { user: { id: 999, bannedAt: null } }; // not the installer (42)
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(403);
    expect((res._body as { error: string }).error).toMatch(/installer/);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('C8: block:settings:* tokens succeed when caller == installer', async () => {
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      ...RESOLVED_INSTALL,
      appBlock: {
        ...RESOLVED_INSTALL.appBlock,
        manifest: { scopes: ['block:settings:read'] },
        approvedScopes: ['block:settings:read'],
      },
    });
    mockSession.value = { user: { id: 42, bannedAt: null } }; // == installedByUserId
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(200);
    expect(mockTokenService.sign).toHaveBeenCalled();
  });

  it('scope allowlist: rejects when manifest carries scopes the OauthClient doesnt allow', async () => {
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      ...RESOLVED_INSTALL,
      appBlock: {
        ...RESOLVED_INSTALL.appBlock,
        manifest: { scopes: ['models:read:self', 'buzz:read:self'] },
        approvedScopes: ['models:read:self', 'buzz:read:self'],
        app: { allowedScopes: 4 /* only ModelsRead bit set; BuzzRead missing */ },
      },
    });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(403);
    expect((res._body as { rejected?: string[] }).rejected).toContain('buzz:read:self');
  });

  it('schema: rejects body missing modelId/slotId in slotContext', async () => {
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { blockInstanceId: 'bki_x', slotContext: {} },
      }),
      res
    );
    expect(res._status).toBe(400);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    expect(mockBlockRegistry.resolveBlockInstance).not.toHaveBeenCalled();
  });

  it('404: returns "Block install not found" when the resolver returns null', async () => {
    // E.g. caller-supplied modelId doesn't match the install row, or the
    // install row was deleted between page load and token mint.
    mockBlockRegistry.resolveBlockInstance.mockResolvedValueOnce(null);
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(404);
    expect((res._body as { error: string }).error).toMatch(/not found/i);
  });

  it('JWT ctx: modelId/slotId come from the validated install — never from raw slotContext', async () => {
    // Even when the caller asserts a different slotId in slotContext, the
    // resolver pins the auth context against (modelId, slotId) from the
    // request — and we re-stamp ctx from the resolved row. An attacker who
    // lies about slotId here triggers a 404 (resolver returns null), not a
    // mint against the wrong slot.
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: validBody({ slotId: 'model.sidebar_top' }),
      }),
      res
    );
    expect(res._status).toBe(200);
    const signArgs = mockTokenService.sign.mock.calls.at(-1)?.[0] as { ctx: Record<string, unknown> };
    // The resolved install row has slotId='model.sidebar_top'.
    expect(signArgs.ctx.slotId).toBe('model.sidebar_top');
    expect(signArgs.ctx.modelId).toBe(12345);
  });

  it('JWT ctx: extra slotContext fields beyond modelId/slotId never reach the JWT', async () => {
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: validBody({
          modelName: 'evil',
          modelType: 42,
          modelVersionId: '99',
        }),
      }),
      res
    );
    expect(res._status).toBe(200);
    const signArgs = mockTokenService.sign.mock.calls.at(-1)?.[0] as { ctx: Record<string, unknown> };
    expect(signArgs.ctx.modelName).toBeUndefined();
    expect(signArgs.ctx.modelType).toBeUndefined();
    expect(signArgs.ctx.modelVersionId).toBeUndefined();
  });

  it('synthetic id (bus_pub_*): mints when resolver validates publisher subscription', async () => {
    // Demonstrates the bug fix — pre-fix the handler did a raw findUnique
    // on a synthetic id and 404'd. Post-fix the resolver returns a record
    // with source='publisher_subscription'.
    mockBlockRegistry.resolveBlockInstance.mockResolvedValueOnce({
      ...RESOLVED_INSTALL,
      source: 'publisher_subscription',
    });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: { blockInstanceId: 'bus_pub_abc', slotContext: { modelId: 12345, slotId: 'model.sidebar_top' } },
      }),
      res
    );
    expect(res._status).toBe(200);
    expect(mockTokenService.sign).toHaveBeenCalled();
  });

  // ==========================================================================
  // A6 — per-user scope-grant consent. Scenario: approve v1 (scope A) → install
  // (grant A) → approve v2 (scope A + B). A token minted for the existing
  // install carries ONLY A until a grant for B exists; the response signals
  // needs_consent for B. Granting B then mints A + B. A revoked grant withholds.
  //
  // These set isModerator (App Blocks is mod-only today — the mint path 403s
  // non-mods before the consent gate). The resolver returns a v2 install
  // (manifest A + B); the grant ledger is what gates which scopes sign.
  // ==========================================================================
  const V2_INSTALL = {
    ...RESOLVED_INSTALL,
    appBlock: {
      ...RESOLVED_INSTALL.appBlock,
      manifest: { scopes: ['models:read:self', 'buzz:read:self'] },
      approvedScopes: ['models:read:self', 'buzz:read:self'],
      app: { allowedScopes: 4 | 65536 /* ModelsRead | BuzzRead */ },
    },
  };

  it('A6: existing install (granted A only) mints ONLY A + signals needs_consent for B', async () => {
    mockSession.value = { user: { id: 42, bannedAt: null, isModerator: true } } as never;
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue(V2_INSTALL);
    // The viewer granted scope A (models:read:self) at v1 install; never B.
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['models:read:self'],
      revokedAt: null,
    });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(200);
    const signArgs = mockTokenService.sign.mock.calls.at(-1)?.[0] as { scopes: string[] };
    expect(signArgs.scopes).toEqual(['models:read:self']); // only A signed
    const body = res._body as { needsConsent: boolean; missingScopes: string[] };
    expect(body.needsConsent).toBe(true);
    expect(body.missingScopes).toEqual(['buzz:read:self']); // B withheld
  });

  it('A6: after granting B, the token mints A + B with no needs_consent', async () => {
    mockSession.value = { user: { id: 42, bannedAt: null, isModerator: true } } as never;
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue(V2_INSTALL);
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['models:read:self', 'buzz:read:self'],
      revokedAt: null,
    });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(200);
    const signArgs = mockTokenService.sign.mock.calls.at(-1)?.[0] as { scopes: string[] };
    expect(new Set(signArgs.scopes)).toEqual(new Set(['models:read:self', 'buzz:read:self']));
    const body = res._body as { needsConsent: boolean; missingScopes: string[] };
    expect(body.needsConsent).toBe(false);
    expect(body.missingScopes).toEqual([]);
  });

  it('A6: a revoked grant withholds every consent-gated scope', async () => {
    mockSession.value = { user: { id: 42, bannedAt: null, isModerator: true } } as never;
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue(V2_INSTALL);
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['models:read:self', 'buzz:read:self'],
      revokedAt: new Date(), // revoked → treated as empty
    });
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(200);
    const signArgs = mockTokenService.sign.mock.calls.at(-1)?.[0] as { scopes: string[] };
    expect(signArgs.scopes).toEqual([]); // all withheld
    const body = res._body as { needsConsent: boolean; missingScopes: string[] };
    expect(body.needsConsent).toBe(true);
    expect(new Set(body.missingScopes)).toEqual(new Set(['models:read:self', 'buzz:read:self']));
  });

  it('A6: consent-exempt scopes (block:settings:*) sign even with no grant', async () => {
    mockSession.value = { user: { id: 42, bannedAt: null, isModerator: true } } as never;
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      ...RESOLVED_INSTALL,
      appBlock: {
        ...RESOLVED_INSTALL.appBlock,
        manifest: { scopes: ['block:settings:read'] },
        approvedScopes: ['block:settings:read'],
        app: { allowedScopes: 4 },
      },
    });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null); // no grant at all
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(200);
    const signArgs = mockTokenService.sign.mock.calls.at(-1)?.[0] as { scopes: string[] };
    expect(signArgs.scopes).toEqual(['block:settings:read']);
    const body = res._body as { needsConsent: boolean };
    expect(body.needsConsent).toBe(false);
  });

  // Last in file: this test resets modules to swap out the env mock; vitest
  // doesn't re-establish the module mocks afterwards, so subsequent tests
  // would see uninitialised env. Keep it terminal.
  it('returns 503 when keys are not configured', async () => {
    vi.resetModules();
    vi.doMock('~/env/server', () => ({
      env: { NEXTAUTH_URL: 'https://civitai.com', TRPC_ORIGINS: [] },
    }));
    const { default: handler } = await import('../index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: validBody() }), res);
    expect(res._status).toBe(503);
    vi.doUnmock('~/env/server');
    vi.resetModules();
  });
});
