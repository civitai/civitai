import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PRIVATE_RUN_REFUSAL_REASONS } from '~/server/services/blocks/private-run-access.service';
// Type-only namespace import, hoisted, because an inline `typeof import('…')` is an ERROR under
// @typescript-eslint/consistent-type-imports — and in a file that is NEW on this branch that is
// a BLOCKING error: `.github/workflows/lint.yml` lints ADDED files for real and only
// report-only-lints MODIFIED ones, on the stated reasoning that "new files start clean". The
// sibling that already solved this is
// `src/server/services/blocks/__tests__/block-bridge-auth.consent-revocation.test.ts`.
// Erased at compile time, so it does NOT load the module the factory below partially replaces.
import type * as PrivateRunAccessModule from '~/server/services/blocks/private-run-access.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockDbWrite = dbMock.dbWrite;
dbMock.dbWrite.user.findUnique.mockImplementation(async () => ({
  deletedAt: null,
  bannedAt: null,
}));
redisMock.redis.incrBy.mockImplementation(async () => 1);
redisMock.redis.expire.mockImplementation(async () => true);
redisMock.redis.ttl.mockImplementation(async () => 60);

/**
 * PHASE 3 — the PRIVATE-RUN mint on POST /api/v1/block-tokens.
 *
 * Serves a DELISTED / SUSPENDED app's already-deployed bundle to its owner, an accepted
 * listing collaborator, or a moderator. Requires NO dev tunnel, which is what makes it
 * mutually exclusive with PHASE 2.
 *
 * ── THE CENTRAL CLAIM OF THIS FILE ──────────────────────────────────────────────
 * 🔴 NOT "IT REFUSES" — "IT REFUSES *IDENTICALLY*". Every refusal on this surface must
 * be byte-indistinguishable from the response for an app that does not exist, because
 * the alternative is an existence oracle: a distinguishable refusal tells any signed-in
 * prober which delisted slugs are real, which of them are theirs, and which are
 * undeployed. So the refusal tests capture the FULL response for a nonexistent
 * appBlockId once, then assert DEEP EQUALITY of status + body + headers against it —
 * with a positive control in the same test proving the comparison can actually
 * distinguish a different response.
 */

