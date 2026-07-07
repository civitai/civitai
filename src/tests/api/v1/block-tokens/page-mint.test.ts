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
    // Phase 2 dev-tunnel author-own mint resolver — default null (not owned), so
    // the dev branch cleanly `continue`s to the bare 404 in this suite.
    resolveDevPageBlockForAuthor: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
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
vi.mock('~/server/utils/server-domain', () => ({
  getAllServerHosts: () => ['civitai.com'],
  // #2670 (color-domain maturity) added a getRequestDomainColor(req) call to the
  // mint. The test reqs carry no `host` header, so the real impl returns
  // undefined → SFW ceiling; mirror that here so the module mock stays complete.
  getRequestDomainColor: () => undefined,
}));
vi.mock('~/server/services/feature-flags.service', () => mockFlags);
// Phase 2 dev-tunnel flag helpers (dynamically imported by the mint's dev branch).
// Default OFF in this suite so the dev branch `continue`s → the bare 404 path the
// W10 page-mint tests assert. The dev-mint behaviour has its own suite
// (dev-tunnel-mint.test.ts).
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorEnabled: vi.fn(async () => false),
  isAppBlocksDevTunnelEnabled: vi.fn(async () => false),
}));

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

// OAuth bit that allows ai:write:budgeted (AIServicesWrite = 1<<15).
const AI_WRITE_BIT = 1 << 15;

