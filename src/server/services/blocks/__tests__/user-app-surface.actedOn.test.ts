import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

/**
 * THE ACTIVITY LEG of `listMyScopeGrants` — apps that USED the viewer's account with NEITHER an
 * install/subscription NOR a consent grant, and which therefore appeared nowhere on
 * `/apps/activity` → "Apps & permissions".
 *
 * WHY THE POPULATION EXISTS. The dominant mechanism is `CONSENT_EXEMPT_SCOPES`
 * (`src/server/services/blocks/scope-grant.service.ts`): for an app whose scopes are ALL exempt,
 * `partitionByConsent` returns `missing: []`, so no consent modal fires and `recordScopeGrant`
 * is never reached. The app can read and write the account and own no row on either of the two
 * pre-existing legs. Measured on production 2026-09-12: 13 `(user, app)` pairs across 10 users
 * and 6 apps, every one of them invocation-only, 84 of 111 such calls `collections:read:self`.
 * **2** of those 13 are the app's own AUTHOR and are now skipped, leaving 11 over 9 users and 4
 * apps.
 *
 * 🔴 RED AT `origin/main` — the matrix is recorded in the PR body, and every test in the first
 * two `describe`s below was run against the pre-change service in a separate worktree. The
 * failures are assertion failures, not import errors: the file deliberately imports NOTHING that
 * this change introduced (no `app-surface-provenance`, no exported constant), so it is a valid
 * probe of the old implementation rather than a module-absence red.
 *
 * 🔴 MOCKING GOES THROUGH THE CANONICAL SHARED MOCKS (`~/__tests__/mocks/*`), NOT A PER-FILE
 * `vi.mock`, AND THAT IS ENFORCED. `no-direct-shared-module-mock.test.ts` is a ratchet over
 * `~/server/db/client` and `~/server/logging/client`: under `isolate: false` a per-file
 * `vi.mock` freezes that file's mock shape into every later file sharing the worker, so a file
 * with no mock at all can fail on a missing export. The sibling
 * `user-app-surface.orchestration.test.ts` still uses `vi.hoisted` + `vi.mock` because it is
 * ALLOWLISTED as pre-existing; a new file is not, and copying its shape is what the ratchet
 * exists to catch. Behaviour is declared on `dbMock` instead; the global
 * `resetSharedMocks` in `src/__tests__/setup.ts` clears implementations AND call counts between
 * files, so this file resets only what it overrides.
 *
 * ⚠️ THIS FILE WAS WRITTEN WITH `vi.mock` AND CAUGHT BY THAT GATE IN CI, NOT LOCALLY — the gate
 * lives in `src/server/services/__tests__/`, which was outside the paths run by hand. A green
 * local run covered only the directories it was pointed at.
 */

/**
 * A viewer id, and a DIFFERENT app-owner id. Distinct constants because the owner-skip guard is
 * an equality test between the two: a fixture that let them collide would make every row vanish
 * and read as a broken activity leg.
 */
const VIEWER = 42;
const OTHER_OWNER = 999;

function appBlockRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apb_acted',
    blockId: 'playable-collections',
    manifest: {
      name: 'Playable Collections',
      // A realistic DECLARED set: 6 scopes, of which production shows 3 ever invoked. If the
      // implementation synthesised a ceiling from the manifest this fixture would expose it.
      scopes: [
        'collections:read:self',
        'collections:write:self',
        'apps:storage:shared:read',
        'apps:storage:shared:write',
        'user:read:self',
        'images:read:self',
      ],
    },
    approvedScopes: [
      'collections:read:self',
      'collections:write:self',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
      'user:read:self',
      'images:read:self',
    ],
    // Authorship lives on the `OauthClient` behind `AppBlock.app` — `AppBlock` has no `userId`.
    // Defaults to a THIRD PARTY so the ordinary row class is the default and the owner case has
    // to be asked for explicitly.
    app: { userId: OTHER_OWNER },
    ...over,
  };
}

/**
 * One `GROUP BY app_block_id` result row, which is the ONLY shape the activity leg reads. It
 * carries no id and no timestamp: a group is not a row, and that is the point of the change
 * these tests were rewritten for.
 */
function actedOnGroup(appBlockId: string | null = 'apb_acted') {
  return { appBlockId };
}

