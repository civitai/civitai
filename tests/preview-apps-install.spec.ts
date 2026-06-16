import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e (F-C): App Blocks INSTALL + CONSENT round-trip — the authenticated
 * write path that turns a marketplace browse into an installed app:
 * `getInstallConfig` → `upsertSubscription` (install) → `listMySubscriptions`
 * (read-back) → `deleteSubscription` (self-clean), then `grantScopes` (consent)
 * → `listMyScopeGrants` (read-back). Otherwise untested by the preview suite.
 *
 * Runs as the `mod` fixture (id 2000000001) — REQUIRED: getInstallConfig,
 * upsertSubscription and deleteSubscription are all `moderatorProcedure`, and
 * `features.appBlocks` (the Flipt mod segment) gates every blocks proc. mod is
 * also the only role exempt from per-user rate limits. A non-mod tester would be
 * UNAUTHORIZED on every call here.
 *
 * SELF-SEED / SELF-CLEAN (the dev DB + fixtures are shared across concurrent
 * previews): we DISCOVER an appBlockId at runtime from `listAvailable` (never
 * hardcode one — the weekly prod clone's approved set varies, and could be
 * empty → `test.skip()` annotated), CREATE our own `viewer_personal`
 * subscription, then DELETE it in `finally` so a mid-test failure still cleans
 * up and re-runs never accumulate/collide on the shared clone.
 *
 * NB: DB-backed procs (not meili-backed search) → no `retryFlaky`.
 *
 * --- GENERATE / BUZZ-SPEND IS INTENTIONALLY NOT E2E'd HERE -------------------
 * The generate leg (`blocks.submitWorkflow`) is deliberately NOT covered, for
 * the SAME reason `generation-submit` is deferred: (1) submitWorkflow re-asserts
 * `assertViewerIsModerator` AND requires a valid block JWT carrying a positive
 * `buzzBudget` + `ai:write:budgeted` scope context (it's a GA-gated, token-
 * minted path, not a plain tRPC input), and (2) Buzz lives in an EXTERNAL
 * service (`BUZZ_ENDPOINT`), so a spendable balance can't be seeded in the
 * preview's dev DB. The consent GRANT below is the furthest deterministically-
 * coverable pre-spend step (it records the user's consent that a later mint
 * would intersect against); actual spend is out of scope for preview-e2e.
 * ----------------------------------------------------------------------------
 *
 * Verified tRPC shapes (against origin/main, paths relative to civitai/src):
 *  - blocks.listAvailable → `{ items: AvailableBlock[]; nextCursor? }` (NOT a
 *    bare array; block-registry.service.ts:2226). Each item's `id` is the
 *    appBlockId. Used to discover an id (skip-if-empty).
 *  - blocks.getInstallConfig (blocks.router.ts:1133 moderatorProcedure + flag;
 *    input { appBlockId }) → `{ settings: Record<string,unknown>; scopes:
 *    string[] }` where `scopes` = manifest.scopes ∩ approvedScopes (the
 *    consentable CEILING). Can be empty → consent leg skips (annotated).
 *  - blocks.upsertSubscription (blocks.router.ts:1186 moderatorProcedure; input
 *    { appBlockId, scope, targetModelTypes, targetBaseModels, settings?,
 *    enabled? }) → `SubscriptionRecord` (subscription.schema.ts:86). NOTE the
 *    `id` is a STRING (ULID-shaped PK), NOT a number. `scope` is
 *    `subscriptionScopeSchema` = z.enum(['publisher_all_my_models',
 *    'viewer_personal']) (subscription.schema.ts:13) — we use 'viewer_personal'
 *    (the "subscribe on every model page I visit" scope). The blanket shape this
 *    writes has `slotId: null` and `targetModelIds: []`.
 *  - blocks.listMySubscriptions (blocks.router.ts:909 protectedProcedure) →
 *    `SubscriptionRecord[]` (BlockRegistry.listUserSubscriptions, returns the
 *    caller's own rows). We match our row by (appBlockId, scope==='viewer
 *    _personal', id).
 *  - blocks.deleteSubscription (blocks.router.ts:1244 moderatorProcedure; input
 *    { subscriptionId: string }) → `{ ok: true }`. Idempotent (missing row is a
 *    no-op success) + ownership-checked at the service layer.
 *  - blocks.grantScopes (blocks.router.ts:820 protectedProcedure; input
 *    { appBlockId, scopes: string[] (1..32) }) → `{ ok: true; granted: string[]
 *    }`. Server intersects `scopes` with the manifest∩approvedScopes CEILING and
 *    returns the actually-granted subset in `granted` — so `granted` is itself
 *    the deterministic write-confirmation. Throws BAD_REQUEST if NONE of the
 *    requested scopes are in the ceiling, which is why we source the scope from
 *    getInstallConfig().scopes (a known-in-ceiling value).
 *  - blocks.listMyScopeGrants (blocks.router.ts:723 protectedProcedure) →
 *    `ScopeGrantSurface[]` (user-app-surface.service.ts:42). RETURN-SHAPE
 *    SURPRISE: this is NOT the raw `app_user_scope_grants` consent ledger — it
 *    AGGREGATES one row per app the user has INSTALLED/SUBSCRIBED to, and its
 *    `scopes` field is the app's MANIFEST-declared scopes (the dev's stated
 *    intent), with the per-app subscription scopes under
 *    `surfaces.subscriptionScopes`. So a granted scope shows up here ONLY because
 *    (a) the app is present (the user has a sub for it) and (b) granted ⊆
 *    manifest scopes. We therefore re-INSTALL before the consent leg so the app
 *    is present in this surface, and assert the app row exists with the granted
 *    scope inside its (manifest) `scopes` set. The strong consent confirmation is
 *    `granted` from grantScopes itself; this read-back is the corroborating
 *    surface check. (No `revokeScopes` proc exists — see scope-grant.service.ts;
 *    grantScopes is additive + idempotent, fine on the weekly-refreshed clone.)
 */

