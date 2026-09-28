import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE VIEWER-SIDE CONSENT STATE on `ScopeGrantSurface` — the fields phase 3's revoke control
 * keys off, and the one decision this settles.
 *
 * ## The decision
 *
 * `AppPermissionsActivityDrawer.tsx`'s docblock recorded as DELIBERATELY OPEN which set the
 * permissions page should show. The answer is BOTH, because they answer different questions:
 *
 *   - `scopes`        = the APP-SIDE set, `manifest.scopes ∩ approved_scopes` — what the app
 *                       may be granted and exercised with. It stays the ROW LIST, and every
 *                       argument in its own docblock for why the EFFECTIVE set is displayed
 *                       (the only set correct in both divergence directions; `granted_scopes`
 *                       alone UNDER-reports by omitting the exempt scopes a token really
 *                       carries) is preserved.
 *   - `grantedScopes` = the USER-SIDE set — what this viewer actually agreed to. Additive,
 *                       for the one thing the effective set cannot express: per-row consent
 *                       STATE, which is what a revoke button has to key off. A control
 *                       offered on the app-side set alone would render "remove" for a
 *                       permission the viewer never granted.
 *
 * ## RED/GREEN
 *
 * Red at `origin/main` by absence: the four fields and the `revoked_scopes` column do not
 * exist there. Each arm names its killing mutation inline.
 */

/**
 * 🔴 THE CANONICAL db MOCK, not a per-file direct mock of the `~/server/db/client` module.
 *
 * ⚠️ AND THE PHRASING ABOVE IS DELIBERATE. `no-direct-shared-module-mock`'s detector is
 * TEXTUAL over the whole file, comments included — so writing the guarded call's literal
 * spelling here, even to say we are NOT doing it, makes the guard fail on this file. A
 * false positive costs one reworded sentence and a false negative costs the invariant, so
 * the over-broad match is the right trade; do not "fix" it by adding an allowlist entry.
 *
 * `no-direct-shared-module-mock.test.ts` enforces this. The sibling
 * `user-app-surface.orchestration.test.ts` hand-writes its client and is ALLOWLISTED as
 * pre-existing — that is a grandfather clause, not precedent, and its own comment records the
 * cost: every method the service starts calling has to be added to that literal by hand, or
 * all 32 of its tests die at once with `dbRead.blockScopeInvocation.groupBy is not a
 * function`. The hybrid node vivifies any depth of property access, so nothing here tracks
 * the client's shape.
 *
 * `~/server/logging/client` is mocked globally by `~/__tests__/setup` for the same reason, so
 * this file declares neither.
 */
import { dbMock } from '~/__tests__/mocks/db.mock';

/** `listMyScopeGrants` is a pure read path — every query in it goes to the REPLICA. */
const read = dbMock.dbRead;

const USER = 42;
const APP = 'apb_1';
const SPEND = 'ai:write:budgeted';
const POSTS = 'posts:write:self';
/** Consent-EXEMPT — signed without a grant, therefore never revokable. */
const EXEMPT = 'models:read:self';

/** An AppBlock whose effective set is the three scopes below. */
function appBlock(over: Record<string, unknown> = {}) {
  return {
    id: APP,
    blockId: 'hello',
    manifest: { name: 'Hello World', scopes: [SPEND, POSTS, EXEMPT] },
    approvedScopes: [SPEND, POSTS, EXEMPT],
    ...over,
  };
}

/** A blanket subscription, so the app gets an `origin: 'install'` row. */
function sub(over: Record<string, unknown> = {}) {
  return {
    appBlockId: APP,
    scope: 'viewer_personal',
    slotId: null,
    targetModelIds: [],
    appBlock: appBlock(),
    ...over,
  };
}

function grant(over: Record<string, unknown> = {}) {
  return {
    appBlockId: APP,
    buzzBudgetPerDay: null,
    revokedAt: null,
    grantedScopes: [SPEND, POSTS],
    revokedScopes: [],
    revokedScopesAt: null,
    appBlock: appBlock(),
    ...over,
  };
}