/**
 * 🔴 THE PER-TEST RESET IS THIS FILE'S JOB, AND ASSUMING OTHERWISE PRODUCED SEVEN FAILURES.
 * `resetSharedMocks()` in `src/__tests__/setup.ts` runs per test FILE, not per test — so under
 * the canonical mocks a spy's call history accumulates across every `it()` in this file. The
 * symptom is unmistakable once seen and baffling before: `expected … to be called 1 times, but
 * got 17 times`, and `expected 42 to be 7` from a `mock.calls[0]` that belonged to the first
 * test rather than the current one. Every count- and `mock.calls[n]`-based assertion in this
 * file depends on the resets below.
 *
 * ⚠️ AND NOT VIA `Object.values(mockDbRead)`, which is what the allowlisted sibling
 * `user-app-surface.orchestration.test.ts` does. `dbMock.dbRead` is an auto-vivifying callable
 * PROXY, not a plain object of plain objects, so that walk enumerates nothing and resets
 * nothing — it would read as a reset while providing none. The delegates are named explicitly.
 *
 * `mockReset` clears the implementation as well as the history, so the defaults are re-declared
 * after it. They match `db.mock.ts`'s own `findMany → []` / `groupBy → []` defaults and are
 * spelled out anyway: "nothing used this viewer's account" is the baseline every test is
 * measured against, so a test that surfaces a row has to say why, visibly, rather than inherit
 * it from another module.
 *
 * `blockScopeInvocation.findMany` is reset even though the leg no longer calls it — that is what
 * makes the "aggregates in the database" assertion below a real claim rather than a reading of
 * another test's history.
 */
beforeEach(() => {
  for (const fn of [
    mockDbRead.blockUserSubscription.findMany,
    mockDbRead.blockBuzzAttribution.findMany,
    mockDbRead.blockScopeInvocation.findMany,
    mockDbRead.blockScopeInvocation.groupBy,
    mockDbRead.appUserScopeGrant.findMany,
    mockDbRead.appBlock.findMany,
  ]) {
    fn.mockReset();
  }
  mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
  mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([]);
  mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([]);
  mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([]);
  mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([]);
  mockDbRead.appBlock.findMany.mockResolvedValue([]);
});

// ── THE REGRESSION THE CHANGE EXISTS FOR ────────────────────────────────────────────────────

describe('listMyScopeGrants — the activity leg', () => {
  /**
   * 🔴 THE HEADLINE REGRESSION. An app that invoked a scope-gated endpoint on this account with
   * no subscription and no grant row. Red at `origin/main`: `result` is `[]`, because
   * `byAppBlock` was built from subscriptions and grants only and nothing ever read
   * `block_scope_invocations` for this surface.
   */
  it('🔴 surfaces an app that INVOKED a scope on the viewer with no install and no consent', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].appBlockId).toBe('apb_acted');
    expect(result[0].slug).toBe('playable-collections');
    expect(result[0].name).toBe('Playable Collections');
    expect(result[0].origin).toBe('activity');
    // Honest surfaces — it really is installed nowhere and consented to nowhere.
    expect(result[0].surfaces.modelInstallCount).toBe(0);
    expect(result[0].surfaces.subscriptionScopes).toEqual([]);
    expect(result[0].buzzBudgetPerDay).toBeNull();
    expect(result[0].spendScopeGranted).toBe(false);
  });

  /**
   * 🔴 NO SYNTHESISED CEILING. The fixture's app declares AND is approved for SIX scopes, so a
   * row that emitted `manifest ∩ approved` would come back with all six — which is the 3–6×
   * over-report measured on the live population and the exact defect class #4790 removed. The
   * assertion is `[]`, and the `length` check below is not redundant: it distinguishes "emitted
   * an empty array" from a `toEqual` that an `undefined` would also satisfy.
   */
  it('🔴 emits scopes: [] for an activity-only row even though the app declares six', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(VIEWER);

    expect(Array.isArray(result[0].scopes)).toBe(true);
    expect(result[0].scopes).toEqual([]);
    // POSITIVE CONTROL on the fixture: the same app as an INSTALL-backed row DOES render its
    // six effective scopes, so `[]` above is a property of the row class and not of a fixture
    // whose intersection is empty anyway.
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([]);
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        scope: 'viewer_personal',
        slotId: null,
        targetModelIds: [],
        appBlock: appBlockRow(),
      },
    ]);
    const installed = await listMyScopeGrants(VIEWER);
    expect(installed[0].scopes).toHaveLength(6);
  });

  it('an app whose AppBlock no longer resolves is skipped, not rendered nameless', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_gone')]);
    // `findMany` simply omits a deleted row — the same outcome the other two legs get from
    // their `if (!row.appBlock)` guards.
    mockDbRead.appBlock.findMany.mockResolvedValue([]);
    const result = await listMyScopeGrants(VIEWER);
    expect(result).toEqual([]);
  });

  /**
   * ⚠️ VACUOUS AT BASE — base never calls `appBlock.findMany` because the leg does not exist, so
   * `not.toHaveBeenCalled()` is trivially true there. It is a cost guard (no batched read on the
   * overwhelmingly common empty sweep), not regression coverage.
   */
  it('does not touch appBlock.findMany when nothing acted on the viewer', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(VIEWER);
    expect(mockDbRead.appBlock.findMany).not.toHaveBeenCalled();
  });
});

