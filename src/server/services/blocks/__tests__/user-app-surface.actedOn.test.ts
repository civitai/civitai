import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mockDbRead = dbMock.dbRead;
const mockLogToAxiom = loggingMock.logToAxiom;

/**
 * THE ACTIVITY LEG of `listMyScopeGrants` — apps that ACTED on the viewer's account with
 * NEITHER an install/subscription NOR a consent grant, and which therefore appeared nowhere on
 * `/apps/activity` → "Apps & permissions".
 *
 * WHY THE POPULATION EXISTS. The dominant mechanism is `CONSENT_EXEMPT_SCOPES`
 * (`src/server/services/blocks/scope-grant.service.ts`): for an app whose scopes are ALL exempt,
 * `partitionByConsent` returns `missing: []`, so no consent modal fires and `recordScopeGrant`
 * is never reached. The app can read and write the account and own no row on either of the two
 * pre-existing legs. Measured on production 2026-09-12: 13 `(user, app)` pairs across 10 users
 * and 6 apps, every one of them invocation-only, 84 of 111 such calls `collections:read:self`.
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
 * exists to catch. Behaviour is declared on `dbMock`/`loggingMock` instead; the global
 * `resetSharedMocks` in `src/__tests__/setup.ts` clears implementations AND call counts between
 * files, so this file resets only what it overrides.
 *
 * ⚠️ THIS FILE WAS WRITTEN WITH `vi.mock` AND CAUGHT BY THAT GATE IN CI, NOT LOCALLY — the gate
 * lives in `src/server/services/__tests__/`, which was outside the paths run by hand. A green
 * local run covered only the directories it was pointed at.
 */

/** The page size the sweep pages at — deliberately re-derived below, never hard-coded twice. */
const PAGE_SIZE = 2000;

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
    ...over,
  };
}

/** A `block_scope_invocations` page row as the sweep selects it (`id` + `appBlockId` only). */
function invocation(id: bigint, appBlockId: string | null = 'apb_acted') {
  return { id, appBlockId };
}