/** Points the subscription leg at a specific AppBlock, so one arm can vary the manifest. */
function mockDbRead_blockUserSubscription_findMany(block: ReturnType<typeof appBlock>) {
  read.blockUserSubscription.findMany.mockResolvedValue([sub({ appBlock: block })]);
  read.appUserScopeGrant.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS but not the hybrid nodes' declared behaviour, so every query
  // this file steers is reset EXPLICITLY. A previous test's `mockRejectedValueOnce` surviving
  // into the next one is what makes a suite order-dependent.
  for (const fn of [
    read.blockUserSubscription.findMany,
    read.blockBuzzAttribution.findMany,
    read.appBlockPublishRequest.groupBy,
    read.appBlockPublishRequest.findFirst,
    read.blockScopeInvocation.findMany,
    read.blockScopeInvocation.groupBy,
    read.appBlock.findMany,
    read.appUserScopeGrant.findMany,
  ]) {
    fn.mockReset();
  }
  read.blockUserSubscription.findMany.mockResolvedValue([sub()]);
  read.blockBuzzAttribution.findMany.mockResolvedValue([]);
  read.appBlockPublishRequest.groupBy.mockResolvedValue([]);
  read.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  read.blockScopeInvocation.findMany.mockResolvedValue([]);
  read.blockScopeInvocation.groupBy.mockResolvedValue([]);
  read.appBlock.findMany.mockResolvedValue([]);
  read.appUserScopeGrant.findMany.mockResolvedValue([grant()]);
});