// ── THE OWNER SKIP: the viewer's OWN app is not "an app that used your account" ──────────────

describe("listMyScopeGrants — the viewer's own app is not an activity row", () => {
  /**
   * 🔴 THE OPERATOR'S OWN CASE, AND IT IS 2 OF THE 13 MEASURED PAIRS. A developer driving their
   * own block writes ordinary `block_scope_invocations` rows against their own account, so
   * without this guard the author of every App Block carries a permanent card on their own
   * permissions tab describing their own app as something that used their account without an
   * install. Measured on production 2026-09-12: `app-requests` and `w6-ui-dogfood`, both owned
   * by the viewer, are exactly that.
   *
   * ⚠️ THIS IS THE GUARD `syntheticAppId: null` WAS BELIEVED TO BE AND IS NOT — see its
   * assertion below, which now pins that the synthetic predicate excludes rows it cannot reach.
   */
  it('🔴 skips an activity row for an app the VIEWER owns', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow({ app: { userId: VIEWER } })]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toEqual([]);
  });

  /**
   * 🔴 THE POSITIVE CONTROL, AND IT IS THE WHOLE TEST. Without it, a mutant that skipped EVERY
   * activity row — or one that compared the wrong pair of ids — would satisfy the assertion
   * above. Identical fixture, identical call, ONE field different: the owner.
   */
  it('🔴 the SAME app still surfaces for a viewer who does not own it', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow({ app: { userId: OTHER_OWNER } })]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('activity');
  });

  /**
   * The skip is scoped to the ACTIVITY leg only. An author who also INSTALLED their own app
   * chose that relationship, and the row carries their real install counts and budget control —
   * hiding it would remove the only surface on which they can bound their own app's spend.
   */
  it('an app the viewer owns AND has installed still renders, as an install row', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        scope: 'viewer_personal',
        slotId: null,
        targetModelIds: [],
        appBlock: appBlockRow({ app: { userId: VIEWER } }),
      },
    ]);
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow({ app: { userId: VIEWER } })]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('install');
  });

  /**
   * ⚠️ INVARIANT GUARD, LABELLED AS ONE. `AppBlock.app` is a REQUIRED relation with
   * `onDelete: Cascade` and the datasource sets no `relationMode`, so a null owner is a state
   * Postgres does not permit. What it pins is the DIRECTION the code fails in: an unresolvable
   * owner must not HIDE the row, because a transparency surface that drops rows on an
   * unexpected shape is failing in the one direction it must not.
   */
  it('an activity row whose owner cannot be resolved is SHOWN, not hidden (invariant guard)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow({ app: null })]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('activity');
  });

  /** The owner id must be SELECTED, or the guard above is deciding on `undefined` forever. */
  it('selects the app owner so the skip has something to compare', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup()]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    await listMyScopeGrants(VIEWER);
    expect(mockDbRead.appBlock.findMany.mock.calls[0][0].select.app).toEqual({
      select: { userId: true },
    });
  });
});

// ── PRECEDENCE: subscription > consent grant > activity-only ────────────────────────────────

