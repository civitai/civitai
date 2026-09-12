import { GLOBAL_SCOPE_ACTIVITY_OR } from '~/server/services/blocks/scope-activity-predicate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Orchestration coverage for the W5 v0 reflection surface
 * (`listMyScopeGrants` + `listMyAppActivity`).
 *
 * Mocking strategy mirrors publish-request.orchestration.test.ts — vi.hoisted
 * shared mocks, vi.mock'd db client, default findMany returns [].
 *
 * Post 2026-05-30 kill_per_model_installs migration:
 *   - model_block_installs is gone — every install row is now a
 *     block_user_subscriptions row with slot_id + target_model_ids set
 *     (the "pinned" shape) or both null (the "blanket" shape)
 *   - listMyModelInstalls + setInstallPinnedVersion are removed; the
 *     replacement is setSubscriptionPinnedVersion (keyed on the subscription
 *     id, not blockInstanceId)
 */

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: {
    blockUserSubscription: { findMany: vi.fn(), findUnique: vi.fn() },
    blockBuzzAttribution: { findMany: vi.fn() },
    appBlockPublishRequest: { groupBy: vi.fn(), findFirst: vi.fn() },
    blockScopeInvocation: { findMany: vi.fn() },
    // The consent BUDGET lives on the grant row, which `listMyScopeGrants` now reads to
    // surface the viewer's per-app daily Buzz limit alongside the scopes.
    appUserScopeGrant: { findMany: vi.fn() },
  },
  mockDbWrite: {
    blockUserSubscription: { update: vi.fn() },
    blockScopeInvocation: { create: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  for (const surface of Object.values(mockDbRead)) {
    for (const fn of Object.values(surface)) {
      (fn as unknown as { mockReset: () => void }).mockReset();
    }
  }
  for (const surface of Object.values(mockDbWrite)) {
    for (const fn of Object.values(surface)) {
      (fn as unknown as { mockReset: () => void }).mockReset();
    }
  }
  mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
  mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([]);
  mockDbRead.appBlockPublishRequest.groupBy.mockResolvedValue([]);
  mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([]);
  // Default: no grant rows ⇒ every app reports `buzzBudgetPerDay: null`, which is the
  // pre-column behaviour and what the existing expectations below assume.
  mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([]);
  mockDbWrite.blockUserSubscription.update.mockResolvedValue({});
  mockDbWrite.blockScopeInvocation.create.mockResolvedValue({});
});

// ---- listMyScopeGrants -----------------------------------------------------