const {
  mockSession,
  mockTokenService,
  mockBlockRegistry,
  mockFlags,
  mockAppBlocksFlag,
  mockDevTunnelService,
  mockPrivateRunAccess,
  mockStdoutAudit,
} = vi.hoisted(() => ({
  mockSession: { value: null as any },
  mockTokenService: {
    sign: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
      token: 'jwt.privaterun.signed',
      expiresAt: '2099-01-01T00:00:00Z',
      jti: 'j',
    })),
    checkRateLimit: vi.fn<(...args: any[]) => Promise<boolean>>(async () => true),
  },
  mockBlockRegistry: {
    resolveBlockInstance: vi.fn<(...args: any[]) => Promise<any>>(),
    // MISSES for a non-approved app, which is what lets PHASE 2/3 run at all.
    resolvePageBlock: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    resolveDevPageBlockForAuthor: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    // PHASE 2 must MISS in this file, so PHASE 3 is the branch under test.
    resolveOwnedNonApprovedPageBlock: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
  },
  mockFlags: {
    getFeatureFlags: vi.fn(({ user }: { user?: { isModerator?: boolean } }) => ({
      appBlocks: !!user,
      appBlocksPages: !!user,
    })),
  },
  mockAppBlocksFlag: {
    isAppBlocksAuthorEnabled: vi.fn(async () => false),
    isAppBlocksDevTunnelEnabled: vi.fn(async () => false),
    isAppBlocksDevTunnelUnsubmittedSpendEnabled: vi.fn(async () => false),
    isAppBlocksPrivateRunEnabled: vi.fn(async () => true),
  },
  mockDevTunnelService: {
    getActiveDevTunnel: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
  },
  // 🔴 THE PREDICATE IS MOCKED AT ITS MODULE SEAM, and that is the right seam for a
  // HANDLER test. Its own behaviour — the whole access matrix, every gate order and
  // every reachability proof — is covered behaviourally against a fake Prisma in
  // `blocks/__tests__/private-run-access.service.test.ts`, and the two are joined by a
  // behavioural SSR⇄mint agreement case in the call-site ledger. What THIS file owns is
  // the handler's contract: given a verdict, does the mint produce the right response,
  // the right claims, and an indistinguishable refusal.
  mockPrivateRunAccess: {
    resolvePrivateRunAccess: vi.fn<(...args: any[]) => Promise<any>>(),
  },
  mockStdoutAudit: { emitMintAuditToStdout: vi.fn() },
}));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    NEXTAUTH_URL: 'https://civitai.com',
    TRPC_ORIGINS: [] as string[],
    BLOCK_TOKEN_PRIVATE_KEY: 'fake-private',
    BLOCK_TOKEN_PUBLIC_KEY: 'fake-public',
    APP_BLOCK_OAUTH_TOKENS_ENABLED: false,
  },
}));
vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mockSession.value),
}));
vi.mock('~/server/services/block-token.service', () => ({ BlockTokenService: mockTokenService }));
vi.mock('~/server/services/block-registry.service', () => ({ BlockRegistry: mockBlockRegistry }));
vi.mock('~/server/utils/server-domain', () => ({
  getAllServerHosts: () => ['civitai.com'],
  getRequestDomainColor: () => undefined,
  isHostForColor: () => false,
  isMatureContentRating: () => false,
}));
vi.mock('~/server/services/feature-flags.service', () => mockFlags);
vi.mock('~/server/services/app-blocks-flag', () => mockAppBlocksFlag);
vi.mock('~/server/services/blocks/dev-tunnel.service', () => mockDevTunnelService);
// 🔴 A PARTIAL MOCK, NOT A WHOLESALE ONE, AND THE DIFFERENCE IS LOAD-BEARING HERE.
// This file now imports `PRIVATE_RUN_REFUSAL_REASONS` from the same module so its
// refusal lists are DERIVED rather than hand-copied. A wholesale factory returning only
// `resolvePrivateRunAccess` would make that tuple `undefined` at import time — the
// one-key-factory staleness shape this repo has a guard for — and the two loops over it
// would silently iterate nothing, i.e. the no-existence-oracle test would pass having
// compared zero refusals. Spreading the original keeps the real tuple and overrides only
// the function under mock.
vi.mock('~/server/services/blocks/private-run-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrivateRunAccessModule>()),
  resolvePrivateRunAccess: mockPrivateRunAccess.resolvePrivateRunAccess,
}));
vi.mock('~/server/logging/mint-audit-stdout', () => mockStdoutAudit);

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

const APP_BLOCK = 'apb_privrun';
const OWNER = 4001;
const EDITOR = 4002;
const MOD = 4004;

/**
 * 🔴 EVERY ID AND BUDGET IS PAIRWISE DISTINCT, AND DISTINCT FROM EVERY CONSTANT THE
 * ASSERTIONS NAME. The manifest budget is 137 — not 250 (the cap), not 50 (the
 * default), not a multiple of either — so a clamp or precedence mutant MOVES the
 * asserted value instead of landing on it.
 */
const BLOCK = (over: Record<string, unknown> = {}) => ({
  appBlockId: APP_BLOCK,
  blockId: 'seed-explorer-fixture',
  appId: 'app_privrun',
  status: 'suspended',
  approvedScopes: ['ai:write:budgeted', 'models:read:self'],
  manifest: {
    name: 'Seed Explorer',
    page: { path: '/', title: 'Seed', buzzBudgetPerGen: 137 },
    scopes: ['ai:write:budgeted', 'models:read:self'],
    iframe: { src: 'https://seed-explorer-fixture.civit.ai', sandbox: 'allow-scripts' },
  },
  iframeSrc: 'https://seed-explorer-fixture.civit.ai',
  sandbox: 'allow-scripts',
  trustTier: 'unverified',
  name: 'Seed Explorer',
  pageTitle: 'Seed',
  scopes: ['ai:write:budgeted', 'models:read:self'],
  contentRating: 'g',
  bootSkeleton: false,
  currentVersionDeployedAt: new Date('2026-09-01'),
  ownerUserId: OWNER,
  listingStatus: 'removed',
  ...over,
});

