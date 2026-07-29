import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * PHASE 2 — App Dev Tunnel OWNED, NON-APPROVED mint on POST /api/v1/block-tokens.
 *
 * Closes the SSR↔mint asymmetry: the SSR dev route mounts an OWNED app at ANY status
 * (`resolveDevPageBlockForAuthor`), but the token mint's `resolvePageBlock` requires
 * `status:'approved'` and `tryDevTunnelScopedMint` only rescues the synthetic
 * `ephemeral-*` namespace — so a previously-approved app now suspended / pending /
 * deprecated (a REAL `apb_…` id) fell through BOTH branches to the bare 404, which the
 * host rendered as "Couldn't authenticate this app". This branch mints a SCOPED,
 * forced-SFW, self-bound, budget-capped dev token for that case, gated on OWNERSHIP +
 * an ACTIVE dev tunnel + the author/dev-tunnel flags, sourcing scopes from the app's
 * APPROVED SNAPSHOT (never the raw manifest).
 *
 * Asserts the 6 security invariants + the full matrix:
 *   ✅ owner + suspended/pending/deprecated + active tunnel + flags → self-bound mint,
 *      scopes = clamped approved snapshot, budget from manifest, forced-SFW, dev:true,
 *   ❌ non-owner (resolver → null) → the SAME bare 404, no mint, no oracle,
 *   ❌ owner + no active tunnel → 404 (not a general un-suspend),
 *   ❌ owner + dev-tunnel flag OFF → 404 (also proves the PUBLIC path stays 404),
 *   ✅ scope clamp: apps:storage:* in the approved snapshot is STRIPPED,
 *   ✅ approved app → handled by resolvePageBlock; this branch is never reached.
 */

