import { isFlipt } from '~/server/flipt/client';
import {
  narrowStoreScope,
  storeScopeRank,
  widerStoreScope,
  type StoreVisibilityScope,
} from '~/shared/utils/store-visibility-scope';
import {
  recordPublicCatalogDecision,
  type PublicCatalogOutcome,
  type StoreScopeEntrypoint,
} from '~/server/prom/store-scope.metrics';

/**
 * The PUBLIC App-catalog read grant — the deliberate decision that the REST
 * catalog endpoints (`GET /api/v1/apps`, `GET /api/v1/apps/{slug}`) are readable
 * by anyone, including an unauthenticated caller.
 *
 * ## Why this is its own module, and not another term in `resolveStoreVisibilityScope`
 *
 * Public REST catalog access is INTENDED product behaviour, but until now it was
 * not something anyone had decided — it was a side effect. `resolveStoreVisibility
 * Scope` resolved nothing for an anonymous principal, and the listing service's
 * `?? 'full'` turned that missing value into the whole approved catalog
 * (civitai#3983). #4041 makes an absent scope fail CLOSED everywhere, which is
 * correct and must stay — and which, on its own, would have taken a live public
 * endpoint from 14 items to zero. This module is the other half: it re-grants that
 * access ON PURPOSE, in one named place, so the catalog's public reach is a
 * decision a reader can find rather than a `??` nobody meant.
 *
 * 🔴 IT IS DELIBERATELY NOT `hasAppsStoreAccess`, AND NOT A STORE FLAG. The
 * existing store predicate is `appListings || appBlocks || appListingsPublic
 * External`, and it gates the `/apps` PAGE as well as the read scope. Granting
 * public REST access by enabling any of those three flags — or by reusing that
 * predicate here — would also open `/apps` to every visitor, i.e. launch the store.
 * Nobody asked for that. The state this module encodes (catalog readable over the
 * REST API, `/apps` still dark for an anonymous viewer) is not reachable by ANY
 * combination of those flags; that is precisely why it needs its own decision
 * point. Adding a store flag to this module's inputs re-creates the coupling — do
 * not do it.
 *
 * ## What it does, exactly
 *
 * {@link resolvePublicAppsCatalogScope} takes the value `resolveStoreVisibility
 * Scope` produced and answers the only question the REST handlers actually have:
 * *what may this caller read from the public catalog?*
 *
 *   1. NARROW first ({@link narrowStoreScope}) — #4041's fail-closed rule is
 *      applied unchanged and FIRST, so an absent or uninterpretable value can never
 *      be mistaken for an entitlement.
 *   2. A caller already AT OR ABOVE the floor — compared by
 *      {@link storeScopeRank}, never by naming a scope — is returned VERBATIM and
 *      never pays for the kill-switch eval, because the grant has nothing it could
 *      add to them. With today's `full` floor that is exactly the `full` callers.
 *   3. Everyone else meets the grant. If the operator kill switch is ON the grant is
 *      withheld and the caller gets THEIR OWN resolved scope back — `none` for an
 *      anonymous caller (empty page / 404), `public-external` for the external-only
 *      cohort. Otherwise they get the WIDER of their own scope and
 *      {@link PUBLIC_APPS_CATALOG_SCOPE}.
 *
 * 🔴 THE INVARIANT THAT REPLACES THE OLD SHORT-CIRCUIT: this module NEVER returns a
 * scope narrower than the one the caller resolved, in any configuration of the kill
 * switch. The pre-#4048 code got that for free by returning early for every non-
 * `none` scope; the widening restructure has to state it and test it, because the
 * one edit that would break it — closing the withheld branch to a literal `'none'` —
 * looks like the obviously-correct thing to write. `widerStoreScope` on one arm and
 * the caller's own scope on the other are what keep it true.
 *
 * ## The fail-closed invariant this preserves (read this before "simplifying" it)
 *
 * #3983's exploit was not that anonymous callers could read the catalog — that is
 * intended. It was that an ABSENT scope produced a WIDER answer than a resolved
 * one: absent → `full`, resolved-`none` → empty, from the same request. Step 1
 * collapses that: absent and `none` are the same input to step 3 and therefore
 * produce the same response. There is no value the resolver can fail to produce
 * that buys a caller more than a correctly-resolved `none` does. Every other
 * consumer of the scope — both listing-service entry points, the three store tRPC
 * procs — keeps failing closed exactly as #4041 left them; this module is scoped to
 * the two public REST handlers and nothing else imports it.
 *
 * ⚠️ Honest consequence, stated rather than discovered later: while the grant is
 * active and the floor is `full`, a caller in the external-only cohort and an
 * anonymous caller read the SAME catalog at these two endpoints — the cohort member
 * is WIDENED to the floor rather than held at `public-external`. That is deliberate.
 * The floor is public: withholding onsite listings from a signed-in cohort member
 * that an anonymous caller can read anyway protects nothing, and doing it produced a
 * live inversion where signing in REDUCED what `GET /api/v1/apps` returned
 * (civitai#4048 — measured 14 items anonymous vs 4 for the cohort). The distinction
 * between the two callers reappears the moment the kill switch is thrown — the
 * cohort member keeps `public-external`, the anonymous caller drops to `none` — and
 * it has always mattered on the tRPC/page surfaces, which this module does not touch.
 */