const BODY = (over: Record<string, unknown> = {}) => ({
  blockInstanceId: `page_${APP_BLOCK}`,
  slotContext: { entityType: 'none', slotId: 'app.page' },
  ...over,
});

async function invoke(body: unknown) {
  const { default: handler } = await import('~/pages/api/v1/block-tokens/index');
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

/** The comparable projection of a response: status + body + every header. */
function shape(res: { _status: number; _body: any; _headers: Record<string, string> }) {
  return { status: res._status, body: res._body, headers: { ...res._headers } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.value = { user: { id: MOD, isModerator: true, bannedAt: null } };
  mockTokenService.checkRateLimit.mockResolvedValue(true);
  mockTokenService.sign.mockResolvedValue({
    token: 'jwt.privaterun.signed',
    expiresAt: '2099-01-01T00:00:00Z',
    jti: 'j',
  });
  mockBlockRegistry.resolvePageBlock.mockResolvedValue(null);
  mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(null);
  mockDevTunnelService.getActiveDevTunnel.mockResolvedValue(null);
  mockDbWrite.user.findUnique.mockResolvedValue({ deletedAt: null, bannedAt: null });
  mockAppBlocksFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(true);
  mockFlags.getFeatureFlags.mockImplementation(({ user }: any) => ({
    appBlocks: !!user,
    appBlocksPages: !!user,
  }));
});

describe('PHASE 3 private-run mint — the grant path [REG]', () => {
  it('a MODERATOR on a suspended, deployed app mints a self-bound, forced-SFW token', async () => {
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    const res = await invoke(BODY());
    expect(res._status).toBe(200);
    expect(res._body.token).toBe('jwt.privaterun.signed');
    expect(res._body.kind).toBe('block');
    // No consent round-trip on this surface.
    expect(res._body.needsConsent).toBe(false);
    expect(res._body.missingScopes).toEqual([]);
    expect(res._headers['cache-control']).toBe('no-store');

    const signed = mockTokenService.sign.mock.calls[0][0];
    // SELF-BOUND: the `sub` is the VIEWER, so nobody ever spends another user's Buzz.
    expect(signed.userId).toBe(MOD);
    // The app's REAL ids — the deliberate divergence from the review sandbox, which
    // signs a non-resolving synthetic id. The real ids are what make the
    // `page_<appBlockId>` ban-revocation namespace and the metric labels work.
    expect(signed.appBlockId).toBe(APP_BLOCK);
    expect(signed.appId).toBe('app_privrun');
    expect(signed.blockId).toBe('seed-explorer-fixture');
  });

  it('🔴 the token carries privateRun:true and the AUDIENCE, and NEVER dev:true', async () => {
    // `dev: true` would skip the per-app velocity reservation and hand every admitted
    // viewer an uncapped per-app surface on a taken-down app. This is the assertion
    // that would catch a mint that reached for `dev` to get past a status gate.
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      mockTokenService.sign.mockClear();
      mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
        allowed: true,
        audience,
        block: BLOCK(),
      });
      await invoke(BODY());
      const signed = mockTokenService.sign.mock.calls[0][0];
      expect(signed.privateRun, `audience=${audience}`).toBe(true);
      expect(signed.privateRunAudience).toBe(audience);
      expect(signed.dev, 'a private-run token must NEVER be a dev token').not.toBe(true);
      expect(signed.reviewRunForReal).not.toBe(true);
    }
  });

  it('SCOPES come from the approved SNAPSHOT through the private-run clamp', async () => {
    // The manifest here declares MORE than the snapshot; only the snapshot may reach
    // the token, and only after the clamp.
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK({
        approvedScopes: ['models:read:self'],
        manifest: {
          name: 'Seed Explorer',
          page: { path: '/', buzzBudgetPerGen: 137 },
          scopes: ['ai:write:budgeted', 'posts:write:self', 'collections:read:private'],
        },
      }),
    });
    const res = await invoke(BODY());
    expect(res._status).toBe(200);
    // EXACTLY the clamped snapshot plus the force-added self-read — no widening.
    expect(res._body.scopes).toEqual(['models:read:self', 'user:read:self']);
    expect(res._body.scopes).not.toContain('ai:write:budgeted');
    expect(res._body.scopes).not.toContain('posts:write:self');
    const signed = mockTokenService.sign.mock.calls[0][0];
    expect(signed.scopes).toEqual(['models:read:self', 'user:read:self']);
    // No spend scope ⇒ no budget claim at all.
    expect(signed.buzzBudget).toBeUndefined();
  });

  it('🔴 approvedScopes: [] mints a VALID token that can spend nothing — not a 403', async () => {
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'owner',
      block: BLOCK({ approvedScopes: [] }),
    });
    const res = await invoke(BODY());
    expect(res._status).toBe(200);
    expect(res._body.scopes).toEqual(['user:read:self']);
    expect(mockTokenService.sign.mock.calls[0][0].buzzBudget).toBeUndefined();
  });

  it('🔴 an EDITOR is READ-ONLY — no spend scope, no budget, even with both in the snapshot', async () => {
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'editor',
      block: BLOCK(),
    });
    const res = await invoke(BODY());
    expect(res._status).toBe(200);
    expect(res._body.scopes).not.toContain('ai:write:budgeted');
    expect(res._body.scopes).toContain('models:read:self');
    expect(mockTokenService.sign.mock.calls[0][0].buzzBudget).toBeUndefined();
  });

  it('an OWNER and a MODERATOR keep the spend scope and the clamped budget', async () => {
    for (const audience of ['owner', 'moderator'] as const) {
      mockTokenService.sign.mockClear();
      mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
        allowed: true,
        audience,
        block: BLOCK(),
      });
      const res = await invoke(BODY());
      expect(res._body.scopes, `audience=${audience}`).toContain('ai:write:budgeted');
      // 137 is under the 250 cap, so it passes through verbatim — and because it is
      // neither the cap nor the default, this value could only have come from the
      // manifest via the clamp.
      expect(mockTokenService.sign.mock.calls[0][0].buzzBudget).toBe(137);
    }
  });

  it('a manifest budget OVER the dev cap clamps to 250', async () => {
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK({
        manifest: {
          name: 'x',
          page: { path: '/', buzzBudgetPerGen: 301 },
          scopes: ['ai:write:budgeted'],
        },
      }),
    });
    await invoke(BODY());
    expect(mockTokenService.sign.mock.calls[0][0].buzzBudget).toBe(250);
  });

  it('the mint-time AUDIT line carries the audience, slug, status and listing status', async () => {
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    await invoke(BODY());
    const [event, fields] = mockStdoutAudit.emitMintAuditToStdout.mock.calls[0];
    expect(event).toBe('app-blocks.private-run.mint');
    // The discriminating half: a grant must NOT ride the refusal event.
    expect(event).not.toBe('app-blocks.private-run.mint-refused');
    expect(fields).toMatchObject({
      outcome: 'granted',
      audience: 'moderator',
      status: 'suspended',
      listingStatus: 'removed',
      userId: MOD,
      slug: 'seed-explorer-fixture',
      spendGranted: true,
    });
    // 🔴 NEVER THE TOKEN. Flags and identifiers only — the audit sink takes flat
    // scalars, and a token in a log line is a credential in a log line.
    expect(JSON.stringify(fields)).not.toContain('jwt.privaterun.signed');
  });
});