const {
  mockDbWrite,
  mockRedis,
  mockSession,
  mockTokenService,
  mockBlockRegistry,
  mockFlags,
  mockAppBlocksFlag,
  mockDevTunnelService,
} = vi.hoisted(() => {
  const dbWrite = {
    user: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
        deletedAt: null,
        bannedAt: null,
      })),
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
    // resolvePageBlock MISSES for a non-approved app → the dev branches run.
    resolvePageBlock: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    // Ephemeral branch resolver — never matches a real `apb_…` id, but the handler
    // calls it only for the `ephemeral-*` namespace; default null keeps it inert.
    resolveDevPageBlockForAuthor: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    // The NEW owned-non-approved resolver.
    resolveOwnedNonApprovedPageBlock: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
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
    isAppBlocksDevTunnelUnsubmittedSpendEnabled: vi.fn(async () => true),
  };
  const devTunnelService = {
    getActiveDevTunnel: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
      sessionId: 'bki_testsession',
      grantedScopes: [],
    })),
  };
  return {
    mockDbWrite: dbWrite,
    mockRedis: redis,
    mockSession: session,
    mockTokenService: tokenService,
    mockBlockRegistry: blockRegistry,
    mockFlags: flags,
    mockAppBlocksFlag: appBlocksFlag,
    mockDevTunnelService: devTunnelService,
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
vi.mock('~/server/services/blocks/dev-tunnel.service', () => mockDevTunnelService);

function makeReq(body: unknown): NextApiRequest & { log?: any } {
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
  return res as unknown as NextApiResponse & {
    _status: number;
    _body: any;
    _headers: Record<string, string>;
  };
}

const MOD = { user: { id: 4242, isModerator: true, bannedAt: null } };

// The resolution BlockRegistry.resolveOwnedNonApprovedPageBlock returns for an OWNED,
// non-approved page app: the REAL ids + the app's status + the moderator-reviewed
// approved-scope SNAPSHOT + the manifest (for page.buzzBudgetPerGen).
const OWNED_RESOLUTION = (extra?: Record<string, unknown>) => ({
  appBlockId: 'apb_real',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  status: 'suspended',
  approvedScopes: ['ai:write:budgeted', 'user:read:self'],
  manifest: {
    name: 'My App',
    page: { path: '/', title: 'My App', buzzBudgetPerGen: 75 },
    scopes: ['ai:write:budgeted', 'user:read:self'],
  },
  ...extra,
});

const DEV_BODY = (extra?: Record<string, unknown>) => ({
  blockInstanceId: 'page_apb_real',
  slotContext: { entityType: 'none', slotId: 'app.page' },
  ...extra,
});

async function invoke(body: unknown) {
  const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

describe('POST /api/v1/block-tokens — dev-tunnel OWNED non-approved mint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.value = MOD;
    mockRedis.incrBy.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(60);
    mockTokenService.checkRateLimit.mockResolvedValue(true);
    mockBlockRegistry.resolvePageBlock.mockResolvedValue(null); // non-approved → miss
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue(null);
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(OWNED_RESOLUTION());
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(true);
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(true);
    mockDevTunnelService.getActiveDevTunnel.mockResolvedValue({
      sessionId: 'bki_testsession',
      grantedScopes: [],
    });
  });

  it('owner + SUSPENDED app + active tunnel + flags → mints a self-bound token (real ids, dev:true, forced-SFW)', async () => {
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    expect(res._body.token).toBe('jwt.dev.signed');
    expect(res._body.domain).toBeNull();
    expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    // Scopes = clamped approved snapshot (user:read:self force-added; already present).
    expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    // Self-bound to the OWNER; the app's REAL ids are signed (not synthetic).
    expect(arg.userId).toBe(MOD.user.id);
    expect(arg.appId).toBe('appblk-my-app');
    expect(arg.appBlockId).toBe('apb_real');
    expect(arg.blockId).toBe('my-app');
    expect(arg.blockInstanceId).toBe('page_apb_real');
    expect(arg.dev).toBe(true);
    expect(arg.domain).toBeNull();
    // Budget from the manifest page.buzzBudgetPerGen (75), clamped to the dev cap (250).
    expect(arg.buzzBudget).toBe(75);
    // Ownership resolve was called with the real id + caller + write db.
    expect(mockBlockRegistry.resolveOwnedNonApprovedPageBlock).toHaveBeenCalledWith(
      'apb_real',
      MOD.user.id,
      { db: 'write' }
    );
    // Active-tunnel check keyed on (userId, slug).
    expect(mockDevTunnelService.getActiveDevTunnel).toHaveBeenCalledWith(MOD.user.id, 'my-app');
  });

  it.each([['pending'], ['deprecated']])(
    'owner + %s app + active tunnel → mints via the SAME belt',
    async (status) => {
      mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(
        OWNED_RESOLUTION({ status })
      );
      const res = await invoke(DEV_BODY());
      expect(res._status).toBe(200);
      expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
      const arg = mockTokenService.sign.mock.calls[0][0] as any;
      expect(arg.appBlockId).toBe('apb_real');
      expect(arg.dev).toBe(true);
    }
  );

  it('NON-OWNER (resolver → null) → the SAME bare 404, NO token, even with a tunnel + flags on', async () => {
    // The resolver enforces ownership in the query; a non-owner gets null → 404. The
    // active tunnel + flags are irrelevant — no cross-user mint, no existence oracle.
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(null);
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Page app not found' });
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    // Fail-closed before ever touching the tunnel (resolve gates first).
    expect(mockDevTunnelService.getActiveDevTunnel).not.toHaveBeenCalled();
  });

  it('owner + suspended app but NO ACTIVE TUNNEL → 404 (not a general un-suspend)', async () => {
    mockDevTunnelService.getActiveDevTunnel.mockResolvedValue(null);
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Page app not found' });
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('owner + suspended app + dev-tunnel FLAG OFF → 404 (also proves the PUBLIC path stays 404 for a suspended app)', async () => {
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(false);
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    // Fail-closed BEFORE resolving ownership / touching the tunnel.
    expect(mockBlockRegistry.resolveOwnedNonApprovedPageBlock).not.toHaveBeenCalled();
    expect(mockDevTunnelService.getActiveDevTunnel).not.toHaveBeenCalled();
  });

  it('author capability OFF → 404, NO token', async () => {
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(false);
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    expect(mockBlockRegistry.resolveOwnedNonApprovedPageBlock).not.toHaveBeenCalled();
  });

  it('SCOPE CLAMP: apps:storage:* / social:tip:self in the approved snapshot are STRIPPED, no widening', async () => {
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(
      OWNED_RESOLUTION({
        approvedScopes: ['ai:write:budgeted', 'apps:storage:read', 'apps:storage:write', 'social:tip:self'],
      })
    );
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    // ai:write:budgeted survives (tunnel allowlist), storage/tip stripped, self-read added.
    expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    expect(arg.scopes).not.toContain('apps:storage:read');
    expect(arg.scopes).not.toContain('apps:storage:write');
    expect(arg.scopes).not.toContain('social:tip:self');
  });

  it('an EMPTY approved snapshot → a valid READ-ONLY token (user:read:self only, no budget)', async () => {
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(
      OWNED_RESOLUTION({ approvedScopes: [] })
    );
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    expect(arg.scopes).toEqual(['user:read:self']);
    expect(arg.buzzBudget).toBeUndefined(); // no spend scope → no budget
  });

  it('a read-only approved snapshot (no ai:write:budgeted) mints no budget', async () => {
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(
      OWNED_RESOLUTION({ approvedScopes: ['user:read:self', 'models:read:self'] })
    );
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    expect(arg.scopes).toEqual(['models:read:self', 'user:read:self']);
    expect(arg.buzzBudget).toBeUndefined();
  });

  it('emits the app-blocks.dev-tunnel.owned-nonapproved-mint audit event, NEVER the token', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const req = makeReq(DEV_BODY()) as any;
    req.log = log;
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(log.info).toHaveBeenCalledWith(
      'app-blocks.dev-tunnel.owned-nonapproved-mint',
      expect.objectContaining({
        status: 'suspended',
        userId: MOD.user.id,
        slug: 'my-app',
        sessionId: 'bki_testsession',
        scopes: ['ai:write:budgeted', 'user:read:self'],
        spendGranted: true,
      })
    );
    const payload = log.info.mock.calls.find(
      (c: any[]) => c[0] === 'app-blocks.dev-tunnel.owned-nonapproved-mint'
    )![1];
    expect(JSON.stringify(payload)).not.toContain('jwt.dev.signed');
  });

  it('a soft-deleted account never mints (M1 parity)', async () => {
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: new Date(), bannedAt: null });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('REGRESSION: an APPROVED app is handled by resolvePageBlock — this branch is never reached', async () => {
    // resolvePageBlock succeeds for an approved app → the normal mint path runs and
    // the owned-non-approved branch (and its resolver) is never touched.
    mockBlockRegistry.resolvePageBlock.mockResolvedValue({
      appBlock: {
        id: 'apb_real',
        blockId: 'my-app',
        appId: 'appblk-my-app',
        status: 'approved',
        currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
        manifest: { scopes: ['models:read:self'], page: { path: '/', title: 'My App' } },
        approvedScopes: ['models:read:self'],
        app: { allowedScopes: 4 /* ModelsRead */ },
      },
    });
    mockDbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['models:read:self'],
      revokedAt: null,
    });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    // The non-approved branch never ran for an approved app.
    expect(mockBlockRegistry.resolveOwnedNonApprovedPageBlock).not.toHaveBeenCalled();
  });

  it('an ephemeral-<slug> id is NOT handled by this branch (belongs to tryDevTunnelScopedMint)', async () => {
    // A synthetic ephemeral id must never reach resolveOwnedNonApprovedPageBlock — the
    // prefix gate hands it to the ephemeral branch instead. Here the ephemeral
    // resolver returns null → 404, and the owned resolver is never called.
    const res = await invoke({
      blockInstanceId: 'page_ephemeral-my-app',
      slotContext: { entityType: 'none', slotId: 'app.page' },
    });
    expect(res._status).toBe(404);
    expect(mockBlockRegistry.resolveOwnedNonApprovedPageBlock).not.toHaveBeenCalled();
  });
});