/**
 * The public catalog FLOOR — what a caller with no scope of their own is lifted to.
 * `full` — both `onsite` and `offsite` approved listings, which is what
 * `GET /api/v1/apps` has been serving publicly all along (measured: 14 items,
 * 10 onsite + 4 offsite). This constant exists so narrowing the public catalog later
 * (e.g. to `public-external`) is a one-line, reviewable product decision rather than
 * an edit threaded through two handlers.
 *
 * 🔴 THE RESOLVER MUST STAY CORRECT UNDER THAT ONE-LINE EDIT. Nothing below compares
 * against a named scope; it compares RANKS against whatever this constant holds. Set
 * it to `public-external` and a `full` caller still short-circuits as `privileged`,
 * a `public-external` caller short-circuits too, and a `none` caller is lifted to
 * `public-external`. The suite runs that configuration explicitly rather than
 * trusting the reading.
 *
 * Approved-only, deploy-gated and maturity-gated filtering still applies inside the
 * listing service — `full` is a KIND predicate, not "everything in the table".
 */
export const PUBLIC_APPS_CATALOG_SCOPE: StoreVisibilityScope = 'full';

/**
 * Operator KILL SWITCH for the public catalog. Flipt flag; when it resolves TRUE the
 * public GRANT is withheld — every caller is left with the scope they resolved for
 * themselves and nothing more. For an unauthenticated caller that is `none`, i.e. an
 * empty page / 404, which is the whole point of the switch. It is NOT a global
 * blackout: a caller in the external-only cohort still reads `public-external`
 * through it, and a `full` caller never reaches it at all. The switch withdraws the
 * public floor; it cannot take away an entitlement the caller already had.
 *
 * 🔴 THE POLARITY IS THE WHOLE POINT — it is a DISABLE flag, not an ENABLE flag.
 * `isFlipt` returns `false` for a flag that does not exist and for an unreachable
 * Flipt, so the absent/dark/broken state of this switch is **public access stays
 * on**. An enable-shaped flag would have made merging this PR empty the live
 * endpoint until someone remembered to create the flag — the exact regression the
 * grant exists to prevent, re-introduced by its own kill switch. If you ever invert
 * this to an `apps-public-catalog-enabled` flag, you must create AND enable it in
 * flipt-state BEFORE the code merges, and the window between the two is an outage of
 * a public endpoint.
 *
 * The flag does NOT exist in Flipt as merged, and does not need to: the as-merged
 * behaviour is the intended one. To throw the switch, create it as a PLAIN base
 * `enabled: true` boolean (NO segments, NO percentage rollout) — it is evaluated
 * GLOBALLY (entityId `'global'`, empty context) because the callers it governs are
 * unauthenticated and carry no context for a segment to match. A segmented or
 * percentage-rollout shape cannot reliably match a global eval and would read as a
 * switch that does nothing.
 *
 * Propagation is the Flipt eval cache (~10s) plus the config poll (~60s), on top of
 * whatever the CDN is still serving for `s-maxage`. It is not instant; that is
 * acceptable for a catalog-visibility switch and is why it is deliberately NOT in
 * the client's cache-bypass set (these are hot, unauthenticated endpoints).
 */