describe('grantedScopes / revokedScopes on ScopeGrantSurface', () => {
  it('reports the viewer’s live granted set alongside the app-side effective set', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    // The APP-SIDE set is unchanged — the exempt scope is in it, because a token really
    // carries that scope and the page must not under-report what the app can do.
    expect(row.scopes).toEqual([SPEND, POSTS, EXEMPT]);
    // The USER-SIDE set is what the viewer agreed to: no exempt scope, because no grant is
    // ever recorded for one.
    expect(row.grantedScopes).toEqual([POSTS, SPEND].sort());
    expect(row.revokedScopes).toEqual([]);
  });

  /**
   * 🔴 THE SUBTRACTION, MIRRORED. This surface must never disagree with enforcement, and the
   * raw `granted_scopes` column is not the answer: an install after a revoke unions the scope
   * back in, so a display reading the column directly would show a permission the mint
   * withholds.
   *
   * MUTATION THAT MUST KILL IT: drop the `.filter((s) => !revokedSet.has(s))` in
   * `listMyScopeGrants`' grant loop.
   */
  it('a scope in BOTH arrays is reported as revoked, not granted', async () => {
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({ grantedScopes: [SPEND, POSTS], revokedScopes: [SPEND] }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.grantedScopes).toEqual([POSTS]);
    expect(row.revokedScopes).toEqual([SPEND]);
    // The two are disjoint by construction — a UI keying row state off set membership needs
    // that to hold or a row is both at once.
    expect(row.grantedScopes.filter((s) => row.revokedScopes.includes(s))).toEqual([]);
  });

  /**
   * 🔴 AND IT MUST AGREE WITH `spendScopeGranted`, which the budget editor keys off. Two
   * derivations of "does this app hold the spend scope" that can disagree is the shape that
   * offers a budget field the server silently drops.
   */
  it('spendScopeGranted follows the SUBTRACTED set, not the raw column', async () => {
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({ grantedScopes: [SPEND], revokedScopes: [SPEND], buzzBudgetPerDay: 500 }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.spendScopeGranted).toBe(false);
    expect(row.grantedScopes).toEqual([]);
  });

  /** The control: with nothing revoked, the same fixture reports the spend scope granted. */
  it('CONTROL: spendScopeGranted is true when the spend scope is not revoked', async () => {
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({ grantedScopes: [SPEND], revokedScopes: [], buzzBudgetPerDay: 500 }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.spendScopeGranted).toBe(true);
    expect(row.buzzBudgetPerDay).toBe(500);
  });

  /**
   * A FULLY revoked grant conveys nothing, so the granted set is empty — matching
   * `getGrantedScopes`, which returns an empty set for a non-null `revoked_at` regardless of
   * what the array holds.
   *
   * 🔴 THE SUBSCRIPTION LEG IS CLEARED, AND WITHOUT THAT LINE THIS ARM WAS VACUOUS. `beforeEach`
   * leaves a blanket subscription mocked, so the row this assertion read was minted by the
   * SUBSCRIPTION leg and the grant leg's own handling of `revoked_at` was never exercised — the
   * grant-only shape the arm's title claims to cover was never built. Measured: with the
   * subscription in place the arm passed both before and after the grant leg started emitting a
   * card for a fully-revoked row, i.e. it could not see the defect in either direction. The
   * sibling arm below (the PARTIAL revoke) clears it and always did; this one did not.
   */
  it('a whole-grant revoke reports an empty granted set whatever the array holds', async () => {
    read.blockUserSubscription.findMany.mockResolvedValue([]);
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({ grantedScopes: [SPEND, POSTS], revokedAt: new Date(), revokedScopes: [POSTS] }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const rows = await listMyScopeGrants(USER);
    // 🔴 THE CARD SURVIVES. A grant-only app — no install, no subscription, no recorded
    // activity — has the grant leg as its ONLY source of a row, so skipping a fully-revoked
    // grant deleted the app from the permissions surface entirely.
    expect(
      rows,
      'a fully-revoked grant-only app vanished from the permissions surface, taking the ' +
        '"Removed / you withdrew this" row and the revocation timestamp with it'
    ).toHaveLength(1);
    const [row] = rows;
    expect(row.origin).toBe('consent');
    expect(row.grantedScopes).toEqual([]);
    expect(row.revokedScopes).toEqual([POSTS]);
  });

  /**
   * 🔴 THE PRODUCTION SHAPE, AS `revokeScopes` ACTUALLY WRITES IT. The arm above varies
   * `granted_scopes` to pin the subtraction rule; this one is the row a real
   * withdraw-your-last-permission leaves behind — `granted_scopes` emptied,
   * `revoked_scopes` holding everything, `revoked_at` and `revoked_scopes_at` stamped
   * (`scope-grant.service.ts`' `fullyRevoked` branch).
   *
   * It is reachable WITHOUT an install or any activity: a consent-modal grant on a page mint
   * needs neither, and `block_scope_invocation` rows come only from the REST `withBlockScope`
   * middleware and the bridge procedures. So the grant leg is the only leg that can carry this
   * app, and the whole revoke UI — the "Removed" marker, `scopesRevokedAt`, and every remaining
   * row — hangs off the card existing.
   */
  it('a viewer who withdrew their ONLY permission still sees the app, and when', async () => {
    const when = new Date('2026-09-27T09:00:00Z');
    read.blockUserSubscription.findMany.mockResolvedValue([]);
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({
        grantedScopes: [],
        // 🔴 STORED OUT OF ORDER, SO THE SERVICE'S `.sort()` IS OBSERVABLE. `listMyScopeGrants` does
        // `[...(g.revokedScopes ?? [])].sort()`; with a pre-sorted fixture that call is inert and the
        // assertion below passes with it deleted — measured. `POSTS` sorts before `SPEND`
        // (`posts:…` > `ai:…`), so storing them reversed makes the sort do work, and the assertion
        // names the expected order as a LITERAL rather than re-running `.sort()` on the fixture,
        // which would move with the code it checks.
        revokedScopes: [SPEND, POSTS].slice().reverse(),
        revokedAt: when,
        revokedScopesAt: when,
        // Non-null on purpose: a stored ceiling is what makes the `buzzBudgetPerDay` assertion
        // below a real check of `usableConsentBudget` rather than a restatement of the fixture
        // default. `revokeScopes` NULLs the column when the spend scope is among the revoked,
        // but a row written before that rule — or revoked via a different scope first — can
        // still carry one.
        buzzBudgetPerDay: 500,
      }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const rows = await listMyScopeGrants(USER);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.origin).toBe('consent');
    expect(row.grantedScopes).toEqual([]);
    expect(
      row.revokedScopes,
      'the surface stopped sorting `revoked_scopes`, so row order depends on insertion order'
    ).toEqual([SPEND, POSTS]);
    // The timestamp the drawer renders as "you last removed a permission on <date>".
    expect(row.scopesRevokedAt).toEqual(when);
    // The app-side row list is untouched — the page still says what the app may be exercised
    // with, and each of those rows now reports its own consent state.
    expect(row.scopes).toEqual([SPEND, POSTS, EXEMPT]);
    // 🔴 AND NO BUDGET CONTROL. `usableConsentBudget` returns null on a revoked grant and
    // `liveGrantedScopes` returns [], so the card cannot offer a spend ceiling for an app that
    // can no longer spend — which was the stated reason the row used to be skipped outright.
    expect(row.spendScopeGranted).toBe(false);
    expect(row.buzzBudgetPerDay).toBeNull();
  });

  /**
   * A PARTIAL REVOKE KEEPS ITS CARD.
   *
   * ⚠️ THIS IS NOW AN INVARIANT GUARD, NOT REGRESSION COVERAGE, AND THE LABEL MATTERS BECAUSE
   * "reads as coverage while providing none" is the failure mode. Its docblock said *"the grant leg
   * skips rows carrying it; keying that skip on 'has any revocation' would make a viewer's first
   * revoke remove the very row they revoked from"* — RETRACTED: 4990 removed the skip entirely, so
   * neither flag gates the card and there is no longer a way to lose it by keying the skip wrongly.
   * The arm is kept (the operator's brief required it to keep passing, and it still pins that a
   * partial revoke reports `origin: 'consent'` with the remaining scope) but it now guards an
   * invariant the bug cannot violate. The live version of this claim is the CARD-SURVIVES assertion
   * in the whole-grant arm above.
   */
  it('a partially-revoked app still has its row, with the remaining permissions', async () => {
    read.blockUserSubscription.findMany.mockResolvedValue([]);
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({ grantedScopes: [POSTS], revokedScopes: [SPEND] }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const rows = await listMyScopeGrants(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('consent');
    expect(rows[0].grantedScopes).toEqual([POSTS]);
  });
});

describe('scopesRevokedAt', () => {
  it('carries the most recent revocation time', async () => {
    const when = new Date('2026-09-20T10:00:00Z');
    read.appUserScopeGrant.findMany.mockResolvedValue([
      grant({ revokedScopes: [SPEND], revokedScopesAt: when }),
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.scopesRevokedAt).toEqual(when);
  });

  it('is null when nothing has ever been revoked', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.scopesRevokedAt).toBeNull();
  });
});

describe('revokableScopes', () => {
  /**
   * 🔴 THE SEVEN EXEMPT SCOPES ARE EXCLUDED, AND THIS IS WHERE THE UI LEARNS IT.
   * `partitionByConsent` signs an exempt scope on the exempt test ALONE, before it consults
   * the grant, so a suppression entry for one would be stored and enforce NOTHING — the
   * button would report success and the app would keep the permission.
   * `blocks.revokeScopes` refuses them as a backstop; this field is how the control is never
   * offered in the first place.
   *
   * MUTATION THAT MUST KILL IT: drop the `.filter((s) => !isConsentExemptScope(s))` from the
   * `revokableScopes` computation.
   */
  it('excludes the consent-exempt scopes from the app’s effective set', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.revokableScopes).toEqual([SPEND, POSTS]);
    expect(row.revokableScopes).not.toContain(EXEMPT);
    // …and it really is a SUBSET of the displayed rows, so every control the UI renders has a
    // row to sit on.
    for (const s of row.revokableScopes) expect(row.scopes).toContain(s);
  });

  /**
   * 🔴 DERIVED FROM THE SAME PREDICATE THE MINT USES, not from a copy. Enumerated over all
   * seven rather than sampled: membership decides both what mints consent-free AND what is
   * un-revokable, so a member that slipped through would be an un-enforceable "success".
   */
  it.each([
    'apps:storage:read',
    'apps:storage:write',
    'apps:storage:shared:read',
    'apps:storage:shared:write',
    'models:read:self',
    'collections:read:self',
    'collections:write:self',
  ])('never offers %s', async (scope) => {
    const block = appBlock({ manifest: { name: 'x', scopes: [scope] }, approvedScopes: [scope] });
    read.blockUserSubscription.findMany.mockResolvedValue([sub({ appBlock: block })]);
    read.appUserScopeGrant.findMany.mockResolvedValue([]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.scopes).toEqual([scope]);
    expect(row.revokableScopes).toEqual([]);
  });

  /**
   * 🔴 A SCOPE RETIRED FROM THE REGISTRY IS NOT OFFERED, AND THE BLAST RADIUS WAS THE OTHER
   * SCOPES IT TOOK DOWN WITH IT.
   *
   * `effectiveBlockScopes` is deliberately NOT registry-filtered (its own docblock says the mint
   * applies that filter), and `consentGatedScopes` only subtracts the exempt set. So a scope
   * removed from the vocabulary — `block:settings:read`/`write`, `media:read:owned` — but still
   * sitting in an app's `manifest.scopes` AND `approved_scopes` from before the hygiene pass
   * reached this list. `blocks.revokeScopes` refuses unknown strings ALL-OR-NOTHING, so a
   * withdraw-all built on this field would have failed the whole call and the viewer could not
   * revoke `posts:write:self` or `ai:write:budgeted` on that app either. The retired scope itself
   * is harmless (not mintable, grants nothing); the other scopes were the cost.
   *
   * MUTATION THAT MUST KILL IT: drop the `isKnownBlockScope` filter from `revokableScopes`.
   */
  it('never offers a scope retired from the registry', async () => {
    const RETIRED = 'block:settings:write';
    const block = appBlock({
      manifest: { name: 'x', scopes: [SPEND, RETIRED, POSTS] },
      approvedScopes: [SPEND, RETIRED, POSTS],
    });
    mockDbRead_blockUserSubscription_findMany(block);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    // The app-side row list still shows it — that set is "what the app may be exercised with",
    // and the retired scope really is in its approved manifest.
    expect(row.scopes).toContain(RETIRED);
    // …but it is NOT offered as revokable, because the mutation would refuse the whole call.
    expect(
      row.revokableScopes,
      'a registry-retired scope was offered as revokable. `blocks.revokeScopes` refuses unknown ' +
        'strings all-or-nothing, so a withdraw-all on this app would fail entirely and the ' +
        'viewer could revoke NOTHING on it.'
    ).toEqual([SPEND, POSTS]);
  });

  /**
   * AN ACTIVITY-ONLY ROW OFFERS NOTHING. Such a row emits `scopes: []` by construction — the
   * viewer granted the app nothing and it reached them entirely through exempt scopes — so
   * there is nothing consent-gated to withdraw. A button there would be the same lie the
   * exempt refusal exists to prevent.
   */
  it('an activity-only row offers no revoke control and no granted scopes', async () => {
    read.blockUserSubscription.findMany.mockResolvedValue([]);
    read.appUserScopeGrant.findMany.mockResolvedValue([]);
    read.blockScopeInvocation.groupBy.mockResolvedValue([{ appBlockId: APP }]);
    read.appBlock.findMany.mockResolvedValue([
      { ...appBlock(), app: { userId: 999 } }, // not the viewer's own app
    ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.origin).toBe('activity');
    expect(row.scopes).toEqual([]);
    expect(row.revokableScopes).toEqual([]);
    expect(row.grantedScopes).toEqual([]);
    expect(row.revokedScopes).toEqual([]);
  });
});