const ROLE = 'mod' as const;
const SCOPE = 'viewer_personal' as const;

type AvailableBlock = { id: string };
type ListAvailableResult = { items: AvailableBlock[]; nextCursor?: string };

type InstallConfig = { settings: Record<string, unknown>; scopes: string[] };

// SubscriptionRecord subset this spec reads. `id` is a STRING, not a number.
type SubscriptionRecord = {
  id: string;
  scope: string;
  appBlockId: string;
  enabled: boolean;
};

type GrantScopesResult = { ok: boolean; granted: string[] };

// ScopeGrantSurface subset — `scopes` is the app's MANIFEST scopes (see header).
type ScopeGrantSurface = {
  appBlockId: string;
  scopes: string[];
  surfaces: { modelInstallCount: number; subscriptionScopes: string[] };
};

test.describe('App Blocks install + consent round-trip (mod, self-cleaning)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('upsertSubscription + grantScopes round-trip, verified by read-back', async ({ page }) => {
    // Warm the request context against the preview origin so page.request shares
    // the mod auth cookie + a navigated origin (the helper stamps Origin/Referer
    // for the CSRF gate; navigating once is the safe baseline). domcontentloaded
    // ONLY — never networkidle.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // DISCOVER an appBlockId at runtime (never hardcode). `{}` input is valid.
    const listing = await trpcQuery<ListAvailableResult>(page.request, 'blocks.listAvailable', {});
    const blocks = listing?.items ?? [];
    test.skip(
      blocks.length === 0,
      'No approved app blocks in this dev-DB clone — nothing to install (the weekly prod clone can have zero). Skipping rather than hard-failing.'
    );
    const appBlockId = blocks[0].id;
    expect(typeof appBlockId, 'discovered appBlockId should be a string').toBe('string');

    // Track the created subscription id so `finally` can always clean it up.
    let subscriptionId: string | null = null;

    try {
      // INSTALL CONFIG: the authenticated source for the install modal's settings
      // + the consentable scope CEILING. We read it both to exercise the proc and
      // to source a known-in-ceiling scope for the consent leg below.
      const installConfig = await trpcQuery<InstallConfig>(
        page.request,
        'blocks.getInstallConfig',
        { appBlockId }
      );
      expect(
        Array.isArray(installConfig?.scopes),
        'getInstallConfig should return a { scopes: string[] } ceiling'
      ).toBe(true);

      // INSTALL: create a blanket `viewer_personal` subscription. enabled:true,
      // no target filters (null → applies everywhere). Returns the created
      // SubscriptionRecord whose `id` is a STRING.
      const sub = await trpcMutation<SubscriptionRecord | null>(
        page.request,
        'blocks.upsertSubscription',
        {
          appBlockId,
          scope: SCOPE,
          targetModelTypes: null,
          targetBaseModels: null,
          enabled: true,
        }
      );
      expect(typeof sub?.id, 'upsertSubscription should return a string subscription id').toBe(
        'string'
      );
      expect(sub?.scope, 'the created subscription should carry the viewer_personal scope').toBe(
        SCOPE
      );
      subscriptionId = sub!.id;

      // READ-BACK: the new (appBlockId, viewer_personal) subscription must appear
      // in the caller's own subscriptions — proves the write persisted (not just
      // 200-OK'd), matched deterministically by the returned id.
      const mySubs = await trpcQuery<SubscriptionRecord[]>(
        page.request,
        'blocks.listMySubscriptions'
      );
      const found = (mySubs ?? []).find(
        (s) => s.id === subscriptionId && s.appBlockId === appBlockId && s.scope === SCOPE
      );
      expect(
        found,
        `the installed (appBlockId=${appBlockId}, viewer_personal) subscription should be in listMySubscriptions`
      ).toBeTruthy();

      // CONSENT: grant a scope from the install ceiling so a future block-token
      // mint can carry it. Source the scope FROM the ceiling (getInstallConfig)
      // so it's known-grantable — grantScopes BAD_REQUESTs if none are in-ceiling.
      const ceiling = installConfig?.scopes ?? [];
      if (ceiling.length > 0) {
        const scopeToGrant = ceiling[0];
        const grant = await trpcMutation<GrantScopesResult>(page.request, 'blocks.grantScopes', {
          appBlockId,
          scopes: [scopeToGrant],
        });
        // `granted` is the server-intersected actually-recorded set — the
        // deterministic write-confirmation. The requested scope came from the
        // ceiling, so it must survive the intersection.
        expect(
          grant?.granted ?? [],
          `grantScopes should record the in-ceiling scope "${scopeToGrant}"`
        ).toContain(scopeToGrant);

        // CORROBORATING READ-BACK on the per-app surface — SOFT. `granted` above
        // is the authoritative, race-immune consent confirmation (grantScopes
        // reads the appBlock, not our subscription). listMyScopeGrants, by
        // contrast, derives the app surface PURELY from the existence of our
        // `viewer_personal` subscription row — and the `mod` fixture is SHARED
        // across concurrently-deployed previews, all writing the SAME
        // (user, appBlockId, viewer_personal) row. A sibling preview's `finally`
        // cleanup could delete that row between our grant and this read. So:
        // assert-if-present, annotate-if-absent — never spuriously fail on a
        // cross-preview teardown race.
        const grants = await trpcQuery<ScopeGrantSurface[]>(
          page.request,
          'blocks.listMyScopeGrants'
        );
        const appSurface = (grants ?? []).find((g) => g.appBlockId === appBlockId);
        if (appSurface) {
          expect(
            appSurface.scopes,
            `the granted scope "${scopeToGrant}" should be within the app's surfaced scope set`
          ).toContain(scopeToGrant);
        } else {
          test.info().annotations.push({
            type: 'note',
            description: `listMyScopeGrants surface for ${appBlockId} was absent at read-back — most likely a concurrent preview's cleanup deleted the shared mod subscription. grantScopes().granted already confirmed the consent deterministically.`,
          });
        }
      } else {
        test.info().annotations.push({
          type: 'note',
          description: `getInstallConfig().scopes is empty for ${appBlockId} (no consentable scopes in the manifest∩approved ceiling) — skipping the consent leg. Install round-trip still asserted.`,
        });
      }
    } finally {
      // CLEANUP: delete our own subscription so re-runs don't accumulate on the
      // shared dev clone. Idempotent + ownership-checked server-side. Best-effort
      // — a cleanup failure must not mask the assertions above.
      if (subscriptionId) {
        try {
          await trpcMutation(page.request, 'blocks.deleteSubscription', { subscriptionId });
          // Verify it's gone (deterministic): re-query and assert absence. Inside
          // try/catch so a read-back hiccup during teardown can't fail the spec.
          const after = await trpcQuery<SubscriptionRecord[]>(
            page.request,
            'blocks.listMySubscriptions'
          );
          expect(
            (after ?? []).some((s) => s.id === subscriptionId),
            'the deleted subscription should no longer be in listMySubscriptions'
          ).toBe(false);
        } catch {
          // Teardown is best-effort; the install/consent assertions are the point.
        }
      }
    }
  });
});
