import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * PHASE 2 — App Dev Tunnel author-own SCOPED mint on POST /api/v1/block-tokens.
 *
 * When `resolvePageBlock` misses (a PRE-APPROVAL ephemeral app), the cookie-authed
 * AUTHOR who OWNS the app mints a SCOPED, forced-SFW, self-bound, budget-capped dev
 * token so real Buzz-spend generation works pre-approval. The RESOLVER is the single
 * scope authority (`app.scopes`); the mint re-clamps + signs it. Asserts:
 *   - grant = clampTunnelDeclaredScopes(resolver scopes); App Storage STRIPPED,
 *   - the BRAND-NEW scope decision comes from the SESSION + the unsubmitted-spend
 *     flag (passed to the resolver) — NEVER a request body,
 *   - the unsubmitted-spend flag OFF → read-only (no spend),
 *   - the app-blocks.dev-tunnel.mint audit event fires (never the token),
 *   - the synthetic non-resolving ids + forced-SFW + dev:true are signed,
 *   - foreign / approved-elsewhere (resolver → null) → the SAME bare 404, no token,
 *   - the dev-tunnel kill-switch OFF → 404 (no mint, before any session/scope read),
 *   - a resolved non-ephemeral status → 404 (fail-closed).
 */

const {
  mockSession,
  mockTokenService,
  mockBlockRegistry,
  mockFlags,
  mockAppBlocksFlag,
  mockDevTunnelService,
} = vi.hoisted(() => {
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
    isAppBlocksDevTunnelUnsubmittedSpendEnabled: vi.fn(async () => true),
  };
  // The mint reads the caller's dev-tunnel session (server-stored, CLI-declared) as
  // the BRAND-NEW scope source — never a browser body.
  const devTunnelService = {
    getActiveDevTunnel: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
      sessionId: 'bki_testsession',
      grantedScopes: ['ai:write:budgeted', 'user:read:self'],
    })),
  };
  return {
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
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mockSession.value),
}));
vi.mock('~/server/services/block-token.service', () => ({ BlockTokenService: mockTokenService }));
vi.mock('~/server/services/block-registry.service', () => ({ BlockRegistry: mockBlockRegistry }));
// The hand-written REDIS_KEYS carried a placeholder ('rl') where the real key is
// 'blocks:token-rate-limit'. Nothing asserted on it, so the copy was invisible; the canonical
// registration spreads the real constant.
vi.mock('~/server/utils/server-domain', () => ({
  getAllServerHosts: () => ['civitai.com'],
  getRequestDomainColor: () => undefined,
  isHostForColor: () => false,
  isMatureContentRating: () => false,
}));
vi.mock('~/server/services/feature-flags.service', () => mockFlags);
vi.mock('~/server/services/app-blocks-flag', () => mockAppBlocksFlag);
vi.mock('~/server/services/blocks/dev-tunnel.service', () => mockDevTunnelService);

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockDbWrite = dbMock.dbWrite;
const mockRedis = redisMock.redis;

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
  return res as unknown as NextApiResponse & {
    _status: number;
    _body: any;
    _headers: Record<string, string>;
  };
}

const MOD = { user: { id: 4242, isModerator: true, bannedAt: null } };