/** A `block_buzz_attribution` page row as the sweep selects it. */
function attribution(id: string, appBlockId = 'apb_spender') {
  return { id, appBlockId };
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
 * after it. They match `db.mock.ts`'s own `findMany → []` default and are spelled out anyway:
 * "nothing acted on this viewer" is the baseline every test is measured against, so a test that
 * surfaces a row has to say why, visibly, rather than inherit it from another module.
 */
beforeEach(() => {
  for (const fn of [
    mockDbRead.blockUserSubscription.findMany,
    mockDbRead.blockBuzzAttribution.findMany,
    mockDbRead.blockScopeInvocation.findMany,
    mockDbRead.appUserScopeGrant.findMany,
    mockDbRead.appBlock.findMany,
    mockLogToAxiom,
  ]) {
    fn.mockReset();
  }
  mockLogToAxiom.mockResolvedValue(undefined);
  mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
  mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([]);
  mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([]);
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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n)]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(42);

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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n)]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(42);

    expect(Array.isArray(result[0].scopes)).toBe(true);
    expect(result[0].scopes).toEqual([]);
    // POSITIVE CONTROL on the fixture: the same app as an INSTALL-backed row DOES render its
    // six effective scopes, so `[]` above is a property of the row class and not of a fixture
    // whose intersection is empty anyway.
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([]);
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_acted',
        scope: 'viewer_personal',
        slotId: null,
        targetModelIds: [],
        appBlock: appBlockRow(),
      },
    ]);
    const installed = await listMyScopeGrants(42);
    expect(installed[0].scopes).toHaveLength(6);
  });

  /**
   * 🔴 THE ATTRIBUTION LEG — FIXTURE-ONLY, AND SAID SO RATHER THAN IMPLIED.
   * `block_buzz_attribution` holds ZERO rows in production (measured 2026-09-12,
   * `count(*) = 0`), so this leg cannot be verified against live data at all. It is included
   * because an un-consented BUZZ SPEND is strictly more serious to be invisible than an
   * un-consented read: the leg that matters most is the one with no live data behind it.
   *
   * Red at `origin/main` for the same reason as the invocation case.
   */
  it("🔴 surfaces an app that SPENT the viewer's Buzz with no install and no consent (fixture only)", async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    // Nothing on the invocation leg — so a pass here cannot be explained by that leg.
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([]);
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([attribution('bba_1')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ id: 'apb_spender', blockId: 'sensei', manifest: { name: 'Sensei' } }),
    ]);

    const result = await listMyScopeGrants(42);

    expect(result).toHaveLength(1);
    expect(result[0].appBlockId).toBe('apb_spender');
    expect(result[0].origin).toBe('activity');
    expect(result[0].scopes).toEqual([]);
  });

  it('unions the two activity tables rather than letting either win', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_inv')]);
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([attribution('bba_1', 'apb_att')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ id: 'apb_inv', blockId: 'inv', manifest: { name: 'Aaa Invoker' } }),
      appBlockRow({ id: 'apb_att', blockId: 'att', manifest: { name: 'Bbb Spender' } }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result.map((r) => r.appBlockId)).toEqual(['apb_inv', 'apb_att']);
    // And the batched resolve was asked for BOTH ids — a leg that silently dropped its ids
    // would still produce one card and look half-right.
    const ids = mockDbRead.appBlock.findMany.mock.calls[0][0].where.id.in as string[];
    expect([...ids].sort()).toEqual(['apb_att', 'apb_inv']);
  });

  /**
   * ⚠️ ONE OF THE THREE TESTS IN THIS FILE THAT PASS AT `origin/main`, AND IT PASSES THERE
   * VACUOUSLY — base returns `[]` for every input, so `toEqual([])` is satisfied by the absence
   * of the whole feature rather than by the guard. Labelled rather than counted: this is an
   * invariant guard on the skip behaviour, not regression coverage. Its real coverage is the
   * mutation result recorded in the PR body.
   */
  it('an app whose AppBlock no longer resolves is skipped, not rendered nameless', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_gone')]);
    // `findMany` simply omits a deleted row — the same outcome the other two legs get from
    // their `if (!row.appBlock)` guards.
    mockDbRead.appBlock.findMany.mockResolvedValue([]);
    const result = await listMyScopeGrants(42);
    expect(result).toEqual([]);
  });

  /**
   * ⚠️ THE SECOND VACUOUS-AT-BASE TEST — base never calls `appBlock.findMany` because the leg
   * does not exist, so `not.toHaveBeenCalled()` is trivially true there. It is a cost guard (no
   * batched read on the overwhelmingly common empty sweep), not regression coverage.
   */
  it('does not touch appBlock.findMany when nothing acted on the viewer', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(42);
    expect(mockDbRead.appBlock.findMany).not.toHaveBeenCalled();
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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_acted')]);
    // Deliberately ALSO resolvable by the batched read: a mutant that skipped the `has()` guard
    // would then succeed in overwriting, rather than failing for lack of a row to overwrite.
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(42);

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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(42);

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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    const result = await listMyScopeGrants(42);
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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ manifest: { ...appBlockRow().manifest, name: 'Bbb Acted' } }),
    ]);

    const result = await listMyScopeGrants(42);

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
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n, 'apb_acted')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    const result = await listMyScopeGrants(42);
    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('activity');
    expect(result[0].scopes).toEqual([]);
    expect(result[0].buzzBudgetPerDay).toBeNull();
  });
});

// ── (d) SYNTHETIC DEV-TUNNEL EXCLUSION + the rest of the query shape ────────────────────────