describe('🔴 PHASE 3 — NO EXISTENCE ORACLE: every refusal is byte-identical [INV]', () => {
  /**
   * [INV] rather than [REG] for the mint half: the 404 shape predates this work, and
   * what is new is that a whole family of private-run refusals now routes into it. The
   * SSR half of this property is [REG] and lives in the page test.
   */
  /**
   * 🔴 DERIVED FROM THE EXPORTED TUPLE, NOT HAND-WRITTEN. The first version listed eight
   * reasons by hand and OMITTED `no-iframe-src` — the reason added by the very change
   * that introduced this list — so the byte-identical-404 invariant went unasserted for
   * the new refusal. That is the exact staleness `PRIVATE_RUN_REFUSAL_REASONS` was
   * exported to prevent, reproduced one file over.
   *
   * `no-app` is the BASELINE every other reason is compared against, so it is excluded
   * here rather than listed as one of the compared refusals.
   */
  const refusals = PRIVATE_RUN_REFUSAL_REASONS.filter((r) => r !== 'no-app');

  it('POSITIVE CONTROL: the derived refusal list is non-empty and covers the tuple', () => {
    // 🔴 DERIVING A LIST TRADES STALENESS FOR A NEW FAILURE MODE: an empty derived list
    // makes every loop below iterate nothing and pass. (An UNDEFINED tuple would throw
    // at `.filter`, so that half is self-announcing; an empty one is not.) Bound it, and
    // pin that exactly one reason was excluded.
    expect(refusals.length).toBeGreaterThan(6);
    expect(refusals.length).toBe(PRIVATE_RUN_REFUSAL_REASONS.length - 1);
    expect(refusals).not.toContain('no-app');
    expect(refusals).toContain('no-iframe-src');
  });

  it('the missing-app baseline, and EVERY refusal, produce the IDENTICAL response', async () => {
    // BASELINE: a nonexistent app. `resolvePageBlock` misses, PHASE 2 misses, and the
    // predicate answers `no-app`.
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: false,
      reason: 'no-app',
    });
    const baseline = shape(await invoke(BODY()));
    expect(baseline.status).toBe(404);
    expect(baseline.body).toEqual({ error: 'Page app not found' });

    for (const reason of refusals) {
      mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason });
      const got = shape(await invoke(BODY()));
      // 🔴 DEEP EQUALITY on status + body + EVERY header, not `expect(404)`. The
      // headers matter as much as the body: the success path sets
      // `Cache-Control: no-store`, and a refusal that set a DIFFERENT caching signal —
      // or set one at all — would be distinguishable from a missing app even with an
      // identical body.
      expect(got, `refusal "${reason}" must be indistinguishable from a missing app`).toEqual(
        baseline
      );
    }
  });

  it('🔴 a `flag-off` refusal emits NO audit at all — the log-amplification decision', async () => {
    // That gate is answered before any DB read, so it is the cheapest request in the set
    // and the one a signed-in prober can issue for any `page_<anything>` id. With the
    // flag off — the shipping state — auditing it would write two records per such
    // request carrying no information. Asserted, not just commented, because the SSR
    // route and the mint took OPPOSITE decisions on the same enumerable input before
    // review caught it.
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: false,
      reason: 'flag-off',
    });
    const res = await invoke(BODY());
    expect(res._status).toBe(404);
    expect(mockStdoutAudit.emitMintAuditToStdout).not.toHaveBeenCalled();
  });

  it('every OTHER refusal reason IS audited — the control on the row above', async () => {
    // Without this, the `flag-off` assertion passes against a branch that audits
    // nothing at all, which would lose the whole forensic trail the feature depends on.
    // Derived too — every reason EXCEPT the one deliberately not audited. A ninth reason
    // added with a broken audit branch is then visible instead of silently uncovered.
    for (const reason of PRIVATE_RUN_REFUSAL_REASONS.filter((r) => r !== 'flag-off')) {
      mockStdoutAudit.emitMintAuditToStdout.mockClear();
      mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason });
      await invoke(BODY());
      expect(mockStdoutAudit.emitMintAuditToStdout, `reason=${reason}`).toHaveBeenCalledWith(
        'app-blocks.private-run.mint-refused',
        expect.objectContaining({ outcome: 'refused', reason })
      );
    }
  });

  it('🔴 POSITIVE CONTROL: the comparison CAN distinguish a different response', async () => {
    // Without this, a harness that produced an identical empty object for every call
    // would make the test above uniformly, meaninglessly green. Same comparison, same
    // baseline, a response that genuinely differs — and it must NOT be equal.
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: false,
      reason: 'no-app',
    });
    const baseline = shape(await invoke(BODY()));

    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    const granted = shape(await invoke(BODY()));

    expect(granted).not.toEqual(baseline);
    expect(granted.status).toBe(200);
    // And the discriminator is real in all three dimensions the comparison reads.
    expect(granted.body).not.toEqual(baseline.body);
    expect(granted.headers).not.toEqual(baseline.headers);
  });

  it('the refusal is AUDITED internally, while the response says nothing', async () => {
    // The reason must reach the operator and never the caller. This is the one place
    // where those two requirements are asserted together.
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: false,
      reason: 'no-role',
    });
    const res = await invoke(BODY());
    expect(res._body).toEqual({ error: 'Page app not found' });
    expect(JSON.stringify(res._body)).not.toContain('no-role');
    const [event, fields] = mockStdoutAudit.emitMintAuditToStdout.mock.calls.at(-1)!;
    // 🔴 A DISTINCT EVENT NAME FROM THE GRANT. The refusal rides
    // `app-blocks.private-run.mint-refused`, not the grant's name with an `outcome`
    // field — see the emit site for the two reasons (a log store counts refusals without
    // parsing a field; and the mint-audit call-site ledger enumerates emit sites as a
    // LIST, so one name from two sites reddens it).
    expect(event).toBe('app-blocks.private-run.mint-refused');
    expect(fields).toMatchObject({ outcome: 'refused', reason: 'no-role' });
  });
});