// The ephemeral resolution BlockRegistry.resolveDevPageBlockForAuthor returns for
// an OWNED pre-approval app. The resolver is the SINGLE scope authority — `scopes`
// is the clamped granted set (pending manifest OR session-declared). The mint
// re-clamps `app.scopes` and signs it; there is NO body scope source.
const EPHEMERAL_RESOLUTION = {
  appBlockId: 'ephemeral-my-app',
  appId: 'ephemeral-my-app',
  blockId: 'my-app',
  status: 'ephemeral',
  trustTier: 'unverified',
  name: 'my-app',
  pageTitle: 'my-app',
  sandbox: 'allow-scripts allow-forms',
  scopes: ['ai:write:budgeted', 'user:read:self'],
  ephemeralSource: 'brand-new',
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

// A POST whose Origin header is `origin` (pass `null` to omit it entirely — a
// `null`/absent Origin, e.g. a sandboxed-iframe or non-browser POST).
function makeReqOrigin(body: unknown, origin: string | null): NextApiRequest {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  return {
    method: 'POST',
    headers,
    body,
    socket: { remoteAddress: '127.0.0.1' },
    query: {},
  } as unknown as NextApiRequest;
}

async function invokeOrigin(body: unknown, origin: string | null) {
  const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
  const res = makeRes();
  await handler(makeReqOrigin(body, origin), res);
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
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(true);
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(true);
    mockAppBlocksFlag.isAppBlocksDevTunnelUnsubmittedSpendEnabled.mockResolvedValue(true);
    mockDevTunnelService.getActiveDevTunnel.mockResolvedValue({
      sessionId: 'bki_testsession',
      grantedScopes: ['ai:write:budgeted', 'user:read:self'],
    });
  });

  it('mints a scoped token by RE-CLAMPING the resolver-supplied scopes (App Storage stripped, self-read added)', async () => {
    // The resolver is the single scope authority; the mint re-clamps `app.scopes`
    // as defense-in-depth. A resolution carrying storage/junk → clamp strips it.
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...EPHEMERAL_RESOLUTION,
      scopes: ['ai:write:budgeted', 'apps:storage:read', 'apps:storage:write'],
      ephemeralSource: 'pending',
    });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    expect(res._body.token).toBe('jwt.dev.signed');
    expect(mockTokenService.sign).toHaveBeenCalledTimes(1);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
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
  });

  it('sources the BRAND-NEW scope decision from the SESSION + the flag (never the body): passes both to the resolver', async () => {
    mockDevTunnelService.getActiveDevTunnel.mockResolvedValue({
      sessionId: 'bki_testsession',
      grantedScopes: ['ai:write:budgeted', 'user:read:self'],
    });
    mockAppBlocksFlag.isAppBlocksDevTunnelUnsubmittedSpendEnabled.mockResolvedValue(true);
    // Junk body scopes MUST be ignored — there is no body scope source anymore.
    const res = await invoke(DEV_BODY({ devScopes: ['apps:storage:write', 'social:tip:self'] }));
    expect(res._status).toBe(200);
    // The resolver was called with the SESSION's grantedScopes + the flag result —
    // NOT anything from the request body.
    expect(mockBlockRegistry.resolveDevPageBlockForAuthor).toHaveBeenCalledWith(
      'my-app',
      MOD.user.id,
      expect.objectContaining({
        db: 'write',
        sessionGrantedScopes: ['ai:write:budgeted', 'user:read:self'],
        unsubmittedSpendAllowed: true,
      })
    );
    // Grant == clamp(resolver scopes); the body's storage/tip never appear.
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    expect(arg.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    expect(arg.scopes).not.toContain('apps:storage:write');
    expect(arg.scopes).not.toContain('social:tip:self');
  });

  it('unsubmitted-spend FLAG OFF → the mint passes unsubmittedSpendAllowed:false; a read-only resolution mints no spend', async () => {
    mockAppBlocksFlag.isAppBlocksDevTunnelUnsubmittedSpendEnabled.mockResolvedValue(false);
    // With the flag off the resolver returns the stripped (read-only) set.
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...EPHEMERAL_RESOLUTION,
      scopes: ['user:read:self'],
      ephemeralSource: 'brand-new',
    });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    expect(mockBlockRegistry.resolveDevPageBlockForAuthor).toHaveBeenCalledWith(
      'my-app',
      MOD.user.id,
      expect.objectContaining({ unsubmittedSpendAllowed: false })
    );
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    expect(arg.scopes).toEqual(['user:read:self']);
    expect(arg.scopes).not.toContain('ai:write:budgeted');
    expect(arg.buzzBudget).toBeUndefined(); // no spend granted → no budget
  });

  it('a resolver with NO scopes → a valid READ-ONLY token (no spend), still 200', async () => {
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...EPHEMERAL_RESOLUTION,
      scopes: [],
    });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(200);
    const arg = mockTokenService.sign.mock.calls[0][0] as any;
    expect(arg.scopes).toEqual(['user:read:self']); // clamp force-adds self-read
    expect(arg.buzzBudget).toBeUndefined();
  });

  it('emits the app-blocks.dev-tunnel.mint audit event (spendGranted reflects the grant), NEVER the token', async () => {
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...EPHEMERAL_RESOLUTION,
      scopes: ['ai:write:budgeted', 'user:read:self'],
      ephemeralSource: 'brand-new',
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
    const req = makeReq(DEV_BODY()) as any;
    req.log = log;
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(log.info).toHaveBeenCalledWith(
      'app-blocks.dev-tunnel.mint',
      expect.objectContaining({
        mode: 'brand-new',
        userId: MOD.user.id,
        slug: 'my-app',
        sessionId: 'bki_testsession',
        scopes: ['ai:write:budgeted', 'user:read:self'],
        spendGranted: true,
      })
    );
    // The audit payload must NOT carry the signed token/secret.
    const payload = log.info.mock.calls.find(
      (c: any[]) => c[0] === 'app-blocks.dev-tunnel.mint'
    )![1];
    expect(JSON.stringify(payload)).not.toContain('jwt.dev.signed');
  });

  /**
   * THE STDOUT MIRROR (#3715). The `req.log?.info` sink above is Axiom-only in
   * production: next-axiom's `Logger.sendLogs()` prints to the console ONLY when the
   * AXIOM_* env vars are unset (dist/logger.js:198-202), so with them set nothing
   * reaches stdout and a stdout-scraping log store cannot see this event at all.
   *
   * 🔴 WHY THIS EVENT IS DUAL-SINKED — and it is NOT because it feeds a gate.
   * `app-blocks.dev-tunnel.mint` is classified `kind: 'audit-only'` in the call-site
   * ledger: it carries `spendGranted` only, with no `spendGrantBasis` and no
   * `requestBudgetedSpend`, because the dev-tunnel path has no per-mint request
   * mechanism to record. #3715 puts this path out of the adoption gate's scope
   * entirely. The mirror exists for the reason that applies to every mint audit,
   * gate-bearing or not: a SHORT-WINDOW (~72h measured) forensic copy readable at
   * incident time, and a second sink that does not depend on one vendor being
   * reachable. Both halves are asserted; losing either loses a distinct capability.
   */
  describe('the app-blocks.dev-tunnel.mint audit event is ALSO mirrored to stdout (#3715)', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    // Nested, so it runs AFTER the outer beforeEach's vi.clearAllMocks().
    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => {
      logSpy.mockRestore();
    });

    /** Every stdout line the handler wrote, parsed back from JSON. */
    const stdoutEvents = (): Record<string, unknown>[] =>
      logSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((line: unknown): line is string => typeof line === 'string')
        .flatMap((line: string) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
    const mirrorOf = (name: string) => stdoutEvents().find((e) => e.event === name);

    it('POSITIVE CONTROL: the stdout spy observes a real emit, and reports absence for a name nothing emits', async () => {
      const res = await invoke(DEV_BODY());
      expect(res._status).toBe(200);
      expect(stdoutEvents().length).toBeGreaterThan(0);
      expect(mirrorOf('app-blocks.dev-tunnel.no-such-mint')).toBeUndefined();
    });

    it('mirrors the event to stdout with the SAME name and the SAME payload as the Axiom sink, NEVER the token', async () => {
      // RED at base: the mirror did not exist, so nothing was written to stdout.
      mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
        ...EPHEMERAL_RESOLUTION,
        scopes: ['ai:write:budgeted', 'user:read:self'],
        ephemeralSource: 'brand-new',
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
      const req = makeReq(DEV_BODY()) as any;
      req.log = log;
      const res = makeRes();
      await handler(req, res);
      expect(res._status).toBe(200);

      // Enumerated payload — not a `toContain`, which a differently-shaped object
      // could satisfy.
      const mirror = mirrorOf('app-blocks.dev-tunnel.mint');
      expect(mirror).toEqual({
        event: 'app-blocks.dev-tunnel.mint',
        mode: 'brand-new',
        userId: MOD.user.id,
        slug: 'my-app',
        sessionId: 'bki_testsession',
        scopes: ['ai:write:budgeted', 'user:read:self'],
        spendGranted: true,
      });
      // DUAL-SINK RELATIONSHIP: the mirror is exactly the Axiom payload plus `event`.
      // Pins the two sinks together so neither can silently drift.
      const axiom = log.info.mock.calls.find(
        (c: any[]) => c[0] === 'app-blocks.dev-tunnel.mint'
      )![1];
      expect(mirror).toEqual({ event: 'app-blocks.dev-tunnel.mint', ...axiom });
      // 🔴 No token on the stdout sink either.
      expect(JSON.stringify(mirror)).not.toContain('jwt.dev.signed');
    });

    it('a READ-ONLY mint mirrors spendGranted:false (the enumerated value, not the absence of a word)', async () => {
      mockAppBlocksFlag.isAppBlocksDevTunnelUnsubmittedSpendEnabled.mockResolvedValue(false);
      mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue({
        ...EPHEMERAL_RESOLUTION,
        scopes: ['user:read:self'],
        ephemeralSource: 'brand-new',
      });
      const res = await invoke(DEV_BODY());
      expect(res._status).toBe(200);
      const mirror = mirrorOf('app-blocks.dev-tunnel.mint')!;
      expect(mirror.spendGranted).toBe(false);
      expect(mirror.scopes).toEqual(['user:read:self']);
    });

    it('a path that never mints (resolver → null, 404) mirrors NOTHING', async () => {
      // The mirror must be tied to the mint, not to the request: a 404 that signs no
      // token must not fabricate an audit line.
      mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue(null);
      const res = await invoke(DEV_BODY());
      expect(res._status).toBe(404);
      expect(mirrorOf('app-blocks.dev-tunnel.mint')).toBeUndefined();
    });
  });

  it('foreign / already-claimed / absent app (resolver → null) → the SAME bare 404, NO token', async () => {
    mockBlockRegistry.resolveDevPageBlockForAuthor.mockResolvedValue(null);
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Page app not found' });
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('dev-tunnel kill-switch OFF → 404, NO token (before any session/scope read)', async () => {
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(false);
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    // fail-closed BEFORE reading the tunnel session / resolving.
    expect(mockDevTunnelService.getActiveDevTunnel).not.toHaveBeenCalled();
    expect(mockBlockRegistry.resolveDevPageBlockForAuthor).not.toHaveBeenCalled();
  });

  it('author capability OFF → 404, NO token', async () => {
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(false);
    const res = await invoke(DEV_BODY());
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
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('a soft-deleted account never mints (M1 parity)', async () => {
    mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: new Date(), bannedAt: null });
    const res = await invoke(DEV_BODY());
    expect(res._status).toBe(404);
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });

  it('CROSS-ORIGIN POST (Origin not in the allowlist) is 403 by setSameOriginCors BEFORE the dev mint', async () => {
    // setSameOriginCors (handler entry) rejects the request before the dev-tunnel
    // branch runs — the CSRF gate must fire ahead of any ownership/mint work, so a
    // forged cross-origin POST can neither mint a token nor touch the resolver.
    const res = await invokeOrigin(DEV_BODY(), 'https://evil.example');
    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'cross-origin POST rejected' });
    // Never reached the dev branch: no resolve, no sign, no ACAO for the bad origin.
    expect(mockBlockRegistry.resolveDevPageBlockForAuthor).not.toHaveBeenCalled();
    expect(mockTokenService.sign).not.toHaveBeenCalled();
    expect(res._headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a null/absent-Origin POST is likewise 403 before the dev mint', async () => {
    const res = await invokeOrigin(DEV_BODY(), null);
    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'cross-origin POST rejected' });
    expect(mockBlockRegistry.resolveDevPageBlockForAuthor).not.toHaveBeenCalled();
    expect(mockTokenService.sign).not.toHaveBeenCalled();
  });
});