describe('listMyScopeGrants', () => {
  function appBlock(over: Record<string, unknown> = {}) {
    return {
      id: 'apb_1',
      blockId: 'hello',
      manifest: { name: 'Hello World', scopes: ['user:read:self'] },
      approvedScopes: ['user:read:self'],
      ...over,
    };
  }

  /** Pinned subscription row — what used to be a model_block_installs row. */
  function pinnedSub(over: Record<string, unknown> = {}) {
    return {
      appBlockId: 'apb_1',
      scope: 'publisher_all_my_models',
      slotId: 'model.sidebar_top',
      targetModelIds: [100],
      appBlock: appBlock(),
      ...over,
    };
  }

  /** Blanket subscription row — the historical bus_* shape. */
  function blanketSub(over: Record<string, unknown> = {}) {
    return {
      appBlockId: 'apb_1',
      scope: 'viewer_personal',
      slotId: null,
      targetModelIds: [],
      appBlock: appBlock(),
      ...over,
    };
  }

  it('returns empty array when the user has no installs and no subscriptions', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const result = await listMyScopeGrants(42);
    expect(result).toEqual([]);
  });

  it('aggregates 2 pinned installs + 1 blanket subscription for the same app into a single row', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({ targetModelIds: [100, 101] }), // 2 pinned models in one row
      blanketSub(),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result).toHaveLength(1);
    expect(result[0].appBlockId).toBe('apb_1');
    expect(result[0].surfaces.modelInstallCount).toBe(2);
    expect(result[0].surfaces.subscriptionScopes).toEqual(['viewer_personal']);
  });

  // ── The CONSENT BUDGET the viewer set for this app. It lives on the grant row, not on
  // the subscription rows this function aggregates, so it is a separate read — and its
  // guards must mirror `getConsentBuzzBudget` exactly, or the permissions page would show
  // a limit the SPEND path does not enforce (or hide one it does).
  it('surfaces the consent budget from the grant row', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      { appBlockId: 'apb_1', buzzBudgetPerDay: 750, revokedAt: null },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].buzzBudgetPerDay).toBe(750);
    // 🔴 THIS ASSERTION USED TO REQUIRE `appBlockId: { in: [...] }`, AND THAT BOUND WAS
    // THE DEFECT — it is deliberately inverted, not deleted. Filtering the grant read by
    // the INSTALL set meant a grant for a never-installed app was never queried, so the
    // budget editor could not render for it (see the service docblock). The read is now
    // keyed on `userId` alone, which is the same `(user_id, app_block_id)` index with a
    // cheaper predicate and is bounded by the viewer's own grant count.
    expect(mockDbRead.appUserScopeGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42 } })
    );
  });

  /**
   * 🔴 THE GRANT-ONLY APP. This is the regression the whole change exists for, and the
   * shape that shipped broken: a full-page app at `/apps/run/<slug>` is CONSENTED to,
   * never installed, so it has a live `app_user_scope_grants` row and NO
   * `block_user_subscriptions` row. Aggregating installs alone returned `[]`, the
   * permissions panel rendered "No apps installed or subscribed yet.", and
   * `AppBudgetControl` — which renders only from these rows — never appeared. The user
   * could consent, generate and SPEND with no surface on which to bound it.
   *
   * Measured in production 2026-09-11: 4 subscription rows platform-wide against 29
   * grants, so this was very nearly every consenting user rather than an edge case.
   *
   * RED AT BASE: on the pre-change service every assertion below fails at the first —
   * `result` is `[]`, because `byAppBlock` is built from subscriptions and the grant
   * read is filtered to its keys.
   */
  it('🔴 surfaces an app the viewer GRANTED but never installed, with its budget control data', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    // No installs, no subscriptions — the full-page-app shape.
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_9',
        buzzBudgetPerDay: 1200,
        revokedAt: null,
        grantedScopes: ['ai:write:budgeted', 'buzz:read:self'],
        appBlock: appBlock({
          id: 'apb_9',
          blockId: 'sensei',
          manifest: { name: 'Sensei', scopes: ['ai:write:budgeted'] },
          approvedScopes: ['ai:write:budgeted'],
        }),
      },
    ]);

    const result = await listMyScopeGrants(42);

    expect(result).toHaveLength(1);
    expect(result[0].appBlockId).toBe('apb_9');
    expect(result[0].slug).toBe('sensei');
    expect(result[0].name).toBe('Sensei');
    // The two fields the budget editor keys off. Without BOTH, the control does not
    // render even when the row exists.
    expect(result[0].spendScopeGranted).toBe(true);
    expect(result[0].buzzBudgetPerDay).toBe(1200);
    // Honest surface counts — it really is installed nowhere.
    expect(result[0].surfaces.modelInstallCount).toBe(0);
    expect(result[0].surfaces.subscriptionScopes).toEqual([]);
  });

  /**
   * The grant leg must not CLOBBER the subscription leg for an app that has both —
   * a plain `set()` would zero the install counts. Distinct non-zero fixture values
   * (2 pinned models, a blanket scope) so a mutant that resets either one is visible.
   */
  it('keeps install/subscription counts for an app that has BOTH a grant and installs', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({ targetModelIds: [100, 101] }),
      blanketSub(),
    ]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        buzzBudgetPerDay: 300,
        revokedAt: null,
        grantedScopes: ['ai:write:budgeted'],
        appBlock: appBlock(),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result).toHaveLength(1);
    expect(result[0].surfaces.modelInstallCount).toBe(2);
    expect(result[0].surfaces.subscriptionScopes).toEqual(['viewer_personal']);
    expect(result[0].buzzBudgetPerDay).toBe(300);
  });

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled so nobody counts it as the
   * latter. Nothing in this repo writes a non-null `revoked_at`, so this state is not
   * currently reachable in production. It pins the intent that a revoked grant conveys
   * nothing: it must not mint a row whose only reason to exist is a consent that was
   * withdrawn, which would offer a budget control for an app that cannot spend.
   */
  it('does NOT surface a grant-only app whose grant is revoked (invariant guard)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_9',
        buzzBudgetPerDay: 1200,
        revokedAt: new Date('2026-01-01T00:00:00Z'),
        grantedScopes: ['ai:write:budgeted'],
        appBlock: appBlock({ id: 'apb_9', blockId: 'sensei' }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result).toEqual([]);
  });

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — and an earlier draft of this docblock got
   * the mechanism wrong, so the correction is recorded rather than quietly swapped. It said
   * "a `Restrict`-deleted app". The relation is `onDelete: Cascade` and REQUIRED
   * (`packages/civitai-db-schema/prisma/schema.full.prisma`), with no `relationMode`
   * override, so Postgres deletes the grant row along with its AppBlock instead of orphaning
   * it: this state is not reachable in production. The subscription leg's
   * `if (!row.appBlock) continue` is unreachable for the same reason — precedent for the
   * shape, not evidence that the state occurs.
   *
   * What it pins is the intent that an unresolvable row is SKIPPED rather than rendered as a
   * card with no name, which is what the manifest-or-blockId fallback would otherwise produce.
   */
  it('skips a grant-only row whose AppBlock does not resolve', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_gone',
        buzzBudgetPerDay: 500,
        revokedAt: null,
        grantedScopes: ['ai:write:budgeted'],
        appBlock: null,
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result).toEqual([]);
  });

  it('reports null when the app has no grant row', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([]);
    const result = await listMyScopeGrants(42);
    expect(result[0].buzzBudgetPerDay).toBeNull();
  });

  it('reports null for a REVOKED grant, matching what the spend path enforces', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      { appBlockId: 'apb_1', buzzBudgetPerDay: 750, revokedAt: new Date() },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].buzzBudgetPerDay).toBeNull();
  });

  // A non-positive stored value would become a cap of 0 at the spend path, where
  // `total > 0` denies everything. Both sides treat it as "no budget"; this pins that
  // they agree rather than each guessing.
  it('reports null for a non-positive stored budget', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      { appBlockId: 'apb_1', buzzBudgetPerDay: 0, revokedAt: null },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].buzzBudgetPerDay).toBeNull();
  });

  // ── `spendScopeGranted` — whether the viewer's GRANT actually carries
  // `ai:write:budgeted`. The budget editor on /apps/activity keys off this, and it is
  // NOT derivable from `scopes` (which is the app's APPROVED set, i.e. what the mint will
  // issue a token for). Offering a limit control off the approved set would render a field
  // the server silently drops, because `grantScopes` ignores a budget for an app that does
  // not hold the spend scope.
  it('spendScopeGranted is TRUE when the GRANT row carries ai:write:budgeted', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        buzzBudgetPerDay: 750,
        revokedAt: null,
        grantedScopes: ['user:read:self', 'ai:write:budgeted'],
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].spendScopeGranted).toBe(true);
  });

  // 🔴 THE DISCRIMINATING CASE: the app is APPROVED for the spend scope (and declares it in
  // its manifest), and the user has NOT granted it. Deriving `spendScopeGranted` from either
  // of those app-side sets would answer `true` here.
  it('spendScopeGranted is FALSE when only the APP (manifest + approval) carries the spend scope', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello', scopes: ['ai:write:budgeted'] },
          approvedScopes: ['ai:write:budgeted'],
        }),
      }),
    ]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        buzzBudgetPerDay: null,
        revokedAt: null,
        grantedScopes: ['user:read:self'], // the user granted something else
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual(['ai:write:budgeted']); // the app is approved for it…
    expect(result[0].spendScopeGranted).toBe(false); // …the grant says no
  });

  it('spendScopeGranted is FALSE for a REVOKED grant (mirrors getGrantedScopes)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        buzzBudgetPerDay: 750,
        revokedAt: new Date(),
        grantedScopes: ['ai:write:budgeted'],
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].spendScopeGranted).toBe(false);
  });

  it('spendScopeGranted is FALSE when the app has no grant row at all', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockResolvedValue([]);
    const result = await listMyScopeGrants(42);
    expect(result[0].spendScopeGranted).toBe(false);
  });

  // ── PRE-MIGRATION. `buzz_budget_per_day` may not exist yet (migrations are applied by
  // hand, per environment). The permissions page must still render: with no column, no
  // budget can have been set, so "none" is the TRUE state and it is what the spend path
  // enforces in that same database.
  it('renders with NO budgets when the column does not exist yet (P2022)', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockRejectedValue(
      Object.assign(new Error('column does not exist'), { code: 'P2022' })
    );
    const result = await listMyScopeGrants(42);
    expect(result).toHaveLength(1);
    expect(result[0].buzzBudgetPerDay).toBeNull();
    expect(result[0].spendScopeGranted).toBe(false);
  });

  // 🔴 And ONLY that code. A bare catch would render "no limits set" whenever the DB is
  // unreachable — a lie about the user's own settings, on the page whose whole job is to
  // report them.
  it('RETHROWS any other DB error rather than reporting "no limits"', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    mockDbRead.appUserScopeGrant.findMany.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'P1001' })
    );
    await expect(listMyScopeGrants(42)).rejects.toThrow(/connection refused/);
  });

  // ── WHICH SET IS DISPLAYED. `scopes` is `AppBlock.approved_scopes` — the pinned,
  // mod-reviewed set the MINT issues tokens for ("The mint sources scopes from
  // `approvedScopes` (the pinned, mod-reviewed set — NEVER the raw manifest)",
  // `block-registry.service.ts`) — and NEVER `manifest.scopes`, which is only the dev's
  // stated wishlist. The four tests below pin that, including both directions of the
  // divergence the swap exists for.

  it('reads scopes from approvedScopes, NOT the joined manifest.scopes', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello', scopes: ['ai:write:budgeted', 'buzz:read:self'] },
          approvedScopes: ['models:read:self'],
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual(['models:read:self']);
  });

  // 🔴 THE DISCRIMINATING CASE for this change: the manifest is a STRICT SUPERSET of the
  // approval, i.e. a moderator narrowed what the app may actually do. The displayed set must
  // be the narrow one, because that is the only one the mint will honour. Every value here is
  // pairwise distinct and distinct from the constant the assertion names, so a mutant that
  // hardcodes a literal cannot survive.
  it('shows ONLY the approved set when the manifest declares a strict superset', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: {
            name: 'Hello',
            scopes: ['ai:write:budgeted', 'buzz:read:self', 'collections:read:private'],
          },
          approvedScopes: ['buzz:read:self'],
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual(['buzz:read:self']);
  });

  // 🔴 NO FALLBACK. An app approved for NOTHING displays nothing, even though its manifest
  // still asks for things — a fallback here would restore the whole over-report, in exactly
  // the case that matters most.
  it('emits an empty scopes array for an EMPTY approval, never falling back to the manifest', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello', scopes: ['models:read:self', 'images:write:self'] },
          approvedScopes: [],
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual([]);
  });

  // ⚠️ THE NEXT TWO ARE INVARIANT GUARDS, NOT REGRESSION COVERAGE — labelled as such rather
  // than counted. Prisma types `approvedScopes` as `string[]`, so nothing in this codebase
  // can produce either shape; they pin the JSON/DB-boundary defensiveness at the read site
  // so a later "the type says string[], drop the guard" edit fails instead of shipping a
  // non-string into a `<Badge>` key and a scope-description lookup.
  it('drops non-string elements from a malformed approvedScopes array', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello', scopes: ['models:read:self'] },
          approvedScopes: [null, 'buzz:read:self', 42, undefined, 'collections:read:private'],
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual(['buzz:read:self', 'collections:read:private']);
  });

  // The fixture is a non-null SCALAR on purpose: `null` alone cannot distinguish the
  // `Array.isArray` guard from a weaker `(x ?? []).filter(…)`, because `null ?? []` also
  // yields `[]`. A bare string is the realistic JSON-column mishap AND it makes the weaker
  // shape throw `.filter is not a function`, so this case pins the guard rather than the
  // nullishness.
  it('emits an empty scopes array when approvedScopes is not an array at all', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello', scopes: ['models:read:self'] },
          approvedScopes: 'buzz:read:self',
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual([]);
  });

  it('emits an empty scopes array when neither manifest nor approvedScopes carry scopes', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello' },
          approvedScopes: [],
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual([]);
  });

  it('sorts rows by app name ascending', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      blanketSub({
        appBlockId: 'apb_z',
        appBlock: appBlock({ id: 'apb_z', blockId: 'z', manifest: { name: 'Zeta' } }),
      }),
      blanketSub({
        appBlockId: 'apb_a',
        appBlock: appBlock({ id: 'apb_a', blockId: 'a', manifest: { name: 'Alpha' } }),
      }),
      blanketSub({
        appBlockId: 'apb_m',
        appBlock: appBlock({ id: 'apb_m', blockId: 'm', manifest: { name: 'Mu' } }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result.map((r) => r.name)).toEqual(['Alpha', 'Mu', 'Zeta']);
  });

  it('falls back to slug for name when manifest.name is missing', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({ blockId: 'hello-world', manifest: { scopes: [] } }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].name).toBe('hello-world');
  });

  it('captures both subscription scopes when an app is subscribed under both', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      blanketSub({ scope: 'publisher_all_my_models' }),
      blanketSub({ scope: 'viewer_personal' }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].surfaces.subscriptionScopes).toEqual([
      'publisher_all_my_models',
      'viewer_personal',
    ]);
    // modelInstallCount=0 when there are no pinned subs (just blanket).
    expect(result[0].surfaces.modelInstallCount).toBe(0);
  });

  it('surfaces iconUrl when manifest carries one', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      pinnedSub({
        appBlock: appBlock({
          manifest: { name: 'Hello', iconUrl: 'https://cdn.example/icon.png' },
        }),
      }),
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].iconUrl).toBe('https://cdn.example/icon.png');
  });

  it('omits iconUrl when manifest does not declare one', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([pinnedSub()]);
    const result = await listMyScopeGrants(42);
    expect(result[0].iconUrl).toBeUndefined();
  });
});