describe('PHASE 3 sits AFTER PHASE 2 and never steals the dev tunnel [REG]', () => {
  it('🔴 when PHASE 2 handles, PHASE 3 is NOT reached', async () => {
    // The ordering property. If PHASE 3 ran first, both branches would match for a
    // tunnelled owner and the first one would win — silently taking the dev tunnel away
    // from every owner of a suspended app, who would then be served the DEPLOYED bundle
    // instead of the local code they asked for.
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue({
      appBlockId: APP_BLOCK,
      blockId: 'seed-explorer-fixture',
      appId: 'app_privrun',
      status: 'suspended',
      approvedScopes: ['models:read:self'],
      manifest: { name: 'x', page: { path: '/' }, scopes: [] },
    });
    mockDevTunnelService.getActiveDevTunnel.mockResolvedValue({
      sessionId: 'bki_t',
      grantedScopes: [],
    });
    mockAppBlocksFlag.isAppBlocksAuthorEnabled.mockResolvedValue(true);
    mockAppBlocksFlag.isAppBlocksDevTunnelEnabled.mockResolvedValue(true);
    mockSession.value = { user: { id: OWNER, isModerator: false, bannedAt: null } };

    const res = await invoke(BODY());
    expect(res._status).toBe(200);
    // The tell: the private-run predicate was never consulted.
    expect(mockPrivateRunAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
    // And the token is a DEV token, not a private-run one.
    const signed = mockTokenService.sign.mock.calls[0][0];
    expect(signed.dev).toBe(true);
    expect(signed.privateRun).not.toBe(true);
  });

  it('an owner with NO tunnel falls through PHASE 2 to PHASE 3 and gets the deployed bundle', async () => {
    // The complementary half, and the actual product improvement for an owner: before
    // this branch existed, an owner without a tunnel got the bare 404.
    mockBlockRegistry.resolveOwnedNonApprovedPageBlock.mockResolvedValue(null);
    mockDevTunnelService.getActiveDevTunnel.mockResolvedValue(null);
    mockSession.value = { user: { id: OWNER, isModerator: false, bannedAt: null } };
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'owner',
      block: BLOCK(),
    });
    const res = await invoke(BODY());
    expect(res._status).toBe(200);
    expect(mockPrivateRunAccess.resolvePrivateRunAccess).toHaveBeenCalled();
    expect(mockTokenService.sign.mock.calls[0][0].privateRun).toBe(true);
  });
});