export const PUBLIC_APPS_CATALOG_DISABLED_FLAG = 'apps-public-catalog-disabled';

/** Global eval — these callers are unauthenticated and carry no Flipt context. */
async function isPublicAppsCatalogDisabled(): Promise<boolean> {
  return isFlipt(PUBLIC_APPS_CATALOG_DISABLED_FLAG);
}

/**
 * The decision itself, with the FLOOR and the kill-switch read passed in — the whole
 * of the policy, and the only copy of it.
 *
 * The floor is a PARAMETER rather than a closed-over constant for one reason: the
 * constant is documented as a one-line product edit, and a test that cannot run the
 * narrowed-floor configuration against THIS function has to re-implement the policy
 * to check it, which pins a copy instead of the code. `resolvePublicAppsCatalogScope`
 * supplies {@link PUBLIC_APPS_CATALOG_SCOPE}; nothing else should.
 *
 * @param readKillSwitch a THUNK, not a boolean — the privileged branch must return
 *   without evaluating it, so a caller at or above the floor pays no Flipt round trip
 *   in any configuration. Passing an already-awaited boolean would quietly lose that.
 * @returns the scope to serve AND the outcome to record, so the counter cannot drift
 *   out of step with the branch that was actually taken.
 */
export async function decidePublicCatalogScope(
  resolved: unknown,
  floor: StoreVisibilityScope,
  readKillSwitch: () => Promise<boolean>
): Promise<{ scope: StoreVisibilityScope; outcome: PublicCatalogOutcome }> {
  // 1. #4041's rule, first and unchanged: anything uninterpretable becomes `none`.
  const scope = narrowStoreScope(resolved);
  // 2. Already at or above the floor ⇒ the grant has nothing to add. Compared by
  //    RANK, not by naming a scope, so this stays correct if the floor is narrowed —
  //    and so a privileged caller never pays for the kill-switch read below.
  if (storeScopeRank(scope) >= storeScopeRank(floor)) {
    return { scope, outcome: 'privileged' };
  }
  // 3. The grant, unless an operator has withheld it. 🔴 WITHHELD RETURNS THE
  //    CALLER'S OWN SCOPE, NEVER A LITERAL `'none'`: the switch withdraws the public
  //    FLOOR, it does not revoke an entitlement the caller resolved for themselves.
  //    Writing `scope: 'none'` here narrows the external-only cohort on a surface
  //    they are entitled to read, which is the invariant stated in the module doc.
  if (await readKillSwitch()) {
    return { scope, outcome: 'withheld' };
  }
  // 4. Lift to the floor — `widerStoreScope`, so this can only ever RAISE the
  //    caller's scope. A plain `scope: floor` would be a NARROWING for any caller
  //    above a later-narrowed floor.
  return { scope: widerStoreScope(scope, floor), outcome: 'granted' };
}

/**
 * Resolve what the PUBLIC REST catalog endpoints may serve this caller.
 *
 * @param resolved the raw value from `resolveStoreVisibilityScope` — typed `unknown`
 *   on purpose. Production has been observed carrying `undefined` across exactly this
 *   boundary while every type checked green (civitai#3983), so the narrowing has to
 *   happen at runtime, here, on the value that actually arrived.
 * @param entrypoint which REST handler is asking — for the decision counter only.
 */
export async function resolvePublicAppsCatalogScope(
  resolved: unknown,
  entrypoint: StoreScopeEntrypoint
): Promise<StoreVisibilityScope> {
  const { scope, outcome } = await decidePublicCatalogScope(
    resolved,
    PUBLIC_APPS_CATALOG_SCOPE,
    isPublicAppsCatalogDisabled
  );
  recordPublicCatalogDecision(outcome, entrypoint);
  return scope;
}