// ---- listMyAppActivity -----------------------------------------------------

describe('listMyAppActivity', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'bba_1',
      attributedAt: new Date('2026-05-28T10:00:00Z'),
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'per_model_install',
      usdAmountCents: 199,
      status: 'pending',
      appBlock: { blockId: 'hello', manifest: { name: 'Hello World' } },
      ...over,
    };
  }

  it('returns empty page when there are no rows', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    const result = await listMyAppActivity({ userId: 42 });
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it('filters by the spender userId', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42 });
    expect(mockDbRead.blockBuzzAttribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42 } })
    );
  });

  it('server-filters by appBlockId when the per-app drill-down is passed', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, appBlockId: 'apb_1' });
    expect(mockDbRead.blockBuzzAttribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42, appBlockId: 'apb_1' } })
    );
  });

  it('joins the AppBlock and exposes appName + appSlug per item', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ appBlock: { blockId: 'gen-from-model', manifest: { name: 'Generate' } } }),
    ]);
    const result = await listMyAppActivity({ userId: 42 });
    expect(result.items[0].appName).toBe('Generate');
    expect(result.items[0].appSlug).toBe('gen-from-model');
  });

  it('falls back to blockId when manifest.name missing', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ appBlock: { blockId: 'gen-from-model', manifest: {} } }),
    ]);
    const result = await listMyAppActivity({ userId: 42 });
    expect(result.items[0].appName).toBe('gen-from-model');
  });

  /**
   * 🔴 THIS TEST USED TO ASSERT `appSlug` FELL BACK TO `appBlockId`, AND THAT EXPECTATION
   * WAS THE DEFECT WRITTEN DOWN. `appBlockId` is the FOREIGN KEY — the AppBlock's `id` —
   * while `appSlug` is consumed as a store slug: `ActivityAppName` builds
   * `/apps/store-preview/<slug>` from it, and `AppListing.slug` mirrors
   * `AppBlock.blockId`, never the id. So the "defensive" fallback handed the UI a primary
   * key dressed as a slug and produced a link that can only 404 — offered precisely on
   * the rows where the app is least resolvable.
   *
   * The two halves are now deliberately DIFFERENT, which is the whole point:
   *   • `appName` keeps the fallback — a display string with no navigational meaning.
   *   • `appSlug` goes NULL — there is no listing to link to, and the consumer renders
   *     plain text (`AppNameCrumb`'s rule, applied at the source).
   */
  it('🔴 appSlug is NULL when the appBlock relation is null — never the primary key', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ appBlock: null, appBlockId: 'apb_x' }),
    ]);
    const result = await listMyAppActivity({ userId: 42 });
    // The DISPLAY name still degrades to an identifier rather than to nothing.
    expect(result.items[0].appName).toBe('apb_x');
    expect(
      result.items[0].appSlug,
      'the AppBlock PRIMARY KEY was emitted as a store slug — /apps/store-preview/<pk> 404s'
    ).toBeNull();
  });

  it('orderBy is createdAt desc + id desc tiebreak', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual([{ attributedAt: 'desc' }, { id: 'desc' }]);
  });

  it('fetches limit + 1 to detect next page', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, limit: 10 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.take).toBe(11);
  });

  it('drops the trailing row when limit + 1 are returned and surfaces nextCursor', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ id: 'bba_1' }),
      row({ id: 'bba_2' }),
      row({ id: 'bba_3' }), // the trailing has-next indicator
    ]);
    const result = await listMyAppActivity({ userId: 42, limit: 2 });
    expect(result.items.map((i) => i.id)).toEqual(['bba_1', 'bba_2']);
    expect(result.nextCursor).toBe('bba_2');
  });

  it('returns nextCursor=null when fewer than limit + 1 rows come back', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([row({ id: 'bba_1' })]);
    const result = await listMyAppActivity({ userId: 42, limit: 10 });
    expect(result.items.map((i) => i.id)).toEqual(['bba_1']);
    expect(result.nextCursor).toBeNull();
  });

  it('cursor + skip:1 are forwarded to Prisma when caller supplies a cursor', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, limit: 5, cursor: 'bba_99' });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 'bba_99' });
    expect(arg.skip).toBe(1);
    expect(arg.take).toBe(6);
  });

  it('caps limit at 100 even when caller asks for more', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, limit: 5000 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.take).toBe(101); // 100 cap + 1
  });

  it('defaults limit to 25 when not supplied', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.take).toBe(26);
  });
});