/**
 * 🔴 THE TWO-STAGE P2022 DEGRADE. Two hand-applied migrations mean a database can have
 * `buzz_budget_per_day` and NOT `revoked_scopes`, so the newer column's absence must not
 * blank the older feature — which is exactly what the single shared catch this replaced did.
 */
describe('a database mid-migration', () => {
  function missingColumnError() {
    return Object.assign(new Error('The column ... does not exist in the current database.'), {
      code: 'P2022',
    });
  }

  /**
   * MUTATION THAT MUST KILL IT: delete the stage-1 retry, leaving one catch that sets
   * `grants = []`.
   */
  it('without revoked_scopes: revocations read as none AND the budget still works', async () => {
    read.appUserScopeGrant.findMany
      .mockRejectedValueOnce(missingColumnError())
      .mockResolvedValueOnce([
        // The pre-migration row shape — no revocation columns at all.
        {
          appBlockId: APP,
          buzzBudgetPerDay: 750,
          revokedAt: null,
          grantedScopes: [SPEND],
          appBlock: appBlock(),
        },
      ]);
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.revokedScopes).toEqual([]);
    expect(row.scopesRevokedAt).toBeNull();
    // 🔴 THE HALF THE OLD SHARED CATCH LOST: the budget and the spend flag survive.
    expect(row.buzzBudgetPerDay).toBe(750);
    expect(row.spendScopeGranted).toBe(true);
    expect(row.grantedScopes).toEqual([SPEND]);
    // The retry really was the narrower select — without this the test would also pass on an
    // implementation that swallowed the error and re-ran the identical query.
    const retrySelect = read.appUserScopeGrant.findMany.mock.calls[1][0].select;
    expect(retrySelect).not.toHaveProperty('revokedScopes');
    expect(retrySelect).toHaveProperty('buzzBudgetPerDay', true);
  });

  /** Both columns missing ⇒ the pre-existing behaviour: no grants, every app reports null. */
  it('without either column: no grant rows, every app reports null', async () => {
    read.appUserScopeGrant.findMany
      .mockRejectedValueOnce(missingColumnError())
      .mockRejectedValueOnce(missingColumnError());
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const [row] = await listMyScopeGrants(USER);
    expect(row.buzzBudgetPerDay).toBeNull();
    expect(row.grantedScopes).toEqual([]);
    expect(row.revokedScopes).toEqual([]);
    // The row itself survives — it comes from the subscription leg, which is untouched.
    expect(row.origin).toBe('install');
  });

  /** Any OTHER error still throws: a page that renders "no limits" because the DB is
   *  unreachable would be a lie about the user's own settings. */
  it('a non-P2022 error propagates from the first read', async () => {
    read.appUserScopeGrant.findMany.mockRejectedValueOnce(
      Object.assign(new Error('replica down'), { code: 'P1001' })
    );
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await expect(listMyScopeGrants(USER)).rejects.toThrow(/replica down/);
  });

  /** …and from the RETRY as well, which is the arm a single catch would have swallowed. */
  it('a non-P2022 error propagates from the retry', async () => {
    read.appUserScopeGrant.findMany
      .mockRejectedValueOnce(missingColumnError())
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'P2024' }));
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await expect(listMyScopeGrants(USER)).rejects.toThrow(/timeout/);
  });
});