describe('listMyScopeGrants — precedence', () => {
  /**
   * 🔴 A GRANT + INVOCATIONS MUST KEEP THE GRANT ROW. The activity leg's `has()` guard is the
   * precedence rule; without it the sweep would overwrite the entry and report `origin:
   * 'activity'` for an app the viewer explicitly consented to — and, because the activity leg
   * also forces `scopes: []`, would BLANK the scope list and the budget row class at the same
   * time. Distinct non-default budget/scope values so a mutant that overwrites is visible in
   * more than one field.
   */
  it('🔴 grant + invocations keeps the CONSENT row, its scopes and its budget', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        buzzBudgetPerDay: 1337,
        revokedAt: null,
        grantedScopes: ['ai:write:budgeted'],
        appBlock: appBlockRow(),
      },
    ]);
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_acted')]);
    // Deliberately ALSO resolvable by the batched read: a mutant that skipped the `has()` guard
    // would then succeed in overwriting, rather than failing for lack of a row to overwrite.
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('consent');
    expect(result[0].buzzBudgetPerDay).toBe(1337);
    expect(result[0].spendScopeGranted).toBe(true);
    // The consent row renders the effective set; the activity class would have forced `[]`.
    expect(result[0].scopes).toHaveLength(6);
  });

  /**
   * 🔴 A SUBSCRIPTION + INVOCATIONS MUST KEEP THE INSTALL ROW AND ITS COUNTS. Two pinned models
   * and a blanket scope, both non-zero and distinct, so a mutant that overwrites the entry zeroes
   * two observable fields rather than one.
   */
  it('🔴 subscription + invocations keeps the INSTALL row and its install counts', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        scope: 'publisher_all_my_models',
        slotId: 'model.sidebar_top',
        targetModelIds: [100, 101, 102],
        appBlock: appBlockRow(),
      },
      {
        appBlockId: 'apb_acted',
        scope: 'viewer_personal',
        slotId: null,
        targetModelIds: [],
        appBlock: appBlockRow(),
      },
    ]);
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('install');
    expect(result[0].surfaces.modelInstallCount).toBe(3);
    expect(result[0].surfaces.subscriptionScopes).toEqual(['viewer_personal']);
    expect(result[0].scopes).toHaveLength(6);
  });

  /**
   * All three at once, which is the NORMAL shape for a subscribed app that has actually run —
   * not a corner case. The subscription must win outright.
   */
  it('subscription + grant + invocations all present: install wins', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        scope: 'viewer_personal',
        slotId: null,
        targetModelIds: [],
        appBlock: appBlockRow(),
      },
    ]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        buzzBudgetPerDay: 900,
        revokedAt: null,
        grantedScopes: ['ai:write:budgeted'],
        appBlock: appBlockRow(),
      },
    ]);
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    const result = await listMyScopeGrants(VIEWER);
    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('install');
    // The grant's budget still reaches the row — the maps feeding it are keyed on appBlockId
    // independently of which leg minted the entry.
    expect(result[0].buzzBudgetPerDay).toBe(900);
  });

  /**
   * 🔴 THE DISCRIMINATING CASE FOR `origin` ITSELF, AND THE ONE NO COUNT CAN ANSWER. A
   * consent-only row and an activity-only row BOTH carry `modelInstallCount: 0` and
   * `subscriptionScopes: []`. If `origin` were derived from the counts — which is exactly what
   * the client used to do — these two rows would be indistinguishable and the activity row would
   * be labelled "Granted at consent". Two rows in ONE read, so no single hard-coded literal
   * satisfies both.
   */
  it('🔴 a consent-only and an activity-only row are both 0/0 yet report DIFFERENT origins', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_consented',
        buzzBudgetPerDay: null,
        revokedAt: null,
        grantedScopes: ['collections:read:self'],
        appBlock: appBlockRow({
          id: 'apb_consented',
          blockId: 'consented',
          manifest: { name: 'Aaa Consented', scopes: ['collections:read:self'] },
          approvedScopes: ['collections:read:self'],
        }),
      },
    ]);
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ manifest: { ...appBlockRow().manifest, name: 'Bbb Acted' } }),
    ]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result.map((r) => r.name)).toEqual(['Aaa Consented', 'Bbb Acted']);
    // Both rows are 0/0 — that is the premise, asserted so the test cannot pass for the wrong
    // reason (e.g. a fixture that accidentally gave one of them a subscription).
    for (const row of result) {
      expect(row.surfaces.modelInstallCount).toBe(0);
      expect(row.surfaces.subscriptionScopes).toEqual([]);
    }
    expect(result[0].origin).toBe('consent');
    expect(result[1].origin).toBe('activity');
  });

  /**
   * A REVOKED grant does not claim `'consent'`, and the app is not thereby hidden either: the
   * activity leg picks it up and reports the honest `'activity'`. ⚠️ The revoked state is an
   * INVARIANT guard — nothing in this repo writes a non-null `revoked_at` — labelled rather than
   * counted as regression coverage. What it pins is that the two guards COMPOSE: the grant leg's
   * `!g.revokedAt` must not leave the app invisible now that a third leg exists.
   */
  it('a revoked grant plus invocations yields an ACTIVITY row, not a consent row (invariant guard)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        buzzBudgetPerDay: 1200,
        revokedAt: new Date('2026-01-01T00:00:00Z'),
        grantedScopes: ['ai:write:budgeted'],
        appBlock: appBlockRow(),
      },
    ]);
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    const result = await listMyScopeGrants(VIEWER);
    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('activity');
    expect(result[0].scopes).toEqual([]);
    expect(result[0].buzzBudgetPerDay).toBeNull();
  });

  /**
   * ⚠️ INVARIANT GUARD, and the ALIGNMENT of three writes rather than one branch. A grant whose
   * AppBlock does not resolve must seed NEITHER the budget map, NOR the spend map, NOR a row.
   * Before this change the row creation required `g.appBlock` while the two maps did not, so such
   * a grant decided the budget control of whatever row ANOTHER leg had minted for the same app.
   * Unreachable for the same reason as every `appBlock` guard in this file (required relation,
   * `onDelete: Cascade`, FK enforced by Postgres) — pinned so the three cannot drift apart again.
   */
  it('a grant whose AppBlock does not resolve seeds no budget and no spend flag (invariant guard)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        buzzBudgetPerDay: 4242,
        revokedAt: null,
        grantedScopes: ['ai:write:budgeted'],
        appBlock: null,
      },
    ]);
    // The activity leg DOES resolve it, so a row exists for the assertion to read. Without this
    // the test would pass on an empty result and prove nothing about the maps.
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([actedOnGroup('apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(VIEWER);

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('activity');
    expect(result[0].buzzBudgetPerDay).toBeNull();
    expect(result[0].spendScopeGranted).toBe(false);
  });
});