// ---- W5 v0.5: setSubscriptionPinnedVersion ---------------------------------

describe('setSubscriptionPinnedVersion', () => {
  it('rejects when the subscription does not exist', async () => {
    const { setSubscriptionPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findUnique.mockResolvedValue(null);
    await expect(
      setSubscriptionPinnedVersion({ userId: 42, subscriptionId: 'bus_missing', version: null })
    ).rejects.toThrow('subscription not found');
  });

  it('rejects when the caller is not the subscription owner', async () => {
    const { setSubscriptionPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findUnique.mockResolvedValue({
      id: 'bus_1',
      appBlockId: 'apb_1',
      userId: 99,
    });
    await expect(
      setSubscriptionPinnedVersion({ userId: 42, subscriptionId: 'bus_1', version: null })
    ).rejects.toThrow('not the subscription owner');
  });

  it('rejects when the version is not an approved release', async () => {
    const { setSubscriptionPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findUnique.mockResolvedValue({
      id: 'bus_1',
      appBlockId: 'apb_1',
      userId: 42,
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    await expect(
      setSubscriptionPinnedVersion({ userId: 42, subscriptionId: 'bus_1', version: '9.9.9' })
    ).rejects.toThrow('not an approved release');
  });

  it('clears the pin when version is null without checking publish_requests', async () => {
    const { setSubscriptionPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findUnique.mockResolvedValue({
      id: 'bus_1',
      appBlockId: 'apb_1',
      userId: 42,
    });
    await setSubscriptionPinnedVersion({ userId: 42, subscriptionId: 'bus_1', version: null });
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockDbWrite.blockUserSubscription.update).toHaveBeenCalledWith({
      where: { id: 'bus_1' },
      data: { pinnedVersion: null },
    });
  });

  it('writes the pin when the version is approved', async () => {
    const { setSubscriptionPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findUnique.mockResolvedValue({
      id: 'bus_1',
      appBlockId: 'apb_1',
      userId: 42,
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pubreq_1' });
    const result = await setSubscriptionPinnedVersion({
      userId: 42,
      subscriptionId: 'bus_1',
      version: '0.2.1',
    });
    expect(result).toEqual({ ok: true });
    expect(mockDbWrite.blockUserSubscription.update).toHaveBeenCalledWith({
      where: { id: 'bus_1' },
      data: { pinnedVersion: '0.2.1' },
    });
  });
});

// ---- W5 v0.5: listMyScopeInvocations --------------------------------------

describe('listMyScopeInvocations', () => {
  function invocationRow(over: Record<string, unknown> = {}) {
    return {
      id: 100n,
      invokedAt: new Date('2026-05-30T12:00:00Z'),
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'user:read:self',
      endpoint: '/api/v1/blocks/me',
      statusCode: 200,
      appBlock: { blockId: 'who-am-i', manifest: { name: 'Who Am I' } },
      ...over,
    };
  }

  it('returns empty page when there are no invocations', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    const result = await listMyScopeInvocations({ userId: 42 });
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it('serialises BigInt id to string for JSON safety', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocationRow({ id: 12345n })]);
    const result = await listMyScopeInvocations({ userId: 42 });
    expect(result.items[0].id).toBe('12345');
  });

  it('caps limit at 100 even when caller asks for more', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42, limit: 9999 });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.take).toBe(101);
  });

  it('passes appBlockId filter through to the query', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42, appBlockId: 'apb_target' });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: 42, appBlockId: 'apb_target' });
  });

  // Unified scope-usage audit: the GLOBAL feed (no appBlockId) must keep app-block
  // AND pre-approval dev-tunnel SYNTHETIC rows (appBlockId null + syntheticAppId
  // set) while excluding ONLY external-OAuth rows (appBlockId null + syntheticAppId
  // null). It filters on the two PRE-EXISTING columns so the read is safe before
  // the `source`/`oauth_client_id` migration is applied. This assertion FAILS under
  // the earlier `appBlockId: { not: null }`-only filter, which silently dropped the
  // dev's own synthetic rows.
  it('global feed keeps app-block + synthetic rows, excludes only external-OAuth', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42 });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    // 🔴 IDENTITY FIRST — the feed's half of the guard the probe now carries. `toEqual`
    // against the literal below cannot distinguish "spread the shared constant" from
    // "re-spelled the same clause here", and an audit walked exactly that ambiguity on the
    // probe side (67/67 green over a divergent copy). `toBe` on the array reference can only
    // pass if what reached Prisma IS the exported object.
    expect(
      arg.where.OR,
      'the feed did not pass the SHARED predicate to Prisma — it re-spelled its own copy'
    ).toBe(GLOBAL_SCOPE_ACTIVITY_OR.OR);

    expect(arg.where).toEqual({
      userId: 42,
      // app-block row (appBlockId set) → matched by predicate 1;
      // synthetic dev-tunnel row (appBlockId null, syntheticAppId set) → predicate 2;
      // external-OAuth row (both null) → matched by NEITHER, so excluded.
      OR: [{ appBlockId: { not: null } }, { syntheticAppId: { not: null } }],
    });
    // Pre-migration safety: the read must NOT reference the new columns.
    expect(JSON.stringify(arg.where)).not.toContain('source');
    expect(JSON.stringify(arg.where)).not.toContain('oauthClientId');
  });

  it('global feed INCLUDES a synthetic dev-tunnel row (appBlockId null, syntheticAppId set)', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    // A pre-approval dev-tunnel invocation: no AppBlock row, synthetic ref set.
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([
      invocationRow({
        id: 7n,
        appBlockId: null,
        appBlock: null,
        syntheticAppId: 'ephemeral-my-app',
      }),
    ]);
    const result = await listMyScopeInvocations({ userId: 42 });
    // The mapper returns the row (does not crash on a null appBlockId) — it is
    // present in the dev's own audit feed, restoring the pre-PR behaviour.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('7');
    // 🔴 …AND ITS `appSlug` IS NULL, NOT THE PRIMARY KEY. This is the LIVE instance of
    // the fallback defect, not a defensive one: a synthetic dev-tunnel row genuinely has
    // no AppBlock, so `?? r.appBlockId` used to emit an id (or, here, `null`'s
    // stand-in) into a value the UI turns into `/apps/store-preview/<slug>`. There is no
    // listing for a pre-approval app, so there must be no link. See "the appSlug
    // contract" in the service.
    expect(result.items[0].appSlug).toBeNull();
  });

  it('🔴 appSlug is NULL when the AppBlock join fails on a row that HAS an appBlockId', async () => {
    // The other shape: `appBlockId` is set (a real FK) but the relation did not resolve.
    // The old fallback emitted that FK — an `AppBlock.id` — as the store slug. Split from
    // the synthetic case above so each dies for its own reason.
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([
      invocationRow({ id: 8n, appBlockId: 'apb_orphan', appBlock: null }),
    ]);
    const result = await listMyScopeInvocations({ userId: 42 });
    expect(result.items[0].appSlug).toBeNull();
    // POSITIVE CONTROL for the assertion above: a resolvable row DOES carry its slug, so
    // "null" is not simply what this feed always returns.
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocationRow({ id: 9n })]);
    expect((await listMyScopeInvocations({ userId: 42 })).items[0].appSlug).toBe('who-am-i');
  });

  it('emits a nextCursor when the page is full and silently ignores a malformed inbound cursor', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    // 1 more row than limit → hasNext + nextCursor is the last visible id.
    const rows = Array.from({ length: 3 }, (_, i) => invocationRow({ id: BigInt(100 - i) }));
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue(rows);
    const result = await listMyScopeInvocations({
      userId: 42,
      limit: 2,
      cursor: 'not-a-bigint',
    });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('99'); // last visible row's id
    // Defensive cursor handling: bad cursor is treated as "no cursor", not an error.
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.cursor).toBeUndefined();
  });

  it('uses BigInt cursor when caller provides a valid numeric string', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42, cursor: '12345' });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 12345n });
    expect(arg.skip).toBe(1);
  });
});