describe('PHASE 3 refuses before it resolves anything [REG]', () => {
  it('🔴 the resolved id is DERIVED from the instance id, never taken from elsewhere', async () => {
    // ⚠️ THIS TEST REPLACED ONE THAT COULD NOT EXIST, and the correction is worth
    // recording. The first draft asserted "a mismatched `blockInstanceId` is refused",
    // reasoning from the `blockInstanceId !== page_${appBlockId}` line in the branch. It
    // FAILED — because on the page path `appBlockId` is derived by SLICING
    // `blockInstanceId`, so that comparison is structurally never true and the guard is
    // unreachable. The draft test was asserting a refusal the code cannot produce.
    //
    // What IS a real and checkable property is the derivation itself: the app the mint
    // resolves must be the one named by the instance id, with no second source. A mint
    // that took the id from the body, the slot context or a query param would let a
    // caller request a token for app A against app B's instance — and THAT is the
    // hazard the unreachable line was reaching for.
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    await invoke(BODY({ blockInstanceId: 'page_apb_other' }));
    expect(mockPrivateRunAccess.resolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ by: { appBlockId: 'apb_other' } })
    );
    // …and the signed instance id is the one the caller asked for, so the token cannot
    // be replayed against a different instance than it was minted for.
    expect(mockTokenService.sign.mock.calls[0][0].blockInstanceId).toBe('page_apb_other');
  });

  /**
   * ⚠️ TWO TESTS WERE REMOVED FROM HERE, AND SAYING SO IS THE POINT.
   *
   * They stubbed `dbWrite.user.findUnique` to a soft-deleted / banned row and asserted
   * the mint refused. That worked while the MINT performed its own authoritative
   * viewer re-read — and that read was exactly the SSR↔mint asymmetry review found: the
   * mint had it, the SSR route did not, so a soft-deleted viewer whose session lacked
   * `deletedAt` got a full render of a delisted app before failing at the mint.
   *
   * The read moved INTO `resolvePrivateRunAccess`, so both callers now inherit it and
   * the property is no longer the mint's to assert. This file mocks the predicate at its
   * module seam, so a stub on `dbWrite` here would now assert nothing — it would be a
   * test that passes because the code it named no longer runs, which is worse than no
   * test. The property is covered behaviourally in
   * `blocks/__tests__/private-run-access.service.test.ts` (the banned/soft-deleted viewer
   * rows, keyed on `where.id` so the viewer and owner reads are distinguishable) and the
   * mint's side of it is the `viewer-ineligible` row in the no-existence-oracle describe
   * above.
   */

  it('the flag is evaluated FOR THE CALLER and threaded into the predicate', async () => {
    // Not "the flag is read" — that the CALLER'S evaluated value is what the predicate
    // is given. A mint that read the flag globally would pass the base value for
    // everyone, which is a different (and looser) gate.
    mockAppBlocksFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(false);
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: false,
      reason: 'flag-off',
    });
    await invoke(BODY());
    expect(mockAppBlocksFlag.isAppBlocksPrivateRunEnabled).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: MOD }),
    });
    expect(mockPrivateRunAccess.resolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ privateRunEnabled: false, db: 'write' })
    );
  });

  it('🔴 the predicate is asked for the PRIMARY pool, never the replica', async () => {
    mockPrivateRunAccess.resolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    await invoke(BODY());
    expect(mockPrivateRunAccess.resolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ db: 'write', by: { appBlockId: APP_BLOCK } })
    );
  });
});
