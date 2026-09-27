import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.revokeScopes` — the tRPC half of per-scope consent revocation.
 *
 * ## What this suite is FOR, and what its siblings already cover
 *
 * `scope-grant.service.test.ts` pins the ledger write against a mocked DB;
 * `blocks/__tests__/consent-revocation.service.test.ts` pins the Redis marker;
 * `middleware/__tests__/block-scope.consent-revocation.test.ts` pins enforcement. None of
 * them builds the mutation's own state, so what is asserted HERE is everything that lives
 * only at the procedure: the three gates it deliberately does NOT inherit from
 * `grantScopes`, the exempt-scope refusal, and the fact that BOTH durable writes happen and
 * in the right order.
 *
 * ## The two gates that are absent on purpose
 *
 * `grantScopes` refuses a non-`approved` app and intersects with the app's manifest ceiling.
 * Both are correct for GRANTING and wrong for REVOKING:
 *   - `listMyScopeGrants` has no status filter, so suspended and deprecated apps are exactly
 *     what a viewer sees listed. Inheriting the approved gate would make the apps most worth
 *     withdrawing consent from the only ones you could not withdraw it from.
 *   - the ceiling MOVES (a publisher push replaces `manifest` without re-approval), so a
 *     scope really granted last month can be outside today's intersection. Narrowing is
 *     always safe; filtering would refuse to revoke exactly those.
 *
 * ## RED/GREEN
 *
 * Red at `origin/main` by absence — the procedure does not exist there, so every call would
 * be a type error and the file could not compile. The per-arm mutations that must kill each
 * test are named inline.
 */

const { mockIsAppBlocksEnabled } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: vi.fn(),
    listAvailable: vi.fn(),
    upsertSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    upsertUserSettings: vi.fn(),
    getEffectiveCheckpoint: vi.fn(),
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
// Same import-chain shim every sibling blocks.router suite uses: `rateLimit` transitively
// evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { REDIS_KEYS } from '~/server/redis/client';

const appBlockFindUnique = dbMock.dbRead.appBlock.findUnique;
const grantMock = dbMock.dbWrite.appUserScopeGrant;

const USER = 42;
const APP = 'apb_x';
const SPEND = 'ai:write:budgeted';
const POSTS = 'posts:write:self';

/** ctx with the appBlocks feature on — the proc gates on `ctx.features.appBlocks`. */
function consentCtx(userId = USER) {
  return {
    acceptableOrigin: true,
    user: { id: userId, isModerator: false, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {
      canViewNsfw: false,
      isBlue: false,
      isGreen: false,
      isGreenSession: false,
      appBlocks: true,
    } as never,
    track: undefined,
  };
}

function caller(userId = USER) {
  return blocksRouter.createCaller(consentCtx(userId) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 THE OAUTH MIRROR BRANCH IS ENV-GATED, and its default is FALSE. Left unset, the two
  // teardown tests below would both pass — one because nothing happened and one because
  // nothing happened — i.e. the "does nothing for a non-OAuth app" control would be
  // vacuous and the positive case would be the flag, not the code. Turn it ON for the whole
  // file and let the `manifest.auth` value be the only variable.
  setEnv({ APP_BLOCK_OAUTH_TOKENS_ENABLED: true });
  appBlockFindUnique.mockReset();
  grantMock.findUnique.mockReset();
  grantMock.create.mockReset();
  grantMock.update.mockReset();

  // Default world: an APPROVED, non-OAuth app and a live grant holding two gated scopes.
  appBlockFindUnique.mockResolvedValue({ manifest: { auth: 'jwt' } });
  grantMock.findUnique.mockResolvedValue({
    id: 'augr_1',
    grantedScopes: [SPEND, POSTS],
    revokedScopes: [],
  });
  grantMock.update.mockResolvedValue({});
  grantMock.create.mockResolvedValue({});

  redisMock.redis.set.mockReset();
  redisMock.redis.del.mockReset();
  redisMock.redis.set.mockResolvedValue('OK');
  redisMock.redis.del.mockResolvedValue(1);
});

describe('blocks.revokeScopes — the happy path writes BOTH halves', () => {
  it('records the suppression in Postgres and publishes the in-flight marker', async () => {
    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });

    // ── The DURABLE half — governs every future mint.
    const data = grantMock.update.mock.calls[0][0].data;
    expect(data.revokedScopes).toEqual([POSTS]);
    expect(data.grantedScopes).toEqual([SPEND]);

    // ── The IN-FLIGHT half — closes the window on tokens already signed. Asserted against
    // the REAL key constant, never a hand-typed string: fifteen constants across six files
    // had silently drifted from production while their suites passed.
    expect(redisMock.redis.set).toHaveBeenCalledTimes(1);
    const [key, value] = redisMock.redis.set.mock.calls[0];
    expect(key).toBe(`${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${USER}:${APP}`);
    expect(JSON.parse(value as string)).toEqual([POSTS]);

    expect(out).toMatchObject({
      ok: true,
      revoked: [POSTS],
      revokedScopes: [POSTS],
      grantedScopes: [SPEND],
      fullyRevoked: false,
      budgetCleared: false,
    });
  });

  /**
   * 🔴 POSTGRES BEFORE REDIS, and the order is the recovery story rather than a style
   * choice. The row is the authority and is permanent; the marker only closes the in-flight
   * window and expires by itself within one token lifetime. A failure after the row is
   * written leaves the revoke DURABLE but not immediate, which is recoverable. The reverse
   * order would leave a marker refusing a permission the ledger still grants — which
   * self-heals into the permission coming BACK.
   */
  it('writes Postgres BEFORE Redis', async () => {
    const order: string[] = [];
    grantMock.update.mockImplementation(async () => {
      order.push('pg');
      return {};
    });
    redisMock.redis.set.mockImplementation(async () => {
      order.push('redis');
      return 'OK';
    });
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(order).toEqual(['pg', 'redis']);
  });

  /**
   * 🔴 A MARKER-PUBLISH FAILURE IS SURFACED, NOT SWALLOWED — the NARROWING direction. If the
   * marker is not written, an already-minted token keeps the revoked scope for up to four
   * hours while the viewer has just been told the permission was removed. The error says
   * which half landed, because the Postgres row IS committed.
   *
   * MUTATION THAT MUST KILL IT: add `.catch(() => {})` to the `ConsentRevocation.publish`
   * call in the procedure.
   */
  it('reports an error — naming the in-flight caveat — if the marker cannot be published', async () => {
    redisMock.redis.set.mockRejectedValue(new Error('redis down'));
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] })).rejects.toMatchObject(
      { message: expect.stringMatching(/already-open app session/i) }
    );
    // …and the durable half really did land first, which is what makes that message true.
    expect(grantMock.update).toHaveBeenCalledTimes(1);
  });

  it('reports fullyRevoked + budgetCleared when the last spend scope goes', async () => {
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [SPEND],
      revokedScopes: [],
    });
    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [SPEND] });
    expect(out).toMatchObject({ fullyRevoked: true, budgetCleared: true, grantedScopes: [] });
    expect(grantMock.update.mock.calls[0][0].data).toMatchObject({ buzzBudgetPerDay: null });
  });

  /**
   * 🔴 THE VIEWER'S OWN ROW, NEVER ANOTHER USER'S. `userId` comes from `ctx.user`, and there
   * is no input field that could name a different one — a mutation that took a userId would
   * let any authenticated caller revoke a stranger's permissions.
   */
  it('keys the write on ctx.user.id', async () => {
    await caller(777).revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(grantMock.findUnique.mock.calls[0][0].where).toEqual({
      userId_appBlockId: { userId: 777, appBlockId: APP },
    });
    expect(redisMock.redis.set.mock.calls[0][0]).toContain(':777:');
  });
});

describe('finding 5 — revoke is NOT gated on the app being approved', () => {
  /**
   * 🔴 THE POINT OF THE WHOLE BLOCK. `grantScopes` throws BAD_REQUEST for any status other
   * than `approved`; inheriting that here would have made a suspended app's permissions
   * permanently un-withdrawable, which is the exact opposite of what a takedown should
   * imply.
   *
   * MUTATION THAT MUST KILL IT: add `if (block.status !== 'approved') throw …` to the
   * procedure (and `status: true` to its select).
   */
  it.each(['suspended', 'pending', 'rejected', 'deprecated', 'ephemeral'])(
    'succeeds for a %s app',
    async (status) => {
      appBlockFindUnique.mockResolvedValue({ status, manifest: { auth: 'jwt' } });
      const out = await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
      expect(out.revokedScopes).toEqual([POSTS]);
      expect(grantMock.update).toHaveBeenCalledTimes(1);
    }
  );

  /**
   * 🔴 AND IT DOES NOT EVEN SELECT `status`, which is the structural half: a column the
   * procedure cannot see is a gate it cannot accidentally grow. (It still selects `manifest`,
   * for the OAuth-mirror decision.)
   */
  it('does not read the status column at all', async () => {
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(appBlockFindUnique.mock.calls[0][0].select).toEqual({ manifest: true });
  });

  // The app must still EXIST — the grant row's FK requires it, so a bad id is a 404 rather
  // than a create that violates a constraint.
  it('404s for an app that does not exist', async () => {
    appBlockFindUnique.mockResolvedValue(null);
    await expect(
      caller().revokeScopes({ appBlockId: 'apb_nope', scopes: [POSTS] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(grantMock.update).not.toHaveBeenCalled();
  });
});

describe('finding 2 — a consent-EXEMPT scope is refused with its own error', () => {
  /**
   * 🔴 ACCEPTING ONE WOULD BE THE WORST OUTCOME AVAILABLE. `partitionByConsent` signs an
   * exempt scope on the exempt test ALONE, before it consults the grant, so a suppression
   * entry for one would be stored and enforce NOTHING: the UI reports success and the app
   * keeps the permission.
   *
   * ALL SEVEN are enumerated, not sampled — the set decides which scopes are revokable at
   * all, and a member that slipped through would be an un-enforceable "success" forever.
   *
   * MUTATION THAT MUST KILL IT: delete the `exempt.length > 0` block from the procedure.
   */
  it.each([
    'apps:storage:read',
    'apps:storage:write',
    'apps:storage:shared:read',
    'apps:storage:shared:write',
    'models:read:self',
    'collections:read:self',
    'collections:write:self',
  ])('refuses %s', async (scope) => {
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: [scope] })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    // 🔴 NOTHING WAS WRITTEN. Without this the test would pass on an implementation that
    // wrote the suppression and then threw — the stored row would be a permanent,
    // unenforceable entry in the viewer's ledger.
    expect(grantMock.update).not.toHaveBeenCalled();
    expect(grantMock.create).not.toHaveBeenCalled();
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  it('NAMES the refused scope, so the error is actionable rather than generic', async () => {
    await expect(
      caller().revokeScopes({ appBlockId: APP, scopes: ['models:read:self'] })
    ).rejects.toMatchObject({ message: expect.stringContaining('models:read:self') });
  });

  /**
   * 🔴 A MIXED BATCH IS REFUSED WHOLESALE, not partially applied. A partial success would
   * leave the client unable to say which scopes it actually revoked, and the viewer with a
   * permissions page that disagrees with what they clicked.
   */
  it('refuses the WHOLE call when one scope of several is exempt', async () => {
    await expect(
      caller().revokeScopes({ appBlockId: APP, scopes: [POSTS, 'models:read:self'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(grantMock.update).not.toHaveBeenCalled();
  });

  /**
   * THE CONTROL. Every gated scope in the vocabulary that a revoke is FOR must go through —
   * otherwise "refuses" is the answer the code gives for everything and the test above
   * proves nothing about exemption.
   */
  it.each([SPEND, POSTS, 'collections:read:private', 'buzz:read:self', 'social:tip:self'])(
    'CONTROL: accepts the gated scope %s',
    async (scope) => {
      grantMock.findUnique.mockResolvedValue({
        id: 'augr_1',
        grantedScopes: [scope, 'user:read:self'],
        revokedScopes: [],
      });
      const out = await caller().revokeScopes({ appBlockId: APP, scopes: [scope] });
      expect(out.revokedScopes).toEqual([scope]);
    }
  );
});

describe('no manifest ceiling is applied', () => {
  /**
   * 🔴 A SCOPE OUTSIDE TODAY'S `manifest ∩ approved_scopes` IS STILL REVOKABLE. That ceiling
   * exists on `grantScopes` so a host cannot grant itself something the app never declared;
   * the argument does not transfer, because a publisher push replaces `manifest` without
   * re-approval and the viewer's grant outlives it. Filtering here would refuse to revoke
   * exactly the scopes whose declaration has since vanished.
   *
   * The procedure does not even read `approvedScopes`, which is the structural half.
   */
  it('revokes a scope the current manifest no longer declares', async () => {
    appBlockFindUnique.mockResolvedValue({
      manifest: { auth: 'jwt', scopes: ['user:read:self'] },
    });
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [POSTS, 'user:read:self'],
      revokedScopes: [],
    });
    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(out.revokedScopes).toEqual([POSTS]);
    expect(appBlockFindUnique.mock.calls[0][0].select).not.toHaveProperty('approvedScopes');
  });

  /**
   * A PRE-EMPTIVE "no" for a scope the viewer has never been asked about is accepted, and it
   * creates the row. If this no-op'd, the next install would union the scope in with no
   * prompt — the resurrection hazard in the shape with nothing on screen to reveal it.
   */
  it('records a suppression for a scope the viewer holds no grant for', async () => {
    grantMock.findUnique.mockResolvedValue(null);
    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [SPEND] });
    expect(grantMock.create).toHaveBeenCalledTimes(1);
    expect(grantMock.create.mock.calls[0][0].data.revokedScopes).toEqual([SPEND]);
    expect(out.fullyRevoked).toBe(true);
  });
});

describe('the OAuth mirror', () => {
  /**
   * 🔴 THE `OauthConsent` ROW IS A SECOND ENFORCEMENT SURFACE. It mirrors the grant into a
   * bitmask the auth hub mints real OAuth access tokens against, and those tokens outlive
   * this mutation — so a revoke that ignores it is incomplete. Deleting the mirror (and its
   * access/refresh keys) is what stops them.
   */
  it('tears the mirror down for an OAuth app', async () => {
    appBlockFindUnique.mockResolvedValue({ manifest: { auth: 'oauth' } });
    // `revokeOauthConsentForBlock` resolves the client id off the app row, then deletes the
    // api keys and the consent row.
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      manifest: { auth: 'oauth' },
      appId: 'oauth_client_1',
    });
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, clientId: 'oauth_client_1' },
    });
    expect(dbMock.dbWrite.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, clientId: 'oauth_client_1', type: { in: ['Access', 'Refresh'] } },
    });
  });

  /**
   * THE CONTROL: a JWT app has no mirror, so nothing is deleted. Without this, an
   * implementation that tore down unconditionally would pass the test above — and would be
   * issuing pointless deletes on every revoke of every non-OAuth app.
   */
  it('CONTROL: does nothing for a non-OAuth app', async () => {
    appBlockFindUnique.mockResolvedValue({ manifest: { auth: 'jwt' } });
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * Best-effort: the block-JWT surface is already closed by the two writes above, so a
   * failure here must not tell the viewer nothing was recorded when the durable half was.
   */
  it('does not fail the mutation if the mirror teardown throws', async () => {
    appBlockFindUnique.mockResolvedValue({ manifest: { auth: 'oauth' }, appId: 'oauth_client_1' });
    dbMock.dbWrite.oauthConsent.deleteMany.mockRejectedValue(new Error('pg down'));
    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(out.ok).toBe(true);
  });
});

describe('input bounds and the feature gate', () => {
  it('rejects an empty scope list', async () => {
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: [] })).rejects.toThrow();
  });

  it('rejects more than 32 scopes', async () => {
    const many = Array.from({ length: 33 }, (_, i) => `x:y:${i}`);
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: many })).rejects.toThrow();
  });

  /**
   * The same `ctx.features.appBlocks` check `grantScopes` carries. Consent is a per-user
   * capability behind a segmented flag, and a revoke surface is only reachable where the
   * grant surface is.
   */
  it('FORBIDS a caller without the appBlocks feature', async () => {
    const ctx = consentCtx() as unknown as { features: Record<string, unknown> };
    ctx.features = { ...ctx.features, appBlocks: false };
    await expect(
      blocksRouter.createCaller(ctx as never).revokeScopes({ appBlockId: APP, scopes: [POSTS] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(grantMock.update).not.toHaveBeenCalled();
  });
});