// ---- W5 v0.5: recordScopeInvocation ---------------------------------------

describe('recordScopeInvocation', () => {
  it('inserts a row with the expected shape', async () => {
    const { recordScopeInvocation } = await import('../user-app-surface.service');
    await recordScopeInvocation({
      userId: 42,
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'user:read:self',
      endpoint: '/api/v1/blocks/me',
      statusCode: 200,
    });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        appBlockId: 'apb_1',
        blockInstanceId: 'bki_1',
        scope: 'user:read:self',
        endpoint: '/api/v1/blocks/me',
        statusCode: 200,
      },
    });
  });

  it('clamps a runaway endpoint string to 512 chars', async () => {
    const { recordScopeInvocation } = await import('../user-app-surface.service');
    const huge = '/x/'.repeat(1000);
    await recordScopeInvocation({
      userId: 42,
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 's',
      endpoint: huge,
      statusCode: 200,
    });
    const arg = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0];
    expect(arg.data.endpoint.length).toBe(512);
  });

  it('swallows db errors so the request lifecycle is not affected', async () => {
    const { recordScopeInvocation } = await import('../user-app-surface.service');
    mockDbWrite.blockScopeInvocation.create.mockRejectedValueOnce(new Error('FK violation'));
    // Must not throw — caller is `res.on('finish')` and has no error handler.
    await expect(
      recordScopeInvocation({
        userId: 42,
        appBlockId: 'apb_deleted',
        blockInstanceId: 'bki_1',
        scope: 's',
        endpoint: '/x',
        statusCode: 200,
      })
    ).resolves.toBeUndefined();
  });
});