// ── THE AGGREGATE: one GROUP BY, not a paged row sweep ──────────────────────────────────────

describe('listMyScopeGrants — the activity aggregate query', () => {
  /**
   * 🔴 THE QUESTION IS "WHICH APPS", SO THE QUERY ASKS FOR APPS — AND THE PAGED ROW SWEEP IT
   * REPLACES ASKED FOR ROWS. That sweep fetched up to 40,000 rows to compute a set of a few dozen
   * ids (measured: 1,919 rows → 13 apps on the heaviest account, ~148:1) and its `take` bounded
   * nothing, because page one already scans the whole `app_block_id IS NOT NULL` bitmap for every
   * viewer. A GROUP BY also cannot UNDER-report, which is what removed the truncation log.
   *
   * Asserted on BOTH sides: `groupBy` is used, and `findMany` on the same table is NOT. Only the
   * negative half can see a mutant that adds the row sweep back alongside the aggregate.
   */
  it('🔴 aggregates in the database by app id instead of paging rows', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(VIEWER);

    expect(mockDbRead.blockScopeInvocation.groupBy).toHaveBeenCalledTimes(1);
    const args = mockDbRead.blockScopeInvocation.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(['appBlockId']);
    // No row-paging machinery survives: a `take`/`cursor`/`skip` on an aggregate would be the
    // paged shape reintroduced, and an `orderBy` would re-add the Sort the HashAggregate avoids.
    expect(args.take).toBeUndefined();
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toBeUndefined();
    // 🔴 THE NEGATIVE HALF. The permissions surface must not read this table row-by-row at all.
    expect(mockDbRead.blockScopeInvocation.findMany).not.toHaveBeenCalled();
  });

  /**
   * 🔴 `block_buzz_attribution` IS NOT A SOURCE, AND THE JUSTIFICATION THAT MADE IT ONE NAMED THE
   * WRONG TABLE. It is a PURCHASE / revenue-share ledger — `recordAttribution` is reached only
   * from the Stripe webhook and `paddle.service.ts` after a completed Buzz purchase — so a row
   * means the VIEWER BOUGHT BUZZ in that app with their own card, and a card describing an app
   * that used their account without an install would be actively wrong about it. An app SPENDING
   * the viewer's Buzz needs the consent-GATED `ai:write:budgeted` and lands in
   * `block_scope_invocations` as `workflow:submit:*`, i.e. on the leg that already exists.
   *
   * The positive control is inside the assertion: a leg that still read the table would have been
   * handed a spendable fixture and produced a row.
   */
  it('🔴 does not read block_buzz_attribution for the permissions surface', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      { id: 'bba_1', appBlockId: 'apb_spender' },
    ]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ id: 'apb_spender', blockId: 'sensei', manifest: { name: 'Sensei' } }),
    ]);

    const result = await listMyScopeGrants(VIEWER);

    expect(mockDbRead.blockBuzzAttribution.findMany).not.toHaveBeenCalled();
    // …and a purchase therefore mints NO permissions row, which is the behavioural half.
    expect(result).toEqual([]);
  });

  /**
   * ⚠️ AN INVARIANT GUARD ON THE SYNTHETIC PREDICATE, RE-LABELLED FROM THE COVERAGE CLAIM IT USED
   * TO MAKE. The comment on this clause said it kept the scary card off a developer's permissions
   * tab. It does not: measured on production 2026-09-12, all **59** synthetic rows ALSO carry
   * `app_block_id IS NULL`, so `appBlockId: { not: null }` already excludes every one and this
   * predicate removes **0** rows. And the dev-tunnel SCOPED mint signs the app's REAL ids, so an
   * author driving their own APPROVED app writes rows this clause cannot see — that case is
   * handled by the owner skip, which has its own tests above. Kept because it stays correct if the
   * retry path ever learns to set both columns; pinned here as intent, not as protection.
   */
  it('excludes synthetic dev-tunnel rows via syntheticAppId: null (invariant guard)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(VIEWER);
    const where = mockDbRead.blockScopeInvocation.groupBy.mock.calls[0][0].where;
    expect(where.syntheticAppId).toBeNull();
    expect(where.userId).toBe(VIEWER);
    // Also the null-`appBlockId` exclusion, which is what removes the external-OAuth population
    // (1,031,554 of 1,034,384 rows measured in production) without naming `source` — filtering on
    // `source` would break this file's pre-migration safety for no extra exclusion.
    expect(where.appBlockId).toEqual({ not: null });
    expect(JSON.stringify(where)).not.toContain('source');
    expect(JSON.stringify(where)).not.toContain('oauthClientId');
  });

  /**
   * 🔴 ALL-TIME: NO TIME BOUND ANYWHERE IN THE AGGREGATE. This supersedes clawgate #532's own
   * bounded-lookback acceptance criterion (the operator chose unbounded; it is flagged on the
   * card). A lookback window would make an app that last used your account outside it silently
   * invisible again — the precise defect this change removes — so the absence of a date predicate
   * is a REQUIREMENT, pinned here rather than left to inspection.
   */
  it('🔴 applies NO time bound — the aggregate is all-time', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(VIEWER);
    const serialised = JSON.stringify(
      mockDbRead.blockScopeInvocation.groupBy.mock.calls[0][0].where
    );
    // Guard the guard: a `where` that serialised to nothing would satisfy every `not.toContain`.
    expect(serialised).toContain('userId');
    expect(serialised).not.toContain('invokedAt');
    expect(serialised).not.toContain('gte');
    expect(serialised).not.toContain('gt');
  });

  it('the aggregate is scoped to the viewer', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(7);
    expect(mockDbRead.blockScopeInvocation.groupBy.mock.calls[0][0].where.userId).toBe(7);
  });

  /**
   * 🔴 A NULL `appBlockId` REACHING THE ACCUMULATOR IS DROPPED, NOT USED AS A KEY. Added because
   * the guard SURVIVED a mutation sweep: replacing `if (row.appBlockId != null) found.add(...)`
   * with an unconditional `found.add(row.appBlockId as string)` left the suite green, since no
   * fixture fed a null row through. It is a SEAM guard, not dead code — the `where` above excludes
   * nulls today, so the only way one arrives is a future widening of that predicate, and the
   * consequence is a `null` reaching `appBlock.findMany({ id: { in: [...] } })` and a Map key. The
   * mock makes the state trivially producible, which is exactly why there is no excuse for leaving
   * the guard unexercised. (`GROUP BY` over a nullable column genuinely can return a NULL group,
   * which is a second reason the shape is worth pinning.)
   */
  it('🔴 drops a null appBlockId rather than keying the map on it', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([
      actedOnGroup(null),
      actedOnGroup('apb_acted'),
    ]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(VIEWER);

    // The batched resolve must be asked for the real id ALONE — a `null` in the `in` list is the
    // observable the guard exists to prevent.
    expect(mockDbRead.appBlock.findMany.mock.calls[0][0].where.id.in).toEqual(['apb_acted']);
    // POSITIVE CONTROL: the resolvable sibling still produces its row, so this is not passing
    // because the whole leg bailed out.
    expect(result.map((r) => r.appBlockId)).toEqual(['apb_acted']);
  });
});