// An approved page app that declares the W10 generation-spend scope plus an
// (optional) manifest per-gen budget. The OAuth client allows ai:write:budgeted
// and the scope is in the approved set, so the budget path — not an allowlist
// gate — governs the outcome.
const PAGE_BUDGET_BLOCK = (manifestBudget?: number) => ({
  appBlock: {
    id: 'apb_page',
    blockId: 'hello-page',
    appId: 'appblk-hello-page',
    status: 'approved',
    manifest: {
      scopes: ['ai:write:budgeted'],
      page: {
        path: '/',
        title: 'Hello',
        ...(manifestBudget !== undefined ? { buzzBudgetPerGen: manifestBudget } : {}),
      },
    },
    approvedScopes: ['ai:write:budgeted'],
    app: { allowedScopes: AI_WRITE_BIT },
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

  it('PAGE-ONLY LAUNCH GATE: a NON-MOD can still mint a page token (launch belt must NOT hide page apps)', async () => {
    // The page-only launch gate restricts the PUBLIC to launch (page) slots —
    // it must NOT block the page path itself (that would defeat the purpose).
    // app.page IS a launch slot, so a non-mod with both page flags on mints a
    // page token exactly like a mod. (Flag the non-mod ON to model the launch
    // segment-widen; otherwise the appBlocks/appBlocksPages gates would 403
    // first, masking the launch-belt behaviour under test.)
    const NON_MOD = { user: { id: 7, isModerator: false, bannedAt: null } } as any;
    mockSession.value = NON_MOD;
    (mockFlags.getFeatureFlags as any).mockImplementation(() => ({
      appBlocks: true,
      appBlocksPages: true,
    }));
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(
      PAGE_BLOCK(['apps:storage:read', 'apps:storage:write'])
    );
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);
    // 200 — the launch belt passes for a page slot regardless of mod status.
    expect(res._status).toBe(200);
    expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
  });

  it('rejects a page manifest that declares a still-forbidden money scope (page hard rule)', async () => {
    // The OAuth client ALLOWS the money scope + it's in the approved set — so
    // the earlier OAuth/approved gates pass and the PAGE HARD RULE is what
    // rejects (proves the page-specific gate, not the generic allowlist).
    // social:tip:self is NOT un-forbidden by W10 (only ai:write:budgeted is).
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(
      PAGE_BLOCK(
        ['apps:storage:read', 'social:tip:self'],
        ['apps:storage:read', 'social:tip:self'],
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

  // W10: ai:write:budgeted is INTENTIONALLY absent here — it is now allowed for
  // pages (covered by the budget tests below). Only tipping + balance-read stay
  // page-forbidden.
  it.each([['buzz:read:self'], ['social:tip:self']])(
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

  it('treats a synthetic ephemeral-<slug> page instance id as non-approved → 404 when the dev-tunnel gate does not apply', async () => {
    // A synthetic `ephemeral-<slug>` id never names a real approved AppBlock.id,
    // so `resolvePageBlock` yields null. Phase 2 then tries the author-own dev
    // mint, but here the dev-tunnel flags are OFF (this suite) so that branch
    // `continue`s → the SAME bare 404. (The author-own dev mint that DOES issue a
    // scoped token for the OWNER is covered by dev-tunnel-mint.test.ts.)
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(null);
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(
      makeReq({
        origin: 'https://civitai.com',
        body: {
          blockInstanceId: 'page_ephemeral-my-app',
          slotContext: { entityType: 'none', slotId: 'app.page' },
        },
      }),
      res
    );
    expect(res._status).toBe(404);
    // The synthetic id is passed through verbatim to the (null-yielding) lookup.
    expect(mockBlockRegistry.resolvePageBlock).toHaveBeenCalledWith('ephemeral-my-app', {
      db: 'write',
    });
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

  // ───────────────────────── W10 generation spend ──────────────────────────
  // A page can now mint an `ai:write:budgeted` token. The per-gen budget is
  // sourced from the approved manifest's `page.buzzBudgetPerGen`, clamped to
  // BUZZ_BUDGET_CAP (1000), defaulted to BUZZ_BUDGET_DEFAULT (10) when absent.
  // (The user must have GRANTED ai:write:budgeted — consent — for it to be
  // signed; we mock that grant in each case.)
  describe('W10 generation-spend budget (ai:write:budgeted)', () => {
    beforeEach(() => {
      mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: ['ai:write:budgeted'],
        revokedAt: null,
      });
    });

    it('mints with buzzBudget === manifest page.buzzBudgetPerGen', async () => {
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(200));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.scopes).toEqual(['ai:write:budgeted']);
      expect(signArg.buzzBudget).toBe(200);
      // ctx is still the bare page ctx — no modelId.
      expect(signArg.ctx).toEqual({ slotId: 'app.page', entityType: 'none' });
    });

    it('clamps a manifest budget above the cap to BUZZ_BUDGET_CAP (1000)', async () => {
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(5000));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.buzzBudget).toBe(1000);
    });

    it('falls back to BUZZ_BUDGET_DEFAULT (10) when the manifest omits a budget', async () => {
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(undefined));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.buzzBudget).toBe(10);
    });

    it('422 INVALID_BUZZ_BUDGET when the manifest declares a <= 0 budget (fail-closed, no silent default)', async () => {
      // An explicit non-positive manifest budget is a HARD ERROR — the mint
      // does NOT silently coerce it to the default. (Belt-and-suspenders: the
      // manifest validator also rejects a <=0 page.buzzBudgetPerGen at publish
      // time — unit-covered in the validator test — so this should be
      // unreachable in practice, but the mint stays fail-closed regardless.)
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(0));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(422);
      expect(res._body.error).toBe('INVALID_BUZZ_BUDGET');
      expect(mockTokenService.sign).not.toHaveBeenCalled();
    });

    it('clamps to default when the manifest budget is a non-number (no 422)', async () => {
      // A non-number page.buzzBudgetPerGen (validator should have rejected it,
      // but be defensive) → settings stay empty → DEFAULT budget, not 422.
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(
        PAGE_BUDGET_BLOCK('200' as unknown as number)
      );
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.buzzBudget).toBe(10);
    });

    // ── Audit should-fix: integer enforcement in resolveBuzzBudget ──────────
    // A fractional manifest budget reaches the mint as a finite number (the
    // pageSettings mapper only filters non-finite/non-number), so the integer
    // guard in resolveBuzzBudget is what stops a fractional Buzz budget. It
    // must DEFAULT (10), not pass 12.5 through.
    it('a fractional manifest budget (12.5) → integer default (10), never a fractional budget', async () => {
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(12.5));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.buzzBudget).toBe(10);
      expect(Number.isInteger(signArg.buzzBudget)).toBe(true);
    });

    it('an Infinity manifest budget → default (10), not an unbounded budget', async () => {
      // Infinity is filtered by the pageSettings mapper (Number.isFinite false)
      // → empty settings → resolveBuzzBudget default. Belt: even if it reached
      // resolveBuzzBudget, Number.isInteger(Infinity) is false → default.
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(Infinity));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.buzzBudget).toBe(10);
    });

    it('a NaN manifest budget → default (10), not a poisoned budget', async () => {
      // NaN is a `number` but Number.isFinite(NaN) is false → filtered by the
      // pageSettings mapper → empty settings → resolveBuzzBudget default. Belt:
      // even if it reached resolveBuzzBudget, Number.isInteger(NaN) is false →
      // default. Locks the third leg of the Number.isInteger guard (fractional /
      // Infinity / NaN) — without it a NaN budget could short-circuit the
      // downstream `buzzBudget <= 0` comparisons (NaN comparisons are always
      // false) and slip a non-numeric budget into the signed token.
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(NaN));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(200);
      const signArg = mockTokenService.sign.mock.calls[0][0];
      expect(signArg.buzzBudget).toBe(10);
      expect(Number.isInteger(signArg.buzzBudget)).toBe(true);
    });

    it('a negative INTEGER manifest budget (-50) reaching the mint → 422 (fail-closed, no silent default)', async () => {
      // A negative integer is a finite number → mapped into settings → reaches
      // resolveBuzzBudget as an integer → candidate <= 0 → 0 sentinel → 422.
      mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(-50));
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const res = makeRes();
      await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

      expect(res._status).toBe(422);
      expect(res._body.error).toBe('INVALID_BUZZ_BUDGET');
      expect(mockTokenService.sign).not.toHaveBeenCalled();
    });
  });

  // ── Audit: a MIXED manifest with one still-forbidden money scope is a HARD
  // reject of the WHOLE request — the allowed ai:write:budgeted does not
  // "rescue" the request when social:tip:self rides alongside it. ───────────
  it('MIXED manifest [ai:write:budgeted, social:tip:self] → 403, whole request rejected', async () => {
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted', 'social:tip:self'],
      revokedAt: null,
    });
    mockBlockRegistry.resolvePageBlock.mockResolvedValue({
      appBlock: {
        id: 'apb_page',
        blockId: 'hello-page',
        appId: 'appblk-hello-page',
        status: 'approved',
        manifest: {
          scopes: ['ai:write:budgeted', 'social:tip:self'],
          page: { path: '/', title: 'Hello' },
        },
        approvedScopes: ['ai:write:budgeted', 'social:tip:self'],
        // Allow both bits so the OAuth/approved gates pass and the PAGE HARD
        // RULE is what rejects (social:tip:self stays page-forbidden).
        app: { allowedScopes: MONEY_BITS },
      },
    });
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

    expect(res._status).toBe(403);
    // No partial mint — the whole request is rejected, no token signed.
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  // ── MODEL_INSTALL positive regression: the path the integer-enforcement fix
  // most needs to leave untouched. A valid integer install budget mints
  // verbatim (clamped only by the cap). ────────────────────────────────────
  it('MODEL path regression: settings.buzz_budget_per_gen=200 + ai:write:budgeted → buzzBudget===200', async () => {
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      ...MODEL_INSTALL,
      settings: { buzz_budget_per_gen: 200 },
      appBlock: {
        ...MODEL_INSTALL.appBlock,
        manifest: { scopes: ['ai:write:budgeted'] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 1 << 15 /* AIServicesWrite */ },
      },
    });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted'],
      revokedAt: null,
    });
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: modelBody() }), res);

    expect(res._status).toBe(200);
    expect(mockBlockRegistry.resolvePageBlock).not.toHaveBeenCalled();
    const signArg = mockTokenService.sign.mock.calls[0][0];
    expect(signArg.buzzBudget).toBe(200);
    // Model ctx stays byte-identical: { modelId, slotId }, no entityType.
    expect(signArg.ctx).toEqual({ modelId: 12345, slotId: 'model.sidebar_top' });
  });

  // ── Audit 🟡#2 — REGRESSION LOCK: the Number.isInteger guard now also affects
  // the MODEL-slot path (both paths share resolveBuzzBudget). A FRACTIONAL
  // install budget that PRE-PR would have flowed through verbatim (12.5) now
  // falls back to the DEFAULT (10). This is the intended post-PR behavior — a
  // model slot can never carry a fractional Buzz budget either. Documented here
  // so a future change can't silently re-loosen the integer guard for models.
  it('MODEL path regression: a FRACTIONAL install budget (12.5) → DEFAULT 10 (post-PR integer behavior)', async () => {
    mockBlockRegistry.resolveBlockInstance.mockResolvedValue({
      ...MODEL_INSTALL,
      settings: { buzz_budget_per_gen: 12.5 },
      appBlock: {
        ...MODEL_INSTALL.appBlock,
        manifest: { scopes: ['ai:write:budgeted'] },
        approvedScopes: ['ai:write:budgeted'],
        app: { allowedScopes: 1 << 15 /* AIServicesWrite */ },
      },
    });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted'],
      revokedAt: null,
    });
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: modelBody() }), res);

    expect(res._status).toBe(200);
    const signArg = mockTokenService.sign.mock.calls[0][0];
    expect(signArg.buzzBudget).toBe(10);
    expect(Number.isInteger(signArg.buzzBudget)).toBe(true);
  });

  // ── Anon page mint: when the pages flag is widened to the public (anon passes
  // both gates), the consent-gated `ai:write:budgeted` scope is STRIPPED from
  // the anon token — an anon viewer can never mint a spend-capable page token.
  // Mirrors the model-path anon-strip in index.test.ts. (Today the flag is
  // mod-only so anon is 403'd at the gate — this proves the strip is the belt
  // that keeps anon safe IF the flag is ever widened.)
  it('anon page mint (flag public): ai:write:budgeted is STRIPPED, not signed', async () => {
    (mockFlags.getFeatureFlags as any).mockImplementation(() => ({
      appBlocks: true,
      appBlocksPages: true,
    }));
    mockSession.value = null; // anonymous — no grant ledger
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(PAGE_BUDGET_BLOCK(200));
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const res = makeRes();
    await handler(makeReq({ origin: 'https://civitai.com', body: pageBody() }), res);

    expect(res._status).toBe(200);
    const signArg = mockTokenService.sign.mock.calls[0][0];
    // SECURITY INVARIANT: no money scope in an anon token. ai:write:budgeted is
    // consent-gated, so it is withheld for anon → the anon page token carries
    // NO spend scope and NO buzzBudget.
    expect(signArg.scopes).not.toContain('ai:write:budgeted');
    expect(signArg.buzzBudget).toBeUndefined();
    expect(signArg.userId).toBeNull();
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