describe('listMyScopeGrants — the activity sweep query', () => {
  /**
   * 🔴 (d) SYNTHETIC DEV-TUNNEL ROWS ARE EXCLUDED. A pre-approval App-Dev-Tunnel call writes
   * `synthetic_app_id` — a developer driving their OWN unpublished app against their OWN
   * account. Surfacing that as "an app you never consented to" would put a permanent scary card
   * on every App Blocks developer's permissions tab. 59 such rows exist in production (measured
   * 2026-09-12), none among the 13 invisible pairs, so the guard has a real data shape behind it.
   */
  it('🔴 excludes synthetic dev-tunnel rows via syntheticAppId: null', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(42);
    const where = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0].where;
    expect(where.syntheticAppId).toBeNull();
    expect(where.userId).toBe(42);
    // Also the null-`appBlockId` exclusion, which is what removes the external-OAuth population
    // (1,031,554 of 1,034,384 rows in production) without naming `source` — filtering on
    // `source` would break this file's pre-migration safety for no extra exclusion.
    expect(where.appBlockId).toEqual({ not: null });
    expect(JSON.stringify(where)).not.toContain('source');
    expect(JSON.stringify(where)).not.toContain('oauthClientId');
  });

  /**
   * The sweep is viewer-scoped on BOTH tables. Asserted separately from the shape above so a
   * leg that forgot `userId` fails with its own message rather than hiding behind the other's.
   */
  it('both activity tables are filtered to the viewer', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(7);
    expect(mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0].where.userId).toBe(7);
    expect(mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0].where).toEqual({ userId: 7 });
  });

  /**
   * 🔴 ALL-TIME: NO TIME BOUND ANYWHERE IN THE SWEEP. This supersedes clawgate #532's own
   * bounded-lookback acceptance criterion (the operator chose unbounded + paging; it is flagged
   * on the card). A lookback window would make an app that last acted on you outside it silently
   * invisible again — the precise defect this change removes — so the absence of a date predicate
   * is a REQUIREMENT, pinned here rather than left to inspection.
   */
  it('🔴 applies NO time bound — the sweep is all-time', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(42);
    for (const delegate of [
      mockDbRead.blockScopeInvocation.findMany,
      mockDbRead.blockBuzzAttribution.findMany,
    ]) {
      const serialised = JSON.stringify(delegate.mock.calls[0][0].where);
      expect(serialised).not.toContain('invokedAt');
      expect(serialised).not.toContain('attributedAt');
      expect(serialised).not.toContain('gte');
      expect(serialised).not.toContain('gt');
    }
  });

  it('orders each sweep by the column pair its index leads on', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(42);
    // `bsi_user_invoked_idx` = (user_id, invoked_at DESC, id DESC) — verified live in pg_indexes.
    expect(mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0].orderBy).toEqual([
      { invokedAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0].orderBy).toEqual([
      { attributedAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  // ── PAGING ──────────────────────────────────────────────────────────────────────────────

  it('stops after ONE page when the first page is short', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n)]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    await listMyScopeGrants(42);
    expect(mockDbRead.blockScopeInvocation.findMany).toHaveBeenCalledTimes(1);
    // First page carries NO cursor — a cursor on page 1 would skip a row.
    expect(mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0].cursor).toBeUndefined();
    expect(mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0].skip).toBeUndefined();
  });

  /**
   * 🔴 A FULL PAGE MUST BE FOLLOWED, AND THE SECOND PAGE MUST RESUME FROM THE LAST ROW'S id.
   * The app that is ONLY on page two is the whole point: a sweep that stopped at one page, or
   * that re-requested page one, would leave it invisible — the defect this change removes, now
   * re-introduced one page deep. `skip: 1` is asserted because a cursor WITHOUT it re-reads the
   * cursor row, which silently halves throughput and, at the tail, never terminates.
   */
  it('🔴 follows a FULL page and resumes from the last id, finding an app only page 2 holds', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      invocation(BigInt(PAGE_SIZE - i), 'apb_page1')
    );
    mockDbRead.blockScopeInvocation.findMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([invocation(0n, 'apb_page2')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ id: 'apb_page1', blockId: 'p1', manifest: { name: 'Aaa Page One' } }),
      appBlockRow({ id: 'apb_page2', blockId: 'p2', manifest: { name: 'Bbb Page Two' } }),
    ]);

    const result = await listMyScopeGrants(42);

    expect(mockDbRead.blockScopeInvocation.findMany).toHaveBeenCalledTimes(2);
    const secondCall = mockDbRead.blockScopeInvocation.findMany.mock.calls[1][0];
    // `page1`'s last element is id 1n (counting down from PAGE_SIZE), which is the cursor.
    expect(secondCall.cursor).toEqual({ id: 1n });
    expect(secondCall.skip).toBe(1);
    // THE PAYOFF: the page-2-only app is in the output.
    expect(result.map((r) => r.appBlockId)).toEqual(['apb_page1', 'apb_page2']);
  });

  it('takes exactly the page size, not page size + 1', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    await listMyScopeGrants(42);
    // The sweep detects exhaustion by a SHORT page, so an off-by-one `take` would make a page
    // that exactly fills look short and stop the walk one page early.
    expect(mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0].take).toBe(PAGE_SIZE);
    expect(mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0].take).toBe(PAGE_SIZE);
  });

  it('pages the attribution leg too, with its own string cursor', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => attribution(`bba_${i}`, 'apb_a'));
    mockDbRead.blockBuzzAttribution.findMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([attribution('bba_last', 'apb_b')]);
    mockDbRead.appBlock.findMany.mockResolvedValue([
      appBlockRow({ id: 'apb_a', blockId: 'a', manifest: { name: 'Aaa' } }),
      appBlockRow({ id: 'apb_b', blockId: 'b', manifest: { name: 'Bbb' } }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(mockDbRead.blockBuzzAttribution.findMany).toHaveBeenCalledTimes(2);
    expect(mockDbRead.blockBuzzAttribution.findMany.mock.calls[1][0].cursor).toEqual({
      id: `bba_${PAGE_SIZE - 1}`,
    });
    expect(result.map((r) => r.appBlockId)).toEqual(['apb_a', 'apb_b']);
  });

  /**
   * 🔴 A TRUNCATED SWEEP IS LOGGED, NOT SILENT. The page ceiling exists so an account with
   * millions of block-token rows cannot turn this page into a DoS, but a truncated sweep
   * UNDER-REPORTS, and an under-report nobody can see is the same defect wearing a different
   * hat. Asserted on the log's own `name`, not merely on "logToAxiom was called" — the service
   * logs under other names too.
   */
  it('🔴 logs when the page ceiling truncates the sweep', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    // Every page full ⇒ the loop can only end at the ceiling.
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue(
      Array.from({ length: PAGE_SIZE }, (_, i) => invocation(BigInt(PAGE_SIZE - i), 'apb_acted'))
    );
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(42);

    const truncation = mockLogToAxiom.mock.calls.find(
      (call) => (call[0] as { name?: string }).name === 'app-surface-activity-sweep-truncated'
    );
    expect(truncation, 'the sweep hit its page ceiling and said nothing').toBeDefined();
    expect(truncation![0]).toMatchObject({
      table: 'block_scope_invocations',
      userId: 42,
      distinctAppsFound: 1,
    });
    // …and the rows it DID find are still returned — a truncated sweep degrades, never throws.
    expect(result).toHaveLength(1);
  });

  /**
   * POSITIVE CONTROL for the assertion above: the ordinary path must NOT log a truncation.
   * Without this, a mutant that logged unconditionally would pass the ceiling test.
   *
   * ⚠️ THE THIRD VACUOUS-AT-BASE TEST, for the same reason as the two above — base logs no
   * truncation because it sweeps nothing. Its value is entirely as this pair's control.
   */
  it('does NOT log a truncation on an ordinary short-page sweep', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocation(10n)]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    await listMyScopeGrants(42);
    expect(
      mockLogToAxiom.mock.calls.filter(
        (call) => (call[0] as { name?: string }).name === 'app-surface-activity-sweep-truncated'
      )
    ).toHaveLength(0);
  });

  /**
   * 🔴 A NULL `appBlockId` REACHING THE ACCUMULATOR IS DROPPED, NOT USED AS A KEY. Added because
   * the guard SURVIVED a mutation sweep: replacing `if (row.appBlockId != null) found.add(...)`
   * with an unconditional `found.add(row.appBlockId as string)` left all 37 tests green, since no
   * fixture fed a null row through the sweep. It is a SEAM guard, not dead code — the `where`
   * above excludes nulls today, so the only way one arrives is a future widening of that
   * predicate, and the consequence is a `null` reaching `appBlock.findMany({ id: { in: [...] } })`
   * and a Map key. The mock makes the state trivially producible, which is exactly why there is
   * no excuse for leaving the guard unexercised.
   */
  it('🔴 drops a null appBlockId rather than keying the map on it', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([
      invocation(11n, null),
      invocation(10n, 'apb_acted'),
    ]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);

    const result = await listMyScopeGrants(42);

    // The batched resolve must be asked for the real id ALONE — a `null` in the `in` list is the
    // observable the guard exists to prevent.
    expect(mockDbRead.appBlock.findMany.mock.calls[0][0].where.id.in).toEqual(['apb_acted']);
    // POSITIVE CONTROL: the resolvable sibling still produces its row, so this is not passing
    // because the whole sweep bailed out.
    expect(result.map((r) => r.appBlockId)).toEqual(['apb_acted']);
  });

  it('de-duplicates an app that appears on many invocation rows', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([
      invocation(12n),
      invocation(11n),
      invocation(10n),
    ]);
    mockDbRead.appBlock.findMany.mockResolvedValue([appBlockRow()]);
    const result = await listMyScopeGrants(42);
    expect(result).toHaveLength(1);
    expect(mockDbRead.appBlock.findMany.mock.calls[0][0].where.id.in).toEqual(['apb_acted']);
  });
});
