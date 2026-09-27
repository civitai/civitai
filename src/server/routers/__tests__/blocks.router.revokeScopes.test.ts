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
import { CONSENT_REVOKE_MARKER_DEGRADED_MESSAGE } from '~/server/services/blocks/consent-revocation.service';

const appBlockFindUnique = dbMock.dbRead.appBlock.findUnique;
const grantMock = dbMock.dbWrite.appUserScopeGrant;

const USER = 42;
const APP = 'apb_x';
const SPEND = 'ai:write:budgeted';
const POSTS = 'posts:write:self';
/** A THIRD gated scope, so a prior-revocation fixture is distinguishable from this call's. */
const PRIVATE = 'collections:read:private';

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
    // 🔴 A PRIOR REVOCATION IN THE FIXTURE, AND IT IS THE POINT. Every arm in this file used to
    // start from `revokedScopes: []`, which made `result.revoked` (this call's DELTA) and
    // `result.revokedScopes` (the WHOLE list) byte-identical in every single test — so
    // publishing the delta instead of the whole list survived the entire suite, as did swapping
    // the two response fields. `ConsentRevocation.publish`'s own docblock forbids a delta by
    // name ("WRITES THE WHOLE LIST, NOT A DELTA … rather than an accumulating side channel"),
    // and nothing enforced it. Live effect of that mutant: on a viewer's SECOND revoke the
    // marker is overwritten with only the new scope, so the FIRST revoked scope stops being
    // refused on tokens already in flight.
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [SPEND, POSTS],
      revokedScopes: [PRIVATE],
    });

    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });

    // ── The DURABLE half — governs every future mint.
    const data = grantMock.update.mock.calls[0][0].data;
    expect(new Set(data.revokedScopes)).toEqual(new Set([PRIVATE, POSTS]));
    expect(data.grantedScopes).toEqual([SPEND]);

    // ── The IN-FLIGHT half. Asserted against the REAL key constant, never a hand-typed string:
    // fifteen constants across six files had silently drifted from production while their
    // suites passed.
    expect(redisMock.redis.set).toHaveBeenCalledTimes(1);
    const [key, value] = redisMock.redis.set.mock.calls[0];
    expect(key).toBe(`${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${USER}:${APP}`);
    expect(
      new Set(JSON.parse(value as string)),
      'the marker carries only this call’s delta. A viewer’s earlier revocation then stops ' +
        'being enforced on in-flight tokens the moment they revoke anything else.'
    ).toEqual(new Set([PRIVATE, POSTS]));

    // ── And the two response fields are NOT interchangeable.
    expect(out.revoked, '`revoked` must be THIS call’s delta').toEqual([POSTS]);
    expect(new Set(out.revokedScopes), '`revokedScopes` must be the whole list').toEqual(
      new Set([PRIVATE, POSTS])
    );
    expect(out).toMatchObject({
      ok: true,
      grantedScopes: [SPEND],
      fullyRevoked: false,
      budgetCleared: false,
    });
  });

  /**
   * 🔴 UNKNOWN SCOPE STRINGS ARE REFUSED BEFORE ANYTHING IS STORED. Whatever lands in
   * `revoked_scopes` is what the marker carries, and the marker is GET+`JSON.parse`d on every
   * authed block request for that (user, app) pair — so 32 arbitrary strings per call, unioned
   * and never pruned, grow both the row and a hot-path payload without bound. An unknown string
   * could never suppress anything either: `partitionByConsent` only consults scopes the mint
   * signs.
   */
  it('refuses an unknown scope string, storing nothing', async () => {
    await expect(
      caller().revokeScopes({ appBlockId: APP, scopes: ['not:a:real:scope'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(grantMock.update).not.toHaveBeenCalled();
    expect(grantMock.create).not.toHaveBeenCalled();
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE call when one scope of several is unknown', async () => {
    await expect(
      caller().revokeScopes({ appBlockId: APP, scopes: [POSTS, 'nope:nope:nope'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(grantMock.update).not.toHaveBeenCalled();
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
  it('reports SERVICE_UNAVAILABLE with the in-flight caveat if the marker cannot be published', async () => {
    redisMock.redis.set.mockRejectedValue(new Error('redis down'));
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] })).rejects.toMatchObject(
      {
        // 🔴 THE **CODE** IS THE LOAD-BEARING HALF, and the first version asserted only the
        // message. `src/server/trpc/client-safe-error.ts` replaces the message of every
        // `status >= 500 && status !== 503`, so under the `INTERNAL_SERVER_ERROR` this used to
        // throw, the careful wording was discarded one layer below and the viewer saw a generic
        // "something went wrong (ref: …)" — while this assertion passed, because it reads the
        // error at the procedure boundary, ABOVE where the message is thrown away. 503 is that
        // formatter's own carve-out.
        code: 'SERVICE_UNAVAILABLE',
        message: CONSENT_REVOKE_MARKER_DEGRADED_MESSAGE,
      }
    );
    // …and the durable half really did land first, which is what makes that message true.
    expect(grantMock.update).toHaveBeenCalledTimes(1);
  });

  // The structural half of the same claim: a 4xx/503 message survives the client-safe
  // formatter. Without this, swapping the code back to a 500 fails only the spelling above.
  it('the publish-failure message survives the client-safe error formatter', async () => {
    const { getClientSafeError } = await import('~/server/trpc/client-safe-error');
    redisMock.redis.set.mockRejectedValue(new Error('redis down'));
    const err = await caller()
      .revokeScopes({ appBlockId: APP, scopes: [POSTS] })
      .then(
        () => null,
        (e) => e
      );
    expect(err).not.toBeNull();
    expect(
      getClientSafeError(err as never),
      'the formatter replaced this message, so the viewer cannot tell "recorded, enforcement ' +
        'lags" from "nothing was recorded" — which is the whole point of the wording'
    ).toBeUndefined();
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
    // 🔴 `{ id: true }` — it does not even select `manifest` any more. A column the procedure
    // cannot see is a gate it cannot accidentally grow, and the teardown stopped branching on
    // `manifest.auth` (a publisher push replaces it without re-approval, which is the same
    // reason this procedure applies no manifest ceiling).
    // `appId` joined the select so the teardown gate can reuse it instead of re-reading the row
    // (three reads of one row before). `status` is still absent, which is the claim this pins.
    expect(appBlockFindUnique.mock.calls[0][0].select).toEqual({ id: true, appId: true });
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
  /** A live mirror row for this (user, client) — what the teardown is now gated on. */
  function mirrorExists(clientId = 'oauth_client_1') {
    appBlockFindUnique.mockResolvedValue({ id: APP, appId: clientId });
    // 🔴 `dbWrite` FOR BOTH GATE READS. The gate moved off the replica because the mirror is
    // WRITTEN on the primary at mint time, so a revoke moments later landed inside replication
    // lag, read `null`, skipped the teardown, and left the OauthConsent bitmask plus the hub's
    // Access/Refresh keys alive — the hole this gate exists to close.
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({ id: APP, appId: clientId });
    dbMock.dbWrite.oauthConsent.findFirst.mockResolvedValue({ id: 1 });
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(null);
  }

  beforeEach(() => {
    // DEFAULT: no mirror. The teardown must be gated on one EXISTING, so "no mirror" is the
    // world every test that is not about it runs in.
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({ id: APP, appId: 'jwt_client' });
    dbMock.dbWrite.oauthConsent.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(null);
  });

  /**
   * 🔴 THE `OauthConsent` ROW IS A SECOND ENFORCEMENT SURFACE. It mirrors the grant into a
   * bitmask the auth hub mints real OAuth access tokens against, and those tokens outlive this
   * mutation. Deleting it — and the `Access`/`Refresh` keys alongside it — is what stops them.
   */
  it('tears the mirror down, deleting both the consent row and the live keys', async () => {
    mirrorExists();
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, clientId: 'oauth_client_1' },
    });
    expect(dbMock.dbWrite.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, clientId: 'oauth_client_1', type: { in: ['Access', 'Refresh'] } },
    });
  });

  /**
   * 🔴 GATED ON THE MIRROR EXISTING — NOT ON `manifest.auth`, NOT ON THE ENV FLAG, AND NOT
   * UNCONDITIONAL. Three stale gates each let a live mirror row survive a revoke: today's
   * `manifest.auth` (a publisher push replaces it without re-approval), the env flag (can be
   * switched off after rows exist), and position after the publish. Dropping all gates closed
   * those and overcorrected — the callee is NOT a no-op without a row: two primary `deleteMany`s
   * plus `deleteAuthSubject` plus an AWAITED `invalidateCivitaiUser`, an untimed outbound
   * orchestrator call, on every revoke of every app.
   *
   * MUTATION THAT MUST KILL IT: remove the `oauthConsent.findFirst` gate.
   */
  it('does NOT touch the mirror when there is none', async () => {
    appBlockFindUnique.mockResolvedValue({ id: APP, appId: 'jwt_client' });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({ id: APP, appId: 'jwt_client' });
    dbMock.dbWrite.oauthConsent.findFirst.mockResolvedValue(null);
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(
      dbMock.dbWrite.oauthConsent.deleteMany,
      'the teardown ran with no mirror row, which costs two primary writes plus an UNTIMED ' +
        'outbound orchestrator call on every revoke of every app'
    ).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE GATE READS THE **PRIMARY**, AND THE REPLICA VERSION REINTRODUCED THE HOLE IT CLOSES.
   *
   * The mirror is written on the primary by `syncOauthConsentFromGrant` at mint time, so a viewer
   * who opens an `auth:"oauth"` app and withdraws a permission moments later lands inside
   * replication lag: a replica gate reads `null`, the teardown is skipped, and the `OauthConsent`
   * bitmask plus the hub's Access/Refresh keys SURVIVE the revoke. `grantScopes` makes this exact
   * argument 230 lines above for the structurally identical decision.
   *
   * The fixture is the lag itself: the primary HAS the row, the replica does not.
   *
   * MUTATION THAT MUST KILL IT: read `dbRead` for either gate query.
   */
  it('reads the PRIMARY, so a just-written mirror is not missed to replica lag', async () => {
    appBlockFindUnique.mockResolvedValue({ id: APP, appId: 'oauth_client_1' });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({ id: APP, appId: 'oauth_client_1' });
    // PRIMARY sees the mirror…
    dbMock.dbWrite.oauthConsent.findFirst.mockResolvedValue({ id: 1 });
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(null);
    // …the REPLICA has not caught up.
    dbMock.dbRead.oauthConsent.findFirst.mockResolvedValue(null);

    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(
      dbMock.dbWrite.oauthConsent.deleteMany,
      'the teardown was skipped because the gate asked the replica about a row the primary had ' +
        'just written — the OauthConsent bitmask and the hub keys survive the revoke'
    ).toHaveBeenCalledTimes(1);

    // 🔴 AND THE DECIDING READS ARE PINNED TO THE PRIMARY EXPLICITLY, not only via the outcome —
    // a mutant that flips the *appBlock* lookup left the behavioural assertion green, because the
    // replica fixture still answered with an appId. These are the reads the decision rests on.
    expect(
      dbMock.dbWrite.oauthConsent.findFirst,
      'the mirror-existence read must use the primary — that row is written there at mint time'
    ).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.apiKey.findFirst).toHaveBeenCalledTimes(1);
    expect(
      dbMock.dbRead.oauthConsent.findFirst,
      'the gate asked the replica about a row the primary had just written'
    ).not.toHaveBeenCalled();
  });

  /**
   * 🔴 GATED ON **EITHER** ARTEFACT — the callee deletes the api keys FIRST, deliberately, because
   * a key with no consent row resolves a null `buzzLimit` (i.e. NO CAP) in `bearer-token.ts`. So a
   * teardown that dies between its two writes leaves "keys present, consent gone" = full scope,
   * uncapped — and a gate looking only at the consent row would read `null` on every retry and
   * never clean them. Checking both makes the teardown idempotent against its own partial failure.
   *
   * MUTATION THAT MUST KILL IT: `if (!mirror) return;`.
   */
  it('tears down stray api keys even when the consent row is already gone', async () => {
    appBlockFindUnique.mockResolvedValue({ id: APP, appId: 'oauth_client_1' });
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({ id: APP, appId: 'oauth_client_1' });
    dbMock.dbWrite.oauthConsent.findFirst.mockResolvedValue(null); // consent already deleted
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({ id: 9 }); // …but a key survived
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(
      dbMock.dbWrite.apiKey.deleteMany,
      'a half-finished teardown left Access/Refresh keys with no consent row — which resolves a ' +
        'null buzzLimit, i.e. FULL SCOPE AND NO CAP — and the retry skipped them'
    ).toHaveBeenCalledTimes(1);
  });

  /**
   * …but a stale mirror on a now-JWT app IS torn down: the gate is the ROW, so a manifest that
   * has since flipped away from `oauth` cannot strand it. This is the hole the `manifest.auth`
   * gate left.
   */
  it('tears down a stale mirror even on a JWT app', async () => {
    mirrorExists('jwt_client');
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, clientId: 'jwt_client' },
    });
  });

  it('tears down a stale mirror even with APP_BLOCK_OAUTH_TOKENS_ENABLED off', async () => {
    setEnv({ APP_BLOCK_OAUTH_TOKENS_ENABLED: false });
    mirrorExists();
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 IT RUNS EVEN WHEN THE MARKER PUBLISH FAILS — it is in a `finally`. With the teardown
   * merely sequenced after the publish, a Redis blip threw past it: the durable row was written,
   * the viewer saw an error, and the app's live OAuth tokens kept working against the pre-revoke
   * bitmask with nothing scheduled to clean them up.
   *
   * MUTATION THAT MUST KILL IT: move the teardown out of the `finally` to after the throw.
   */
  it('tears the mirror down EVEN WHEN the marker publish fails', async () => {
    mirrorExists();
    redisMock.redis.set.mockRejectedValue(new Error('redis down'));
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] })).rejects.toMatchObject(
      { code: 'SERVICE_UNAVAILABLE' }
    );
    expect(
      dbMock.dbWrite.oauthConsent.deleteMany,
      'the mirror was never touched because the Redis failure threw past it — the app’s live ' +
        'OAuth tokens keep working against the pre-revoke bitmask'
    ).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 POSTGRES, THEN REDIS, THEN THE MIRROR — and the middle step moved BACK in front of the
   * teardown deliberately. Putting the teardown first did close the unreachability hole, but
   * `revokeOauthConsentForBlock` awaits `invalidateCivitaiUser`, an outbound orchestrator DELETE
   * with NO timeout, so a slow orchestrator delayed the "immediate" half of the revoke for
   * exactly as long as it was slow — and that window is the one the 503 message apologises for.
   * A `finally` gets both properties.
   */
  it('writes Postgres, then Redis, then the mirror teardown', async () => {
    mirrorExists();
    const order: string[] = [];
    grantMock.update.mockImplementation(async () => {
      order.push('pg');
      return {};
    });
    redisMock.redis.set.mockImplementation(async () => {
      order.push('redis');
      return 'OK';
    });
    dbMock.dbWrite.oauthConsent.deleteMany.mockImplementation(async () => {
      order.push('oauth');
      return { count: 1 };
    });
    await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(order).toEqual(['pg', 'redis', 'oauth']);
  });

  /**
   * 🔴 IT RUNS BEFORE THE THROW, NOT AFTER IT — the property a plain sequential block does NOT
   * give you. `finally` is load-bearing: any teardown placed after the `if (publishFailed) throw`
   * is simply never reached on the failure path, which is the original hole in a new spelling.
   * This asserts the ordering directly, so moving the block past the throw reds.
   */
  it('the teardown completes BEFORE the publish-failure throw propagates', async () => {
    mirrorExists();
    const order: string[] = [];
    redisMock.redis.set.mockImplementation(async () => {
      order.push('publish-failed');
      throw new Error('redis down');
    });
    dbMock.dbWrite.oauthConsent.deleteMany.mockImplementation(async () => {
      order.push('oauth');
      return { count: 1 };
    });
    await expect(caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] })).rejects.toMatchObject(
      { code: 'SERVICE_UNAVAILABLE' }
    );
    expect(
      order,
      'the teardown did not run before the throw — anything sequenced after the throw is never ' +
        'reached on the failure path, which is the original unreachability hole respelled'
    ).toEqual(['publish-failed', 'oauth']);
  });

  /** Best-effort: the durable row is written and the marker has gone out. */
  it('does not fail the mutation if the mirror teardown throws', async () => {
    mirrorExists();
    dbMock.dbWrite.oauthConsent.deleteMany.mockRejectedValue(new Error('pg down'));
    const out = await caller().revokeScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(out.ok).toBe(true);
    expect(redisMock.redis.set).toHaveBeenCalledTimes(1);
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

/**
 * 🔴 `blocks.grantScopes`' MARKER RE-PUBLISH — behaviour that had NO test at all.
 *
 * Review found two mutations surviving the whole repo suite:
 *   - DELETE the re-publish block: a prompted re-consent lifts the suppression in Postgres
 *     while the Redis marker keeps refusing the scope for up to a full token lifetime (900s,
 *     4h dev). The viewer clicks *Allow* and the app still gets `403 consent_revoked`.
 *   - DROP the `!== null` guard (`revokedScopesAfterClear ?? []`): every ordinary install or
 *     consent then `redis.del`s a LIVE suppression marker — which that block's own docblock
 *     names as "reopening in Redis the resurrection hole `clearRevocations` closes in
 *     Postgres".
 *
 * The reason nothing caught either: `blocks.router.getInstallConfig.test.ts` is the only suite
 * that calls `grantScopes`, it never asserts on `redis.set`/`redis.del`, and every one of its
 * grant fixtures omits `revokedScopes` — so `clearedTo` stayed `null` and the branch was never
 * entered by any test in the repo. These arms live here, beside the revoke they undo, rather
 * than in that suite.
 */
describe('blocks.grantScopes — the marker re-publish', () => {
  const MANIFEST = { auth: 'jwt', scopes: [SPEND, POSTS, PRIVATE] };

  beforeEach(() => {
    appBlockFindUnique.mockResolvedValue({
      status: 'approved',
      version: '1.2.3',
      manifest: MANIFEST,
      approvedScopes: [SPEND, POSTS, PRIVATE],
    });
  });

  /**
   * MUTATION THAT MUST KILL IT: delete the `if (cleared.revokedScopesAfterClear !== null)`
   * block from `grantScopes`.
   */
  it('re-publishes the NARROWED list when a re-consent lifts one of two suppressions', async () => {
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [],
      revokedScopes: [POSTS, PRIVATE],
    });
    await caller().grantScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(redisMock.redis.set).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(redisMock.redis.set.mock.calls[0][1] as string),
      'the marker was not narrowed, so the scope the viewer just re-consented to keeps being ' +
        'refused for the rest of an in-flight token’s life'
    ).toEqual([PRIVATE]);
    expect(redisMock.redis.del).not.toHaveBeenCalled();
  });

  /** The last suppression lifted ⇒ the key goes, rather than waiting out its TTL. */
  it('DELETES the marker when the last suppression is lifted', async () => {
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [],
      revokedScopes: [POSTS],
    });
    await caller().grantScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(redisMock.redis.del).toHaveBeenCalledWith(
      `${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${USER}:${APP}`
    );
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE CONTROL, AND THE ONE THAT MAKES THE `!== null` GUARD TESTABLE. An ordinary consent
   * with nothing suppressed must touch the marker NEITHER way. With `?? []` in place of the
   * guard, this arm reds on the `redis.del` — which is the mutant that would otherwise silently
   * delete a live suppression on every install.
   *
   * MUTATION THAT MUST KILL IT: `revokedScopes: cleared.revokedScopesAfterClear ?? []`.
   */
  it('CONTROL: an ordinary consent with nothing revoked touches the marker neither way', async () => {
    grantMock.findUnique.mockResolvedValue({ id: 'augr_1', grantedScopes: [], revokedScopes: [] });
    await caller().grantScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(
      redisMock.redis.del,
      'an ordinary consent DELETED the suppression marker. `null` (nothing was cleared) and ' +
        '`[]` (the last suppression was lifted) have been collapsed, which reopens the ' +
        'resurrection hole in the Redis layer.'
    ).not.toHaveBeenCalled();
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  /**
   * 🔴 AND IT CLEARS ONLY WHAT THE DIALOG NAMED. Re-consenting to POSTS must leave a revoked
   * PRIVATE suppressed in Postgres too, not just in the marker — the wholesale-clear shape
   * would restore a permission the viewer withdrew and was never asked about again.
   */
  it('leaves an unrelated suppression in place in Postgres', async () => {
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [],
      revokedScopes: [POSTS, PRIVATE],
    });
    await caller().grantScopes({ appBlockId: APP, scopes: [POSTS] });
    expect(grantMock.update.mock.calls[0][0].data.revokedScopes).toEqual([PRIVATE]);
  });

  /**
   * A re-publish failure must not fail a SUCCESSFUL consent write — the opposite of the revoke
   * path, and the asymmetry is the safe direction: failing to WIDEN access costs the viewer at
   * most one token lifetime of refusals on a permission they just re-granted, and it self-heals
   * when the marker expires. Failing to NARROW it does not self-correct.
   */
  it('does not fail the consent if the re-publish throws', async () => {
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [],
      revokedScopes: [POSTS, PRIVATE],
    });
    redisMock.redis.set.mockRejectedValue(new Error('redis down'));
    await expect(caller().grantScopes({ appBlockId: APP, scopes: [POSTS] })).resolves.toMatchObject(
      { ok: true }
    );
  });
});
